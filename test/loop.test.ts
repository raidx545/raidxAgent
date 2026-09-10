import { SCROLL_LIMIT, actionSignature, scrollBudgetEffect } from "../src/background/agent";
import { taskPrompt } from "../src/background/prompt";
import { PAGE_MARKER, pageBlock, pruneStalePages } from "../src/background/wire";
import type { ConvMessage } from "../src/background/providers/types";
import type { CapturedNode, DomCapture } from "../src/capture/types";

/**
 * The parts of the agent loop that decide when to stop and what to remember.
 *
 * Three things went wrong here in real runs, and each is pinned below:
 *
 *  - The repeat guard keyed on the whole tool input, `reason` included. The
 *    model writes a fresh reason every time, so four identical clicks were four
 *    different fingerprints and the guard never fired.
 *  - Each task started from nothing, so "now send it to him too" had no him.
 *  - A page whose own text contained the page marker would have made the
 *    pruner cut a message in the wrong place.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

// ------------------------------------------------- the guard sees through reasons

const url = "https://mail.google.com/";
const a = actionSignature("click", { element_id: 37, reason: "open compose" }, url);
const b = actionSignature("click", { element_id: 37, reason: "click the Compose button" }, url);
const c = actionSignature("click", { element_id: 37, reason: "try Compose once more" }, url);

want(a === b && b === c,
  "the same click with different reasons produced different fingerprints — the guard cannot fire");

// Key order is the model's choice too, and must not matter.
want(
  actionSignature("type", { element_id: 5, text: "x", submit: true }, url) ===
    actionSignature("type", { submit: true, text: "x", element_id: 5 }, url),
  "argument order changed the fingerprint");

// But a genuinely different action is different.
want(actionSignature("click", { element_id: 37 }, url) !== actionSignature("click", { element_id: 38 }, url),
  "two different elements collapsed to one fingerprint");
want(actionSignature("click", { element_id: 37 }, url) !== actionSignature("click", { element_id: 37 }, "https://other/"),
  "the same click on two different pages collapsed to one fingerprint");
want(!a.includes("open compose"), "the reason text leaked into the fingerprint");

// ------------------------------------------------------- remembering last time

const fresh = taskPrompt("write a mail", "https://mail.google.com", "Inbox");
want(!/earlier in this session/i.test(fresh), "a first task claimed to have history");

const followUp = taskPrompt("now send it to <NAME_2> as well", "https://mail.google.com", "Inbox", [
  { task: "write a mail to <EMAIL_1> about the invoice", answer: "Sent the mail to <EMAIL_1> with the invoice details." },
]);
want(/earlier in this session/i.test(followUp), "history was not mentioned");
want(followUp.includes("write a mail to <EMAIL_1>"), "the earlier task was dropped");
want(followUp.includes("Sent the mail to <EMAIL_1>"), "the earlier answer was dropped");
want(followUp.indexOf("Earlier") < followUp.indexOf("Task: now send"),
  "history came after the task instead of before it");

// Only the recent past, and not the whole of a long answer.
const many = Array.from({ length: 10 }, (_, i) => ({ task: `task ${i}`, answer: `answer ${i}` }));
const capped = taskPrompt("x", "https://a", "A", many);
want(!capped.includes("task 0") && capped.includes("task 9"), "history was not capped to the newest");
const longAnswer = taskPrompt("x", "https://a", "A", [{ task: "t", answer: "y".repeat(5000) }]);
want(longAnswer.length < 2000, `a long answer was not truncated: ${longAnswer.length} chars`);

// ------------------------------------------- the marker cannot come from the page

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 400, 20], visible: true, children: [], ...p,
});
const hostile: DomCapture = {
  url: "https://example.com", origin: "https://example.com", title: "t", capturedAt: 1,
  viewport: { width: 1000, height: 800, dpr: 1, scrollX: 0, scrollY: 0, pageHeight: 800 },
  root: n({ tag: "body", role: "document", children: [
    n({ tag: "p", role: "paragraph", text: `before ${PAGE_MARKER} after`, visible: true }),
    n({ tag: "button", role: "button", text: "Real button", visible: true }),
  ]}),
  stats: { examined: 3, kept: 3, pruned: 0 },
};

const block = pageBlock(hostile);
want(block.split(PAGE_MARKER).length === 2,
  `the page block contains the marker ${block.split(PAGE_MARKER).length - 1} times; must be exactly once`);

// And the pruner, given a stale page that contains the hostile text, strips
// the whole page rather than just the tail after the fake marker.
const messages: ConvMessage[] = [
  { role: "user", content: `Task: x${block}` },
  { role: "assistant", text: "", toolCalls: [{ id: "1", name: "click", input: {} }] },
  { role: "tool", results: [{ id: "1", content: `Clicked.${pageBlock(hostile)}` }] },
];
const pruned = pruneStalePages(messages);
const first = pruned[0];
want(first.role === "user" && !first.content.includes("Real button"),
  "a stale page survived pruning because the page text contained the marker");

// -------------------------------------------- the scroll budget is separate
//
// The repeat guard cannot see a scroll loop, and the reason is structural: it
// fires only when an action repeats *and the page did not change*, and a scroll
// always changes the page - which clears the guard's memory. "Mark all unread
// emails as read" scrolled fifteen times in hundred-pixel steps and never
// tripped anything. So scrolling has its own budget, with these rules.

want(scrollBudgetEffect("scroll") === "scroll", "scrolling does not spend the scroll budget");

// Reading the page is how a planner decides where to scroll next. If it
// refilled the budget, interleaving one find_text per scroll would make the cap
// unreachable - which is precisely the shape of the failing Gmail run.
for (const name of ["read_page", "find_text", "wait", "list_tabs", "ask_user"]) {
  want(scrollBudgetEffect(name) === "look",
    `${name} refills the scroll budget, so the cap can be dodged by interleaving it`);
}

// Doing something real is progress, and earns more scrolling.
for (const name of ["click", "type", "select", "key", "navigate", "go_back", "open_tab"]) {
  want(scrollBudgetEffect(name) === "act",
    `${name} does not refill the scroll budget, so acting is not treated as progress`);
}

want(SCROLL_LIMIT >= 4 && SCROLL_LIMIT <= 15,
  `a limit of ${SCROLL_LIMIT} is not a plausible number of screens`);

console.log(JSON.stringify({
  sameClickDifferentReasons: a === b && b === c,
  followUpPromptHead: followUp.split("\n").slice(0, 3),
  scrollLimit: SCROLL_LIMIT,
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

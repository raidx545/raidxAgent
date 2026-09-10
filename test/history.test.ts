import { pruneStalePages, pageBlock, PAGE_MARKER } from "../src/background/wire";
import type { ConvMessage } from "../src/background/providers/types";
import type { CapturedNode, DomCapture } from "../src/capture/types";

/**
 * What the planner is handed as a task runs on.
 *
 * Each step appends a fresh page render to the history, so by turn ten the
 * planner receives ten of them and only the last describes the page in front of
 * it. The other nine are not merely wasted tokens: they are full of element ids
 * that have since been reissued to different elements, which is exactly the
 * material a planner needs in order to click the wrong thing.
 *
 * These tests pin down that only the newest page survives, that everything
 * *else* in the history survives untouched, and that the saving is real.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 200, 20], visible: true, children: [], ...p,
});

/** A page with enough elements to be worth pruning. */
function page(step: number): DomCapture {
  id = step * 100;
  const rows = Array.from({ length: 40 }, (_, i) =>
    n({ tag: "a", role: "link", text: `Row ${i} of step ${step}` }),
  );
  return {
    url: `https://example.in/step/${step}`,
    origin: "https://example.in",
    title: `Step ${step}`,
    capturedAt: Date.now(),
    viewport: { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0, pageHeight: 2000 },
    root: n({ tag: "body", role: "document", children: rows }),
    stats: { examined: 60, kept: 41, pruned: 19 },
  };
}

/** Ten steps of history, exactly as the agent loop builds it. */
function history(steps: number): ConvMessage[] {
  const messages: ConvMessage[] = [
    { role: "user", content: `Task: find the thing.${pageBlock(page(0))}` },
  ];
  for (let step = 1; step <= steps; step++) {
    messages.push({
      role: "assistant",
      text: `Step ${step}: I will click row ${step}.`,
      toolCalls: [{ id: `c${step}`, name: "click", input: { element_id: step * 100 + 3 } }],
    });
    messages.push({
      role: "tool",
      results: [{ id: `c${step}`, content: `Clicked <a "Row ${step}">.${pageBlock(page(step))}` }],
    });
  }
  return messages;
}

const chars = (messages: ConvMessage[]): number =>
  messages.reduce(
    (sum, m) =>
      sum +
      (m.role === "user"
        ? m.content.length
        : m.role === "assistant"
          ? m.text.length
          : m.results.reduce((s, r) => s + r.content.length, 0)),
    0,
  );

const blocks = (messages: ConvMessage[]): number =>
  messages.reduce(
    (sum, m) =>
      sum +
      (m.role === "user"
        ? (m.content.match(new RegExp(PAGE_MARKER, "g")) ?? []).length
        : m.role === "tool"
          ? m.results.reduce(
              (s, r) => s + (r.content.match(new RegExp(PAGE_MARKER, "g")) ?? []).length,
              0,
            )
          : 0),
    0,
  );

// --------------------------------------------------------- only one survives

const raw = history(9);
const pruned = pruneStalePages(raw);

want(blocks(raw) === 10, `fixture wrong: expected 10 page blocks, got ${blocks(raw)}`);
want(blocks(pruned) === 1, `expected exactly one page to survive, got ${blocks(pruned)}`);

// The surviving one must be the newest, or the planner acts on a dead page.
const last = pruned[pruned.length - 1];
const lastText = last.role === "tool" ? last.results[0].content : "";
want(lastText.includes(PAGE_MARKER), "the newest message lost its page");
want(lastText.includes("Row 3 of step 9"), "the surviving page is not the newest one");

// ------------------------------------------------------ nothing else is lost

want(
  pruned.length === raw.length,
  `pruning dropped whole messages: ${raw.length} -> ${pruned.length}`,
);
// Read the messages directly rather than through JSON.stringify, which escapes
// the quotes inside the element descriptions and makes the check pass or fail
// for the wrong reason.
const plain = pruned
  .map((m) =>
    m.role === "user"
      ? m.content
      : m.role === "assistant"
        ? m.text
        : m.results.map((r) => r.content).join("\n"),
  )
  .join("\n");

for (let step = 1; step <= 9; step++) {
  want(plain.includes(`Step ${step}: I will click row ${step}.`),
    `reasoning from step ${step} was lost`);
  want(plain.includes(`Clicked <a "Row ${step}">`),
    `the outcome of step ${step} was lost`);
}

// Tool call ids must survive exactly, or the provider rejects the conversation.
for (let step = 1; step <= 9; step++) {
  const assistant = pruned.find(
    (m) => m.role === "assistant" && m.toolCalls.some((c) => c.id === `c${step}`),
  );
  const result = pruned.find((m) => m.role === "tool" && m.results.some((r) => r.id === `c${step}`));
  want(!!assistant && !!result, `the call/result pair for step ${step} was broken`);
}

// A superseded page must say so, so the planner does not treat it as current.
const early = pruned[0];
const earlyText = early.role === "user" ? early.content : "";
want(earlyText.startsWith("Task: find the thing."), "the task itself was pruned away");
want(/superseded/i.test(earlyText), `a stripped page gave no explanation: ${earlyText.slice(-80)}`);
want(!earlyText.includes("Row 3 of step 0"), "a stale page survived in the first message");

// -------------------------------------------------------------- the saving

const before = chars(raw);
const after = chars(pruned);
const saved = 1 - after / before;
// The exact ratio depends on how much of a message is page versus prose, so
// this asserts the effect is large rather than pinning a number that would
// churn whenever the renderer changes.
want(saved > 0.6, `expected a large saving on the final turn, got ${(saved * 100).toFixed(1)}%`);

// Across a whole task the effect compounds, because every turn resends history.
let sentRaw = 0;
let sentPruned = 0;
for (let turn = 1; turn <= 10; turn++) {
  sentRaw += chars(history(turn - 1));
  sentPruned += chars(pruneStalePages(history(turn - 1)));
}
want(sentPruned < sentRaw * 0.5,
  `expected to more than halve a task's traffic, sent ${sentPruned} of ${sentRaw}`);

// ------------------------------------------------------------- degenerate

want(pruneStalePages([]).length === 0, "an empty history threw");
const single = [{ role: "user" as const, content: `Task.${pageBlock(page(0))}` }];
want(blocks(pruneStalePages(single)) === 1, "the only page was pruned away");
const none: ConvMessage[] = [{ role: "user", content: "no page here" }];
want(pruneStalePages(none)[0] === none[0], "a history with no pages was rewritten anyway");

console.log(JSON.stringify({
  pageBlocks: { before: blocks(raw), after: blocks(pruned) },
  finalTurnChars: { before: before.toLocaleString(), after: after.toLocaleString() },
  savedOnFinalTurn: `${(saved * 100).toFixed(1)}%`,
  charsSentAcrossA10StepTask: {
    before: sentRaw.toLocaleString(),
    after: sentPruned.toLocaleString(),
    saved: `${((1 - sentPruned / sentRaw) * 100).toFixed(1)}%`,
  },
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

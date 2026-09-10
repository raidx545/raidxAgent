import { renderPage } from "../src/background/wire";
import type { CapturedNode, DomCapture } from "../src/capture/types";

/**
 * What survives the render budget on a page far larger than it.
 *
 * This reproduces the failure that made the agent loop on Gmail. An inbox has
 * thousands of rows and appends its compose dialog near the *end* of the DOM,
 * so truncating in document order drops the one part of the page the user just
 * opened. The agent clicks "Compose", is shown a page with no compose window,
 * concludes nothing happened, and clicks again.
 *
 * The budget must therefore be spent on what is on screen, not on what comes
 * first in the markup.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 400, 20], visible: true, children: [], ...p,
});

/**
 * An inbox: a few hundred rows, almost all below the fold, with a compose
 * dialog appended last — which is where a real mail client puts it.
 */
function inbox(rows: number): DomCapture {
  id = 0;

  const chrome = [
    n({ tag: "button", role: "button", text: "Compose", visible: true }),
    n({ tag: "input", role: "textbox", label: "Search mail", visible: true }),
  ];

  const list = Array.from({ length: rows }, (_, i) =>
    n({
      tag: "tr",
      role: "row",
      text: `Sender ${i} — Subject line number ${i}`,
      // Only the first fifteen rows fit on screen.
      visible: i < 15,
    }),
  );

  const compose = n({
    tag: "div",
    role: "dialog",
    label: "New Message",
    visible: true,
    attrs: { "aria-modal": "true" },
    children: [
      n({ tag: "input", role: "textbox", label: "To recipients", visible: true }),
      n({ tag: "input", role: "textbox", label: "Subject", visible: true }),
      n({ tag: "div", role: "textbox", label: "Message Body", visible: true }),
      n({ tag: "button", role: "button", text: "Send", visible: true }),
    ],
  });

  return {
    url: "https://mail.example.com/u/0/#inbox",
    origin: "https://mail.example.com",
    title: "Inbox",
    capturedAt: Date.now(),
    viewport: { width: 1400, height: 900, dpr: 2, scrollX: 0, scrollY: 0, pageHeight: 40000 },
    root: n({ tag: "body", role: "document", children: [...chrome, ...list, compose] }),
    stats: { examined: rows * 3, kept: rows + 8, pruned: rows * 2 },
  };
}

// --------------------------------------------------- the case that looped

const wire = renderPage(inbox(2179));

want(wire.includes("Compose"), "the Compose button was dropped");

// The compose dialog is the whole point: it is last in the DOM and on screen.
for (const part of ["New Message", "To recipients", "Subject", "Message Body", "Send"]) {
  want(wire.includes(part), `the compose dialog lost "${part}" — this is what caused the loop`);
}

// An open dialog should be called out, so the planner works inside it.
want(/dialog is open/i.test(wire), "an open modal was not announced");

// Rows on screen stay; rows far below the fold are what gets dropped.
want(wire.includes("Sender 0 —"), "a visible inbox row was dropped");
want(wire.includes("Sender 14 —"), "the last visible inbox row was dropped");
want(!wire.includes("Sender 2000 —"), "a row 2000 places below the fold was kept");

// The planner must be told the rest exists, or it will not think to scroll.
want(/off screen/i.test(wire), "the dropped elements were not accounted for");

// -------------------------------------------------- a page inside budget

const small = renderPage(inbox(12));
want(small.includes("Sender 11 —"), "a small page was truncated when it did not need to be");
want(!/off screen/i.test(small), "a small page reported dropped elements it did not have");

// --------------------------------------------- everything visible, no room

// A pathological page where even the visible elements exceed the budget: it
// must still produce something coherent rather than an empty element list.
id = 0;
const allVisible: DomCapture = {
  ...inbox(1),
  root: n({
    tag: "body",
    role: "document",
    children: Array.from({ length: 900 }, (_, i) =>
      n({ tag: "a", role: "link", text: `Link ${i}`, visible: true }),
    ),
  }),
};
const crowded = renderPage(allVisible);
want(crowded.includes("Link 0"), "a fully visible page rendered nothing");
want(/did not fit/i.test(crowded), "an over-budget visible page did not say so");

const lineCount = crowded.split("\n").filter((l) => /^\s*\[\d+\]/.test(l)).length;
want(lineCount <= 400, `the budget was exceeded: ${lineCount} element lines`);

// ------------------------- the shape that actually looped, on real Gmail
//
// The first fix here dropped off-screen lines before visible ones, which is
// right but was not enough: a real inbox has several hundred *visible* elements
// of its own, so the budget was still spent before reaching a dialog appended
// last in the DOM. The planner was told a dialog was open and shown none of it,
// so it clicked Compose, saw nothing, and clicked again.
{
  id = 0;
  const rows: CapturedNode[] = [];
  for (let i = 0; i < 200; i++) {
    rows.push(
      n({ tag: "tr", role: "row", visible: true, children: [
        n({ tag: "span", role: "gridcell", text: `Sender ${i}`, visible: true }),
        n({ tag: "span", role: "gridcell", text: `Subject ${i}`, visible: true }),
        n({ tag: "span", role: "gridcell", text: `Snippet ${i}`, visible: true }),
      ]}),
    );
  }

  const dialog = n({
    tag: "div", role: "dialog", label: "New Message", visible: true,
    attrs: { "aria-modal": "true" },
    children: [
      n({ tag: "input", role: "combobox", label: "To recipients", visible: true }),
      n({ tag: "input", role: "textbox", label: "Subject line", visible: true }),
      n({ tag: "div", role: "textbox", label: "Message Body", visible: true }),
      n({ tag: "button", role: "button", text: "Send message", visible: true }),
    ],
  });

  const crowdedWithDialog: DomCapture = {
    url: "https://mail.google.com/", origin: "https://mail.google.com", title: "Inbox",
    capturedAt: 1,
    viewport: { width: 1400, height: 900, dpr: 2, scrollX: 0, scrollY: 0, pageHeight: 40000 },
    root: n({ tag: "body", role: "document", children: [
      n({ tag: "button", role: "button", text: "Compose", visible: true }),
      ...rows, dialog,
    ]}),
    stats: { examined: 1, kept: 1, pruned: 0 },
  };

  const out = renderPage(crowdedWithDialog);

  for (const part of ["New Message", "To recipients", "Subject line", "Message Body", "Send message"]) {
    want(out.includes(part),
      `the open dialog lost "${part}" behind hundreds of visible rows — this is the Gmail loop`);
  }

  // Announcing a dialog while showing none of it is worse than saying nothing:
  // the planner is told its click worked and then cannot act on the result.
  want(!(/dialog is open/i.test(out) && !out.includes("To recipients")),
    "a dialog was announced but not rendered");

  const budgetLines = out.split("\n").filter((l) => /^\s*\[\d+\]/.test(l)).length;
  want(budgetLines <= 400, `the budget was exceeded: ${budgetLines} lines`);

  // The background still gets whatever room is left, and is accounted for.
  want(out.includes("Sender 0"), "the page behind the dialog vanished entirely");
  want(/did not fit/i.test(out), "dropped on-screen elements were not reported");
}

console.log(JSON.stringify({
  elementLinesOnHugeInbox: wire.split("\n").filter((l) => /^\s*\[\d+\]/.test(l)).length,
  composeDialogSurvived: ["New Message", "To recipients", "Send"].every((p) => wire.includes(p)),
  tail: wire.split("\n").slice(-3),
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

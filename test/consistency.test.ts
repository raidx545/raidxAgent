import { isConsistent } from "../src/background/inspect";
import type { CapturedNode, DomCapture } from "../src/capture/types";

/**
 * When is a screenshot allowed to go with a tree?
 *
 * inspect.ts captures, photographs, then captures again, and keeps the
 * screenshot only if the page held still. "Held still" used to mean the same
 * URL, scroll and viewport - which a page can satisfy while its DOM changes
 * underneath: a mail arrives, a toast dismisses itself. Every id after the
 * change shifts by one, and the planner's click on "Archive" landed on "Delete
 * forever". The shape of the tree has to match too.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 100, 20], visible: true, children: [], ...p,
});

function page(build: () => CapturedNode[]): DomCapture {
  id = 0;
  const children = build();
  return {
    url: "https://mail.example.com/", origin: "https://mail.example.com", title: "Inbox",
    capturedAt: 1,
    viewport: { width: 1200, height: 800, dpr: 2, scrollX: 0, scrollY: 0, pageHeight: 800 },
    root: { ...n({ tag: "body", role: "document" }), id: 999, children },
    stats: { examined: 1, kept: 1, pruned: 0 },
  };
}

const withToast = () => [
  n({ role: "status", text: "Message sent" }),
  n({ tag: "button", role: "button", text: "Archive" }),
  n({ tag: "button", role: "button", text: "Delete forever" }),
];
const withoutToast = () => [
  n({ tag: "button", role: "button", text: "Archive" }),
  n({ tag: "button", role: "button", text: "Delete forever" }),
];

// -------------------------------------------- the case that clicked the wrong thing

want(!isConsistent(page(withToast), page(withoutToast)),
  "a toast dismissing itself between captures was judged consistent - ids shifted and " +
  "\"Archive\" resolved to \"Delete forever\"");

// A row arriving is the same fault in the other direction.
want(!isConsistent(
  page(() => [n({ text: "Row one" }), n({ tag: "button", role: "button", text: "Archive" })]),
  page(() => [n({ text: "Row zero" }), n({ text: "Row one" }), n({ tag: "button", role: "button", text: "Archive" })]),
), "a new row arriving between captures was judged consistent");

// Same count, different element in a slot: still a different page.
want(!isConsistent(
  page(() => [n({ tag: "button", role: "button", text: "Archive" })]),
  page(() => [n({ tag: "a", role: "link", text: "Archive" })]),
), "a button replaced by a link at the same id was judged consistent");

// -------------------------------------------------------- what must still pass

want(isConsistent(page(withoutToast), page(withoutToast)),
  "an unchanged page was judged inconsistent");

// A clock ticking changes text, not structure - and refusing the screenshot on
// every such page would cost far more than it saves.
want(isConsistent(
  page(() => [n({ text: "10:41" }), n({ tag: "button", role: "button", text: "Send" })]),
  page(() => [n({ text: "10:42" }), n({ tag: "button", role: "button", text: "Send" })]),
), "a text-only change (a ticking clock) was judged inconsistent");

// ------------------------------------------------ the old checks still apply

const moved = page(withoutToast);
moved.viewport = { ...moved.viewport, scrollY: 120 };
want(!isConsistent(page(withoutToast), moved), "a scroll between captures was judged consistent");

const navigated = page(withoutToast);
navigated.url = "https://mail.example.com/thread/1";
want(!isConsistent(page(withoutToast), navigated), "a navigation between captures was judged consistent");

console.log(JSON.stringify({ failures: fails, pass: fails.length === 0 }, null, 2));

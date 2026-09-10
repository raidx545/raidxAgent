import { TranscriptView } from "../../src/sidepanel/transcript";
import type { TranscriptEntry } from "../../src/shared/types";

/**
 * The side panel, driven by a scripted run.
 *
 * The panel itself can only be opened by Chrome as part of the extension, which
 * makes every visual change to it awkward to check. This page loads the real
 * stylesheet and the real transcript view and plays a realistic task through
 * them, so the layout can be looked at - and compared against the old
 * behaviour, which the first entry deliberately reproduces.
 */

const container = document.getElementById("transcript") as HTMLElement;
const view = new TranscriptView(container);
const empty = document.getElementById("empty") as HTMLElement;
const jump = document.getElementById("jump") as HTMLElement;

const entry = (e: Partial<TranscriptEntry> & { id: string; role: TranscriptEntry["role"] }) =>
  view.render({ text: "", ...e } as TranscriptEntry);

empty.classList.add("hidden");

entry({ id: "u1", role: "user", text: "write a mail to priya.sharma@example.in saying the meeting moved to 3pm" });
entry({
  id: "s0", role: "system",
  text: "Using Anthropic claude-opus-5. Page content is tokenized before it leaves this browser.",
});
entry({
  id: "s1", role: "system",
  text: "18 value(s) tokenized · 2 sealed · 3 image region(s) destroyed · 11 text span(s) painted over in the screenshot",
});
entry({
  id: "a1", role: "assistant",
  text: "Going straight to the compose URL rather than hunting for the button.",
});

// A run of actions long enough to fold, which is what a real task produces.
const steps: [string, string][] = [
  ["navigate", "Go to https://mail.google.com/mail/u/0/#inbox?compose=new"],
  ["read_page", "Read the page"],
  ["type", "Typed 23 character(s) into <input> and pressed Enter"],
  ["type", "Typed 21 character(s) into <input>"],
  ["scroll", "Scrolled down to y=794 of 2328."],
  ["scroll", "Scrolled down to y=1464 of 2328 (bottom)."],
  ["find_text", 'Found 1 match for "Send": [37] button text="Send message"'],
  ["type", "Typed 34 character(s) into <div>"],
];
steps.forEach(([action, text], i) =>
  entry({ id: `t${i}`, role: "step", action: action as TranscriptEntry["action"], text }),
);

entry({
  id: "a2", role: "assistant",
  text:
    "The draft is ready: to <EMAIL_1>, subject “Meeting moved”, body “The meeting has moved to 3pm.” " +
    "I have stopped before sending, as that needs your approval.",
});

// A long unbreakable string: this used to force the whole panel sideways.
entry({
  id: "s2", role: "system",
  text: "Screenshot attached: data:image/png;base64," + "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw".repeat(4),
});

entry({ id: "e1", role: "error", text: "Stopped — this is going in circles. The same action has been attempted 4 times with no change to the page." });

// The pending state, as it looks mid-action.
entry({ id: "t9", role: "step", action: "click", text: "Click Send", pending: true });

// The header counter, as it looks mid-run.
(document.getElementById("progress") as HTMLElement).textContent = "9 actions";
document.getElementById("status-dot")!.classList.add("running");

jump.classList.remove("hidden");

// A small control strip, so both themes can be seen without changing the OS.
const bar = document.createElement("div");
bar.style.cssText =
  "position:fixed;right:10px;bottom:88px;z-index:99;display:flex;gap:6px;font:11px ui-sans-serif;opacity:.8";
for (const [label, apply] of [
  ["unfold all", () => container.querySelectorAll<HTMLElement>(".steps-toggle").forEach((t) => t.click())],
  ["scroll top", () => { container.scrollTop = 0; }],
] as const) {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = "ghost";
  b.style.border = "1px solid var(--border)";
  b.addEventListener("click", apply);
  bar.appendChild(b);
}
document.body.appendChild(bar);

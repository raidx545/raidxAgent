import type { ActionResult, AgentAction } from "../shared/types";
import { capturedElement, captureDom, lastCapture, walkCapture } from "../capture/dom";
import { scrollByPixels } from "../capture/scroller";
import { CLICK_START, settle } from "./settle";

const fail = (detail: string): ActionResult => ({ ok: false, detail });
const done = (detail: string): ActionResult => ({ ok: true, detail });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Labels of the dialogs currently on screen, for reporting what a click did. */
function openDialogs(): string[] {
  const found: string[] = [];
  for (const el of Array.from(
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]'),
  )) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const label =
      el.getAttribute("aria-label") ||
      (el as HTMLElement).innerText?.trim().split("\n")[0]?.slice(0, 60) ||
      "untitled";
    found.push(label);
  }
  return found;
}

interface KeyCombo { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }

/** "ctrl+shift+Enter" -> its parts. The last segment is the key itself. */
function parseKey(raw: string): KeyCombo {
  const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return {
    key: normaliseKey(key),
    ctrl: mods.has("ctrl") || mods.has("control"),
    shift: mods.has("shift"),
    alt: mods.has("alt") || mods.has("option"),
    meta: mods.has("meta") || mods.has("cmd") || mods.has("command"),
  };
}

/** Accepts the spellings a model reaches for and returns the DOM key name. */
function normaliseKey(key: string): string {
  const named: Record<string, string> = {
    enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab",
    space: " ", spacebar: " ", backspace: "Backspace", delete: "Delete", del: "Delete",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
    home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  };
  return named[key.toLowerCase()] ?? key;
}

function codeFor(key: string): string {
  if (key.length === 1 && /[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
  if (key.length === 1 && /[0-9]/.test(key)) return `Digit${key}`;
  if (key === " ") return "Space";
  return key;
}

function describeKey(c: KeyCombo): string {
  const mods = [c.ctrl && "ctrl", c.shift && "shift", c.alt && "alt", c.meta && "meta"].filter(Boolean);
  return [...mods, c.key === " " ? "Space" : c.key].join("+");
}

function describe(el: Element): string {
  const name = (el as HTMLElement).innerText?.trim().slice(0, 60);
  return `<${el.tagName.toLowerCase()}${name ? ` "${name}"` : ""}>`;
}

function resolve(input: Record<string, unknown>): Element | string {
  const id = input.element_id;
  if (typeof id !== "number") return "element_id must be a number";
  const el = capturedElement(id);
  if (!el) {
    return `No element ${id} on the current page. The page changed since the last read — call read_page and use the new ids.`;
  }
  return el;
}

async function bringIntoView(el: Element): Promise<void> {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  await sleep(60);
}

/**
 * Frameworks like React attach listeners for the full pointer sequence and
 * ignore a bare .click(). Replaying the real sequence makes the interaction
 * indistinguishable from a user's.
 */
function realClick(el: Element): void {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };

  (el as HTMLElement).focus?.({ preventScroll: true });
  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", base));
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.dispatchEvent(new MouseEvent("click", base));
}

/**
 * React tracks input values on the DOM node itself and swallows an `input`
 * event whose value it believes it already applied. Writing through the native
 * prototype setter bypasses that tracker.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

async function typeInto(el: Element, text: string, submit: boolean): Promise<ActionResult> {
  await bringIntoView(el);
  (el as HTMLElement).focus({ preventScroll: true });

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    setNativeValue(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.hasAttribute("contenteditable") || (el as HTMLElement).isContentEditable) {
    // Not `textContent = text`. Rich editors - Slack, Notion, Google Docs, and
    // a fair number of comment boxes - keep their own model of the document
    // and only update it from `beforeinput`/`input` events carrying real
    // InputEvent data. Overwriting the DOM underneath them leaves the editor
    // believing the field is empty, so the send goes out blank. Selecting the
    // contents and inserting through the editing command path fires exactly
    // the events a keyboard would.
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection?.removeAllRanges();
    selection?.addRange(range);

    let inserted = false;
    try {
      // Deprecated on paper, and still the one API that produces a full,
      // cancelable beforeinput/input pair the way typing does.
      inserted = document.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }

    if (!inserted || (el as HTMLElement).innerText.trim() !== text.trim()) {
      // The editor refused the command, or rewrote the result - fall back to a
      // direct write, with the events the first path would have produced.
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, inputType: "insertText", data: text,
      }));
      (el as HTMLElement).textContent = text;
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertText", data: text,
      }));
    }
  } else {
    return fail(`${describe(el)} is not a text field.`);
  }

  if (submit) {
    const enter = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    };
    // dispatchEvent returns false when a page handler called preventDefault —
    // that is our signal the page took the keypress and will submit itself.
    const handled = !el.dispatchEvent(new KeyboardEvent("keydown", enter));
    el.dispatchEvent(new KeyboardEvent("keyup", enter));
    // Plain forms ignore a synthetic Enter, so submit them directly instead.
    const form = (el as HTMLInputElement).form;
    if (!handled && form) form.requestSubmit?.();
    await settle();
  }

  // Deliberately not echoing the text.
  //
  // The planner supplied a token, which was resolved to the real value on its
  // way to the keystroke. Reporting that value back would put it straight into
  // the conversation and undo the tokenizing entirely - and the planner gains
  // nothing, since it already knows what it asked for and will see the field's
  // (tokenized) value in the next page read.
  return done(
    `Typed ${text.length} character(s) into ${describe(el)}${submit ? " and pressed Enter" : ""}.`,
  );
}

/**
 * Finds anything on the page matching a phrase, and says where it is.
 *
 * Searching only visible text nodes was too narrow to be useful. A form field
 * usually has no visible text at all - Gmail's recipient box is labelled
 * `aria-label="To recipients"` and renders as an empty line - so looking for it
 * returned nothing and the planner concluded the field did not exist.
 *
 * This searches what the capture actually holds: labels, values, placeholders
 * and text. It also reports the element id, without which a hit cannot be acted
 * on and the planner has to go back and read the whole page anyway.
 */
function findText(query: string): ActionResult {
  const needle = query.trim().toLowerCase();
  if (!needle) return fail("Give me something to look for.");

  // Search the last capture, never a fresh one: capturing again reassigns
  // every id, so the ids reported here would not be the ids the planner holds
  // and acting on one would be refused.
  const capture = lastCapture() ?? captureDom();
  const hits: string[] = [];

  for (const node of walkCapture(capture.root)) {
    if (hits.length >= 12) break;

    const haystacks: [string, string][] = [
      ["label", node.label],
      ["value", node.value ?? ""],
      ["text", node.text ?? ""],
      ["placeholder", node.attrs.placeholder ?? ""],
      ["aria-label", node.attrs["aria-label"] ?? ""],
      ["title", node.attrs.title ?? ""],
    ];

    const match = haystacks.find(([, value]) => value.toLowerCase().includes(needle));
    if (!match) continue;

    const where = match[1].length > 90 ? `${match[1].slice(0, 90)}…` : match[1];
    hits.push(
      `[${node.id}] ${node.role}${node.visible ? "" : " (offscreen)"} ` +
        `${match[0]}=${JSON.stringify(where)}`,
    );
  }

  if (hits.length === 0) {
    return fail(
      `Nothing on this page matches ${JSON.stringify(query)} — not in any label, value, ` +
        `placeholder or visible text. The element may not exist yet, or may be inside a ` +
        `frame this extension cannot read.`,
    );
  }

  return done(`Found ${hits.length} match(es). Act on these by id:\n${hits.join("\n")}`);
}

/** Executes one action in the page. Never throws — errors come back as results. */
export async function act(action: AgentAction): Promise<ActionResult> {
  const { name, input } = action;

  try {
    switch (name) {
      case "click": {
        const el = resolve(input);
        if (typeof el === "string") return fail(el);
        await bringIntoView(el);
        const before = document.documentElement.childElementCount;
        const dialogsBefore = openDialogs();
        realClick(el);
        // A click gets the long grace: a dialog that mounts late is the whole
        // reason this waits on the page at all.
        await settle({ start: CLICK_START, ceiling: 4000 });

        // Say what the click *did*, not merely that it happened. A planner told
        // only "Clicked <div>" has to re-read the page to find out whether
        // anything changed, and if the read is ambiguous it assumes the worst
        // and clicks again. Naming a new dialog ends that guessing.
        const opened = openDialogs().filter((d) => !dialogsBefore.includes(d));
        const changed = document.documentElement.childElementCount !== before;
        const note = opened.length > 0
          ? ` A dialog opened: ${opened.map((d) => JSON.stringify(d)).join(", ")}.`
          : changed
            ? " The page changed."
            : "";
        return done(`Clicked ${describe(el)}.${note}`);
      }

      case "type": {
        const el = resolve(input);
        if (typeof el === "string") return fail(el);
        const text = typeof input.text === "string" ? input.text : "";
        return await typeInto(el, text, input.submit === true);
      }

      case "select": {
        const el = resolve(input);
        if (typeof el === "string") return fail(el);
        if (!(el instanceof HTMLSelectElement)) {
          return fail(`${describe(el)} is not a <select>.`);
        }
        const wanted = String(input.option ?? "");
        const match = Array.from(el.options).find(
          (o) =>
            o.value === wanted ||
            o.textContent?.trim().toLowerCase() === wanted.toLowerCase(),
        );
        if (!match) {
          const available = Array.from(el.options)
            .map((o) => o.textContent?.trim())
            .filter(Boolean)
            .slice(0, 20)
            .join(", ");
          return fail(`No option ${JSON.stringify(wanted)}. Available: ${available}`);
        }
        el.value = match.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return done(`Selected ${JSON.stringify(match.textContent?.trim())}.`);
      }

      case "scroll": {
        const up = input.direction === "up";
        const direction = up ? -1 : 1;
        const amount = typeof input.amount === "number" ? input.amount : innerHeight * 0.8;

        // Not `scrollBy` on the window: an application shell keeps the window
        // pinned at zero and scrolls a panel inside it, so scrolling the window
        // moved nothing while reporting "y=0 (bottom of page)" in both
        // directions at once. The planner, told it had reached the end of a
        // page it had never moved, went round in circles.
        const at = scrollByPixels(direction * amount);
        // Lazy lists render on scroll; wait for the new rows, not a fixed delay.
        await settle();

        if (!at.moved) {
          return done(
            `Nothing scrolled — already at the ${up ? "top" : "bottom"} of ` +
              `${at.inner ? "this panel" : "the page"}.`,
          );
        }

        const edge = up
          ? at.atTop
            ? " (top)"
            : ""
          : at.atBottom
            ? " (bottom)"
            : "";
        return done(
          `Scrolled ${up ? "up" : "down"} to y=${at.scrollY} of ${at.pageHeight}${edge}.`,
        );
      }

      case "key": {
        const combo = parseKey(String(input.key ?? ""));
        if (!combo.key) return fail("No key given.");
        const target = (document.activeElement ?? document.body) as HTMLElement;
        const init: KeyboardEventInit = {
          bubbles: true,
          cancelable: true,
          key: combo.key,
          code: codeFor(combo.key),
          ctrlKey: combo.ctrl,
          shiftKey: combo.shift,
          altKey: combo.alt,
          metaKey: combo.meta,
        };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keypress", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));

        // A synthetic Escape does not close a native <dialog>, and a synthetic
        // ctrl+a does not select - the browser only honours its own trusted
        // events. Do the two that matter by hand so the shortcut actually works.
        if (combo.key === "Escape") {
          document.querySelector<HTMLDialogElement>("dialog[open]")?.close();
        }
        if (combo.key.toLowerCase() === "a" && (combo.ctrl || combo.meta)) {
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            target.select();
          } else if (target.isContentEditable) {
            const range = document.createRange();
            range.selectNodeContents(target);
            getSelection()?.removeAllRanges();
            getSelection()?.addRange(range);
          }
        }

        await settle();
        return done(`Pressed ${describeKey(combo)}.`);
      }

      case "find_text":
        return findText(String(input.query ?? ""));

      case "wait": {
        const ms = Math.min(Number(input.ms ?? 1000), 10000);
        await sleep(ms);
        return done(`Waited ${ms}ms.`);
      }

      case "read_page":
        return { ok: true, detail: "Read the page.", capture: captureDom() };

      default:
        return fail(`Action ${name} is not handled in the page context.`);
    }
  } catch (error) {
    return fail(`${name} threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

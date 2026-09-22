import type { ActionResult, AgentAction } from "../shared/types";
import { capturedElement, captureDom, lastCapture, liveGeneration, walkCapture } from "../capture/dom";
import { scrollByPixels } from "../capture/scroller";
import { CLICK_START, settle } from "./settle";
import { parseKey, type KeyCombo } from "../shared/keys";
import { fitToField } from "./fit";

const fail = (detail: string, summary?: string): ActionResult => ({ ok: false, detail, summary });
const done = (detail: string, summary?: string): ActionResult => ({ ok: true, detail, summary });

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

function codeFor(key: string): string {
  if (key.length === 1 && /[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
  if (key.length === 1 && /[0-9]/.test(key)) return `Digit${key}`;
  if (key === " ") return "Space";
  return key;
}

/** Reports whether the DOM changed between the call and the check. */
function watchChanges(): () => boolean {
  let changed = false;
  const observer = new MutationObserver(() => { changed = true; });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true,
  });
  return () => {
    observer.disconnect();
    return changed;
  };
}

const TEXT_INPUT_TYPES = new Set([
  "text", "search", "email", "url", "tel", "password", "number", "",
]);

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type));
}

/** Controls a native Enter or Space activates, exactly as the browser defines them. */
function nativelyActivated(el: Element, key: string): boolean {
  if (el.matches(":disabled")) return false;
  if (el instanceof HTMLButtonElement || el.tagName === "SUMMARY") return true;
  if (el instanceof HTMLInputElement) {
    if (["submit", "button", "reset", "image"].includes(el.type)) return true;
    // Space toggles a checkbox or radio; Enter does not.
    return key === " " && (el.type === "checkbox" || el.type === "radio");
  }
  // Enter follows a link; Space scrolls the page instead.
  return key === "Enter" && el instanceof HTMLAnchorElement && el.hasAttribute("href");
}

/** Sequential focus order, the way Tab walks it. */
function focusables(): HTMLElement[] {
  const all = Array.from(document.querySelectorAll<HTMLElement>(
    "a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable=''], [contenteditable=true]",
  )).filter((el) => {
    if (el.matches(":disabled") || el.tabIndex < 0) return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && el.getClientRects().length > 0;
  });
  // Positive tabindex first, in order; then everything else in document order.
  const positive = all.filter((el) => el.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
  return [...positive, ...all.filter((el) => el.tabIndex === 0)];
}

/** Inserts text at the caret, as typing would. */
function insertAtCaret(el: HTMLElement, text: string): boolean {
  if (isTextField(el)) {
    if (el.readOnly || el.disabled) return false;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    setNativeValue(el, next);
    try { el.setSelectionRange(start + text.length, start + text.length); } catch { /* number inputs */ }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return true;
  }
  if (el.isContentEditable) {
    try {
      return document.execCommand(text === "\n" ? "insertParagraph" : "insertText", false, text);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * What the browser itself does for a key nobody handled.
 *
 * Only the browser's native behaviour is reproduced - never a guess at what an
 * application's custom widget would do. A div with role="button" is activated
 * by the page's own key handler, which has already run; clicking it here as
 * well would press it twice. Returns what happened, or null for nothing.
 */
function nativeKeyAction(el: HTMLElement, combo: KeyCombo): string | null {
  const { key } = combo;
  const modified = combo.ctrl || combo.meta || combo.alt;

  if (key === "Escape") {
    // A native <dialog> ignores a dispatched Escape.
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (dialog) { dialog.close(); return "closed the dialog"; }
    return null;
  }

  if (key.toLowerCase() === "a" && (combo.ctrl || combo.meta) && !combo.alt) {
    if (isTextField(el)) { el.select(); return "selected the field's text"; }
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      return "selected the text";
    }
    return null;
  }

  if (modified) return null;

  if (key === "Tab") {
    const order = focusables();
    if (order.length === 0) return null;
    const at = order.indexOf(el);
    const next = combo.shift
      ? order[at <= 0 ? order.length - 1 : at - 1]
      : order[at < 0 || at === order.length - 1 ? 0 : at + 1];
    next.focus();
    return `focus moved to ${describe(next)}`;
  }

  if ((key === "Enter" || key === " ") && nativelyActivated(el, key)) {
    realClick(el);
    return `activated ${describe(el)}`;
  }

  if (key === "Enter") {
    if (el instanceof HTMLTextAreaElement || (el.isContentEditable && !isTextField(el))) {
      return insertAtCaret(el, "\n") ? "started a new line" : null;
    }
    if (el instanceof HTMLInputElement && el.form) {
      // Implicit submission: what Enter in a single-line field does.
      el.form.requestSubmit();
      return "submitted the form";
    }
    return null;
  }

  if (key === "Backspace" || key === "Delete") {
    if (isTextField(el) && !el.readOnly && !el.disabled) {
      let start = el.selectionStart ?? el.value.length;
      let end = el.selectionEnd ?? el.value.length;
      if (start === end) {
        if (key === "Backspace") start = Math.max(0, start - 1);
        else end = Math.min(el.value.length, end + 1);
      }
      if (start === end) return null;
      setNativeValue(el, el.value.slice(0, start) + el.value.slice(end));
      try { el.setSelectionRange(start, start); } catch { /* number inputs */ }
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: key === "Backspace" ? "deleteContentBackward" : "deleteContentForward",
      }));
      return "deleted a character";
    }
    if (el.isContentEditable) {
      try {
        return document.execCommand(key === "Backspace" ? "delete" : "forwardDelete")
          ? "deleted a character" : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  // A printable character typed into a field.
  if ([...key].length === 1) {
    return insertAtCaret(el, key) ? `typed ${JSON.stringify(key)}` : null;
  }

  return null;
}

function describeKey(c: KeyCombo): string {
  const mods = [c.ctrl && "ctrl", c.shift && "shift", c.alt && "alt", c.meta && "meta"].filter(Boolean);
  return [...mods, c.key === " " ? "Space" : c.key].join("+");
}

function describe(el: Element): string {
  const name = (el as HTMLElement).innerText?.trim().slice(0, 60);
  return `<${el.tagName.toLowerCase()}${name ? ` "${name}"` : ""}>`;
}

/**
 * What a person would call this element.
 *
 * `describe` answers the model - a tag name and whatever text is inside, which
 * on a real page is often four merged labels and reads like a stack trace. A
 * viewer needs the name on the control and the kind of thing it is.
 */
function humanName(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const kind =
    tag === "a" ? "link"
    : tag === "button" ? "button"
    : tag === "select" ? "dropdown"
    : tag === "textarea" || tag === "input" ? "field"
    : el.getAttribute("role") === "button" ? "button"
    : "";

  const inner = (el as HTMLElement).innerText?.trim().replace(/\s+/g, " ") ?? "";
  const name = (
    el.getAttribute("aria-label")?.trim() ||
    // Long inner text means the element wraps half the page, not that it is
    // called that; a control's own name is short.
    (inner.length > 0 && inner.length <= 40 ? inner : "") ||
    (el as HTMLInputElement).placeholder?.trim() ||
    el.getAttribute("title")?.trim() ||
    ""
  ).replace(/\s+/g, " ").slice(0, 40);

  if (name && kind) return `the "${name}" ${kind}`;
  if (name) return `"${name}"`;
  return kind ? `a ${kind}` : "that element";
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function resolve(input: Record<string, unknown>, generation?: number): Element | string {
  const id = input.element_id;
  if (typeof id !== "number") return "element_id must be a number";
  if (generation !== undefined && generation !== liveGeneration()) {
    // The ids were read from a capture whose registry has since been rebuilt.
    // Resolving this one anyway would hit whatever holds that number now.
    return `Element ids from that page read are no longer valid - the page was read again since. ` +
      `Call read_page and use the new ids.`;
  }
  const el = capturedElement(id, generation);
  if (!el) {
    return `No element ${id} on the current page. The page changed since the last read — call read_page and use the new ids.`;
  }
  return el;
}

const INTERACTIVE =
  "button, a[href], input, select, textarea, option, summary, [role=button], [role=link], " +
  "[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=option], " +
  "[role=checkbox], [role=radio], [role=switch], [role=textbox], [role=combobox], [role=treeitem]";

/**
 * Whether a person could operate this control at all.
 *
 * The page is driven by dispatched events, and a dispatched event does not ask
 * permission: a `click` sent to a disabled button still reaches its listeners,
 * and the native value setter writes straight through `readonly`. So the agent
 * could press a Submit the page had deliberately greyed out, or overwrite an
 * invoice number the page had locked, and report both as done. A user can do
 * neither, and neither may the agent.
 *
 * The check walks up to the control the element belongs to, because the id the
 * planner holds is often a label or icon inside the button rather than the
 * button itself.
 */
function disabledControl(el: Element): Element | null {
  const control = el.closest(INTERACTIVE) ?? el;
  const native = el.closest("button, input, select, textarea, option, optgroup");
  if (native?.matches(":disabled")) return native;
  if (el.getAttribute("aria-disabled") === "true") return el;
  if (control.getAttribute("aria-disabled") === "true") return control;
  return null;
}

function unwritable(el: Element): string | null {
  const locked = disabledControl(el);
  if (locked) return "disabled";
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly) {
    return "read-only";
  }
  if (el.getAttribute("aria-readonly") === "true") return "read-only";
  return null;
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

/**
 * Inputs whose `value` is not what a person types. Writing to a checkbox's
 * value does not tick it - it silently changes what the form submits for it.
 */
const NOT_TYPED_INTO = new Set(["checkbox", "radio", "submit", "button", "reset", "image", "file", "hidden"]);

function fieldLabel(el: HTMLInputElement | HTMLTextAreaElement): string {
  return [
    el.getAttribute("aria-label"),
    ...Array.from(el.labels ?? []).map((l) => l.textContent),
    el.placeholder,
    el.name,
    el.id,
    el.autocomplete,
  ].filter(Boolean).join(" ");
}

async function typeInto(el: Element, text: string, submit: boolean): Promise<ActionResult> {
  let note = "";

  if (el instanceof HTMLInputElement && NOT_TYPED_INTO.has(el.type)) {
    return fail(
      `${describe(el)} is a ${el.type} input, not a text field - nothing was typed. ` +
        (el.type === "checkbox" || el.type === "radio" ? "Click it to change it." : "Click it instead."),
      `${capitalise(humanName(el))} isn't something you type into.`,
    );
  }

  await bringIntoView(el);
  (el as HTMLElement).focus({ preventScroll: true });

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const fitted = fitToField(text, {
      type: el instanceof HTMLTextAreaElement ? "textarea" : el.type,
      maxLength: el.maxLength,
      inputMode: el.inputMode,
      label: fieldLabel(el),
    });
    if (!fitted.ok) {
      return fail(`${describe(el)}: ${fitted.reason}`,
        `${capitalise(humanName(el))} needs the value in a different form.`);
    }
    const value = fitted.value;

    setNativeValue(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    setNativeValue(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    // Read it back. A browser drops a value its input type cannot hold, and
    // a page can refuse one in its input handler - either way the field is
    // empty, and "typed" would be false.
    if (value.trim() !== "" && el.value === "") {
      return fail(
        `${describe(el)} is still empty - the ${el instanceof HTMLInputElement ? `${el.type} ` : ""}field ` +
          `did not accept that text. Check the format it expects (its placeholder or label) and try again.`,
        `${capitalise(humanName(el))} didn't accept that.`,
      );
    }
    if (fitted.note) note = ` It was ${fitted.note}.`;
    else if (el.value !== value) note = " The page reformatted it as it went in.";
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
    return fail(`${describe(el)} is not a text field.`,
      `${capitalise(humanName(el))} is not something you can type into.`);
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
    `Typed ${text.length} character(s) into ${describe(el)}${submit ? " and pressed Enter" : ""}.${note}`,
    // The text itself is deliberately never echoed - see the note above - so
    // the sentence names the field rather than what went into it.
    `Filled in ${humanName(el)}${submit ? " and pressed Enter" : ""}.`,
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
      `Nothing on this page matches "${query}".`,
    );
  }

  // The id list is the whole point of this result for the planner, and noise
  // for anyone watching.
  return done(
    `Found ${hits.length} match(es). Act on these by id:\n${hits.join("\n")}`,
    `Found ${hits.length} match${hits.length === 1 ? "" : "es"} for "${query}".`,
  );
}

/** Executes one action in the page. Never throws — errors come back as results. */
export async function act(action: AgentAction, generation?: number): Promise<ActionResult> {
  const { name, input } = action;

  try {
    switch (name) {
      case "click": {
        const el = resolve(input, generation);
        if (typeof el === "string") return fail(el);
        const locked = disabledControl(el);
        if (locked) {
          return fail(
            `${describe(locked)} is disabled - clicking it does nothing for a real user, so it was not clicked. ` +
              `Something else on the page has to be done first: usually a required field, a checkbox, ` +
              `or a choice further up. Read the page to find it.`,
            `${capitalise(humanName(locked))} is greyed out, so it can't be pressed yet.`,
          );
        }
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
        return done(
          `Clicked ${describe(el)}.${note}`,
          `Clicked ${humanName(el)}.` +
            (opened.length > 0 ? ` ${opened[0]} opened.` : ""),
        );
      }

      case "type": {
        const el = resolve(input, generation);
        if (typeof el === "string") return fail(el);
        const text = typeof input.text === "string" ? input.text : "";
        const why = unwritable(el);
        if (why) {
          return fail(
            `${describe(el)} is ${why} - nothing was typed. ` +
              (why === "read-only"
                ? `A read-only field is usually filled by the page itself, or by a picker that opens when it is clicked.`
                : `Something else on the page has to be done first before this field accepts input.`),
            `${capitalise(humanName(el))} can't be edited${why === "disabled" ? " yet" : ""}.`,
          );
        }
        return await typeInto(el, text, input.submit === true);
      }

      case "select": {
        const el = resolve(input, generation);
        if (typeof el === "string") return fail(el);
        if (!(el instanceof HTMLSelectElement)) {
          return fail(`${describe(el)} is not a <select>.`,
            `${capitalise(humanName(el))} is not a dropdown.`);
        }
        if (el.matches(":disabled")) {
          return fail(`${describe(el)} is disabled - nothing was selected.`,
            `${capitalise(humanName(el))} is greyed out, so it can't be changed yet.`);
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
          return fail(`No option ${JSON.stringify(wanted)}. Available: ${available}`,
            `No option called "${wanted}" in that dropdown.`);
        }
        if (match.disabled || match.parentElement?.matches("optgroup:disabled")) {
          return fail(`The option ${JSON.stringify(match.textContent?.trim())} is disabled - it cannot be chosen.`,
            `"${match.textContent?.trim()}" isn't available in that dropdown.`);
        }
        el.value = match.value;
        // A person's choice fires both, input first; some frameworks listen
        // only for input.
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return done(`Selected ${JSON.stringify(match.textContent?.trim())}.`,
          `Chose "${match.textContent?.trim()}".`);
      }

      case "scroll": {
        const up = input.direction === "up";
        const direction = up ? -1 : 1;
        // Direction comes from `direction` alone. A negative amount used to
        // reverse it silently: "down" by -500 scrolled up, found the top, and
        // reported "already at the bottom" - a false edge the planner trusted.
        const given = typeof input.amount === "number" && Number.isFinite(input.amount)
          ? Math.abs(input.amount)
          : 0;
        const amount = given > 0 ? given : innerHeight * 0.8;

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
            `Already at the ${up ? "top" : "bottom"}.`,
          );
        }

        const edge = up
          ? at.atTop
            ? " (top)"
            : ""
          : at.atBottom
            ? " (bottom)"
            : "";
        // The planner needs the offset to know how much page is left; a viewer
        // needs to know it moved, and whether it has run out of page.
        const reached = up ? at.atTop : at.atBottom;
        return done(
          `Scrolled ${up ? "up" : "down"} to y=${at.scrollY} of ${at.pageHeight}${edge}.`,
          `Scrolled ${up ? "up" : "down"}${reached ? ` to the ${up ? "top" : "bottom"}` : ""}.`,
        );
      }

      case "key": {
        const combo = parseKey(String(input.key ?? ""));
        if (!combo.key) return fail("No key given.");
        let target = (document.activeElement ?? document.body) as HTMLElement;
        while (target.shadowRoot?.activeElement) target = target.shadowRoot.activeElement as HTMLElement;
        const init: KeyboardEventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          key: combo.key,
          code: codeFor(combo.key),
          ctrlKey: combo.ctrl,
          shiftKey: combo.shift,
          altKey: combo.alt,
          metaKey: combo.meta,
        };

        const changes = watchChanges();
        // A handler that calls preventDefault has taken the key - a chat box
        // sending on Enter, a list moving its selection - and the browser's own
        // action must not happen on top of it, or the message goes twice.
        const taken =
          !target.dispatchEvent(new KeyboardEvent("keydown", init)) ||
          !target.dispatchEvent(new KeyboardEvent("keypress", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));

        // The browser only performs a key's own action for keys a person
        // pressed; for a dispatched event it does nothing at all. Enter did
        // not submit, Tab did not move focus, a letter did not type - and every
        // one was reported as "Pressed". Do what the browser would have done.
        const effect = taken ? "the page handled it" : nativeKeyAction(target, combo);

        await settle();
        const changed = changes();
        const what = effect ?? (changed ? "the page changed" : "nothing on the page reacted");
        return done(
          `Pressed ${describeKey(combo)} on ${target === document.body ? "the page" : describe(target)} - ${what}.`,
          `Pressed ${describeKey(combo)}.`,
        );
      }

      case "find_text":
        return findText(String(input.query ?? ""));

      case "wait": {
        const ms = Math.min(Number(input.ms ?? 1000), 10000);
        await sleep(ms);
        return done(`Waited ${ms}ms.`, "Waited for the page.");
      }

      case "read_page":
        return { ok: true, detail: "Read the page.", capture: captureDom() };

      default:
        return fail(`Action ${name} is not handled in the page context.`,
          "That action isn't available on this page.");
    }
  } catch (error) {
    return fail(`${name} threw: ${error instanceof Error ? error.message : String(error)}`,
      "That didn't work on this page.");
  }
}

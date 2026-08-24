import type { PageElement, PageSnapshot } from "../shared/types";

/**
 * Elements from the last snapshot, indexed by the id handed to the planner.
 * Rebuilt on every snapshot — an id is only valid against the snapshot that
 * produced it, which is why the service worker re-perceives after every action.
 */
let registry: Element[] = [];

const MAX_ELEMENTS = 220;
const MAX_NAME = 120;
const MAX_TEXT = 6000;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable=''],[contenteditable=true]",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=switch]",
  "[role=combobox]",
  "[role=searchbox]",
  "[role=textbox]",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  if (Number(style.opacity) < 0.05) return false;
  return true;
}

function clean(value: string | null | undefined): string {
  if (!value) return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_NAME
    ? `${collapsed.slice(0, MAX_NAME)}…`
    : collapsed;
}

/**
 * Approximates the accessible-name algorithm. Full ARIA name computation is
 * overkill here — these five sources cover what a planner needs to tell two
 * controls apart.
 */
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (clean(parts)) return clean(parts);
  }

  const ariaLabel = clean(el.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const text = clean(labels[0].textContent);
      if (text) return text;
    }
    const placeholder = clean(el.getAttribute("placeholder"));
    if (placeholder) return placeholder;
  }

  if (el instanceof HTMLImageElement) {
    const alt = clean(el.alt);
    if (alt) return alt;
  }

  const text = clean((el as HTMLElement).innerText ?? el.textContent);
  if (text) return text;

  return clean(el.getAttribute("title") || el.getAttribute("name"));
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type === "checkbox" || type === "radio" || type === "submit") return type;
    if (type === "password") return "password";
    return "textbox";
  }
  if (el.hasAttribute("contenteditable")) return "textbox";
  return tag;
}

function attributesOf(el: Element): Record<string, string> | undefined {
  const attrs: Record<string, string> = {};

  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") {
      attrs.checked = String(el.checked);
    }
    if (el.required) attrs.required = "true";
    attrs.inputType = el.type;
  }

  if ((el as HTMLElement & { disabled?: boolean }).disabled) {
    attrs.disabled = "true";
  }

  const expanded = el.getAttribute("aria-expanded");
  if (expanded) attrs.expanded = expanded;

  const selected = el.getAttribute("aria-selected");
  if (selected) attrs.selected = selected;

  if (el instanceof HTMLAnchorElement && el.href) {
    try {
      const url = new URL(el.href);
      // Host only, plus a short path hint — full URLs blow up the snapshot and
      // rarely help the planner choose between links.
      attrs.href = url.host + (url.pathname === "/" ? "" : url.pathname.slice(0, 40));
    } catch {
      /* javascript: and mailto: hrefs are not worth reporting */
    }
  }

  const rect = el.getBoundingClientRect();
  const inViewport = rect.top < innerHeight && rect.bottom > 0;
  if (!inViewport) attrs.offscreen = "true";

  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function valueOf(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    // Never read back a password field's contents.
    if (el.type === "password") return el.value ? "••••••" : "";
    if (el.type === "checkbox" || el.type === "radio") return undefined;
    return clean(el.value);
  }
  if (el instanceof HTMLTextAreaElement) return clean(el.value);
  if (el instanceof HTMLSelectElement) {
    return clean(el.selectedOptions[0]?.textContent ?? el.value);
  }
  return undefined;
}

/** Visible text of the main content area, for questions the DOM skeleton can't answer. */
function pageText(): string {
  const main =
    document.querySelector("main") ??
    document.querySelector("[role=main]") ??
    document.querySelector("article") ??
    document.body;
  const text = clean((main as HTMLElement).innerText ?? "");
  // clean() truncates at MAX_NAME, so re-derive from the raw string instead.
  const raw = ((main as HTMLElement).innerText ?? "").replace(/\s*\n\s*/g, "\n").trim();
  return raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}\n…[truncated]` : raw || text;
}

/**
 * Builds a fresh snapshot and resets the element registry. Elements inside the
 * viewport are listed first so that the planner sees what the user sees before
 * it sees the rest of the page.
 */
export function snapshot(): PageSnapshot {
  registry = [];
  const elements: PageElement[] = [];

  const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))
    .filter(isVisible)
    .sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const aVisible = ra.top < innerHeight && ra.bottom > 0 ? 0 : 1;
      const bVisible = rb.top < innerHeight && rb.bottom > 0 ? 0 : 1;
      if (aVisible !== bVisible) return aVisible - bVisible;
      return ra.top - rb.top || ra.left - rb.left;
    });

  for (const el of candidates) {
    if (elements.length >= MAX_ELEMENTS) break;
    const name = accessibleName(el);
    const role = roleOf(el);
    const value = valueOf(el);
    // A nameless, valueless div with a tabindex is noise, not a control.
    if (!name && !value && role !== "textbox" && role !== "select") continue;

    const id = registry.push(el) - 1;
    elements.push({ id, role, name, value, attrs: attributesOf(el) });
  }

  return {
    url: location.href,
    title: document.title,
    elements,
    text: pageText(),
    truncated: candidates.length > elements.length,
    scroll: {
      y: Math.round(scrollY),
      maxY: Math.max(0, Math.round(document.body.scrollHeight - innerHeight)),
    },
  };
}

/** Resolves a planner-issued element id against the current registry. */
export function lookup(id: number): Element | undefined {
  const el = registry[id];
  // The node may have been detached by a re-render since the snapshot.
  if (!el || !el.isConnected) return undefined;
  return el;
}

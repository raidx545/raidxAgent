import type { BBox, CapturedNode, DomCapture } from "./types";

/**
 * Attributes worth keeping. These are the ones that say what a field is *for*
 * — which is the cheapest and most reliable PII signal on the page, far better
 * than pattern-matching whatever the user has typed so far.
 */
const KEPT_ATTRS = [
  "type",
  "name",
  "id",
  "autocomplete",
  "inputmode",
  "placeholder",
  "pattern",
  "maxlength",
  "alt",
  "title",
  "aria-label",
  "data-testid",
  // Microdata names the entity outright - the most reliable name signal a page
  // can give, and free to read.
  "itemprop",
  "itemtype",
  "rel",
  "datetime",
  // Identity annotations that real applications put on the elements showing a
  // person. Gmail, Outlook, Slack, LinkedIn and Jira all do some version of
  // this, and it is by far the most reliable name signal such a page offers -
  // far better than trying to infer a name from a list of subject lines.
  //
  // Capturing these puts real addresses into the tree, so they are scanned and
  // tokenized like any other text. Reading them without that would be adding a
  // leak while closing one.
  "email",
  "data-email",
  "data-hovercard-id",
  "data-name",
  "data-user-name",
  "data-sender",
];

const MEDIA_TAGS = new Set(["img", "canvas", "svg", "video", "picture", "object", "embed"]);

/**
 * Regions rendered by something we cannot read. A cross-origin iframe paints
 * into the screenshot but contributes nothing to our DOM tree, so PII inside
 * one is invisible to every text detector while still being fully visible in
 * the pixels. They are captured here so the pixel tier can decide what to do.
 */
const OPAQUE_TAGS = new Set(["iframe", "frame", "object", "embed"]);

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  "form",
]);

const LANDMARK_ROLES = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "form",
  "search",
  "dialog",
  "table",
  "list",
]);

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "meta", "link"]);

let examined = 0;
let pruned = 0;

/**
 * Live elements from the last capture, indexed by the node id in the tree.
 *
 * Detection runs elsewhere and comes back asking "where on screen is the text
 * at characters 12-34 of node 87?". Answering that needs the real element, so
 * the capture keeps a registry alongside the serialisable tree.
 */
let registry: Element[] = [];

/** Elements collected during a walk, paired with their node before ids exist. */
let pending = new WeakMap<CapturedNode, Element>();

function collapse(value: string | null | undefined, limit = 300): string {
  if (!value) return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textbox";
  if (tag === "img") return "image";
  if (tag === "form") return "form";
  if (tag === "iframe" || tag === "frame") return "frame";
  if (tag === "address") return "address";
  if (tag === "table") return "table";
  if (tag === "main") return "main";
  if (tag === "nav") return "navigation";
  if (tag === "header") return "banner";
  if (tag === "footer") return "contentinfo";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "input") {
    const type = (el as HTMLInputElement).type;
    if (type === "password") return "password";
    if (type === "checkbox" || type === "radio" || type === "submit") return type;
    if (type === "file") return "file";
    return "textbox";
  }
  if (el.hasAttribute("contenteditable")) return "textbox";
  return tag;
}

function labelOf(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const joined = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (collapse(joined)) return collapse(joined, 120);
  }

  const ariaLabel = collapse(el.getAttribute("aria-label"), 120);
  if (ariaLabel) return ariaLabel;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const text = collapse(labels[0].textContent, 120);
      if (text) return text;
    }
    const placeholder = collapse(el.getAttribute("placeholder"), 120);
    if (placeholder) return placeholder;
  }

  if (el instanceof HTMLImageElement) {
    const alt = collapse(el.alt, 120);
    if (alt) return alt;
  }

  return collapse(el.getAttribute("title"), 120);
}

/**
 * Text belonging to this element directly, excluding descendants' text.
 *
 * The result is whitespace-collapsed and truncated, which means a character
 * offset into it does *not* line up with any offset in the DOM. `ownTextMap`
 * builds the translation, and both must stay in step - so they share one walk.
 */
function ownText(el: Element): string {
  return ownTextMap(el).text;
}

/** One collapsed character, and where in the DOM it came from. */
interface CharSource {
  node: Text;
  offset: number;
}

/**
 * Builds this element's own text together with a per-character index back into
 * the DOM, so a span found in the collapsed string can be turned into a Range
 * and measured on screen.
 */
function ownTextMap(el: Element): { text: string; sources: CharSource[] } {
  let raw = "";
  const rawSources: CharSource[] = [];

  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node.textContent ?? "";
    for (let i = 0; i < text.length; i++) {
      raw += text[i];
      rawSources.push({ node: node as Text, offset: i });
    }
  }

  // Mirror collapse(): runs of whitespace become one space, then trim.
  let collapsed = "";
  const sources: CharSource[] = [];
  let inSpace = false;

  for (let i = 0; i < raw.length; i++) {
    const isSpace = /\s/.test(raw[i]);
    if (isSpace) {
      if (inSpace || collapsed.length === 0) continue;
      inSpace = true;
      collapsed += " ";
      sources.push(rawSources[i]);
      continue;
    }
    inSpace = false;
    collapsed += raw[i];
    sources.push(rawSources[i]);
  }

  // Trailing space from the trim.
  while (collapsed.endsWith(" ")) {
    collapsed = collapsed.slice(0, -1);
    sources.pop();
  }

  if (collapsed.length > 600) {
    collapsed = collapsed.slice(0, 600) + "\u2026";
    sources.length = 600;
  }

  return { text: collapsed, sources };
}

function valueOf(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    // A password's contents are never captured, not even to be tokenized —
    // the fact that the field exists is the finding.
    if (el.type === "password") return undefined;
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "checked" : undefined;
    return collapse(el.value, 300) || undefined;
  }
  if (el instanceof HTMLTextAreaElement) return collapse(el.value, 600) || undefined;
  if (el instanceof HTMLSelectElement) {
    return collapse(el.selectedOptions[0]?.textContent ?? el.value, 120) || undefined;
  }
  if (el.hasAttribute("contenteditable")) {
    return collapse((el as HTMLElement).innerText, 600) || undefined;
  }
  return undefined;
}

function attrsOf(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const name of KEPT_ATTRS) {
    const value = el.getAttribute(name);
    if (value) attrs[name] = collapse(value, 120);
  }

  if (el instanceof HTMLImageElement && el.currentSrc) {
    try {
      const url = new URL(el.currentSrc, location.href);
      // Host and extension only — image URLs frequently embed user ids.
      attrs.srcHost = url.protocol === "data:" ? "data:" : url.host;
    } catch {
      /* malformed src is not worth reporting */
    }
    attrs.naturalSize = `${el.naturalWidth}x${el.naturalHeight}`;
  }

  if (el instanceof HTMLAnchorElement && el.href) {
    try {
      attrs.hrefHost = new URL(el.href).host;
    } catch {
      /* javascript: and mailto: hrefs have no host */
    }
  }

  if (el instanceof HTMLIFrameElement) {
    try {
      const url = new URL(el.src || "about:blank", location.href);
      attrs.frameHost = url.host || url.protocol;
      // Same-origin frames could in principle be walked; cross-origin ones
      // never can. Recording which is which keeps the pixel tier honest.
      attrs.crossOrigin = String(url.origin !== location.origin && url.protocol !== "about:");
    } catch {
      attrs.frameHost = "unknown";
      attrs.crossOrigin = "true";
    }
  }

  // For fields whose contents we refuse to read, record only whether anything
  // is in them. One bit, no secret: enough for the planner to know the field is
  // already filled, and not enough to be worth stealing. The length is
  // deliberately not recorded - a password's length is itself a hint.
  if (el instanceof HTMLInputElement && el.type === "password") {
    attrs.filled = String(el.value.length > 0);
  }

  if ((el as HTMLElement & { disabled?: boolean }).disabled) attrs.disabled = "true";
  if (el instanceof HTMLInputElement && el.readOnly) attrs.readonly = "true";

  return attrs;
}

function boxOf(el: Element): BBox {
  const rect = el.getBoundingClientRect();
  return [
    Math.round(rect.left * 10) / 10,
    Math.round(rect.top * 10) / 10,
    Math.round(rect.width * 10) / 10,
    Math.round(rect.height * 10) / 10,
  ];
}

function isRendered(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/**
 * Is this node worth a place in the tree on its own merits? Layout wrappers are
 * not — they get pruned and their children hoisted, which is what keeps the
 * tree small enough to reason about.
 */
function isSignificant(el: Element, node: CapturedNode): boolean {
  const tag = node.tag;
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (MEDIA_TAGS.has(tag)) return true;
  if (OPAQUE_TAGS.has(tag)) return true;
  if (tag === "address") return true;
  if (LANDMARK_ROLES.has(node.role)) return true;
  if (node.role === "heading") return true;
  if (node.text) return true;
  if (node.value) return true;
  if (el.hasAttribute("contenteditable")) return true;
  return false;
}

function walk(el: Element): CapturedNode[] {
  if (SKIP_TAGS.has(el.tagName.toLowerCase())) return [];
  examined++;

  if (!isRendered(el)) {
    pruned++;
    return [];
  }

  const children: CapturedNode[] = [];
  for (const child of Array.from(el.children)) {
    children.push(...walk(child));
  }

  const bbox = boxOf(el);
  const node: CapturedNode = {
    id: 0,
    tag: el.tagName.toLowerCase(),
    role: roleOf(el),
    label: labelOf(el),
    text: ownText(el) || undefined,
    value: valueOf(el),
    attrs: attrsOf(el),
    bbox,
    visible: bbox[1] < innerHeight && bbox[1] + bbox[3] > 0 && bbox[2] > 0 && bbox[3] > 0,
    children,
  };

  // Keep a node if it earns its place, or if it is a branch point that gives
  // the tree its shape. Otherwise hoist its children into the parent.
  if (isSignificant(el, node) || children.length > 1) {
    node.children = children;
    pending.set(node, el);
    return [node];
  }

  pruned++;
  return children;
}

/** Depth-first id assignment, so ids read in document order. */
function assignIds(node: CapturedNode, next: { value: number }): number {
  node.id = next.value++;
  const el = pending.get(node);
  if (el) registry[node.id] = el;
  let count = 1;
  for (const child of node.children) count += assignIds(child, next);
  return count;
}

/** The live element behind a captured node, if it is still on the page. */
export function capturedElement(id: number): Element | undefined {
  const el = registry[id];
  return el?.isConnected ? el : undefined;
}

export { ownTextMap };

/** Builds the structured page capture. Pure read — touches nothing. */
export function captureDom(): DomCapture {
  examined = 0;
  pruned = 0;
  registry = [];
  pending = new WeakMap();

  const children = walk(document.body);

  const root: CapturedNode = {
    id: 0,
    tag: "body",
    role: "document",
    label: document.title,
    attrs: {},
    bbox: [0, 0, innerWidth, document.body.scrollHeight],
    visible: true,
    children,
  };

  const kept = assignIds(root, { value: 0 });

  return {
    url: location.href,
    origin: location.origin,
    title: document.title,
    capturedAt: Date.now(),
    viewport: {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      scrollX: Math.round(scrollX),
      scrollY: Math.round(scrollY),
      pageHeight: document.body.scrollHeight,
    },
    root,
    stats: { examined, kept, pruned },
  };
}

/** Finds a node by id in a captured tree. */
export function findNode(root: CapturedNode, id: number): CapturedNode | undefined {
  for (const node of walkCapture(root)) {
    if (node.id === id) return node;
  }
  return undefined;
}

/** All visible text in a captured tree, for scanning rather than rendering. */
export function allText(root: CapturedNode): string {
  const parts: string[] = [];
  for (const node of walkCapture(root)) {
    if (node.text) parts.push(node.text);
    if (node.value) parts.push(node.value);
  }
  return parts.join("\n");
}

/** Depth-first iteration over a captured tree. */
export function* walkCapture(node: CapturedNode): Generator<CapturedNode> {
  yield node;
  for (const child of node.children) yield* walkCapture(child);
}

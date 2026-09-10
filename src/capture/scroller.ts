/**
 * Finds the thing that actually scrolls.
 *
 * Every scroll in this extension used to go to `window`, which is right for a
 * document and wrong for an application. Gmail, Slack, Twitter and most app
 * shells pin the window at zero and scroll an inner container, so `scrollBy`
 * did nothing at all and the page reported itself as both at the top and at the
 * bottom - "Now at y=0 (bottom of page)" - because `window.scrollY` was 0 and
 * `document.body.scrollHeight` was barely taller than the viewport.
 *
 * The agent therefore could not scroll any such site, and the planner was told
 * a two-thousand-message inbox was one screen long.
 */

/** Is this element one the user could scroll vertically? */
function scrollable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.scrollHeight <= el.clientHeight + 4) return false;

  const overflow = getComputedStyle(el).overflowY;
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/**
 * The container a scroll gesture in the middle of the screen would move.
 *
 * Starting from what is under the centre of the viewport and walking up finds
 * the same element the user's wheel would, which is the one the planner means
 * when it says "scroll down". Falls back to the document.
 */
export function findScroller(): Element {
  const doc = document.scrollingElement ?? document.documentElement;

  const start = document.elementFromPoint(
    Math.floor(innerWidth / 2),
    Math.floor(innerHeight / 2),
  );

  for (let el = start; el; el = el.parentElement) {
    if (el === document.body || el === document.documentElement) break;
    if (scrollable(el)) return el;
  }

  // Nothing under the centre scrolls. An app shell may still have one large
  // scrolling panel somewhere - take the biggest, if it is worth having.
  if (doc.scrollHeight <= doc.clientHeight + 4) {
    let best: Element | undefined;
    let bestArea = 0;
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      if (!scrollable(el)) continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      // Ignore small scrolling widgets; we want the page's main panel.
      if (area < innerWidth * innerHeight * 0.2) continue;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    if (best) return best;
  }

  return doc;
}

/** Where that container currently sits, in the shape the capture reports. */
export function scrollState(): {
  scrollX: number;
  scrollY: number;
  pageHeight: number;
  pageWidth: number;
  /** True when an inner panel scrolls rather than the document. */
  inner: boolean;
} {
  const el = findScroller();
  const doc = document.scrollingElement ?? document.documentElement;
  const inner = el !== doc;

  if (!inner) {
    return {
      scrollX: Math.round(scrollX),
      scrollY: Math.round(scrollY),
      pageHeight: Math.max(doc.scrollHeight, document.body.scrollHeight, innerHeight),
      pageWidth: Math.max(doc.scrollWidth, document.body.scrollWidth, innerWidth),
      inner: false,
    };
  }

  return {
    scrollX: Math.round(el.scrollLeft),
    scrollY: Math.round(el.scrollTop),
    pageHeight: el.scrollHeight,
    pageWidth: el.scrollWidth,
    inner: true,
  };
}

/** Scrolls by a number of pixels, and reports where it ended up. */
export function scrollByPixels(delta: number): {
  scrollY: number;
  pageHeight: number;
  atTop: boolean;
  atBottom: boolean;
  moved: boolean;
  inner: boolean;
} {
  const el = findScroller();
  const doc = document.scrollingElement ?? document.documentElement;
  const inner = el !== doc;

  const before = inner ? el.scrollTop : scrollY;

  if (inner) {
    el.scrollTop = before + delta;
  } else {
    scrollBy({ top: delta, behavior: "instant" as ScrollBehavior });
  }

  const after = inner ? el.scrollTop : scrollY;
  const height = inner ? el.clientHeight : innerHeight;
  const total = inner
    ? el.scrollHeight
    : Math.max(doc.scrollHeight, document.body.scrollHeight, innerHeight);

  return {
    scrollY: Math.round(after),
    pageHeight: total,
    atTop: after <= 1,
    atBottom: after + height >= total - 4,
    // Reporting whether anything actually moved is the point: a scroll that
    // changed nothing should not be described as if it had.
    moved: Math.abs(after - before) > 1,
    inner,
  };
}

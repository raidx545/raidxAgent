/**
 * The page-side half of a full-page screenshot.
 *
 * `captureVisibleTab` can only ever photograph the viewport, so a whole-page
 * image has to be assembled by scrolling and stitching. Two things make that
 * harder than it sounds, and both are handled here rather than in the stitcher:
 *
 *   Sticky and fixed elements are painted into *every* tile. A navigation bar
 *   pinned to the top of the window appears once per slice, so a naive stitch
 *   produces a page with the header repeated down its whole length. They are
 *   hidden after the first tile and restored afterwards.
 *
 *   `scrollTo` does not always land where you asked. The page clamps at the
 *   bottom, honours `scroll-behavior: smooth`, and may grow as lazy images
 *   load. So every tile reports where it *actually* is, and the stitcher places
 *   it there rather than where it was told to go.
 */

interface Hidden {
  el: HTMLElement;
  visibility: string;
}

let hidden: Hidden[] = [];
let originalScroll: { x: number; y: number } | undefined;
let originalScrollBehavior: string | undefined;

function metrics() {
  const doc = document.documentElement;
  return {
    scrollX: Math.round(scrollX),
    scrollY: Math.round(scrollY),
    // Pages disagree about which element owns the scroll height; the largest
    // honest answer is the safe one.
    pageWidth: Math.max(doc.scrollWidth, document.body.scrollWidth, innerWidth),
    pageHeight: Math.max(doc.scrollHeight, document.body.scrollHeight, innerHeight),
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    dpr: devicePixelRatio || 1,
    stickyHidden: hidden.length,
  };
}

/** Records the starting state and disables smooth scrolling. */
export function begin(): ReturnType<typeof metrics> {
  originalScroll = { x: scrollX, y: scrollY };
  originalScrollBehavior = document.documentElement.style.scrollBehavior;
  // Smooth scrolling means the screenshot fires mid-animation.
  document.documentElement.style.scrollBehavior = "auto";
  hidden = [];
  return metrics();
}

/**
 * Finds elements that stay put while the page scrolls.
 *
 * Only elements currently in view matter - an off-screen sticky element is not
 * being painted into this tile anyway.
 */
function stickyElements(): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
    const style = getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "sticky") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    if (rect.bottom < 0 || rect.top > innerHeight) continue;
    found.push(el);
  }
  return found;
}

function hideSticky(): void {
  for (const el of stickyElements()) {
    if (hidden.some((h) => h.el === el)) continue;
    hidden.push({ el, visibility: el.style.visibility });
    el.style.visibility = "hidden";
  }
}

/**
 * Scrolls to a document offset and reports where the page actually ended up.
 *
 * `hideSticky` is false for the first tile, so pinned headers are captured once
 * in their natural place, and true for every tile after it.
 */
export async function scrollTo(
  y: number,
  hide: boolean,
): Promise<ReturnType<typeof metrics>> {
  if (hide) hideSticky();

  scrollTo_(0, y);
  // Two frames is enough for layout and paint on everything reasonable.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // Lazily-loaded images decode a beat later.
  await new Promise((resolve) => setTimeout(resolve, 120));

  return metrics();
}

// Shadowed by the exported name above, so keep a direct reference.
const scrollTo_ = window.scrollTo.bind(window);

/** Restores scroll position, scroll behaviour, and every hidden element. */
export function end(): ReturnType<typeof metrics> {
  for (const { el, visibility } of hidden) {
    el.style.visibility = visibility;
  }
  hidden = [];

  if (originalScrollBehavior !== undefined) {
    document.documentElement.style.scrollBehavior = originalScrollBehavior;
    originalScrollBehavior = undefined;
  }
  if (originalScroll) {
    scrollTo_(originalScroll.x, originalScroll.y);
    originalScroll = undefined;
  }
  return metrics();
}

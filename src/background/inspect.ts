import type { Capture, DomCapture, ScreenshotMeta } from "../capture/types";
import { TabController, isRestricted } from "./executor";
import { captureFullPage } from "./stitch";

/**
 * Runs the capture layer against a tab: the structured DOM tree from the page,
 * and pixels from the browser.
 *
 * Three things here are load-bearing, and all three were bugs before they were
 * guards:
 *
 *   The screenshot must come from the tab we walked. `captureVisibleTab`
 *   captures whichever tab is *active*, not the tab id you hand it. Since the
 *   caller is usually itself an extension page, the naive call photographs the
 *   inspector rather than the page being scanned. The target tab is brought to
 *   the front for the duration and the previous tab restored afterwards.
 *
 *   The DOM and the pixels must describe the same page state. bboxes are
 *   viewport-relative, so a page that scrolls or reflows between the two
 *   captures shifts every region.
 *
 *   Whatever the image covers, it has to say so. A viewport shot and a stitched
 *   page shot have different origins, and the redactor reads that off the
 *   image rather than guessing.
 */

const MAX_ATTEMPTS = 3;
const PAINT_MS = 350;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CaptureOptions {
  /**
   * Photograph the whole scrollable page rather than just the viewport.
   *
   * Costs roughly half a second per screen - Chrome caps captureVisibleTab at
   * two calls per second - and briefly scrolls the page, which is restored
   * afterwards. In exchange, regions below the fold are actually in the image
   * and can therefore actually be destroyed.
   */
  fullPage?: boolean;
  onProgress?: (tile: number, total: number) => void;
}

export async function captureTab(
  tabId: number,
  options: CaptureOptions = {},
): Promise<Capture> {
  const tab = await chrome.tabs.get(tabId);

  if (isRestricted(tab.url)) {
    throw new Error(
      `${tab.url} is a browser-internal page. Extensions cannot read it - open a normal site.`,
    );
  }

  return withTabInFront(tabId, async () => {
    const controller = new TabController(tabId);

    // A full-page capture scrolls the page, so the DOM has to be walked after
    // the scrolling is finished - otherwise every bbox describes a layout that
    // no longer exists.
    if (options.fullPage) {
      const { shot, error } = await captureFullPage(
        tabId,
        tab.windowId,
        controller,
        (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
        { onProgress: options.onProgress },
      );

      // Let the restored scroll settle before measuring anything.
      await delay(PAINT_MS);
      const dom = await controller.captureDom();
      if (!dom) throw new Error("The page did not respond to the capture request.");

      return { dom, screenshot: shot, screenshotError: error };
    }

    let lastDom: DomCapture | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const dom = await controller.captureDom();
      if (!dom) throw new Error("The page did not respond to the capture request.");
      lastDom = dom;

      const { screenshot, error } = await grabViewport(tabId, dom);
      if (!screenshot) return { dom, screenshotError: error };

      const after = await controller.captureDom();
      if (!after) return { dom, screenshot };
      if (isConsistent(dom, after)) return { dom, screenshot };

      if (attempt === MAX_ATTEMPTS) {
        // Fail closed. A screenshot we cannot align with the tree is worse than
        // no screenshot, because the redactor would burn the wrong rectangles.
        return {
          dom: after,
          screenshotError:
            `The page kept moving while it was being captured (${MAX_ATTEMPTS} attempts), ` +
            `so no screenshot was kept - its regions could not be aligned with the DOM.`,
        };
      }
    }

    return { dom: lastDom!, screenshotError: "Capture did not settle." };
  });
}

/**
 * Brings a tab to the front, runs the capture, and puts the previous tab back.
 *
 * A visible side effect, but the only way to photograph a tab that is not
 * already in front - and the caller asked for exactly this tab.
 */
async function withTabInFront<T>(tabId: number, run: () => Promise<T>): Promise<T> {
  const tab = await chrome.tabs.get(tabId);

  const previousTab = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
  const previousWindow = await chrome.windows
    .getLastFocused()
    .then((w) => w.id)
    .catch(() => undefined);

  const window = await chrome.windows.get(tab.windowId).catch(() => undefined);
  const mustSwitchTab = !tab.active;
  const mustFocusWindow = window ? !window.focused : false;

  try {
    if (mustFocusWindow) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    }
    if (mustSwitchTab) {
      await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
    }
    if (mustSwitchTab || mustFocusWindow) await delay(PAINT_MS);

    return await run();
  } finally {
    if (mustSwitchTab && previousTab?.id !== undefined && previousTab.id !== tabId) {
      await chrome.tabs.update(previousTab.id, { active: true }).catch(() => undefined);
    }
    if (mustFocusWindow && previousWindow !== undefined) {
      await chrome.windows.update(previousWindow, { focused: true }).catch(() => undefined);
    }
  }
}

/** Photographs the viewport, tagged with the coordinate frame it covers. */
async function grabViewport(
  tabId: number,
  dom: DomCapture,
): Promise<{ screenshot?: ScreenshotMeta; error?: string }> {
  const tab = await chrome.tabs.get(tabId);

  if (!tab.active) {
    return {
      error:
        `No screenshot: "${tab.title ?? "this tab"}" could not be brought to the front, ` +
        `and captureVisibleTab would have photographed a different tab.`,
    };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      if (!dataUrl) continue;

      // Measure the scale from the image rather than trusting devicePixelRatio.
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const scale = dom.viewport.width > 0 ? bitmap.width / dom.viewport.width : dom.viewport.dpr;
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();

      if (!Number.isFinite(scale) || scale <= 0) {
        return { error: `Refusing the screenshot: computed a scale of ${scale}.` };
      }

      return {
        screenshot: {
          dataUrl,
          kind: "viewport",
          scale,
          // A viewport shot starts wherever the page happens to be scrolled to.
          originX: dom.viewport.scrollX,
          originY: dom.viewport.scrollY,
          cssWidth: size.width / scale,
          cssHeight: size.height / scale,
          tiles: 1,
        },
      };
    } catch (error) {
      if (attempt === 3) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      await delay(550);
    }
  }

  return { error: "captureVisibleTab returned nothing." };
}

function isConsistent(before: DomCapture, after: DomCapture): boolean {
  return (
    before.url === after.url &&
    before.viewport.scrollX === after.viewport.scrollX &&
    before.viewport.scrollY === after.viewport.scrollY &&
    before.viewport.width === after.viewport.width &&
    before.viewport.height === after.viewport.height
  );
}

import type { ScreenshotMeta } from "../capture/types";
import type { TabController } from "./executor";

/**
 * Assembles a whole-page screenshot from viewport captures.
 *
 * `captureVisibleTab` only ever photographs what is on screen, and Chrome caps
 * it at two calls per second, so a tall page costs real time - roughly half a
 * second per screen. That is acceptable for a capture the user asked for, and
 * it is why the tile count is capped rather than unbounded.
 *
 * Tiles are placed at the scroll position the page *reported*, not the one it
 * was asked for. Pages clamp at the bottom, animate, and grow as images load;
 * trusting the request instead of the report is how stitched screenshots end up
 * with duplicated or missing bands.
 */

/** Chrome allows two per second. Stay just under it. */
const CAPTURE_INTERVAL_MS = 550;

/** Refuse to build an image taller than this, in device pixels. */
const MAX_IMAGE_HEIGHT = 20000;

/** Never take more than this many shots, however tall the page claims to be. */
const MAX_TILES = 24;

/**
 * Long edge, in device pixels, of the image handed onward.
 *
 * A full-page capture at devicePixelRatio is enormous, and every pixel becomes
 * tokens when it reaches a model - resent on every turn as history grows. This
 * keeps detail that matters for layout while cutting the cost several-fold.
 */
const MAX_DELIVERED_EDGE = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function toBitmap(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

async function toDataUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return "data:image/png;base64," + btoa(binary);
}

export interface StitchOptions {
  /** Called between tiles so the caller can show progress. */
  onProgress?: (tile: number, total: number) => void;
}

/**
 * Scrolls the page from top to bottom, photographing each screen, and returns
 * one image covering the whole document.
 *
 * Always restores the page's scroll position and any elements it hid, whether
 * it succeeds or throws.
 */
export async function captureFullPage(
  tabId: number,
  windowId: number,
  controller: TabController,
  capture: (windowId: number) => Promise<string>,
  options: StitchOptions = {},
): Promise<{ shot?: ScreenshotMeta; error?: string }> {
  const started = await controller.fullPageBegin();
  if (!started) return { error: "The page did not respond to the full-page request." };

  try {
    const { viewportHeight, dpr } = started;
    let { pageHeight, pageWidth } = started;

    if (viewportHeight <= 0) {
      return { error: "The page reported a zero-height viewport." };
    }

    // A page that reports less than a screen is just a viewport capture.
    const steps = Math.max(1, Math.ceil(pageHeight / viewportHeight));
    const tileCount = Math.min(steps, MAX_TILES);
    const truncated = tileCount < steps;

    interface Tile {
      bitmap: ImageBitmap;
      /** Document CSS offset this tile's top-left sits at. */
      docY: number;
      docX: number;
    }
    const tiles: Tile[] = [];

    let lastCaptureAt = 0;

    for (let index = 0; index < tileCount; index++) {
      const target = index * viewportHeight;

      // Hide sticky furniture for every tile after the first, so a pinned
      // header is captured once in its natural place rather than N times.
      const position = await controller.fullPageScroll(target, index > 0);
      if (!position) break;

      // Respect Chrome's two-per-second ceiling.
      const wait = CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
      if (wait > 0) await delay(wait);

      let dataUrl: string;
      try {
        dataUrl = await capture(windowId);
      } catch (error) {
        // Quota errors clear quickly; anything else is fatal for this tile.
        await delay(CAPTURE_INTERVAL_MS);
        try {
          dataUrl = await capture(windowId);
        } catch {
          return {
            error: `Screen ${index + 1} of ${tileCount} could not be captured: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      }
      lastCaptureAt = Date.now();

      tiles.push({
        bitmap: await toBitmap(dataUrl),
        docY: position.scrollY,
        docX: position.scrollX,
      });

      options.onProgress?.(index + 1, tileCount);

      // The page may have grown as images loaded; believe the newer number.
      pageHeight = Math.max(pageHeight, position.pageHeight);
      pageWidth = Math.max(pageWidth, position.pageWidth);

      // Reached the bottom early - the page clamped our scroll.
      const atBottom = position.scrollY + viewportHeight >= pageHeight - 2;
      if (atBottom && index > 0) break;
    }

    if (tiles.length === 0) return { error: "No screens could be captured." };

    // Scale comes from a real tile against the real viewport, never assumed.
    const scale = tiles[0].bitmap.width / started.viewportWidth;
    if (!Number.isFinite(scale) || scale <= 0) {
      return { error: `Refusing to stitch: computed a scale of ${scale}.` };
    }

    const lastTile = tiles[tiles.length - 1];
    const coveredCssHeight = lastTile.docY + lastTile.bitmap.height / scale;
    const height = Math.min(Math.round(coveredCssHeight * scale), MAX_IMAGE_HEIGHT);
    const width = tiles[0].bitmap.width;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { error: "No 2D context for stitching." };

    // White beneath, so any gap reads as blank page rather than transparency.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    for (const tile of tiles) {
      ctx.drawImage(tile.bitmap, 0, Math.round(tile.docY * scale));
      tile.bitmap.close();
    }

    const full = await deliver(canvas, scale, dpr);

    return {
      shot: {
        dataUrl: full.dataUrl,
        kind: "page",
        scale: full.scale,
        // A stitched page image starts at the document origin by construction.
        originX: 0,
        originY: 0,
        cssWidth: width / scale,
        cssHeight: height / scale,
        tiles: tiles.length,
        truncatedAtCssY: truncated ? height / scale : undefined,
        downscaledFrom: full.downscaledFrom,
      },
    };
  } finally {
    // Put the page back, whatever happened.
    await controller.fullPageEnd();
  }
}

/**
 * Scales the finished image down to something a model can afford to read.
 *
 * Returns the *effective* scale, so coordinate maths downstream stays correct
 * after the resize - getting this wrong would burn rectangles in the wrong
 * place, which is worse than not burning them at all.
 */
async function deliver(
  canvas: OffscreenCanvas,
  scale: number,
  _dpr: number,
): Promise<{ dataUrl: string; scale: number; downscaledFrom?: { width: number; height: number } }> {
  const longest = Math.max(canvas.width, canvas.height);
  if (longest <= MAX_DELIVERED_EDGE) {
    return { dataUrl: await toDataUrl(canvas), scale };
  }

  const factor = MAX_DELIVERED_EDGE / longest;
  const width = Math.max(1, Math.round(canvas.width * factor));
  const height = Math.max(1, Math.round(canvas.height * factor));

  const small = new OffscreenCanvas(width, height);
  const ctx = small.getContext("2d");
  if (!ctx) return { dataUrl: await toDataUrl(canvas), scale };

  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, width, height);

  return {
    dataUrl: await toDataUrl(small),
    // The image now holds fewer pixels per CSS pixel, so the scale shrinks by
    // exactly the factor we resized by.
    scale: scale * factor,
    downscaledFrom: { width: canvas.width, height: canvas.height },
  };
}

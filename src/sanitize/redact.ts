import type { ScreenshotMeta, Viewport } from "../capture/types";
import type { Rect, SpanRectResult } from "../capture/spans";
import type { Finding } from "../pii/types";
import type { TokenMinter } from "../vault/protocol";

/**
 * Burns pixel-shaped PII out of a screenshot.
 *
 * The asymmetry with tokenization is the whole point. A tokenized name can be
 * swapped back from the vault; a burned region cannot be recovered by anyone,
 * including us. So this fills - it does not blur, pixelate, or overlay with
 * transparency. A CSS blur is a reversible transform and a semi-transparent
 * cover still ships the pixels underneath; both would leave the face in the
 * bytes that cross the wire.
 *
 * Each burned region is stamped with a vault token. Without it the planner sees
 * a black rectangle and reasonably concludes the page is broken or the field is
 * empty; with it, the planner knows a photo is there, can refer to it, and
 * still never sees a pixel of it.
 *
 * Two different things get destroyed here, and conflating them was a real bug:
 *
 *   Image regions - faces, signatures, frames - are blacked out. There is
 *   nothing to say about them beyond "something was here".
 *
 *   Text that the DOM already tokenized is *also* painted over, with the very
 *   same token. Tokenizing an email in the tree while leaving it legible in the
 *   screenshot achieves nothing at all: both go to the model, and the picture
 *   gives the value straight back. This is the half that makes the tree's work
 *   count.
 */

export interface RedactReport {
  regionsBurned: number;
  /** Text spans painted over with their token. */
  textSpansCovered: number;
  /** Text findings whose position on screen could not be resolved. */
  textSpansUnresolved: number;
  /**
   * Regions that lie outside the captured viewport.
   *
   * The screenshot only ever contains the visible viewport, so a region further
   * down the page is not in the image and there is nothing to destroy. That is
   * sound - those pixels never leave the machine either way - but it has to be
   * counted separately from a genuine failure, or a page whose photos are below
   * the fold looks like a redactor that did nothing.
   */
  regionsOutsideViewport: number;
  /** Regions with a degenerate bounding box. */
  regionsSkipped: number;
  /** Screenshot pixels destroyed. */
  pixelsBurned: number;
  outputBytes: number;
}

export interface RedactResult {
  /** PNG data URL with the regions destroyed, or undefined if we could not. */
  screenshot?: string;
  report: RedactReport;
  error?: string;
}

/** Padding around a region, in screenshot pixels. Edges leak. */
const BLEED = 3;

/**
 * Decodes a data URL into a bitmap. Works in a service worker, an offscreen
 * document, and a normal page - none of which share an Image constructor.
 */
async function toBitmap(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function toDataUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // btoa needs a binary string, and spreading a large array blows the stack,
  // so build it in chunks.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return "data:image/png;base64," + btoa(binary);
}

/**
 * Maps an element's box onto pixels in whichever image we were handed.
 *
 * bboxes are viewport-relative; the image may be a viewport shot or a stitched
 * whole page. Everything therefore converts through document coordinates:
 *
 *   documentX = bbox.x + viewport.scrollX
 *   imageX    = (documentX - shot.originX) * shot.scale
 *
 * For a viewport shot the origin is the scroll offset, so the two collapse into
 * the same arithmetic and there is only one code path to get wrong.
 */
function project(
  bbox: readonly [number, number, number, number],
  viewport: Viewport,
  shot: ScreenshotMeta,
): { x: number; y: number; w: number; h: number } {
  const documentX = bbox[0] + viewport.scrollX;
  const documentY = bbox[1] + viewport.scrollY;
  return {
    x: (documentX - shot.originX) * shot.scale,
    y: (documentY - shot.originY) * shot.scale,
    w: bbox[2] * shot.scale,
    h: bbox[3] * shot.scale,
  };
}

/** A zero or nonsensical scale would collapse every burn rectangle to nothing. */
function assertUsableScale(shot: ScreenshotMeta): void {
  if (!Number.isFinite(shot.scale) || shot.scale <= 0) {
    throw new Error(
      `Refusing to redact: the screenshot reports a scale of ${shot.scale}. ` +
        `Burning would silently do nothing and return an unredacted image.`,
    );
  }
}

/**
 * Produces a screenshot with every pixel-shaped finding destroyed.
 *
 * Fails closed: if anything goes wrong, no screenshot is returned at all. An
 * un-redacted screenshot is never an acceptable fallback.
 */
export async function redactScreenshot(
  shot: ScreenshotMeta,
  findings: Finding[],
  viewport: Viewport,
  vault: TokenMinter,
  /** Where each text finding is painted, from the page. */
  spanRects: SpanRectResult[] = [],
  /** The token each finding was replaced with in the tree. */
  tokensByFinding: Map<string, string> = new Map(),
): Promise<RedactResult> {
  const report: RedactReport = {
    regionsBurned: 0,
    textSpansCovered: 0,
    textSpansUnresolved: 0,
    regionsOutsideViewport: 0,
    regionsSkipped: 0,
    pixelsBurned: 0,
    outputBytes: 0,
  };

  const regions = findings.filter((f) => f.shape === "pixel" && f.action === "burn-region");

  let bitmap: ImageBitmap;
  try {
    assertUsableScale(shot);
    bitmap = await toBitmap(shot.dataUrl);
  } catch (error) {
    return {
      report,
      error: `Could not decode the screenshot: ${describe(error)}`,
    };
  }

  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D context on the offscreen canvas.");

    const scale = shot.scale;

    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    for (const finding of regions) {
      // Mint the token first, unconditionally.
      //
      // The collect pass asks the vault for one seal per burn-region finding,
      // so this loop must consume exactly one per finding or the two sequences
      // drift and the replay throws. Skipping the seal for a region that turns
      // out to be off-image would do precisely that. An unused seal costs
      // nothing - it has no value behind it - and the region genuinely exists
      // on the page even when it is outside this particular image.
      const token = vault.seal(finding.kind);

      if (finding.bbox[2] <= 0 || finding.bbox[3] <= 0) {
        report.regionsSkipped++;
        continue;
      }

      const box = project(finding.bbox, viewport, shot);

      let x = Math.floor(box.x) - BLEED;
      let y = Math.floor(box.y) - BLEED;
      let w = Math.ceil(box.w) + BLEED * 2;
      let h = Math.ceil(box.h) + BLEED * 2;

      // Clip to the image. A region outside it has nothing to burn, because it
      // is not in the screenshot in the first place.
      const x0 = Math.max(0, x);
      const y0 = Math.max(0, y);
      const x1 = Math.min(canvas.width, x + w);
      const y1 = Math.min(canvas.height, y + h);
      w = x1 - x0;
      h = y1 - y0;
      if (w <= 0 || h <= 0) {
        report.regionsOutsideViewport++;
        continue;
      }
      x = x0;
      y = y0;

      // Destroy first. Everything after this point is decoration drawn on top
      // of pixels that are already gone.
      ctx.fillStyle = "#000000";
      ctx.fillRect(x, y, w, h);

      // A thin border so the planner can tell one burned region from another
      // when two sit next to each other.
      ctx.strokeStyle = "#ff4d4d";
      ctx.lineWidth = Math.max(1, Math.round(scale));
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

      // Stamp the token, scaled to fit the region rather than a fixed size.
      const fontPx = Math.max(9 * scale, Math.min(h * 0.35, w / (token.length * 0.62)));
      ctx.font = `${Math.floor(fontPx)}px ui-monospace, monospace`;
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(token, x + w / 2, y + h / 2, w - 4);

      report.regionsBurned++;
      report.pixelsBurned += w * h;
    }

    // --- text spans -------------------------------------------------------
    //
    // Painted after the image regions so a token label is never buried under a
    // black rectangle drawn afterwards.
    const rectsByFinding = new Map(spanRects.map((r) => [r.findingId, r]));

    for (const finding of findings) {
      if (finding.shape !== "text") continue;
      if (finding.action === "none" || finding.action === "burn-region") continue;

      const token = tokensByFinding.get(finding.id);
      if (!token) continue;

      const resolved = rectsByFinding.get(finding.id);
      if (!resolved || resolved.rects.length === 0) {
        report.textSpansUnresolved++;
        continue;
      }

      let covered = false;
      for (const rect of resolved.rects) {
        if (coverText(ctx, rect, token, shot, canvas, report)) covered = true;
      }
      if (covered) report.textSpansCovered++;
      else report.textSpansUnresolved++;
    }

    const out = await toDataUrl(canvas);
    report.outputBytes = out.length;
    return { screenshot: out, report };
  } catch (error) {
    // Fail closed - better no screenshot than an unredacted one.
    return { report, error: `Redaction failed: ${describe(error)}` };
  }
}

/**
 * Paints one line of tokenized text out of the image and writes the token in
 * its place.
 *
 * Rectangles here are already in document coordinates - they came from a Range
 * measured on the page - so they only need the image origin and scale applied,
 * not the viewport scroll a second time.
 */
function coverText(
  ctx: OffscreenCanvasRenderingContext2D,
  rect: Rect,
  token: string,
  shot: ScreenshotMeta,
  canvas: OffscreenCanvas,
  report: RedactReport,
): boolean {
  const pad = 1;
  let x = Math.floor((rect[0] - shot.originX) * shot.scale) - pad;
  let y = Math.floor((rect[1] - shot.originY) * shot.scale) - pad;
  let w = Math.ceil(rect[2] * shot.scale) + pad * 2;
  let h = Math.ceil(rect[3] * shot.scale) + pad * 2;

  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(canvas.width, x + w);
  const y1 = Math.min(canvas.height, y + h);
  w = x1 - x0;
  h = y1 - y0;
  if (w <= 1 || h <= 1) return false;
  x = x0;
  y = y0;

  // Destroy first; the label is drawn on pixels that are already gone.
  ctx.fillStyle = "#1d283a";
  ctx.fillRect(x, y, w, h);
  report.pixelsBurned += w * h;

  // Fit the token to the space it has. Too small to read is still correct -
  // the tree carries the same token - so shrinking beats overflowing.
  const byHeight = h * 0.72;
  const byWidth = w / Math.max(1, token.length * 0.58);
  const fontPx = Math.max(7, Math.min(byHeight, byWidth));

  ctx.font = `${Math.floor(fontPx)}px ui-monospace, monospace`;
  ctx.fillStyle = "#9ec5ff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(token, x + 2, y + h / 2, w - 3);

  return true;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

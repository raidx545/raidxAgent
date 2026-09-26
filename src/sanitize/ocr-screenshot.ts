import type { CapturedNode, DomCapture, ScreenshotMeta, Viewport } from "../capture/types";
import { walkCapture } from "../capture/dom";
import { scanText } from "../pii/detect";
import { correctIdentifiers } from "../pii/ocr-correct";
import { findApprox } from "../pii/fuzzy";
import type { OcrEngine, OcrLine } from "../pii/ocr";
import type { Finding, PiiKind } from "../pii/types";
import { mask } from "../pii/types";
import { NEVER_ALIGN } from "../pii/entities";
import { isNameHeader, looksLikeNameCell, takesSingleWord } from "../pii/tier3-entities";
import { canvasToDataUrl, project, unproject } from "./redact";

/**
 * Reading the pixels the tree cannot.
 *
 * A screenshot carries text the DOM never had: a phone number in a product
 * banner, a scanned invoice, a chat screenshot someone pasted, the entire body
 * of a canvas-rendered document. Every text detector in this codebase walks
 * nodes, so all of that went to the model untouched - the tree said <PHONE_1>
 * and the picture said the number.
 *
 * This runs OCR over the image-shaped regions of the page (and, in "full"
 * mode, over the whole screenshot in overlapping bands), scans what it reads
 * with the same detectors that scan the tree, and turns each hit into a region
 * to burn - a region that carries the *value*, so it is tokenized through the
 * vault rather than merely blacked out. The number in the picture and the
 * number in the tree get the same token, which is the whole idea.
 *
 * A leak audit - the whole pipeline over pictures of PII, then the redacted
 * result read again by a stronger reader - is what shaped the rest:
 *
 *  - Pictures below the fold were never read. "Visible" meant "inside the
 *    viewport", and a full-page screenshot shows the whole page.
 *  - Twelve regions per step, largest first, and the rest were sent unread.
 *  - A picture whose read failed was sent unread.
 *  - Each picture was read once, as it was. Light text on a dark banner, faint
 *    grey print and a blurred scan all read badly or not at all - so each is
 *    now read several ways: as it is, cleaned (greyscale, inverted when dark,
 *    contrast stretched) looking for scattered text, and thresholded.
 *  - Lines were scanned one at a time. On a card the label sits on the line
 *    above its value - "Account Number" / "50100234567891" - and a detector
 *    that needs the label never saw it. The lines of a picture are scanned
 *    together.
 *  - A value the tree knew was only found if OCR read it exactly.
 *
 * Fails closed: a picture that could not be read, or that there was no time
 * for, is burned whole rather than sent unread.
 */

export type OcrMode = "off" | "images" | "full";

export interface OcrReport {
  mode: OcrMode;
  engine?: string;
  regionsScanned: number;
  /** Regions beyond the cap - burned whole, since they were not read. */
  regionsSkipped: number;
  /** Regions every variant of which failed - burned whole. */
  regionsFailed: number;
  /** Bands of the whole screenshot read in "full" mode. */
  bandsScanned: number;
  bandsFailed: number;
  /** Images handed to the engine, across every variant. */
  imagesRead: number;
  linesRead: number;
  /** Findings made by running the detectors over OCR text. */
  spansDetected: number;
  /** Findings made by matching values the tree (or another picture) had found. */
  knownValuesCovered: number;
  /**
   * Canvases that were going to be blacked out wholesale and were instead
   * read, so only the PII in them is covered. A canvas-rendered document is
   * useless to the planner as a black rectangle.
   */
  regionsReleased: number;
  /** Identifiers recovered by correcting OCR confusions against their template. */
  spansCorrected: number;
  /**
   * What OCR read, line by line, for the inspector. Local only - this never
   * enters a payload - and it is the difference between "OCR missed it" and
   * knowing that it read S for 5.
   */
  linesText: string[];
  elapsedMs: number;
  error?: string;
}

/** How a crop is prepared before it is read. */
export type Variant = "plain" | "clean" | "binary";

/** A piece of the screenshot handed to the engine, and how to map it back. */
export interface Crop {
  id: string;
  dataUrl: string;
  /** Screenshot-pixel origin of this crop. */
  x: number;
  y: number;
  /** Crop pixels per screenshot pixel; small text is enlarged before OCR. */
  zoom: number;
  /** How the engine should look for text in it. */
  psm?: "auto" | "sparse";
}

export interface CropRequest {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
  /** The preparations to read this rectangle in. Plain alone when absent. */
  variants?: Variant[];
}

export type Cropper = (shot: ScreenshotMeta, rects: CropRequest[]) => Promise<Crop[]>;

/** Smaller than this and there is no legible text to read. */
const MIN_REGION_W = 40;
const MIN_REGION_H = 12;

/**
 * Regions per step. The cap is a guard against pathological pages, not a
 * budget: anything past it is burned whole, never sent unread.
 */
const MAX_REGIONS = 150;

/**
 * Image pixels per CSS pixel to read at. Tesseract wants glyphs around thirty
 * pixels tall; an 11px caption on a 2x display is 22, and on a 1x display 11.
 */
const REGION_SCALE = 3;
const BAND_SCALE = 2;

/** How much a picture region is enlarged before it is read, for a screenshot of this scale. */
export function regionZoom(scale: number): number {
  return Math.min(4, Math.max(1, REGION_SCALE / scale));
}

/**
 * Padding around a covered span, as a share of the text's height. Word boxes
 * hug the ink; anti-aliasing, a descender or an underline sits just outside,
 * and a sliver of a digit is enough for a model to guess it.
 */
export const OCR_BOX_PAD = { x: 0.15, y: 0.22 };

/** Height of one band of a full-screenshot read, in screenshot pixels, and the overlap between bands. */
const BAND_HEIGHT = 1100;
const BAND_OVERLAP = 160;

/** Known values shorter than this match too much by accident. */
const MIN_KNOWN_LENGTH = 4;

/**
 * A single ordinary word is not worth hunting for in a picture either: the
 * page called someone "you", and every "you" in every image would be covered.
 */
function worthMatching(value: string): boolean {
  if (value.length < MIN_KNOWN_LENGTH) return false;
  if (/\s/.test(value)) return true;
  return !NEVER_ALIGN.has(value.toLowerCase().replace(/[^\p{L}]/gu, ""));
}

/** Image regions that are burned whole regardless; reading them is wasted. */
const OPAQUE_KINDS = new Set<PiiKind>([
  "face_or_photo",
  "signature",
  "scanned_document",
  "qr_code",
  "unverified_region",
]);

const IMAGE_TAGS = new Set(["img", "canvas", "picture", "video", "svg", "object", "embed"]);

interface Region {
  id: string;
  node: CapturedNode;
  /** True when a successful read lets the wholesale burn be lifted. */
  releasable: boolean;
  /** True when the node already carries a burn that stays if the read fails. */
  alreadyBurned: boolean;
}

/**
 * Which regions of the page are worth reading.
 *
 * Anything that paints an image and is big enough to hold text, except the
 * regions already going to be destroyed whole - a face is not read, it is
 * burned. A canvas is the exception: it is burned whole today because its
 * contents are opaque to the DOM, and OCR is exactly what makes them not.
 *
 * `inImage` says whether a node is in the screenshot at all. It defaults to
 * "inside the viewport", which is right for a viewport shot and wrong for a
 * whole-page one - there, everything below the fold is in the picture too.
 */
export function ocrRegions(
  dom: DomCapture,
  findings: Finding[],
  inImage: (node: CapturedNode) => boolean = (node) => node.visible,
): Region[] {
  const burned = new Map<number, Finding>();
  for (const finding of findings) {
    if (finding.shape === "pixel" && finding.action === "burn-region") {
      burned.set(finding.nodeId, finding);
    }
  }

  const regions: Region[] = [];
  for (const node of walkCapture(dom.root)) {
    const paintsImage = IMAGE_TAGS.has(node.tag) || !!node.attrs.bgHost;
    if (!paintsImage) continue;
    if (node.bbox[2] < MIN_REGION_W || node.bbox[3] < MIN_REGION_H) continue;
    if (!inImage(node)) continue;

    const burn = burned.get(node.id);
    // The canvas heuristic burns at "low" confidence precisely because it
    // knows nothing; a read replaces that guess with knowledge.
    const releasable = node.tag === "canvas" && !!burn && burn.confidence === "low";
    if (burn && OPAQUE_KINDS.has(burn.kind) && !releasable) continue;

    regions.push({ id: `ocr-${node.id}`, node, releasable, alreadyBurned: !!burn });
  }

  // Largest first, so a cap falls on thumbnails rather than the main image.
  regions.sort((a, b) => b.node.bbox[2] * b.node.bbox[3] - a.node.bbox[2] * a.node.bbox[3]);
  return regions;
}

// ------------------------------------------------------------ preparing crops

const luminance = (d: Uint8ClampedArray, i: number): number =>
  0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/**
 * Greyscale, dark-background inverted, contrast stretched.
 *
 * Tesseract is trained on dark text on a light page. White on a dark banner is
 * read poorly; grey on white at 30% contrast is read as nothing. Stretching
 * between the 2nd and 98th percentile makes faint print full-contrast without
 * letting one stray pixel set the range.
 */
function clean(image: ImageData): void {
  const d = image.data;
  const histogram = new Array<number>(256).fill(0);
  let sum = 0;
  const count = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(luminance(d, i));
    histogram[g]++;
    sum += g;
  }
  const invert = sum / count < 110;

  const percentile = (p: number): number => {
    let seen = 0;
    for (let g = 0; g < 256; g++) {
      seen += histogram[g];
      if (seen >= count * p) return g;
    }
    return 255;
  };
  let lo = percentile(0.02);
  let hi = percentile(0.98);
  if (hi - lo < 16) { lo = 0; hi = 255; }

  for (let i = 0; i < d.length; i += 4) {
    let g = (luminance(d, i) - lo) * (255 / (hi - lo));
    g = Math.max(0, Math.min(255, g));
    if (invert) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
}

/** Otsu's threshold over a cleaned image: pure black text on pure white. */
function binarise(image: ImageData): void {
  clean(image);
  const d = image.data;
  const histogram = new Array<number>(256).fill(0);
  for (let i = 0; i < d.length; i += 4) histogram[d[i]]++;
  const total = d.length / 4;
  let sumAll = 0;
  for (let g = 0; g < 256; g++) sumAll += g * histogram[g];
  let sumBack = 0;
  let weightBack = 0;
  let best = 0;
  let threshold = 128;
  for (let g = 0; g < 256; g++) {
    weightBack += histogram[g];
    if (weightBack === 0) continue;
    const weightFore = total - weightBack;
    if (weightFore === 0) break;
    sumBack += g * histogram[g];
    const meanBack = sumBack / weightBack;
    const meanFore = (sumAll - sumBack) / weightFore;
    const between = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (between > best) { best = between; threshold = g; }
  }
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] > threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
}

const PSM_FOR: Record<Variant, "auto" | "sparse"> = { plain: "auto", clean: "sparse", binary: "auto" };

/** The id a variant is read under; the plain read keeps the region's own id. */
function variantId(id: string, variant: Variant): string {
  return variant === "plain" ? id : `${id}~${variant}`;
}

function baseId(id: string): string {
  return id.split("~")[0];
}

/**
 * Cuts the requested rectangles out of the screenshot, enlarged, in each
 * requested preparation.
 */
export const cropWithCanvas: Cropper = async (shot, rects) => {
  const blob = await (await fetch(shot.dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const crops: Crop[] = [];

  try {
    for (const rect of rects) {
      const x = Math.max(0, Math.floor(rect.x));
      const y = Math.max(0, Math.floor(rect.y));
      const w = Math.min(bitmap.width - x, Math.ceil(rect.w));
      const h = Math.min(bitmap.height - y, Math.ceil(rect.h));
      if (w <= 0 || h <= 0) continue;

      const width = Math.max(1, Math.ceil(w * rect.zoom));
      const height = Math.max(1, Math.ceil(h * rect.zoom));

      for (const variant of rect.variants ?? ["plain"]) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d", { willReadFrequently: variant !== "plain" });
        if (!ctx) continue;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, x, y, w, h, 0, 0, width, height);
        if (variant !== "plain") {
          const image = ctx.getImageData(0, 0, width, height);
          if (variant === "clean") clean(image);
          else binarise(image);
          ctx.putImageData(image, 0, 0);
        }
        crops.push({
          id: variantId(rect.id, variant),
          dataUrl: await canvasToDataUrl(canvas),
          x,
          y,
          zoom: rect.zoom,
          psm: PSM_FOR[variant],
        });
      }
    }
  } finally {
    bitmap.close();
  }

  return crops;
};

// ------------------------------------------------------------- reading lines

/** The character range each word occupies in its line's joined text. */
function wordRanges(line: OcrLine): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const word of line.words) {
    ranges.push({ start: cursor, end: cursor + word.text.length });
    cursor += word.text.length + 1;
  }
  return ranges;
}

/** The union box of the words a character span touches, in crop pixels. */
function boxForSpan(
  line: OcrLine,
  start: number,
  end: number,
): { x0: number; y0: number; x1: number; y1: number } | undefined {
  const ranges = wordRanges(line);
  let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
  for (let i = 0; i < line.words.length; i++) {
    const range = ranges[i];
    if (range.end <= start || range.start >= end) continue;
    const word = line.words[i];
    box = box
      ? {
          x0: Math.min(box.x0, word.x0),
          y0: Math.min(box.y0, word.y0),
          x1: Math.max(box.x1, word.x1),
          y1: Math.max(box.y1, word.y1),
        }
      : { x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1 };
  }
  return box;
}

/**
 * A picture's lines as one text, and a way back from a span of it to the
 * lines it covers. A value that wraps is covered on both lines.
 */
function joinLines(lines: OcrLine[]): {
  text: string;
  segments: (start: number, end: number) => { line: number; start: number; end: number }[];
} {
  const starts: number[] = [];
  let text = "";
  for (const line of lines) {
    if (starts.length > 0) text += "\n";
    starts.push(text.length);
    text += line.text;
  }
  return {
    text,
    segments(start, end) {
      const out: { line: number; start: number; end: number }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const from = starts[i];
        const to = from + lines[i].text.length;
        if (end <= from || start >= to) continue;
        out.push({ line: i, start: Math.max(start, from) - from, end: Math.min(end, to) - from });
      }
      return out;
    },
  };
}

export interface OcrOutcome {
  /** Pixel findings: OCR spans carrying a value, and burns for unread pictures. */
  findings: Finding[];
  /** Node ids whose wholesale burn can be lifted. */
  release: Set<number>;
  report: OcrReport;
}

let seq = 0;

/** One picture (or one band of the screenshot) as read, in one variant. */
interface Block {
  crop: Crop;
  region?: Region;
  lines: OcrLine[];
}

/**
 * Runs OCR over the screenshot and returns what must be burned because of it.
 *
 * Fails closed in every direction: no engine means nothing is released; a
 * picture that could not be read, or that there was no time for, is burned
 * whole; an engine error is reported and the rest of the pipeline proceeds as
 * though OCR had not been asked for.
 */
export async function ocrScreenshot(args: {
  dom: DomCapture;
  shot: ScreenshotMeta;
  viewport: Viewport;
  findings: Finding[];
  mode: OcrMode;
  engine?: OcrEngine;
  crop?: Cropper;
}): Promise<OcrOutcome> {
  const { dom, shot, viewport, findings, mode, engine } = args;
  const crop = args.crop ?? cropWithCanvas;
  const started = performance.now();

  const report: OcrReport = {
    mode,
    engine: engine?.name,
    regionsScanned: 0,
    regionsSkipped: 0,
    regionsFailed: 0,
    bandsScanned: 0,
    bandsFailed: 0,
    imagesRead: 0,
    linesRead: 0,
    spansDetected: 0,
    knownValuesCovered: 0,
    regionsReleased: 0,
    spansCorrected: 0,
    linesText: [],
    elapsedMs: 0,
  };
  const done = (out: Omit<OcrOutcome, "report">): OcrOutcome => {
    report.elapsedMs = Math.round(performance.now() - started);
    return { ...out, report };
  };

  if (mode === "off" || !engine) return done({ findings: [], release: new Set() });

  const imageW = shot.cssWidth * shot.scale;
  const imageH = shot.cssHeight * shot.scale;
  const clip = (box: { x: number; y: number; w: number; h: number }) => {
    const x0 = Math.max(0, box.x);
    const y0 = Math.max(0, box.y);
    const x1 = Math.min(imageW, box.x + box.w);
    const y1 = Math.min(imageH, box.y + box.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  // -- 1. what to read --------------------------------------------------------
  const regions = ocrRegions(dom, findings, (node) => {
    const box = clip(project(node.bbox, viewport, shot));
    return box.w > 1 && box.h > 1;
  });
  const chosen = regions.slice(0, MAX_REGIONS);
  const skipped = regions.slice(MAX_REGIONS);
  report.regionsSkipped = skipped.length;

  const requests: CropRequest[] = [];
  const byId = new Map<string, Region>();
  const zoomForRegions = regionZoom(shot.scale);

  for (const region of chosen) {
    const box = clip(project(region.node.bbox, viewport, shot));
    if (box.w <= 0 || box.h <= 0) continue;
    requests.push({
      id: region.id, x: box.x, y: box.y, w: box.w, h: box.h, zoom: zoomForRegions,
      variants: ["plain", "clean", "binary"],
    });
    byId.set(region.id, region);
  }

  if (mode === "full") {
    // The whole screenshot, in overlapping bands: one enormous image reads
    // worse and slower than several page-sized ones, and a line that falls on
    // a boundary is whole in one band or the other.
    const bandZoom = Math.min(3, Math.max(1, BAND_SCALE / shot.scale));
    let band = 0;
    for (let y = 0; y < imageH; y += BAND_HEIGHT - BAND_OVERLAP) {
      requests.push({
        id: `ocr-band-${band++}`, x: 0, y, w: imageW, h: Math.min(BAND_HEIGHT, imageH - y), zoom: bandZoom,
        variants: ["plain", "clean"],
      });
      if (y + BAND_HEIGHT >= imageH) break;
    }
  }

  const out: Finding[] = [];
  const release = new Set<number>();

  /** A picture that was not read is burned whole, never sent unread. */
  const burnUnread = (region: Region, why: string): void => {
    if (region.alreadyBurned) return;
    out.push({
      id: `ocr-${seq++}`,
      kind: "unverified_region",
      shape: "pixel",
      tier: 3,
      confidence: "high",
      nodeId: region.node.id,
      masked: "",
      bbox: region.node.bbox,
      why,
      action: "burn-region",
    });
  };
  for (const region of skipped) {
    burnUnread(region, "a picture beyond the OCR cap - burned because it was not read");
  }

  if (requests.length === 0) return done({ findings: out, release });

  // -- 2. read ----------------------------------------------------------------
  let crops: Crop[];
  let results;
  try {
    crops = await crop(shot, requests);
    report.imagesRead = crops.length;
    results = await engine.recognize(crops.map((c) => ({ id: c.id, dataUrl: c.dataUrl, psm: c.psm })));
  } catch (error) {
    report.error = `OCR failed: ${error instanceof Error ? error.message : String(error)}`;
    // Nothing was read, so nothing may be released - and every picture that
    // was going to be read goes out burned instead.
    for (const region of chosen) burnUnread(region, "a picture OCR could not read - burned rather than sent unread");
    return done({ findings: out, release: new Set() });
  }

  const cropById = new Map(crops.map((c) => [c.id, c]));
  const blocks: Block[] = [];
  const readOk = new Set<string>();

  for (const result of results) {
    const cropInfo = cropById.get(result.id);
    if (!cropInfo || result.error) continue;
    readOk.add(baseId(result.id));
    blocks.push({ crop: cropInfo, region: byId.get(baseId(result.id)), lines: result.lines });
    report.linesRead += result.lines.length;
    for (const line of result.lines) report.linesText.push(line.text);
  }

  for (const request of requests) {
    const region = byId.get(request.id);
    const ok = readOk.has(request.id);
    if (region) {
      if (ok) {
        report.regionsScanned++;
        if (region.releasable) release.add(region.node.id);
      } else {
        report.regionsFailed++;
        burnUnread(region, "a picture OCR could not read - burned rather than sent unread");
      }
    } else if (ok) {
      report.bandsScanned++;
    } else {
      report.bandsFailed++;
    }
  }

  // -- 3. scan what was read --------------------------------------------------
  const claimed = new Map<OcrLine, [number, number][]>();

  const emit = (
    block: Block,
    lineIndex: number,
    start: number,
    end: number,
    kind: PiiKind,
    confidence: Finding["confidence"],
    why: string,
    counter: "spansDetected" | "knownValuesCovered" | "spansCorrected",
    value: string,
  ): void => {
    const line = block.lines[lineIndex];
    const taken = claimed.get(line) ?? [];
    if (taken.some(([a, b]) => start < b && end > a)) return;
    const box = boxForSpan(line, start, end);
    if (!box) return;
    taken.push([start, end]);
    claimed.set(line, taken);

    const height = box.y1 - box.y0;
    const padY = Math.max(2, height * OCR_BOX_PAD.y);
    const padX = Math.max(2, height * OCR_BOX_PAD.x);

    const { crop: c } = block;
    const sx = c.x + (box.x0 - padX) / c.zoom;
    const sy = c.y + (box.y0 - padY) / c.zoom;
    const sw = (box.x1 - box.x0 + padX * 2) / c.zoom;
    const sh = (box.y1 - box.y0 + padY * 2) / c.zoom;
    const bbox = unproject({ x: sx, y: sy, w: sw, h: sh }, viewport, shot);

    out.push({
      id: `ocr-${seq++}`,
      kind,
      shape: "pixel",
      tier: 3,
      confidence,
      nodeId: block.region?.node.id ?? 0,
      value,
      masked: mask(value),
      bbox,
      why,
      action: "burn-region",
      origin: "ocr",
    });
    report[counter]++;
  };

  // Values the tree already found, to look for in the picture too.
  //
  // The exact spelling is kept: correcting an OCR misreading needs the tree's
  // own string, or the corrected identifier would mint a different token from
  // the one the tree already has.
  const known = new Map<string, { kind: PiiKind; exact: string }>();
  const learn = (raw: string | undefined, kind: PiiKind): void => {
    if (!raw) return;
    const value = raw.replace(/\s+/g, " ").trim();
    if (!worthMatching(value)) return;
    const key = value.toLowerCase();
    if (!known.has(key)) known.set(key, { kind, exact: value });
  };
  for (const finding of findings) {
    if (finding.shape === "text") learn(finding.value, finding.kind);
  }
  const knownExact = () => [...known.values()].map((k) => ({ value: k.exact, kind: k.kind }));

  for (const block of blocks) {
    if (block.lines.length === 0) continue;

    // Detectors over the whole picture's text, so a label on one line is
    // context for the value on the next.
    const joined = joinLines(block.lines);
    for (const hit of await scanText(joined.text)) {
      if (!hit.span || !hit.value) continue;
      for (const seg of joined.segments(hit.span[0], hit.span[1])) {
        emit(block, seg.line, seg.start, seg.end, hit.kind, hit.confidence,
          `read from image pixels by OCR - ${hit.why}`, "spansDetected", hit.value);
      }
      // What one picture gave away is looked for in every other: the same
      // number printed small, blurred or split elsewhere is still the number.
      // Only what was found with confidence, and long enough not to match
      // ordinary words - a mistake here would spread to every picture.
      if ((hit.confidence === "certain" || hit.confidence === "high") &&
          hit.value.replace(/[^\p{L}\p{N}]/gu, "").length >= 6) {
        learn(hit.value, hit.kind);
      }
    }

    // Identifiers the detectors could not see because OCR bent a character:
    // an S in a digit slot, an O where a zero must be.
    for (let i = 0; i < block.lines.length; i++) {
      const line = block.lines[i];
      for (const hit of correctIdentifiers(line.text, knownExact())) {
        emit(block, i, hit.start, hit.end, hit.kind, hit.proven ? "certain" : "high",
          hit.corrections === 0
            ? `read from image pixels by OCR - ${hit.why}`
            : `read from image pixels by OCR as "${hit.read}", ${hit.corrections} character(s) corrected by shape - ${hit.why}`,
          "spansCorrected", hit.value);
        learn(hit.value, hit.kind);
      }
    }
  }

  // A picture of a table - a screenshot of a spreadsheet, a class list, a
  // customer register - names nobody with a label of their own. The column
  // header is the label: whatever starts under "Name" is a name.
  for (const block of blocks) {
    for (const { line: headerLine, word: header, text: headerText } of nameHeaders(block.lines)) {
      const height = Math.max(1, header.y1 - header.y0);
      const tolerance = height * 1.3;
      const single = takesSingleWord(headerText);
      const below = block.lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line !== headerLine && line.y0 >= headerLine.y1 - height * 0.3)
        .sort((a, b) => a.line.y0 - b.line.y0);
      let lastBottom = headerLine.y1;
      let misses = 0;
      for (const { line, index } of below) {
        // A gap of several rows means the table has ended.
        if (line.y0 - lastBottom > height * 3) break;
        const words = line.words;
        const first = words.findIndex((w) => Math.abs(w.x0 - header.x0) <= tolerance);
        if (first < 0) continue;
        lastBottom = Math.max(lastBottom, line.y1);
        let last = first;
        while (
          last + 1 < words.length && last - first < 4 &&
          /^\p{Lu}[\p{L}.'’-]*$/u.test(words[last + 1].text) &&
          words[last + 1].x0 - words[last].x1 < height * 1.6
        ) last++;
        const phrase = words.slice(first, last + 1).map((w) => w.text).join(" ");
        if (!looksLikeNameCell(phrase, single)) {
          if (++misses >= 3) break;
          continue;
        }
        misses = 0;
        const ranges = wordRanges(line);
        emit(block, index, ranges[first].start, ranges[last].end, "person_name", "high",
          "read from image pixels by OCR - under a column headed as names", "spansDetected", phrase);
        learn(phrase, "person_name");
      }
    }
  }

  // And every value known by now - from the tree, or from any picture -
  // wherever any picture shows it, however OCR spelt it.
  for (const block of blocks) {
    for (let i = 0; i < block.lines.length; i++) {
      const line = block.lines[i];
      for (const { kind, exact } of known.values()) {
        for (const [start, end] of findApprox(line.text, exact)) {
          emit(block, i, start, end, kind, "high",
            "read from image pixels by OCR - a value already found elsewhere on this page", "knownValuesCovered", exact);
        }
      }
    }
  }

  report.regionsReleased = release.size;
  return done({ findings: dedupe(out), release });
}

/**
 * Words that head a column of names: "Name", "Customer", "Full Name".
 *
 * A column header stands apart - the next header is a column away. "Name:"
 * with a colon, or "Name" with its value right beside it, is a label for a
 * value on the same line, which the cue detector already reads; treating it
 * as a column head made everything left-aligned below an ID card's "Name:"
 * into a name.
 */
function nameHeaders(lines: OcrLine[]): { line: OcrLine; word: OcrLine["words"][number]; text: string }[] {
  const out: { line: OcrLine; word: OcrLine["words"][number]; text: string }[] = [];
  for (const line of lines) {
    const words = line.words;
    for (let i = 0; i < words.length; i++) {
      const pairLast = i + 1 < words.length ? words[i + 1] : undefined;
      const pair = pairLast ? `${words[i].text} ${pairLast.text}` : "";
      const usePair = !!pair && isNameHeader(pair);
      if (!usePair && !isNameHeader(words[i].text)) continue;
      const lastWord = usePair ? pairLast! : words[i];
      if (/:$/.test(lastWord.text)) continue;
      const height = Math.max(1, lastWord.y1 - lastWord.y0);
      const next = words[words.indexOf(lastWord) + 1];
      if (next && next.x0 - lastWord.x1 < height * 2) continue;
      out.push({ line, word: words[i], text: usePair ? pair : words[i].text });
    }
  }
  return out;
}

/** The same value read in several variants lands in nearly the same place; paint it once. */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.kind}|${f.value ?? ""}|${f.nodeId}|${f.bbox.map((v) => Math.round(v / 3)).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

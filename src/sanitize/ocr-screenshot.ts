import type { CapturedNode, DomCapture, ScreenshotMeta, Viewport } from "../capture/types";
import { walkCapture } from "../capture/dom";
import { scanText } from "../pii/detect";
import { correctIdentifiers } from "../pii/ocr-correct";
import type { OcrEngine, OcrLine } from "../pii/ocr";
import type { Finding, PiiKind } from "../pii/types";
import { mask } from "../pii/types";
import { NEVER_ALIGN } from "../pii/entities";
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
 * This runs OCR over the image-shaped regions of the page, scans what it reads
 * with the same detectors that scan the tree, and turns each hit into a region
 * to burn - a region that carries the *value*, so it is tokenized through the
 * vault rather than merely blacked out. The number in the picture and the
 * number in the tree get the same token, which is the whole idea.
 *
 * It also looks for values the tree already found. A name learnt from the
 * page's own markup will not match any pattern, but it will match itself, and
 * it is covered wherever the picture shows it.
 */

export type OcrMode = "off" | "images" | "full";

export interface OcrReport {
  mode: OcrMode;
  engine?: string;
  regionsScanned: number;
  /** Regions there was no time for - the largest are taken first. */
  regionsSkipped: number;
  regionsFailed: number;
  linesRead: number;
  /** Findings made by running the detectors over OCR text. */
  spansDetected: number;
  /** Findings made by matching values the tree had already found. */
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

/** A piece of the screenshot handed to the engine, and how to map it back. */
export interface Crop {
  id: string;
  dataUrl: string;
  /** Screenshot-pixel origin of this crop. */
  x: number;
  y: number;
  /** Crop pixels per screenshot pixel; small text is enlarged before OCR. */
  zoom: number;
}

export interface CropRequest {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The whole screenshot is not enlarged; it is already large. */
  zoom: number;
}

export type Cropper = (shot: ScreenshotMeta, rects: CropRequest[]) => Promise<Crop[]>;

/** Smaller than this and there is no legible text to read. */
const MIN_REGION_W = 40;
const MIN_REGION_H = 14;

/** Regions per step. The largest are read first; the rest are reported. */
const MAX_REGIONS = 12;

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
}

/**
 * Which regions of the page are worth reading.
 *
 * Anything that paints an image and is big enough to hold text, except the
 * regions already going to be destroyed whole - a face is not read, it is
 * burned. A canvas is the exception: it is burned whole today because its
 * contents are opaque to the DOM, and OCR is exactly what makes them not.
 */
export function ocrRegions(dom: DomCapture, findings: Finding[]): Region[] {
  const burned = new Map<number, Finding>();
  for (const finding of findings) {
    if (finding.shape === "pixel" && finding.action === "burn-region") {
      burned.set(finding.nodeId, finding);
    }
  }

  const regions: Region[] = [];
  for (const node of walkCapture(dom.root)) {
    if (!node.visible) continue;
    const paintsImage = IMAGE_TAGS.has(node.tag) || !!node.attrs.bgHost;
    if (!paintsImage) continue;
    if (node.bbox[2] < MIN_REGION_W || node.bbox[3] < MIN_REGION_H) continue;

    const burn = burned.get(node.id);
    // The canvas heuristic burns at "low" confidence precisely because it
    // knows nothing; a read replaces that guess with knowledge.
    const releasable = node.tag === "canvas" && !!burn && burn.confidence === "low";
    if (burn && OPAQUE_KINDS.has(burn.kind) && !releasable) continue;

    regions.push({ id: `ocr-${node.id}`, node, releasable });
  }

  // Largest first, so a cap falls on thumbnails rather than the main image.
  regions.sort((a, b) => b.node.bbox[2] * b.node.bbox[3] - a.node.bbox[2] * a.node.bbox[3]);
  return regions;
}

/**
 * Cuts the requested rectangles out of the screenshot.
 *
 * Small text is enlarged: Tesseract wants glyphs around thirty pixels tall,
 * and a caption on a 1x display is half that. The zoom is carried on the crop
 * so word boxes can be mapped back.
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

      const canvas = new OffscreenCanvas(Math.ceil(w * rect.zoom), Math.ceil(h * rect.zoom));
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, x, y, w, h, 0, 0, canvas.width, canvas.height);

      crops.push({ id: rect.id, dataUrl: await canvasToDataUrl(canvas), x, y, zoom: rect.zoom });
    }
  } finally {
    bitmap.close();
  }

  return crops;
};

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

export interface OcrOutcome {
  /** Pixel findings carrying the value read, to burn and tokenize. */
  findings: Finding[];
  /** Node ids whose wholesale burn can be lifted. */
  release: Set<number>;
  report: OcrReport;
}

let seq = 0;

/**
 * Runs OCR over the screenshot and returns what must be burned because of it.
 *
 * Fails closed in every direction: no engine means nothing is released; a
 * region that could not be read keeps whatever burn it already had; an engine
 * error is reported and the rest of the pipeline proceeds as though OCR had
 * not been asked for.
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

  // -- 1. what to read --------------------------------------------------------
  const regions = ocrRegions(dom, findings);
  const chosen = regions.slice(0, MAX_REGIONS);
  report.regionsSkipped = regions.length - chosen.length;

  const requests: CropRequest[] = [];
  const byId = new Map<string, Region>();
  // Enlarge text on low-density displays; a 2x screenshot is already crisp.
  const zoom = shot.scale >= 2 ? 1 : 2;

  for (const region of chosen) {
    const box = project(region.node.bbox, viewport, shot);
    if (box.w <= 0 || box.h <= 0) continue;
    requests.push({ id: region.id, x: box.x, y: box.y, w: box.w, h: box.h, zoom });
    byId.set(region.id, region);
  }

  if (mode === "full") {
    // The whole screenshot, at its own size: enlarging a full page would cost
    // seconds for text that is already legible.
    requests.push({ id: "ocr-full", x: 0, y: 0, w: Number.MAX_SAFE_INTEGER, h: Number.MAX_SAFE_INTEGER, zoom: 1 });
  }

  if (requests.length === 0) return done({ findings: [], release: new Set() });

  // -- 2. read ----------------------------------------------------------------
  let crops: Crop[];
  let results;
  try {
    crops = await crop(shot, requests);
    results = await engine.recognize(crops.map((c) => ({ id: c.id, dataUrl: c.dataUrl })));
  } catch (error) {
    report.error = `OCR failed: ${error instanceof Error ? error.message : String(error)}`;
    return done({ findings: [], release: new Set() });
  }

  const cropById = new Map(crops.map((c) => [c.id, c]));

  // Values the tree already found, to look for in the picture too.
  //
  // The exact spelling is kept alongside the lowercased lookup key: a literal
  // match needs the key, but correcting an OCR misreading needs the tree's own
  // string, or the corrected identifier would mint a different token from the
  // one the tree already has.
  const known = new Map<string, { kind: PiiKind; exact: string }>();
  for (const finding of findings) {
    if (finding.shape !== "text" || !finding.value) continue;
    const value = finding.value.replace(/\s+/g, " ").trim();
    if (!worthMatching(value)) continue;
    if (!known.has(value.toLowerCase())) {
      known.set(value.toLowerCase(), { kind: finding.kind, exact: value });
    }
  }
  const knownExact = [...known.values()].map((k) => ({ value: k.exact, kind: k.kind }));

  const out: Finding[] = [];
  const release = new Set<number>();

  // -- 3. scan what was read --------------------------------------------------
  for (const result of results) {
    const cropInfo = cropById.get(result.id);
    if (!cropInfo) continue;
    const region = byId.get(result.id);

    if (result.error) {
      report.regionsFailed++;
      continue;
    }
    report.regionsScanned++;
    report.linesRead += result.lines.length;
    if (region?.releasable) release.add(region.node.id);

    const nodeId = region?.node.id ?? 0;

    for (const line of result.lines) {
      const claimed: [number, number][] = [];
      const free = (s: number, e: number): boolean => !claimed.some(([a, b]) => s < b && e > a);

      const emit = (
        start: number,
        end: number,
        kind: PiiKind,
        confidence: Finding["confidence"],
        why: string,
        counter: "spansDetected" | "knownValuesCovered" | "spansCorrected",
        /** The value to tokenize when it differs from what was read. */
        corrected?: string,
      ): void => {
        if (!free(start, end)) return;
        const box = boxForSpan(line, start, end);
        if (!box) return;
        claimed.push([start, end]);

        // Crop pixels -> screenshot pixels -> viewport CSS pixels.
        const sx = cropInfo.x + box.x0 / cropInfo.zoom;
        const sy = cropInfo.y + box.y0 / cropInfo.zoom;
        const sw = (box.x1 - box.x0) / cropInfo.zoom;
        const sh = (box.y1 - box.y0) / cropInfo.zoom;
        const bbox = unproject({ x: sx, y: sy, w: sw, h: sh }, viewport, shot);

        // The vault gets the identifier as it should read, so it joins with the
        // same identifier in the tree; the box still covers what was painted.
        const value = corrected ?? line.text.slice(start, end);
        out.push({
          id: `ocr-${seq++}`,
          kind,
          shape: "pixel",
          tier: 3,
          confidence,
          nodeId,
          value,
          masked: mask(value),
          bbox,
          why,
          action: "burn-region",
          origin: "ocr",
        });
        report[counter]++;
      };

      report.linesText.push(line.text);

      // Detectors over the line, exactly as over a tree node's text.
      const hits = await scanText(line.text);
      for (const hit of hits) {
        if (!hit.span) continue;
        emit(hit.span[0], hit.span[1], hit.kind, hit.confidence,
          `read from image pixels by OCR - ${hit.why}`, "spansDetected");
      }

      // Then the identifiers the detectors could not see because OCR bent a
      // character: an S in a digit slot, an O where a zero must be. Anything
      // the detectors already claimed is skipped by emit's overlap check.
      for (const hit of correctIdentifiers(line.text, knownExact)) {
        emit(hit.start, hit.end, hit.kind, hit.proven ? "certain" : "high",
          hit.corrections === 0
            ? `read from image pixels by OCR - ${hit.why}`
            : `read from image pixels by OCR as "${hit.read}", ${hit.corrections} character(s) corrected by shape - ${hit.why}`,
          "spansCorrected", hit.value);
      }

      // And the values the tree already knows, wherever the picture shows them.
      const lower = line.text.toLowerCase();
      for (const [value, { kind }] of known) {
        let at = lower.indexOf(value);
        while (at !== -1) {
          emit(at, at + value.length, kind, "high",
            "read from image pixels by OCR - a value the page's own markup names", "knownValuesCovered");
          at = lower.indexOf(value, at + 1);
        }
      }
    }
  }

  report.regionsReleased = release.size;
  return done({ findings: out, release });
}

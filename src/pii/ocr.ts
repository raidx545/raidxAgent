/**
 * What an OCR engine looks like to the sanitizer.
 *
 * The screenshot is the one channel the DOM detectors cannot see into. A phone
 * number baked into a product image, a scanned invoice, a chat screenshot, the
 * whole of a canvas-rendered document - none of it is text as far as the tree
 * is concerned, and all of it is text as far as the model is concerned. OCR is
 * how those pixels get read before they are sent.
 *
 * The engine is an interface rather than an import because the real one -
 * Tesseract in a Web Worker - can only run in the offscreen document, while
 * sanitization runs in the service worker and in tests. The service worker
 * talks to it over messages; tests hand in a fake.
 */

export interface OcrWord {
  text: string;
  /** Pixel box within the image that was recognised. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 0-100. */
  confidence: number;
}

export interface OcrLine {
  /** The words joined by single spaces - the string spans index into. */
  text: string;
  words: OcrWord[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

export interface OcrImage {
  id: string;
  /** PNG or JPEG data URL. */
  dataUrl: string;
}

export interface OcrResult {
  id: string;
  lines: OcrLine[];
  /** Set when this image could not be read; `lines` is then empty. */
  error?: string;
  ms: number;
}

export interface OcrEngine {
  readonly name: string;
  /** Reads every image; one failing does not fail the batch. */
  recognize(images: OcrImage[]): Promise<OcrResult[]>;
  /** Whether recognition can be attempted at all right now. */
  available(): Promise<boolean>;
}

/** Messages between the service worker and the offscreen document. */
export type OcrRequest =
  | { kind: "ocr:recognize"; images: OcrImage[] }
  | { kind: "ocr:status" };

export type OcrResponse =
  | { ok: true; kind: "recognized"; results: OcrResult[] }
  | { ok: true; kind: "status"; ready: boolean; engine: string; error?: string }
  | { ok: false; error: string };

/** Words below this are noise - a smudge Tesseract guessed a letter for. */
export const MIN_WORD_CONFIDENCE = 30;

/**
 * Turns a recogniser's block tree into flat lines, dropping low-confidence
 * words. Lines are what the detectors scan: a phone number is one line, never
 * split across two.
 */
export function flattenBlocks(
  blocks: ReadonlyArray<{
    paragraphs: ReadonlyArray<{
      lines: ReadonlyArray<{
        words: ReadonlyArray<{
          text: string;
          confidence: number;
          bbox: { x0: number; y0: number; x1: number; y1: number };
        }>;
        confidence: number;
        bbox: { x0: number; y0: number; x1: number; y1: number };
      }>;
    }>;
  }> | null | undefined,
): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const words: OcrWord[] = line.words
          .filter((w) => w.text.trim().length > 0 && w.confidence >= MIN_WORD_CONFIDENCE)
          .map((w) => ({
            text: w.text.trim(),
            x0: w.bbox.x0,
            y0: w.bbox.y0,
            x1: w.bbox.x1,
            y1: w.bbox.y1,
            confidence: w.confidence,
          }));
        if (words.length === 0) continue;
        lines.push({
          text: words.map((w) => w.text).join(" "),
          words,
          x0: Math.min(...words.map((w) => w.x0)),
          y0: Math.min(...words.map((w) => w.y0)),
          x1: Math.max(...words.map((w) => w.x1)),
          y1: Math.max(...words.map((w) => w.y1)),
          confidence: line.confidence,
        });
      }
    }
  }
  return lines;
}

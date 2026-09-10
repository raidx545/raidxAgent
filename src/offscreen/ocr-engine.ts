import { createWorker, OEM, type Worker } from "tesseract.js";
import { flattenBlocks, type OcrImage, type OcrResult } from "../pii/ocr";

/**
 * Tesseract, running where it can.
 *
 * The recogniser is a WebAssembly build of Tesseract inside a Web Worker. A
 * service worker cannot spawn a Web Worker, so this lives in the offscreen
 * document beside the vault - the one realm in the extension that both allows
 * workers and outlives the service worker's idle timer, which matters because
 * loading the engine takes a second or two and is not something to repeat on
 * every step.
 *
 * Nothing is fetched from the network. Manifest V3 forbids remote code, so the
 * worker script, the wasm core and the English language data are all copied
 * into the extension at build time and addressed by extension URL. The same
 * module runs unchanged on a plain http page for testing, where the assets sit
 * beside it instead.
 */

/** Where the bundled Tesseract assets are, in whichever context this runs. */
function assetBase(): string {
  const runtime = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } })
    .chrome?.runtime;
  if (runtime?.getURL) return runtime.getURL("tesseract");
  return new URL("tesseract", location.href).href.replace(/\/$/, "");
}

/** A single image is given this long before it is given up on. */
const IMAGE_TIMEOUT_MS = 12_000;

let workerPromise: Promise<Worker> | undefined;
let lastError: string | undefined;

/** The engine, loaded on first use and kept for the life of the document. */
export function engine(): Promise<Worker> {
  workerPromise ??= (async () => {
    const base = assetBase();
    try {
      // The bundled language data is the LSTM-only "best_int" set, so the
      // engine is told to use LSTM only; the legacy engine would look for
      // data that is not there.
      const worker = await createWorker("eng", OEM.LSTM_ONLY, {
        workerPath: `${base}/worker.min.js`,
        corePath: base,
        langPath: `${base}/lang`,
        // A blob: worker would need a CSP source MV3 does not permit; the
        // extension URL is loaded directly instead.
        workerBlobURL: false,
        gzip: true,
        // The data ships with the extension; caching it in IndexedDB would
        // only duplicate it.
        cacheMethod: "none",
        logger: () => {},
      });
      lastError = undefined;
      return worker;
    } catch (error) {
      // Let the next call try again rather than caching the failure forever.
      workerPromise = undefined;
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  })();
  return workerPromise;
}

export function engineStatus(): { ready: boolean; error?: string } {
  return { ready: workerPromise !== undefined && lastError === undefined, error: lastError };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Reads every image in turn. One worker, so they are sequential; a failure on
 * one is reported on that one and the rest still run.
 */
export async function recognizeImages(images: OcrImage[]): Promise<OcrResult[]> {
  const worker = await engine();
  const results: OcrResult[] = [];

  for (const image of images) {
    const started = performance.now();
    try {
      const { data } = await withTimeout(
        worker.recognize(image.dataUrl, {}, { text: true, blocks: true }),
        IMAGE_TIMEOUT_MS,
        `OCR of ${image.id}`,
      );
      results.push({
        id: image.id,
        lines: flattenBlocks(data.blocks),
        ms: Math.round(performance.now() - started),
      });
    } catch (error) {
      results.push({
        id: image.id,
        lines: [],
        error: error instanceof Error ? error.message : String(error),
        ms: Math.round(performance.now() - started),
      });
    }
  }

  return results;
}

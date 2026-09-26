import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { flattenBlocks, type OcrImage, type OcrResult } from "../pii/ocr";

/**
 * Tesseract, running where it can.
 *
 * The recogniser is a WebAssembly build of Tesseract inside Web Workers. A
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
 *
 * There is a pool of workers, not one. Every screenshot is now read several
 * times - each picture in several preprocessed variants, the whole page in
 * overlapping bands - and one worker reading them in turn made that the
 * slowest part of every step. Recognition is CPU-bound and embarrassingly
 * parallel, so the pool is sized to the machine.
 */

/** Where the bundled Tesseract assets are, in whichever context this runs. */
function assetBase(): string {
  const runtime = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } })
    .chrome?.runtime;
  if (runtime?.getURL) return runtime.getURL("tesseract");
  return new URL("tesseract", location.href).href.replace(/\/$/, "");
}

/** A single image is given this long before it is given up on. */
const IMAGE_TIMEOUT_MS = 30_000;

/** Workers in the pool: one per core, within reason. */
const POOL_SIZE = Math.max(2, Math.min(8, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1));

interface PoolWorker {
  worker: Worker;
  /** The reading mode it is currently set to. */
  mode: NonNullable<OcrImage["psm"]>;
  busy: boolean;
}

let poolPromise: Promise<PoolWorker[]> | undefined;
let lastError: string | undefined;

async function makeWorker(base: string): Promise<PoolWorker> {
  // The bundled language data is the LSTM-only "best_int" set, so the engine
  // is told to use LSTM only; the legacy engine would look for data that is
  // not there.
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: `${base}/worker.min.js`,
    corePath: base,
    langPath: `${base}/lang`,
    // A blob: worker would need a CSP source MV3 does not permit; the
    // extension URL is loaded directly instead.
    workerBlobURL: false,
    gzip: true,
    // The data ships with the extension; caching it in IndexedDB would only
    // duplicate it.
    cacheMethod: "none",
    logger: () => {},
  });
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    // Keep the spaces between words as printed: "98765 43210" is a phone
    // number, and so is "9876543210", but the boxes differ.
    preserve_interword_spaces: "1",
  });
  return { worker, mode: "auto", busy: false };
}

/** The pool, loaded on first use and kept for the life of the document. */
function pool(): Promise<PoolWorker[]> {
  poolPromise ??= (async () => {
    const base = assetBase();
    try {
      // The first worker proves the assets load; the rest follow in parallel.
      const first = await makeWorker(base);
      const rest = await Promise.all(
        Array.from({ length: POOL_SIZE - 1 }, () => makeWorker(base).catch(() => undefined)),
      );
      lastError = undefined;
      return [first, ...rest.filter((w): w is PoolWorker => w !== undefined)];
    } catch (error) {
      // Let the next call try again rather than caching the failure forever.
      poolPromise = undefined;
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  })();
  return poolPromise;
}

/** Kept for callers that only need to know the engine loads. */
export async function engine(): Promise<Worker> {
  return (await pool())[0].worker;
}

export function engineStatus(): { ready: boolean; error?: string } {
  return { ready: poolPromise !== undefined && lastError === undefined, error: lastError };
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

/** Engine parameters for each reading mode. */
const MODE: Record<NonNullable<OcrImage["psm"]>, { tessedit_pageseg_mode: PSM; tessedit_char_whitelist: string }> = {
  // Blocks and paragraphs: documents, cards, anything laid out as text.
  auto: { tessedit_pageseg_mode: PSM.AUTO, tessedit_char_whitelist: "" },
  // Find as much text as possible in no particular order: UI screenshots,
  // banners, labels scattered across a picture. Reads what AUTO drops.
  sparse: { tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: "" },
  // A machine-readable zone: capitals, digits and the filler chevron, and
  // nothing else. The ordinary modes drop a line that is mostly "<" - the
  // restricted alphabet is what makes Tesseract read it at all.
  mrz: { tessedit_pageseg_mode: PSM.SINGLE_BLOCK, tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<" },
};

async function readOne(slot: PoolWorker, image: OcrImage): Promise<OcrResult> {
  const started = performance.now();
  try {
    const mode = image.psm ?? "auto";
    if (slot.mode !== mode) {
      await slot.worker.setParameters(MODE[mode]);
      slot.mode = mode;
    }
    const { data } = await withTimeout(
      slot.worker.recognize(image.dataUrl, {}, { text: true, blocks: true }),
      IMAGE_TIMEOUT_MS,
      `OCR of ${image.id}`,
    );
    return { id: image.id, lines: flattenBlocks(data.blocks), ms: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      id: image.id,
      lines: [],
      error: error instanceof Error ? error.message : String(error),
      ms: Math.round(performance.now() - started),
    };
  }
}

/** Images waiting for a worker, across every call. */
const queue: { image: OcrImage; resolve: (result: OcrResult) => void }[] = [];

/**
 * Hands waiting images to idle workers. A worker belongs to one image at a
 * time - two calls running at once must never both drive the same worker, or
 * one of them changes its segmentation mode under the other.
 */
function pump(workers: PoolWorker[]): void {
  for (const slot of workers) {
    if (slot.busy || queue.length === 0) continue;
    const job = queue.shift()!;
    slot.busy = true;
    void readOne(slot, job.image).then((result) => {
      slot.busy = false;
      job.resolve(result);
      pump(workers);
    });
  }
}

/**
 * Reads every image, as many at once as there are workers. A failure on one
 * is reported on that one and the rest still run; results come back in the
 * order the images were given.
 */
export async function recognizeImages(images: OcrImage[]): Promise<OcrResult[]> {
  const workers = await pool();
  return Promise.all(images.map((image) => new Promise<OcrResult>((resolve) => {
    queue.push({ image, resolve });
    pump(workers);
  })));
}

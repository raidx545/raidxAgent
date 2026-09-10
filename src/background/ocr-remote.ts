import type { OcrEngine, OcrImage, OcrRequest, OcrResponse, OcrResult } from "../pii/ocr";
import { ensureOffscreenDocument } from "../vault/remote";

/**
 * The OCR engine as seen from the service worker: a message to the offscreen
 * document, which holds the actual Tesseract worker.
 *
 * Images cross as data URLs. A cropped image region is a few tens of
 * kilobytes; a whole screenshot is a megabyte or two, well within what the
 * message channel carries, and nothing here is on the hot path more than once
 * per step.
 */
export function remoteOcr(): OcrEngine {
  const send = async (request: OcrRequest): Promise<OcrResponse> => {
    const hosted = await ensureOffscreenDocument();
    if (!hosted) return { ok: false, error: "No offscreen document is available to run OCR in." };
    const response = (await chrome.runtime.sendMessage(request)) as OcrResponse | undefined;
    return response ?? { ok: false, error: "The OCR host did not reply." };
  };

  return {
    name: "Tesseract (offscreen document)",

    async available(): Promise<boolean> {
      try {
        const response = await send({ kind: "ocr:status" });
        return response.ok;
      } catch {
        return false;
      }
    },

    async recognize(images: OcrImage[]): Promise<OcrResult[]> {
      if (images.length === 0) return [];
      const response = await send({ kind: "ocr:recognize", images });
      if (!response.ok) throw new Error(response.error);
      if (response.kind !== "recognized") throw new Error("The OCR host returned the wrong reply.");
      return response.results;
    },
  };
}

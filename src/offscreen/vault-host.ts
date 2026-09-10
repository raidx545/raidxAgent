import { Vault } from "../vault/vault";
import type { VaultRequest, VaultResponse } from "../vault/protocol";
import type { OcrRequest, OcrResponse } from "../pii/ocr";
import { engine, engineStatus, recognizeImages } from "./ocr-engine";

/**
 * Owns the one true vault, and the OCR engine.
 *
 * This document is never displayed. Its whole purpose is to be a JavaScript
 * realm that Chrome will not tear down on the service worker's schedule, so
 * that token mappings survive a worker restart in the middle of a task - and,
 * since it is also the one realm here that may spawn a Web Worker, it is where
 * Tesseract runs. Loading the engine costs a second or two once; keeping it
 * here means once per session rather than once per step.
 */
const vault = new Vault();

// Start loading the engine now, so the first screenshot does not wait for it.
void engine().catch(() => undefined);

chrome.runtime.onMessage.addListener(
  (request: OcrRequest, _sender, sendResponse: (response: OcrResponse) => void) => {
    if (typeof request?.kind !== "string" || !request.kind.startsWith("ocr:")) return false;

    switch (request.kind) {
      case "ocr:status": {
        const status = engineStatus();
        sendResponse({ ok: true, kind: "status", ready: status.ready, engine: "tesseract.js", error: status.error });
        return false;
      }

      case "ocr:recognize":
        recognizeImages(request.images).then(
          (results) => sendResponse({ ok: true, kind: "recognized", results }),
          (error) =>
            sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
        // Async reply: keep the channel open.
        return true;

      default:
        return false;
    }
  },
);

chrome.runtime.onMessage.addListener(
  (request: VaultRequest, _sender, sendResponse: (response: VaultResponse) => void) => {
    // Everything else in the extension also broadcasts on this channel, so
    // ignore anything that is not addressed to the vault.
    if (typeof request?.kind !== "string" || !request.kind.startsWith("vault:")) {
      return false;
    }

    try {
      switch (request.kind) {
        case "vault:mint": {
          const tokens = request.requests.map((entry) =>
            entry.op === "seal" ? vault.seal(entry.kind) : vault.tokenize(entry.value, entry.kind),
          );
          sendResponse({ ok: true, kind: "mint", tokens, size: vault.size });
          return false;
        }

        case "vault:resolve": {
          const result = vault.resolveAll(request.text);
          sendResponse({ ok: true, kind: "resolve", ...result });
          return false;
        }

        case "vault:values":
          sendResponse({ ok: true, kind: "values", values: vault.values() });
          return false;

        case "vault:view":
          sendResponse({
            ok: true,
            kind: "view",
            entries: vault.view(),
            size: vault.size,
            ageMs: vault.ageMs,
          });
          return false;

        case "vault:clear":
          vault.clear();
          sendResponse({ ok: true, kind: "cleared" });
          return false;

        case "vault:ping":
          sendResponse({ ok: true, kind: "pong" });
          return false;

        default:
          sendResponse({ ok: false, error: "Unknown vault request." });
          return false;
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },
);

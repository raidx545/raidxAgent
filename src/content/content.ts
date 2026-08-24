import type { ContentRequest, ActionResult } from "../shared/types";
import { act } from "./act";
import { snapshot } from "./perceive";

/**
 * The page-side half of the agent. It owns the only code that reads or touches
 * the DOM; the service worker drives it entirely through these messages.
 */
chrome.runtime.onMessage.addListener(
  (request: ContentRequest, _sender, sendResponse: (r: unknown) => void) => {
    switch (request.kind) {
      case "ping":
        sendResponse({ ok: true, detail: "alive" } satisfies ActionResult);
        return false;

      case "snapshot":
        sendResponse({ ok: true, detail: "snapshot", snapshot: snapshot() } satisfies ActionResult);
        return false;

      case "act":
        // Async work requires keeping the message channel open (return true).
        act(request.action).then(sendResponse);
        return true;

      default:
        sendResponse({ ok: false, detail: "Unknown request" } satisfies ActionResult);
        return false;
    }
  },
);

import type { ContentRequest, ActionResult } from "../shared/types";
import { act } from "./act";
import { captureDom } from "../capture/dom";
import { begin, scrollTo, end } from "../capture/fullpage";
import { spanRects } from "../capture/spans";

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

      case "capture":
        // The one view of the page: tree, roles, labels, values, bboxes. Both
        // the planner and the PII layer read this, and actions resolve against
        // the same ids, so there is no way for the two to disagree.
        sendResponse({ ok: true, detail: "capture", capture: captureDom() });
        return false;

      case "fullpage-begin":
        sendResponse({ ok: true, detail: "ready", page: begin() });
        return false;

      case "fullpage-scroll":
        scrollTo(request.y, request.hideSticky).then((page) =>
          sendResponse({ ok: true, detail: "scrolled", page }),
        );
        return true;

      case "fullpage-end":
        sendResponse({ ok: true, detail: "restored", page: end() });
        return false;

      case "span-rects":
        sendResponse({ ok: true, detail: "rects", rects: spanRects(request.requests) });
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

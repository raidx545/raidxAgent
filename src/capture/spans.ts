import { capturedElement, ownTextMap } from "./dom";

/**
 * Turns "characters 12 to 34 of node 87" into rectangles on screen.
 *
 * This is what makes the screenshot honest. The DOM tree can have an email
 * swapped for `<EMAIL_1>` while the screenshot still shows the address in
 * pixels - and if both go to the model, the tokenizing achieved nothing. To
 * cover it we need to know exactly where that text is painted, which the
 * browser will tell us via a Range, but only if we can map a span in our
 * whitespace-collapsed capture back to the original text nodes.
 *
 * Rectangles come back in *document* coordinates so they work against a
 * stitched full-page image as well as a viewport one.
 */

/** [x, y, width, height] in document CSS pixels. */
export type Rect = [number, number, number, number];

export interface SpanRectRequest {
  /** Echoed back so the caller can match results to findings. */
  findingId: string;
  nodeId: number;
  /** "text", "value", "label", or "attr:name". */
  field: string;
  /** Character range within that field. Absent means the whole element. */
  start?: number;
  end?: number;
}

export interface SpanRectResult {
  findingId: string;
  rects: Rect[];
  /**
   * How the rectangles were obtained:
   *   "range"   - exact, measured from the text itself
   *   "element" - the element's own box, because the text is not selectable
   *   "missing" - the node is gone; nothing to draw
   */
  precision: "range" | "element" | "missing";
}

function toDocumentRect(rect: DOMRect): Rect {
  return [
    Math.round((rect.left + scrollX) * 10) / 10,
    Math.round((rect.top + scrollY) * 10) / 10,
    Math.round(rect.width * 10) / 10,
    Math.round(rect.height * 10) / 10,
  ];
}

function elementRect(el: Element): Rect[] {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? [toDocumentRect(rect)] : [];
}

/**
 * Measures one span.
 *
 * Only a node's own text can be measured precisely: an `<input>` value has no
 * Range, and a label may live in a different element entirely. Those fall back
 * to the element's box, which over-covers rather than under-covers - the safe
 * direction when the alternative is leaving PII visible.
 */
function measure(request: SpanRectRequest): SpanRectResult {
  const el = capturedElement(request.nodeId);
  if (!el) return { findingId: request.findingId, rects: [], precision: "missing" };

  const wholeElement = (): SpanRectResult => ({
    findingId: request.findingId,
    rects: elementRect(el),
    precision: "element",
  });

  if (request.field !== "text" || request.start === undefined || request.end === undefined) {
    return wholeElement();
  }

  const { sources } = ownTextMap(el);
  const start = sources[request.start];
  // The end index is exclusive, so anchor on the last included character.
  const last = sources[Math.max(request.start, request.end - 1)];
  if (!start || !last) return wholeElement();

  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(last.node, last.offset + 1);

    // A wrapped span produces one rectangle per line, which is what we want:
    // filling the union would cover half the paragraph.
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map(toDocumentRect);

    range.detach?.();

    if (rects.length === 0) return wholeElement();
    return { findingId: request.findingId, rects, precision: "range" };
  } catch {
    return wholeElement();
  }
}

/** Measures a batch of spans in one pass. */
export function spanRects(requests: SpanRectRequest[]): SpanRectResult[] {
  return requests.map(measure);
}

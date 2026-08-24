import type { CapturedNode, DomCapture } from "../capture/types";
import { walkCapture } from "../capture/dom";
import type { Detector, Finding, PiiKind } from "./types";

/**
 * Tier 3: the pixel-shaped residue.
 *
 * Faces, signatures, and scanned ID cards cannot be found by pattern matching —
 * they need a model. This tier ships the *routing* for that: it identifies
 * which regions of the page are image-shaped and worth a model's attention,
 * and classifies them from the metadata the DOM already carries.
 *
 * These findings are `shape: "pixel"`, which means they can only ever be
 * destroyed on the canvas — never tokenized, never reversed. That is why the
 * bar here is "worth burning" rather than "certainly a face": a redacted stock
 * photo costs nothing, a leaked face costs everything.
 *
 * `setImageClassifier` is the seam where a real face/OCR model plugs in. Until
 * one does, `confidence` here is honest about being metadata-derived.
 */

/** What a real classifier would return for one image region. */
export interface ImageVerdict {
  kind: PiiKind;
  confidence: "certain" | "high" | "medium" | "low";
  why: string;
}

export interface ImageClassifier {
  name: string;
  /** Receives the region's bbox and, when available, its pixels. */
  classify(node: CapturedNode, bitmap?: ImageBitmap): Promise<ImageVerdict | undefined>;
}

let classifier: ImageClassifier | undefined;

/** Installs an ML classifier. Called by nothing yet — this is the seam. */
export function setImageClassifier(next: ImageClassifier | undefined): void {
  classifier = next;
}

export function activeClassifier(): string {
  return classifier?.name ?? "none (metadata heuristics only)";
}

const IMAGE_TAGS = new Set([
  "img", "canvas", "svg", "video", "picture", "object", "embed", "iframe", "frame",
]);

/** Hosts that serve profile pictures and essentially nothing else. */
const AVATAR_HOSTS = /(gravatar|ui-avatars|avatars\.githubusercontent|lh3\.googleusercontent|pbs\.twimg)/i;

const CUES: { pattern: RegExp; kind: PiiKind; confidence: ImageVerdict["confidence"]; why: string }[] = [
  {
    pattern: /\b(signature|sign here|e-?sign|autograph)\b/i,
    kind: "signature",
    confidence: "high",
    why: "labelled as a signature",
  },
  {
    pattern: /\b(aadhaar|aadhar|pan card|passport|licence|license|voter id|id ?card|kyc)\b/i,
    kind: "scanned_document",
    confidence: "high",
    why: "labelled as an identity document",
  },
  {
    pattern: /\b(qr|barcode)\b/i,
    kind: "qr_code",
    confidence: "high",
    why: "labelled as a QR or barcode",
  },
  {
    pattern: /\b(photo|photograph|selfie|portrait|headshot|profile ?(pic|picture|photo)|avatar|dp)\b/i,
    kind: "face_or_photo",
    confidence: "medium",
    why: "labelled as a personal photo",
  },
  {
    pattern: /\b(scan|scanned|upload(ed)? document|proof)\b/i,
    kind: "scanned_document",
    confidence: "low",
    why: "labelled as a scan or uploaded proof",
  },
];

/** Anything below this is an icon, not a photograph of anyone. */
const MIN_SIDE = 24;

function heuristic(node: CapturedNode): ImageVerdict | undefined {
  const [, , width, height] = node.bbox;
  if (width < MIN_SIDE || height < MIN_SIDE) return undefined;

  // A frame paints into the screenshot but contributes nothing to our tree, so
  // no text detector can ever see what is inside it. We cannot certify pixels
  // we were never able to read.
  //
  // Same-origin frames are burned too, which is not obvious: in principle they
  // *could* be walked, but the content script runs only in the top frame, so in
  // practice their contents are exactly as uninspected as a cross-origin
  // frame's. Exempting them on the strength of what is theoretically readable
  // would ship pixels nothing ever looked at. When frame walking lands, this is
  // the line to relax.
  if (node.tag === "iframe" || node.tag === "frame") {
    const host = node.attrs.frameHost ?? "an unknown host";
    return {
      kind: "unverified_region",
      confidence: "certain",
      why:
        node.attrs.crossOrigin === "false"
          ? `same-origin frame from ${host} - not walked by the content script, so never inspected`
          : `cross-origin frame from ${host} - contents cannot be inspected`,
    };
  }

  const haystack = [
    node.label,
    node.attrs.alt,
    node.attrs.title,
    node.attrs.id,
    node.attrs["data-testid"],
    node.attrs["aria-label"],
    node.attrs.srcHost,
  ]
    .filter(Boolean)
    .join(" ");

  const cue = CUES.find((c) => c.pattern.test(haystack));
  if (cue) return { kind: cue.kind, confidence: cue.confidence, why: cue.why };

  if (node.attrs.srcHost && AVATAR_HOSTS.test(node.attrs.srcHost)) {
    return {
      kind: "face_or_photo",
      confidence: "high",
      why: `served from ${node.attrs.srcHost}, an avatar host`,
    };
  }

  // A canvas is where signature pads and generated QR codes live, and its
  // contents are invisible to the DOM entirely.
  if (node.tag === "canvas") {
    return {
      kind: "scanned_document",
      confidence: "low",
      why: "canvas contents are opaque to the DOM — needs pixel inspection",
    };
  }

  // A small near-square image is the classic avatar shape.
  const ratio = width / height;
  if (node.tag === "img" && ratio > 0.8 && ratio < 1.25 && width < 160) {
    return {
      kind: "face_or_photo",
      confidence: "low",
      why: `${Math.round(width)}×${Math.round(height)} near-square image — avatar-shaped`,
    };
  }

  return undefined;
}

let seq = 0;

export const tier3Pixels: Detector = {
  tier: 3,
  name: "Pixel regions",

  async run(capture: DomCapture): Promise<Finding[]> {
    seq = 0;
    const findings: Finding[] = [];

    for (const node of walkCapture(capture.root)) {
      if (!IMAGE_TAGS.has(node.tag)) continue;

      const verdict = classifier
        ? await classifier.classify(node)
        : heuristic(node);

      if (!verdict) continue;

      findings.push({
        id: `t3-${seq++}`,
        kind: verdict.kind,
        shape: "pixel",
        tier: 3,
        confidence: verdict.confidence,
        nodeId: node.id,
        masked: `«${node.tag} ${Math.round(node.bbox[2])}×${Math.round(node.bbox[3])}»`,
        bbox: node.bbox,
        why: verdict.why,
        action: "burn-region",
      });
    }

    return findings;
  },
};

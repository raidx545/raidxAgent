import type { BBox, CapturedNode, DomCapture } from "../capture/types";

export type PiiKind =
  | "aadhaar"
  | "pan"
  | "gstin"
  | "payment_card"
  | "ifsc"
  | "bank_account"
  | "upi_id"
  | "passport"
  | "voter_id"
  | "vehicle_number"
  | "phone"
  | "email"
  | "ip_address"
  | "pincode"
  | "date_of_birth"
  | "person_name"
  | "org_name"
  | "postal_address"
  | "credential_field"
  | "payment_field"
  | "identity_field"
  | "face_or_photo"
  | "signature"
  | "scanned_document"
  | "qr_code"
  | "unverified_region";

/**
 * The central distinction from the architecture: text-shaped findings can be
 * tokenized and swapped back later; pixel-shaped ones can only be destroyed.
 */
export type Shape = "text" | "pixel";

/**
 * Which detector tier produced this. The pipeline runs them cheapest-first and
 * only escalates what the earlier tiers could not settle.
 */
export type Tier = 1 | 2 | 3;

export type Confidence = "certain" | "high" | "medium" | "low";

/** Where inside a node the match sits. */
export type Field = "text" | "value" | "label" | `attr:${string}`;

/**
 * How this finding must be neutralised. The detector decides, because it is
 * the only thing that knows what it matched - leaving the tokenizer to infer
 * it from confidence and field names would be guesswork.
 */
export type Neutralisation =
  /** Swap just the matched span inside the field. */
  | "replace-span"
  /** Swap the field's entire value - the whole thing is the PII. */
  | "replace-field"
  /** The field is filled but its contents were never captured: mint a token
   *  with nothing behind it, so the planner knows it is populated. */
  | "seal-field"
  /** Destroy the pixels in this region. Irreversible. */
  | "burn-region"
  /** Nothing to neutralise; the finding is informational. */
  | "none";

export interface Finding {
  id: string;
  kind: PiiKind;
  shape: Shape;
  tier: Tier;
  confidence: Confidence;
  /** Node in the capture tree this came from. */
  nodeId: number;
  /** Which part of that node. Undefined for pixel findings. */
  field?: Field;
  /** Character range within that field — span-level, not whole-string. */
  span?: [number, number];
  /** The matched substring. Never populated for credential fields. */
  value?: string;
  /** Display-safe rendering of `value`. */
  masked: string;
  /** Viewport-relative CSS pixels, for overlaying on the screenshot. */
  bbox: BBox;
  /** Why the detector fired, in one line. */
  why: string;
  /** What the sanitizer must do about it. */
  action: Neutralisation;
}

export interface DetectionResult {
  findings: Finding[];
  stats: {
    nodesScanned: number;
    charsScanned: number;
    /** Candidates a pattern matched but a checksum rejected. */
    checksumRejected: number;
    byTier: Record<Tier, number>;
    byShape: Record<Shape, number>;
    elapsedMs: number;
  };
}

/**
 * A detector tier. Each receives the capture plus whatever earlier tiers
 * already found, so it can skip ground that is already covered — this is the
 * "escalate only the residue" rule from the architecture.
 */
export interface Detector {
  tier: Tier;
  name: string;
  run(capture: DomCapture, found: Finding[]): Finding[] | Promise<Finding[]>;
}

/** Masks a value for display: keeps the shape, hides the content. */
export function mask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);

  if (trimmed.includes("@")) {
    const [user, domain] = trimmed.split("@");
    return `${user[0]}${"•".repeat(Math.max(1, user.length - 1))}@${domain}`;
  }

  const head = trimmed.slice(0, 2);
  const tail = trimmed.slice(-2);
  const middle = trimmed.slice(2, -2).replace(/[^\s-]/g, "•");
  return `${head}${middle}${tail}`;
}

/** Convenience for detectors: the text of a node's given field. */
export function fieldText(node: CapturedNode, field: Field): string {
  if (field === "text") return node.text ?? "";
  if (field === "value") return node.value ?? "";
  if (field === "label") return node.label ?? "";
  return node.attrs[field.slice(5)] ?? "";
}

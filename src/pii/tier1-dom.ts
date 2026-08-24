import type { DomCapture } from "../capture/types";
import { walkCapture } from "../capture/dom";
import type { Detector, Finding, PiiKind } from "./types";

/**
 * Tier 1: what the page tells us about itself.
 *
 * An input carrying `autocomplete="cc-number"` is a payment field with
 * certainty — no pattern matching, no checksum, no model. This tier is nearly
 * free and produces the most reliable findings on the page, which is exactly
 * why it runs first.
 */

/** The autocomplete tokens the HTML spec defines that imply personal data. */
const AUTOCOMPLETE: Record<string, PiiKind> = {
  "name": "person_name",
  "given-name": "person_name",
  "additional-name": "person_name",
  "family-name": "person_name",
  "nickname": "person_name",
  "honorific-prefix": "person_name",
  "honorific-suffix": "person_name",
  "organization": "org_name",
  "street-address": "postal_address",
  "address-line1": "postal_address",
  "address-line2": "postal_address",
  "address-line3": "postal_address",
  "address-level1": "postal_address",
  "address-level2": "postal_address",
  "postal-code": "pincode",
  "country": "postal_address",
  "country-name": "postal_address",
  "email": "email",
  "tel": "phone",
  "tel-national": "phone",
  "tel-local": "phone",
  "bday": "date_of_birth",
  "bday-day": "date_of_birth",
  "bday-month": "date_of_birth",
  "bday-year": "date_of_birth",
  "cc-number": "payment_field",
  "cc-name": "payment_field",
  "cc-exp": "payment_field",
  "cc-exp-month": "payment_field",
  "cc-exp-year": "payment_field",
  "cc-csc": "payment_field",
  "cc-type": "payment_field",
  "current-password": "credential_field",
  "new-password": "credential_field",
  "one-time-code": "credential_field",
  "username": "identity_field",
};

/** input[type] values that carry personal data by definition. */
const INPUT_TYPES: Record<string, PiiKind> = {
  password: "credential_field",
  email: "email",
  tel: "phone",
};

/**
 * Keyword signals on name/id/placeholder/label. Weaker than autocomplete — a
 * field called "pan" might be a cooking site — so these land at medium/high,
 * never certain.
 */
const KEYWORDS: { pattern: RegExp; kind: PiiKind; confidence: "high" | "medium" }[] = [
  { pattern: /\b(aadhaar|aadhar|uidai|आधार)\b/i, kind: "aadhaar", confidence: "high" },
  { pattern: /\bpan[\s_-]?(card|no|number)\b|\bpermanent account\b/i, kind: "pan", confidence: "high" },
  { pattern: /\bgstin?\b/i, kind: "gstin", confidence: "high" },
  { pattern: /\bifsc\b/i, kind: "ifsc", confidence: "high" },
  { pattern: /\b(account[\s_-]?(no|number)|acct[\s_-]?no)\b/i, kind: "bank_account", confidence: "high" },
  { pattern: /\b(upi|vpa)[\s_-]?(id)?\b/i, kind: "upi_id", confidence: "high" },
  { pattern: /\bpassport\b/i, kind: "passport", confidence: "high" },
  { pattern: /\b(voter|epic)[\s_-]?(id|no)\b/i, kind: "voter_id", confidence: "high" },
  { pattern: /\b(cvv|cvc|card[\s_-]?(no|number)|expiry)\b/i, kind: "payment_field", confidence: "high" },
  { pattern: /\b(password|passcode|pin)\b/i, kind: "credential_field", confidence: "high" },
  { pattern: /\b(otp|one[\s_-]?time)\b/i, kind: "credential_field", confidence: "high" },
  { pattern: /\b(api[\s_-]?key|secret|token)\b/i, kind: "credential_field", confidence: "medium" },
  { pattern: /\b(dob|date[\s_-]?of[\s_-]?birth|birth[\s_-]?date)\b/i, kind: "date_of_birth", confidence: "high" },
  { pattern: /\b(full[\s_-]?name|first[\s_-]?name|last[\s_-]?name|surname)\b/i, kind: "person_name", confidence: "medium" },
  { pattern: /\b(address|street|locality)\b/i, kind: "postal_address", confidence: "medium" },
  { pattern: /\b(pin[\s_-]?code|postal[\s_-]?code|zip)\b/i, kind: "pincode", confidence: "medium" },
  { pattern: /\b(mobile|phone|contact[\s_-]?(no|number))\b/i, kind: "phone", confidence: "medium" },
];

/** Fields whose contents we never record, not even masked. */
const NEVER_RECORD = new Set<PiiKind>(["credential_field", "payment_field"]);

let seq = 0;
const nextId = (): string => `t1-${seq++}`;

export const tier1DomSignals: Detector = {
  tier: 1,
  name: "DOM signals",

  run(capture: DomCapture): Finding[] {
    seq = 0;
    const findings: Finding[] = [];

    for (const node of walkCapture(capture.root)) {
      const isField =
        node.role === "textbox" ||
        node.role === "password" ||
        node.role === "select" ||
        node.tag === "input" ||
        node.tag === "textarea";

      if (!isField) continue;

      const autocomplete = (node.attrs.autocomplete ?? "").toLowerCase().trim();
      // Tokens may be prefixed, e.g. "shipping street-address" or "section-a tel".
      const token = autocomplete.split(/\s+/).find((t) => t in AUTOCOMPLETE);
      const type = (node.attrs.type ?? "").toLowerCase();

      let kind: PiiKind | undefined;
      let confidence: Finding["confidence"] = "medium";
      let why = "";

      if (token) {
        kind = AUTOCOMPLETE[token];
        confidence = "certain";
        why = `autocomplete="${autocomplete}" declares this field's purpose`;
      } else if (type in INPUT_TYPES) {
        kind = INPUT_TYPES[type];
        confidence = "certain";
        why = `input[type="${type}"] holds this data by definition`;
      } else {
        // Fall back to what the page calls the field.
        const haystack = [node.label, node.attrs.name, node.attrs.id, node.attrs.placeholder]
          .filter(Boolean)
          .join(" ");
        const hit = KEYWORDS.find((k) => k.pattern.test(haystack));
        if (hit) {
          kind = hit.kind;
          confidence = hit.confidence;
          why = `field named "${(node.label || node.attrs.name || node.attrs.id || "").slice(0, 40)}"`;
        }
      }

      if (!kind) continue;

      const record = !NEVER_RECORD.has(kind);
      const value = record ? node.value : undefined;

      // Is there anything in this field? For most fields the captured value
      // answers that. For a password the value is never captured at all, so the
      // capture layer records a single bit instead.
      const filled = node.value !== undefined || node.attrs.filled === "true";

      // Three distinct situations, and they need different handling:
      //   value captured  -> the whole field value is the PII, swap it
      //   filled but not captured (password) -> seal: a token with nothing
      //                      behind it, so the planner knows it is populated
      //   empty field     -> nothing to neutralise; the label is not PII
      const action: Finding["action"] = value
        ? "replace-field"
        : filled
          ? "seal-field"
          : "none";

      findings.push({
        id: nextId(),
        kind,
        shape: "text",
        tier: 1,
        confidence,
        nodeId: node.id,
        // Both replacing and sealing act on the value. Pointing a seal at the
        // label would tokenize the word "Password" and leave the planner
        // unable to recognise the form at all.
        field: action === "none" ? "label" : "value",
        value,
        masked: value
          ? maskShort(value)
          : filled
            ? "«filled, never captured»"
            : "«empty field»",
        bbox: node.bbox,
        why,
        action,
      });
    }

    return findings;
  },
};

function maskShort(value: string): string {
  if (value.length <= 4) return "•".repeat(value.length);
  return `${value.slice(0, 2)}${"•".repeat(value.length - 4)}${value.slice(-2)}`;
}

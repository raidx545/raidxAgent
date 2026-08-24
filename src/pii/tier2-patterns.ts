import type { CapturedNode, DomCapture } from "../capture/types";
import { walkCapture } from "../capture/dom";
import * as check from "./checksums";
import type { Confidence, Detector, Field, Finding, PiiKind } from "./types";
import { fieldText, mask } from "./types";

/**
 * Tier 2: pattern, then checksum.
 *
 * The pattern is the cheap filter; the validator is what makes the finding
 * trustworthy. `\d{12}` matches a timestamp, an order id, and an Aadhaar
 * number alike — the Verhoeff check is what tells them apart, and it cuts the
 * false-positive rate on random digits from 100% to about 10%.
 */

interface Rule {
  kind: PiiKind;
  /** Must be global; the scanner walks matches to get spans. */
  pattern: RegExp;
  /** Second gate. Returning false means the candidate is discarded. */
  validate?: (raw: string) => boolean;
  confidence: Confidence;
  why: string;
}

const RULES: Rule[] = [
  {
    kind: "aadhaar",
    pattern: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    validate: check.isAadhaar,
    confidence: "certain",
    why: "12 digits, valid Verhoeff check digit",
  },
  {
    kind: "payment_card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: check.isPaymentCard,
    confidence: "certain",
    why: "13–19 digits, valid Luhn check digit",
  },
  {
    kind: "pan",
    pattern: /\b[A-Za-z]{5}\d{4}[A-Za-z]\b/g,
    validate: check.isPan,
    confidence: "certain",
    why: "PAN format with a valid holder-type character",
  },
  {
    kind: "gstin",
    pattern: /\b\d{2}[A-Za-z]{5}\d{4}[A-Za-z][0-9A-Za-z]Z[0-9A-Za-z]\b/g,
    validate: check.isGstin,
    confidence: "certain",
    why: "GSTIN format with a valid mod-36 check character",
  },
  {
    kind: "ifsc",
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    validate: check.isIfsc,
    confidence: "high",
    why: "IFSC format: bank code, reserved 0, branch code",
  },
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: "certain",
    why: "RFC-shaped email address",
  },
  {
    kind: "upi_id",
    // Deliberately narrow: a VPA handle looks like an email but the suffix is
    // a known PSP handle, not a domain.
    pattern:
      /\b[A-Za-z0-9._-]{3,}@(?:ok(?:hdfcbank|icici|axis|sbi)|paytm|ybl|ibl|axl|upi|apl|jupiteraxis|fam|superyes)\b/gi,
    confidence: "high",
    why: "UPI virtual payment address with a known PSP handle",
  },
  {
    kind: "phone",
    pattern: /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g,
    validate: check.isIndianMobile,
    confidence: "high",
    why: "Indian mobile number: starts 6–9, ten digits",
  },
  {
    kind: "passport",
    pattern: /\b[A-PR-WYa-prwy][1-9]\d{5}[1-9]\b/g,
    validate: check.isIndianPassport,
    confidence: "medium",
    why: "Indian passport format",
  },
  {
    kind: "voter_id",
    pattern: /\b[A-Z]{3}\d{7}\b/g,
    validate: check.isVoterId,
    confidence: "medium",
    why: "EPIC / voter id format",
  },
  {
    kind: "vehicle_number",
    pattern: /\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{4}\b/g,
    validate: check.isVehicleNumber,
    confidence: "medium",
    why: "Indian vehicle registration format",
  },
  {
    kind: "ip_address",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    confidence: "high",
    why: "IPv4 address",
  },
  {
    kind: "date_of_birth",
    // Only dates sitting next to a birth-date cue; a bare date is not PII.
    pattern:
      /\b(?:dob|d\.o\.b\.?|date of birth|born(?: on)?)\b[:\s]*(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2})/gi,
    confidence: "high",
    why: "date immediately following a birth-date label",
  },
  {
    kind: "bank_account",
    // Very weak on its own — only reported when a nearby cue confirms it.
    pattern: /\b\d{9,18}\b/g,
    confidence: "low",
    why: "digit run in the length range of a bank account number",
  },
];

/** Kinds that only get reported when the surrounding text confirms them. */
const NEEDS_CONTEXT = new Map<PiiKind, RegExp>([
  ["bank_account", /\b(a\/c|acct|account|bank|ifsc|branch)\b/i],
  ["voter_id", /\b(voter|epic|election)\b/i],
  ["passport", /\b(passport|travel document)\b/i],
]);

/** Fields whose contents tier 1 already covered; no need to re-scan. */
const SCANNED_FIELDS: Field[] = [
  "text",
  "value",
  "label",
  "attr:alt",
  "attr:title",
  "attr:placeholder",
  // Identity annotations carry real addresses; they get the same treatment as
  // anything else that reaches the planner.
  "attr:email",
  "attr:data-email",
  "attr:data-hovercard-id",
  "attr:name",
];

let seq = 0;
let rejected = 0;

/** Longer, more specific findings win when two rules cover the same span. */
function dedupe(findings: Finding[]): Finding[] {
  const byNodeField = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = `${finding.nodeId}:${finding.field}`;
    const list = byNodeField.get(key) ?? [];
    list.push(finding);
    byNodeField.set(key, list);
  }

  const kept: Finding[] = [];
  for (const list of byNodeField.values()) {
    // Prefer certain over high over medium, then longer spans.
    const rank: Record<Confidence, number> = { certain: 0, high: 1, medium: 2, low: 3 };
    list.sort((a, b) => {
      const byConfidence = rank[a.confidence] - rank[b.confidence];
      if (byConfidence !== 0) return byConfidence;
      return (b.span![1] - b.span![0]) - (a.span![1] - a.span![0]);
    });

    const taken: [number, number][] = [];
    for (const finding of list) {
      const [start, end] = finding.span!;
      const overlaps = taken.some(([s, e]) => start < e && end > s);
      if (overlaps) continue;
      taken.push([start, end]);
      kept.push(finding);
    }
  }

  return kept;
}

function scanText(node: CapturedNode, field: Field, text: string): Finding[] {
  const found: Finding[] = [];
  if (!text) return found;

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rule.pattern.exec(text)) !== null) {
      // A zero-length match would spin forever.
      if (match[0].length === 0) {
        rule.pattern.lastIndex++;
        continue;
      }

      // Capture group 1, when present, is the part that is actually the PII
      // (the date in a "DOB: …" match, not the label).
      const raw = match[1] ?? match[0];
      const offset = match[1] ? match[0].indexOf(match[1]) : 0;
      const start = match.index + offset;

      if (rule.validate && !rule.validate(raw)) {
        rejected++;
        continue;
      }

      const context = NEEDS_CONTEXT.get(rule.kind);
      if (context) {
        const window = text.slice(Math.max(0, start - 60), start + raw.length + 60);
        if (!context.test(window)) continue;
      }

      found.push({
        id: `t2-${seq++}`,
        kind: rule.kind,
        shape: "text",
        tier: 2,
        confidence: rule.confidence,
        nodeId: node.id,
        field,
        span: [start, start + raw.length],
        value: raw,
        masked: mask(raw),
        bbox: node.bbox,
        why: rule.why,
        action: "replace-span",
      });
    }
  }

  return found;
}

export const tier2Patterns: Detector = {
  tier: 2,
  name: "Pattern + checksum",

  run(capture: DomCapture): Finding[] {
    seq = 0;
    rejected = 0;
    const findings: Finding[] = [];

    for (const node of walkCapture(capture.root)) {
      for (const field of SCANNED_FIELDS) {
        findings.push(...scanText(node, field, fieldText(node, field)));
      }
    }

    return dedupe(findings);
  },
};

/** Candidates a pattern matched but a checksum rejected, from the last run. */
export function checksumRejections(): number {
  return rejected;
}

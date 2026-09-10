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
    // Sixteen digits before twelve, so a VID is not reported as an Aadhaar
    // number that happens to have four digits after it.
    kind: "aadhaar",
    pattern: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    validate: check.isAadhaarVid,
    confidence: "certain",
    why: "16-digit Aadhaar Virtual ID, valid Verhoeff check digit",
  },
  {
    kind: "aadhaar",
    pattern: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    validate: check.isAadhaar,
    confidence: "certain",
    why: "12 digits, valid Verhoeff check digit",
  },
  {
    // A card whose issuer we recognise. The Luhn check alone passes one random
    // number in ten - which is every tenth order id, tracking number and
    // account number on a shopping site - so an unknown issuer is not enough.
    kind: "payment_card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (raw) => check.isPaymentCard(raw) && !!check.cardBrand(raw.replace(/[\s-]/g, "")),
    confidence: "certain",
    why: "13–19 digits, valid Luhn check digit, known card issuer",
  },
  {
    kind: "payment_card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (raw) => check.isPaymentCard(raw) && !check.cardBrand(raw.replace(/[\s-]/g, "")),
    confidence: "medium",
    why: "13–19 digits with a valid Luhn check digit, unknown issuer, beside a card cue",
  },
  {
    // Spaces are allowed where a form shows them: "AAACR 5055 K".
    kind: "pan",
    pattern: /\b[A-Za-z]{5}\s?\d{4}\s?[A-Za-z]\b/g,
    validate: check.isPan,
    confidence: "certain",
    why: "PAN format with a valid holder-type character",
  },
  {
    kind: "gstin",
    pattern: /\b\d{2}\s?[A-Za-z]{5}\s?\d{4}\s?[A-Za-z]\s?[0-9A-Za-z]\s?[Zz]\s?[0-9A-Za-z]\b/g,
    validate: check.isGstin,
    confidence: "certain",
    why: "GSTIN format with a valid mod-36 check character",
  },
  {
    kind: "ifsc",
    pattern: /\b[A-Za-z]{4}0[A-Za-z0-9]{6}\b/g,
    validate: check.isKnownIfsc,
    confidence: "certain",
    why: "IFSC of a known bank",
  },
  {
    kind: "ifsc",
    pattern: /\b[A-Za-z]{4}0[A-Za-z0-9]{6}\b/g,
    validate: (raw) => check.isIfsc(raw) && !check.isKnownIfsc(raw),
    confidence: "high",
    why: "IFSC format beside a banking cue",
  },
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    confidence: "certain",
    why: "RFC-shaped email address",
  },
  {
    // "priya [at] example [dot] in". Written that way to defeat scrapers, and a
    // language model reads it as easily as the plain form - so it has to be
    // treated as one. Both an "at" and at least one "dot" are required.
    kind: "email",
    pattern:
      /\b[A-Za-z0-9._%+-]+\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|<\s*at\s*>|\s+AT\s+|\s+at\s+)\s*[A-Za-z0-9-]+(?:\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|<\s*dot\s*>|\s+DOT\s+|\s+dot\s+)\s*[A-Za-z0-9-]+)+\b/g,
    validate: check.isObfuscatedEmail,
    confidence: "high",
    why: "email address written with 'at' and 'dot' spelled out",
  },
  {
    kind: "upi_id",
    // A VPA looks like an email but the suffix is a payment handle, not a
    // domain. The list is the PSP and bank handles in circulation.
    pattern:
      /\b[A-Za-z0-9._-]{3,}@(?:ok(?:hdfcbank|icici|axis|sbi)|wa(?:hdfcbank|icici|axis|sbi)|paytm|ybl|ibl|axl|upi|apl|yapl|rapl|jupiteraxis|fam|superyes|icici|hdfcbank|sbi|axisbank|kotak|indus|federal|barodampay|cnrb|pnb|boi|uboi|idfcbank|yesbank|airtel|freecharge|mobikwik|pingpay|slice|timecosmos|naviaxis|niyoicici|postbank|dbs|abfspay|citi|hsbc|sc|rbl|kmbl|aubank|dlb|kbl|sib|tjsb|ikwik|pockets|goaxis|amazonpay|shriramhdfcbank|ptyes|ptaxis|ptsbi|pthdfc)\b/gi,
    confidence: "high",
    why: "UPI virtual payment address with a known handle",
  },
  {
    // Every spelling of an Indian mobile a page uses: "98765 43210",
    // "9876543210", "+91 98765 43210", "+919876543210", "09876543210",
    // "(91) 98765-43210", "9876 543 210". The pattern is permissive about
    // grouping and the validator is strict about the digits, which is the
    // right way round - the old pattern insisted on a 5-5 split and a word
    // boundary between "91" and the number, and missed most of the above.
    kind: "phone",
    // The groupings people actually write - and only those. A first draft took
    // "any 2-5 digit chunks adding to ten", and a stress run found what that
    // costs: "INV-7135-391841" and "Ref 634795 5590" both became phone numbers.
    // Nobody writes a mobile as 4-6 with a hyphen or as 6-4 at all.
    //
    // The lookbehind refuses a run glued to an identifier prefix ("INV-",
    // "REF/", "#"): a phone number is preceded by a space, a colon, or a
    // country code, never by "V-".
    pattern:
      /(?<!\d)(?<![A-Za-z0-9][-\/#])(?:\+\s?91[\s-]?|\(\+?91\)[\s-]?|91[\s-]|0[\s-]?)?(?:[6-9]\d{9}|[6-9]\d{4}[\s-]\d{5}|[6-9]\d{3}[\s-]\d{3}[\s-]\d{3}|[6-9]\d{2}[\s-]\d{3}[\s-]\d{4})(?!\d)/g,
    validate: check.isIndianMobile,
    confidence: "high",
    why: "Indian mobile number: starts 6–9, ten digits",
  },
  {
    // The 4-6 split - "9876 543210" - is real but uncommon, and two adjacent
    // reference numbers make the same shape often enough that a stress run
    // measured the cost. It is kept, but only beside a telephone cue.
    kind: "phone",
    pattern:
      /(?<!\d)(?<![A-Za-z0-9][-\/#])(?:\+\s?91[\s-]?|0[\s-]?)?[6-9]\d{3}\s\d{6}(?!\d)/g,
    validate: check.isIndianMobile,
    confidence: "high",
    why: "Indian mobile written 4-6, beside a telephone cue",
  },
  {
    kind: "phone",
    pattern: /(?<!\d)(?<![A-Za-z0-9][-\/#])0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/g,
    validate: check.isIndianLandline,
    confidence: "medium",
    why: "Indian landline: trunk 0, STD code, subscriber number, beside a telephone cue",
  },
  {
    kind: "phone",
    pattern: /\+\d{1,3}[\s-]?(?:\(\d{1,4}\)[\s-]?)?\d(?:[\s-]?\d){6,12}/g,
    validate: check.isInternationalPhone,
    confidence: "medium",
    why: "international number in +country-code form",
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
    // Numeric and written-month forms alike: "14/08/1991", "1991-08-14",
    // "14 August 1991", "August 14, 1991", "14-Aug-91".
    pattern:
      /\b(?:dob|d\.o\.b\.?|date\s+of\s+birth|birth\s*date|birthday|born(?:\s+on)?)\b[:\s]*((?:\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})|(?:\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2})|(?:\d{1,2}[\s\-/.]*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?[\s\-/.]*\d{2,4})|(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{2,4}))/gi,
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

/**
 * Context demanded of specific *rules*, not whole kinds, keyed on their `why`.
 * A landline shares its kind with a mobile number, but only the landline is
 * weak enough to need a cue; the same goes for a card with no known issuer.
 */
const RULE_CONTEXT = new Map<string, RegExp>([
  ["Indian landline: trunk 0, STD code, subscriber number, beside a telephone cue",
    /\b(tel|telephone|phone|ph|landline|office|contact|call|fax|helpline|toll[\s-]?free|board|reception)\b/i],
  ["13–19 digits with a valid Luhn check digit, unknown issuer, beside a card cue",
    /\b(card|credit|debit|visa|master(?:card)?|rupay|amex|maestro|payment|cvv)\b/i],
  ["IFSC format beside a banking cue", /\b(ifsc|bank|branch|neft|rtgs|imps|swift)\b/i],
  ["Indian mobile written 4-6, beside a telephone cue",
    /\b(mob|mobile|ph|phone|tel|telephone|call|whatsapp|contact|cell|sms)\b/i],
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
  "attr:aria-label",
  "attr:data-name",
  "attr:data-user-name",
  "attr:data-sender",
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

function scanText(node: CapturedNode, field: Field, original: string): Finding[] {
  const found: Finding[] = [];
  if (!original) return found;

  // Match against a copy with every script's digits made ASCII. The copy has
  // the same length as the original, so spans found in one index the other,
  // and the value reported is always sliced from the original - which is what
  // the tokenizer will later compare it against.
  const text = check.normaliseDigits(original);

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

      const context = NEEDS_CONTEXT.get(rule.kind) ?? RULE_CONTEXT.get(rule.why);
      if (context) {
        const window = text.slice(Math.max(0, start - 60), start + raw.length + 60);
        if (!context.test(window)) continue;
      }

      // A phone-shaped run wrapped in a longer digit run - part of a card or
      // account number - is not a phone number. Any rule that can be a
      // substring of another kind's match is settled in dedupe by length; this
      // only trims whitespace the permissive patterns may have picked up.
      const value = original.slice(start, start + raw.length).replace(/\s+$/, "");
      const end = start + value.length;
      if (value.length === 0) continue;

      found.push({
        id: `t2-${seq++}`,
        kind: rule.kind,
        shape: "text",
        tier: 2,
        confidence: rule.confidence,
        nodeId: node.id,
        field,
        span: [start, end],
        value,
        masked: mask(value),
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

import type { CapturedNode, DomCapture } from "../capture/types";
import type { Field, Finding } from "../pii/types";
import { fieldText } from "../pii/types";
import { escapeExistingTokens } from "../vault/vault";
import type { TokenMinter } from "../vault/protocol";

/**
 * Turns a captured tree into one that carries tokens where PII used to be.
 *
 * Two properties this has to get right:
 *
 *   Span-level, not whole-string. "Invoice for Sharma Traders, due Friday"
 *   becomes "Invoice for <ORG_1>, due Friday" - the sentence still reads, and
 *   the planner can still reason about it. Replacing the whole string would
 *   destroy the context that makes the page usable.
 *
 *   Never destructive to the input. The captured tree is copied, not mutated,
 *   so the caller keeps the original to compare against and the same capture
 *   can be sanitized twice without drift.
 */

export interface TokenizeResult {
  dom: DomCapture;
  report: TokenizeReport;
  /**
   * Finding id to the token that replaced it.
   *
   * The redactor needs this. A page's email must read `<EMAIL_1>` in the tree
   * *and* in the screenshot - if the image showed a different token, or the raw
   * value, the tokenizing would be for nothing.
   */
  tokensByFinding: Map<string, string>;
}

export interface TokenizeReport {
  /** Spans swapped for a token. */
  spansReplaced: number;
  /** Whole field values swapped. */
  fieldsReplaced: number;
  /** Populated fields we refused to capture, given a value-less token. */
  fieldsSealed: number;
  /** Token-shaped text already on the page, neutralised on the way in. */
  tokensEscaped: number;
  /** Findings that overlapped an earlier one, or disagreed with the capture. */
  spansSkipped: number;
}

/** The fields a finding can point at, in the order we rewrite them. */
const REWRITABLE: Field[] = [
  "text",
  "value",
  "label",
  "attr:alt",
  "attr:title",
  "attr:placeholder",
  "attr:email",
  "attr:data-email",
  "attr:data-hovercard-id",
  "attr:name",
  "attr:aria-label",
];

interface Plan {
  /** Whole-field actions win over spans; at most one per field. */
  whole?: Finding;
  spans: Finding[];
}

function clone(node: CapturedNode): CapturedNode {
  return {
    ...node,
    attrs: { ...node.attrs },
    bbox: [...node.bbox] as CapturedNode["bbox"],
    children: node.children.map(clone),
  };
}

function setField(node: CapturedNode, field: Field, value: string): void {
  if (field === "text") node.text = value || undefined;
  else if (field === "value") node.value = value || undefined;
  else if (field === "label") node.label = value;
  else node.attrs[field.slice(5)] = value;
}

/**
 * Rewrites one field: original text between the spans, tokens in place of them.
 *
 * Built left to right rather than by splicing right to left, because the text
 * we keep also needs escaping and the text we insert must not be - walking
 * forward keeps those two cases separate and the offsets honest.
 */
function rewrite(
  text: string,
  spans: { span: [number, number]; token: string }[],
  counters: TokenizeReport,
): string {
  const escapeInto = (slice: string): string => {
    const escaped = escapeExistingTokens(slice);
    if (escaped !== slice) counters.tokensEscaped++;
    return escaped;
  };

  if (spans.length === 0) return escapeInto(text);

  let out = "";
  let cursor = 0;

  for (const { span, token } of spans) {
    out += escapeInto(text.slice(cursor, span[0])) + token;
    cursor = span[1];
    counters.spansReplaced++;
  }

  return out + escapeInto(text.slice(cursor));
}

/**
 * Produces a tokenized copy of the capture.
 *
 * `findings` should be the full detection result; pixel-shaped findings are
 * ignored here and handled by the redactor, which is the split the architecture
 * calls for - text is renamed, pixels are burned, and the two never mix.
 */
export function tokenizeCapture(
  capture: DomCapture,
  findings: Finding[],
  vault: TokenMinter,
): TokenizeResult {
  const tokensByFinding = new Map<string, string>();
  const report: TokenizeReport = {
    spansReplaced: 0,
    fieldsReplaced: 0,
    fieldsSealed: 0,
    tokensEscaped: 0,
    spansSkipped: 0,
  };

  // Group text findings by the exact field they point at.
  const plans = new Map<string, Plan>();
  for (const finding of findings) {
    if (finding.shape !== "text") continue;
    if (finding.action === "none" || finding.action === "burn-region") continue;
    if (!finding.field) continue;

    const key = finding.nodeId + " " + finding.field;
    const plan = plans.get(key) ?? { spans: [] };

    if (finding.action === "replace-field" || finding.action === "seal-field") {
      // Prefer the first whole-field action; there should only ever be one.
      plan.whole ??= finding;
    } else {
      plan.spans.push(finding);
    }
    plans.set(key, plan);
  }

  const root = clone(capture.root);

  const visit = (node: CapturedNode): void => {
    for (const field of REWRITABLE) {
      const original = fieldText(node, field);
      const plan = plans.get(node.id + " " + field);

      if (!original && !plan?.whole) continue;

      // A whole-field action makes any span inside it redundant.
      if (plan?.whole) {
        const finding = plan.whole;
        if (finding.action === "seal-field") {
          const token = vault.seal(finding.kind);
          tokensByFinding.set(finding.id, token);
          setField(node, field, token);
          report.fieldsSealed++;
        } else {
          const value = finding.value ?? original;
          const token = vault.tokenize(value, finding.kind);
          tokensByFinding.set(finding.id, token);
          setField(node, field, token);
          report.fieldsReplaced++;
        }
        continue;
      }

      const spans = resolveSpans(plan?.spans ?? [], original, vault, report, tokensByFinding);
      setField(node, field, rewrite(original, spans, report));
    }

    for (const child of node.children) visit(child);
  };

  visit(root);

  return {
    dom: {
      ...capture,
      // The URL path can itself be an identifier; only the origin survives.
      url: capture.origin,
      root,
    },
    report,
    tokensByFinding,
  };
}

/**
 * Turns findings into ordered, non-overlapping span/token pairs.
 *
 * Overlaps should already be gone by the time findings reach here, but two
 * tiers can legitimately land on the same characters, and a wrong offset would
 * corrupt the output rather than merely duplicate a token - so this checks.
 */
function resolveSpans(
  findings: Finding[],
  text: string,
  vault: TokenMinter,
  report: TokenizeReport,
  tokensByFinding: Map<string, string>,
): { span: [number, number]; token: string }[] {
  const ordered = [...findings].sort((a, b) => (a.span?.[0] ?? 0) - (b.span?.[0] ?? 0));
  const out: { span: [number, number]; token: string }[] = [];
  let lastEnd = 0;

  for (const finding of ordered) {
    if (!finding.span) continue;
    const [start, end] = finding.span;

    if (start < lastEnd || start >= end || end > text.length) {
      report.spansSkipped++;
      continue;
    }

    // The span must still name the value the detector reported. If the capture
    // and the finding have drifted apart, tokenizing would replace the wrong
    // characters - skipping is the only safe response.
    const actual = text.slice(start, end);
    if (finding.value !== undefined && actual !== finding.value) {
      report.spansSkipped++;
      continue;
    }

    const token = vault.tokenize(actual, finding.kind);
    tokensByFinding.set(finding.id, token);
    out.push({ span: [start, end], token });
    lastEnd = end;
  }

  return out;
}

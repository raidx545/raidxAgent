import type { DomCapture } from "../capture/types";
import { walkCapture } from "../capture/dom";
import { tier1DomSignals } from "./tier1-dom";
import { tier2Patterns, checksumRejections } from "./tier2-patterns";
import { tier3Pixels } from "./tier3-pixels";
import { tier3Entities } from "./tier3-entities";
import type { DetectionResult, Finding, Shape, Tier } from "./types";
import { fieldText } from "./types";

export { setImageClassifier, activeClassifier } from "./tier3-pixels";
export { setEntityOptions } from "./tier3-entities";
export type { EntityOptions } from "./tier3-entities";
export type { ImageClassifier, ImageVerdict } from "./tier3-pixels";

// Cheapest and most certain first. Entities run before pixels only because
// both are tier 3 and text is cheaper to settle than geometry.
const DETECTORS = [tier1DomSignals, tier2Patterns, tier3Entities, tier3Pixels];

/**
 * A tier-1 finding means we already know what that field holds, so re-reporting
 * the same value from tier 2 adds noise rather than information.
 *
 * Keyed on node *and field*, which is the whole correctness of it. Tier 1 fires
 * on an input's value; the very same node's label often repeats the value in
 * plain text - "+91 98765 43210" as the label of a tel field is ordinary
 * markup. Suppressing by node alone threw away the label finding and shipped
 * the raw number to the model with a token sitting next to it, which is worse
 * than never having tokenized at all.
 */
function suppressCovered(findings: Finding[]): Finding[] {
  const covered = new Set(
    findings
      .filter((f) => f.tier === 1 && f.confidence === "certain" && f.field)
      .map((f) => `${f.nodeId} ${f.field}`),
  );

  return findings.filter((finding) => {
    if (finding.tier !== 2) return true;
    if (!finding.field) return true;
    if (!covered.has(`${finding.nodeId} ${finding.field}`)) return true;
    // Same node, same field: keep it only if it names the data more precisely.
    return finding.confidence === "certain";
  });
}

/**
 * Runs the detector tiers cheapest-first over one capture.
 *
 * Detection deliberately produces findings and nothing else — it does not
 * tokenize, redact, or mutate the capture. Splitting by shape and acting on it
 * is a separate step, so that this one stays testable in isolation.
 */
/**
 * Runs detection over a plain string.
 *
 * Used to check an outgoing payload at the moment of sending, and to scan the
 * user's own request. Tier 1 findings are dropped: it reads field metadata,
 * which does not exist here and would only produce noise.
 */
export async function scanText(text: string): Promise<Finding[]> {
  if (!text.trim()) return [];

  const capture: DomCapture = {
    url: "about:payload",
    origin: "about:payload",
    title: "payload",
    capturedAt: Date.now(),
    viewport: { width: 0, height: 0, dpr: 1, scrollX: 0, scrollY: 0, pageHeight: 0 },
    root: {
      id: 0, tag: "body", role: "document", label: "", attrs: {},
      bbox: [0, 0, 0, 0], visible: true,
      children: [{
        id: 1, tag: "p", role: "paragraph", label: "", text,
        attrs: {}, bbox: [0, 0, 0, 0], visible: true, children: [],
      }],
    },
    stats: { examined: 1, kept: 2, pruned: 0 },
  };

  const result = await detect(capture);
  return result.findings.filter((f) => f.shape === "text" && f.tier !== 1);
}

export async function detect(capture: DomCapture): Promise<DetectionResult> {
  const started = performance.now();

  let nodesScanned = 0;
  let charsScanned = 0;
  for (const node of walkCapture(capture.root)) {
    nodesScanned++;
    charsScanned +=
      fieldText(node, "text").length +
      fieldText(node, "value").length +
      fieldText(node, "label").length;
  }

  let findings: Finding[] = [];
  for (const detector of DETECTORS) {
    findings = findings.concat(await detector.run(capture, findings));
  }

  findings = suppressCovered(findings);

  // Most severe first: certain before low, then earlier tiers.
  const rank = { certain: 0, high: 1, medium: 2, low: 3 };
  findings.sort(
    (a, b) => rank[a.confidence] - rank[b.confidence] || a.tier - b.tier || a.nodeId - b.nodeId,
  );

  const byTier: Record<Tier, number> = { 1: 0, 2: 0, 3: 0 };
  const byShape: Record<Shape, number> = { text: 0, pixel: 0 };
  for (const finding of findings) {
    byTier[finding.tier]++;
    byShape[finding.shape]++;
  }

  return {
    findings,
    stats: {
      nodesScanned,
      charsScanned,
      checksumRejected: checksumRejections(),
      byTier,
      byShape,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    },
  };
}

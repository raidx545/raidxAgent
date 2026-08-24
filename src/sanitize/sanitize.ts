import type { Capture, DomCapture, ScreenshotMeta } from "../capture/types";
import type { SpanRectRequest, SpanRectResult } from "../capture/spans";
import { detect, setEntityOptions } from "../pii/detect";
import type { DetectionResult, Finding } from "../pii/types";
import { Vault } from "../vault/vault";
import { CollectingMinter } from "../vault/protocol";
import type { MinterSource } from "../vault/remote";
import { localSource } from "../vault/remote";
import { tokenizeCapture, type TokenizeReport } from "./tokenize";
import { redactScreenshot, type RedactReport } from "./redact";

/**
 * The sanitization layer, end to end.
 *
 * capture -> detect -> split by shape -> tokenize text / burn pixels
 *
 * Detection runs before anything is changed, because you cannot hide what you
 * have not found. The split by shape is not a sequence of two steps: text is
 * renamed into the vault and can come back, pixels are destroyed and cannot.
 * They are siblings, and they operate on different halves of the capture.
 *
 * Nothing here talks to a model. The output is what *would* cross the wire.
 */

export interface SanitizeReport {
  detection: DetectionResult["stats"];
  tokenize: TokenizeReport;
  redact: RedactReport;
  /** Tokens the vault issued during this pass. */
  tokensMinted: number;
  /**
   * Findings from re-running detection on the sanitized output. Anything above
   * zero is PII that survived - the number worth watching.
   */
  residual: Finding[];
  screenshotError?: string;
  elapsedMs: number;
}

/**
 * Choices this layer should not make silently on the user's behalf.
 */
export interface SanitizePolicy {
  /**
   * Destroy regions whose contents we could not read - cross-origin frames,
   * chiefly. Safe by construction, at the cost of blacking out legitimate
   * embeds such as maps and videos. On by default: we do not ship pixels we
   * were never able to inspect.
   */
  burnUnverifiedRegions: boolean;
  /**
   * Report capitalised word sequences that no other strategy explains. Raises
   * recall on unlabelled names, lowers precision on headings and product
   * names.
   */
  aggressiveNames: boolean;
}

export const DEFAULT_POLICY: SanitizePolicy = {
  burnUnverifiedRegions: true,
  aggressiveNames: false,
};

/**
 * Asks the page where a batch of character spans is painted.
 *
 * Injected rather than imported, because sanitization runs where the DOM is
 * not - a service worker, an extension page, a test - and only the content
 * script can measure a Range. Without a resolver the text half of the
 * screenshot cannot be covered, and the report says so rather than pretending.
 */
export type RectResolver = (requests: SpanRectRequest[]) => Promise<SpanRectResult[]>;

export interface SanitizedCapture {
  /** What the planner would be given. */
  dom: DomCapture;
  screenshot?: ScreenshotMeta;
  /** Everything detection found in the original, for the inspector. */
  findings: Finding[];
  report: SanitizeReport;
}

/**
 * Sanitizes one capture against a vault.
 *
 * The vault is passed in rather than created here so that a whole session
 * shares one - the same organisation seen on three pages must get the same
 * token, or the tokens stop working as join keys.
 */
export async function sanitize(
  capture: Capture,
  vault: Vault | MinterSource,
  policy: SanitizePolicy = DEFAULT_POLICY,
  resolveRects?: RectResolver,
): Promise<SanitizedCapture> {
  const started = performance.now();

  const source: MinterSource = vault instanceof Vault ? localSource(vault) : vault;

  setEntityOptions({ aggressive: policy.aggressiveNames });

  // 1. Detect. Nothing is modified yet.
  const detection = await detect(capture.dom);

  // A region we could not read is only burned if policy says so; otherwise it
  // is downgraded to an informational finding rather than silently dropped.
  const findings = detection.findings.map((finding) =>
    finding.kind === "unverified_region" && !policy.burnUnverifiedRegions
      ? { ...finding, action: "none" as const }
      : finding,
  );

  // 2. Work out every token this pass will need, without minting anything.
  //
  //    The vault may live in another context now, so tokens cannot be fetched
  //    one at a time from inside a synchronous tree walk. Instead the walk runs
  //    twice against the same input: once against a collector that records what
  //    it would ask for, then once against a replayer holding the answers. The
  //    traversal is deterministic, so the two sequences match - and ReplayMinter
  //    throws rather than guessing if they ever do not.
  const collector = new CollectingMinter();
  tokenizeCapture(capture.dom, findings, collector);
  if (capture.screenshot) {
    for (const finding of findings) {
      if (finding.shape === "pixel" && finding.action === "burn-region") {
        collector.seal(finding.kind);
      }
    }
  }

  const minter = await source.prepare(collector.requests);
  const tokensMinted = collector.requests.length;

  // 3. Text-shaped findings: rename into the vault, span by span.
  const { dom, report: tokenize, tokensByFinding } = tokenizeCapture(
    capture.dom,
    findings,
    minter,
  );

  // 4. Pixel-shaped findings: destroy on the canvas.
  let screenshot: ScreenshotMeta | undefined;
  let redact: RedactReport = {
    regionsBurned: 0,
    textSpansCovered: 0,
    textSpansUnresolved: 0,
    regionsOutsideViewport: 0,
    regionsSkipped: 0,
    pixelsBurned: 0,
    outputBytes: 0,
  };
  let screenshotError = capture.screenshotError;

  if (capture.screenshot) {
    // Where is each tokenized string actually painted? Without this the tree
    // says <EMAIL_1> while the picture still shows the address.
    let spanRects: SpanRectResult[] = [];
    if (resolveRects) {
      const requests: SpanRectRequest[] = findings
        .filter(
          (f) =>
            f.shape === "text" &&
            f.action !== "none" &&
            f.action !== "burn-region" &&
            tokensByFinding.has(f.id),
        )
        .map((f) => ({
          findingId: f.id,
          nodeId: f.nodeId,
          field: f.field ?? "text",
          start: f.span?.[0],
          end: f.span?.[1],
        }));
      spanRects = await resolveRects(requests).catch(() => []);
    }

    const result = await redactScreenshot(
      capture.screenshot,
      findings,
      capture.dom.viewport,
      minter,
      spanRects,
      tokensByFinding,
    );
    // Same metadata, new pixels: the coordinate frame is unchanged by burning.
    screenshot = result.screenshot
      ? { ...capture.screenshot, dataUrl: result.screenshot }
      : undefined;
    redact = result.report;
    screenshotError = result.error ?? screenshotError;
  }

  // 5. Verify. Run the detector over our own output and see what survived.
  //    A sanitizer that is never checked against its own detector is a
  //    sanitizer that quietly stops working.
  const residual = await residualFindings(dom);

  return {
    dom,
    screenshot,
    findings,
    report: {
      detection: detection.stats,
      tokenize,
      redact,
      tokensMinted,
      residual,
      screenshotError,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    },
  };
}

/**
 * Re-runs detection on sanitized output.
 *
 * Tier 1 findings are dropped from the result: tier 1 reads field metadata -
 * `autocomplete="cc-number"`, a label saying "Aadhaar Number" - and that
 * metadata is *supposed* to survive. A form the planner cannot recognise as a
 * form is useless.
 *
 * Everything else that is text-shaped counts as a leak. Pixel findings are
 * excluded because the tree no longer carries pixels - the redactor answers
 * for those, and its own report says how many regions it burned.
 */
async function residualFindings(dom: DomCapture): Promise<Finding[]> {
  const again = await detect(dom);
  return again.findings.filter(
    (finding) => finding.shape === "text" && finding.tier !== 1,
  );
}

/**
 * Sanitizes a plain string against the same vault as the page.
 *
 * The user's own words need this as much as a website's do. Someone typing
 * "check my Aadhaar 3456 7890 1238" has put an identifier into the request, and
 * the request goes to the model just as the page does - aligning it with
 * page-derived tokens does nothing for a value the page never showed.
 *
 * Implemented by wrapping the string in a one-node capture and running the real
 * pipeline over it, rather than a second, simpler code path that would drift
 * from the first.
 */
export async function sanitizeText(
  text: string,
  vault: Vault | MinterSource,
  policy: SanitizePolicy = DEFAULT_POLICY,
): Promise<{ text: string; findings: Finding[] }> {
  if (!text.trim()) return { text, findings: [] };

  const capture: Capture = {
    dom: {
      url: "about:request",
      origin: "about:request",
      title: "request",
      capturedAt: Date.now(),
      viewport: { width: 0, height: 0, dpr: 1, scrollX: 0, scrollY: 0, pageHeight: 0 },
      root: {
        id: 0,
        tag: "body",
        role: "document",
        label: "",
        attrs: {},
        bbox: [0, 0, 0, 0],
        visible: true,
        children: [
          {
            id: 1,
            tag: "p",
            role: "paragraph",
            label: "",
            text,
            attrs: {},
            bbox: [0, 0, 0, 0],
            visible: true,
            children: [],
          },
        ],
      },
      stats: { examined: 1, kept: 2, pruned: 0 },
    },
  };

  const out = await sanitize(capture, vault, policy);
  const node = out.dom.root.children[0];
  return { text: node?.text ?? text, findings: out.findings };
}

export { Vault };

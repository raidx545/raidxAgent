import { sanitize } from "../src/sanitize/sanitize";
import { Vault } from "../src/vault/vault";
import { CollectingMinter, ReplayMinter } from "../src/vault/protocol";
import type { MintRequest, TokenMinter } from "../src/vault/protocol";
import type { MinterSource } from "../src/vault/remote";
import { verhoeffCheckDigit } from "../src/pii/checksums";
import type { Capture, CapturedNode } from "../src/capture/types";

/**
 * The vault now lives behind an async boundary, so the tokenizer runs its walk
 * twice: once to collect requests, once to apply the answers. That is only
 * sound if both walks ask for exactly the same things in the same order.
 *
 * This pins that invariant down by sanitizing the same capture two ways and
 * requiring the results to be byte-identical.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 100, 20], visible: true, children: [], ...p,
});

const payload = "34567890123";
const AADHAAR = payload + verhoeffCheckDigit(payload);

function buildCapture(): Capture {
  id = 0;
  const nodes = [
    n({ tag: "input", role: "password", label: "Password",
        attrs: { type: "password" }, value: "hunter2-not-real" }),
    n({ tag: "input", role: "textbox", label: "Full Name",
        attrs: { autocomplete: "name" }, value: "Priya Sharma" }),
    n({ tag: "input", role: "textbox", label: "Email",
        attrs: { type: "email" }, value: "priya.sharma@example.in" }),
    n({ tag: "p", text: `Priya Sharma at Sharma Traders Pvt Ltd, PAN AAACR5055K.` }),
    n({ tag: "p", text: `Aadhaar ${AADHAAR}, mobile +91 98765 43210.` }),
    n({ tag: "p", text: `Ship to 17/B Nehru Nagar, Pune 411014.` }),
    n({ tag: "p", text: `Also reachable at priya.sharma@example.in.` }),
    n({ tag: "img", role: "image", attrs: { alt: "Profile photo" }, bbox: [0, 0, 64, 64] }),
    n({ tag: "canvas", role: "canvas", label: "Signature pad", bbox: [0, 80, 200, 90] }),
    n({ tag: "iframe", role: "frame",
        attrs: { frameHost: "ads.example.com", crossOrigin: "true" }, bbox: [0, 200, 300, 250] }),
  ];
  return {
    dom: {
      url: "https://billing.example.in/invoice/8871",
      origin: "https://billing.example.in",
      title: "Invoice",
      capturedAt: 1_700_000_000_000,
      viewport: { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0, pageHeight: 2400 },
      root: n({ tag: "body", role: "document", children: nodes }),
      stats: { examined: 40, kept: nodes.length + 1, pruned: 24 },
    },
  };
}

// --- path A: a plain in-process vault (what the inspector uses) -------------
const directVault = new Vault();
const direct = await sanitize(buildCapture(), directVault);

// --- path B: a batching source standing in for the offscreen document -------
/** Mirrors what the offscreen host does with a mint batch. */
class FakeRemote implements MinterSource {
  readonly vault = new Vault();
  batches = 0;
  lastRequests: MintRequest[] = [];

  async prepare(requests: MintRequest[]): Promise<TokenMinter> {
    this.batches++;
    this.lastRequests = requests;
    // Serialise the batch, as a real message boundary would.
    const wire = JSON.parse(JSON.stringify(requests)) as MintRequest[];
    const tokens = wire.map((entry) =>
      entry.op === "seal" ? this.vault.seal(entry.kind) : this.vault.tokenize(entry.value, entry.kind),
    );
    return new ReplayMinter(wire, tokens);
  }
}

const remote = new FakeRemote();
const viaRemote = await sanitize(buildCapture(), remote);

// --- the invariant ---------------------------------------------------------
want(
  JSON.stringify(direct.dom) === JSON.stringify(viaRemote.dom),
  "the two-pass path produced a different tree than the direct path",
);
want(remote.batches === 1, `expected one round trip to the vault, got ${remote.batches}`);
want(
  direct.report.tokensMinted === viaRemote.report.tokensMinted,
  `token counts differ: ${direct.report.tokensMinted} vs ${viaRemote.report.tokensMinted}`,
);
want(viaRemote.report.residual.length === 0,
  `residual PII via the remote path: ${viaRemote.report.residual.map((f) => f.kind).join(", ")}`);

// Seals for pixel regions must be requested even though there is no screenshot
// here to burn - the collector only adds them when a screenshot exists.
want(
  !remote.lastRequests.some((r) => r.op === "seal" && r.kind === "face_or_photo"),
  "pixel seals were requested with no screenshot to redact",
);

// --- regions outside the image must not desync the two passes ---------------
//
// The collect pass asks for one seal per burn-region finding. If the redactor
// skips sealing for a region it cannot draw - off-image, zero-sized - the
// sequences drift and the replay throws. This is the shape that broke once a
// stitched full-page image made "outside the image" a routine occurrence.
{
  const withShot = buildCapture();
  // A 1x1 transparent PNG: every region will be clipped away.
  withShot.screenshot = {
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    kind: "viewport",
    scale: 1,
    originX: 0,
    originY: 0,
    cssWidth: 1,
    cssHeight: 1,
    tiles: 1,
  };

  const remoteWithShot = new FakeRemote();
  let threw: string | undefined;
  let outcome: Awaited<ReturnType<typeof sanitize>> | undefined;
  try {
    outcome = await sanitize(withShot, remoteWithShot);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }

  // Node has no OffscreenCanvas, so redaction bails before it reaches the
  // clipping code and no seal is consumed. What this pins down here is that the
  // failure is graceful - the sanitizer still returns a tokenized tree and a
  // reported error rather than throwing. Whether off-image regions are counted
  // correctly is checked in dist/selftest.html, where a canvas exists.
  want(threw === undefined, `sanitizing with a screenshot threw: ${threw}`);
  want(outcome !== undefined, "sanitize returned nothing");
  want(
    outcome !== undefined && outcome.report.redact.regionsBurned === 0,
    "something was burned without a working canvas",
  );
  want(
    outcome !== undefined && outcome.report.screenshotError !== undefined,
    "a failed redaction did not report why",
  );
  want(
    outcome !== undefined && outcome.screenshot === undefined,
    "an unredacted screenshot was returned after redaction failed",
  );
  want(
    outcome !== undefined && outcome.report.residual.length === 0,
    "the text half stopped working when the pixel half failed",
  );
}

// --- the replay guard actually guards --------------------------------------
{
  const requests: MintRequest[] = [
    { op: "tokenize", value: "a", kind: "email" },
    { op: "seal", kind: "credential_field" },
  ];
  const replay = new ReplayMinter(requests, ["<EMAIL_1>", "<SECRET_1>"]);
  want(replay.tokenize("a", "email") === "<EMAIL_1>", "replay returned the wrong first token");
  want(replay.seal("credential_field") === "<SECRET_1>", "replay returned the wrong seal");

  let threwOnOverrun = false;
  try { replay.seal("credential_field"); } catch { threwOnOverrun = true; }
  want(threwOnOverrun, "replay kept handing out tokens past the end of the batch");

  let threwOnMismatch = false;
  const wrong = new ReplayMinter(requests, ["<EMAIL_1>", "<SECRET_1>"]);
  try { wrong.seal("credential_field"); } catch { threwOnMismatch = true; }
  want(threwOnMismatch, "replay accepted a call that did not match the collected sequence");
}

// --- the collector must dedupe exactly as the vault does --------------------
{
  const collector = new CollectingMinter();
  const a = collector.tokenize("same@example.in", "email");
  const b = collector.tokenize("same@example.in", "email");
  want(a === b, "collector issued two placeholders for one value");
  want(collector.requests.length === 1,
    `collector asked the vault twice for one value: ${collector.requests.length}`);
  // A seal is never deduped: two filled password fields are two separate facts.
  collector.seal("credential_field");
  collector.seal("credential_field");
  want(collector.requests.length === 3, "seals were deduped, losing a field");
}

// --- placeholders must never reach real output -----------------------------
want(!JSON.stringify(viaRemote.dom).includes("((collect:"),
  "a first-pass placeholder leaked into the sanitized output");

console.log(JSON.stringify({
  batches: remote.batches,
  tokensMinted: viaRemote.report.tokensMinted,
  identicalTrees: JSON.stringify(direct.dom) === JSON.stringify(viaRemote.dom),
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

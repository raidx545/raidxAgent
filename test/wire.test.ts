import { renderPage, alignTask } from "../src/background/wire";
import { sanitize, sanitizeText } from "../src/sanitize/sanitize";
import { Vault } from "../src/vault/vault";
import { walkCapture } from "../src/capture/dom";
import { scanText } from "../src/pii/detect";
import { verhoeffCheckDigit } from "../src/pii/checksums";
import type { Capture, CapturedNode } from "../src/capture/types";

/**
 * What actually crosses the wire.
 *
 * Every other test checks a piece of the pipeline. This one checks the thing
 * the model is literally handed - the rendered string, built by the same
 * function the agent loop calls - and asserts three properties that have to
 * hold together:
 *
 *   nothing private is in it,
 *   the page is still usable (ids, labels, structure, non-PII prose), and
 *   the user's request lines up with the page through the same tokens.
 *
 * Any one of those alone is easy. All three at once is the design.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 300, 20], visible: true, children: [], ...p,
});

const AADHAAR = "34567890123" + verhoeffCheckDigit("34567890123");
/** A second valid Aadhaar the page never shows, for the typed-by-user case. */
const UNSEEN_AADHAAR = "45678901234" + verhoeffCheckDigit("45678901234");

const SECRETS = [
  "priya.sharma@example.in",
  "Priya Sharma",
  "Sharma Traders",
  "AAACR5055K",
  AADHAAR,
  "98765 43210",
  "SBIN0001234",
  "17/B Nehru Nagar",
  "hunter2-not-real",
];

function build(): Capture {
  id = 0;
  const nodes = [
    n({ tag: "h1", role: "heading", text: "Billing" }),
    n({ tag: "input", role: "password", label: "Password",
        attrs: { type: "password", autocomplete: "current-password", filled: "true" } }),
    n({ tag: "input", role: "textbox", label: "Full Name",
        attrs: { autocomplete: "name" }, value: "Priya Sharma" }),
    n({ tag: "input", role: "textbox", label: "Email",
        attrs: { type: "email" }, value: "priya.sharma@example.in" }),
    // A field whose *label* repeats its own value. Ordinary markup, and the
    // shape that leaked: tier 1 covers the value, so a node-keyed suppression
    // threw away tier 2's finding on the label and shipped the raw number.
    n({ tag: "input", role: "textbox", label: "+91 98765 43210",
        attrs: { type: "tel" }, value: "+91 98765 43210" }),
    // Same shape again, with an identifier that has a checksum.
    n({ tag: "input", role: "textbox", label: `Aadhaar ${AADHAAR}`,
        attrs: { name: "aadhaar_no" }, value: AADHAAR }),
    n({ tag: "span", role: "generic", text: "Linked mobile",
        attrs: { "aria-label": "Mobile +91 98765 43210" } }),
    n({ tag: "p", text: `Invoice for Sharma Traders Pvt Ltd. PAN AAACR5055K, Aadhaar ${AADHAAR}.` }),
    n({ tag: "p", text: "Remit to IFSC SBIN0001234, or call +91 98765 43210." }),
    n({ tag: "p", text: "Ship to 17/B Nehru Nagar, Pune 411014." }),
    n({ tag: "button", role: "button", text: "Forward this invoice" }),
    n({ tag: "a", role: "link", text: "Billing help", attrs: { hrefHost: "help.example.in" } }),
    n({ tag: "img", role: "image", label: "Profile photo", attrs: { alt: "Profile photo" },
        bbox: [0, 400, 64, 64] }),
  ];

  return {
    dom: {
      url: "https://billing.example.in/invoice/8871?customer=priya.sharma@example.in",
      origin: "https://billing.example.in",
      title: "Invoice 8871",
      capturedAt: 1_700_000_000_000,
      viewport: { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0, pageHeight: 1600 },
      root: n({ tag: "body", role: "document", children: nodes }),
      stats: { examined: 40, kept: nodes.length + 1, pruned: 24 },
    },
  };
}

const vault = new Vault();
const capture = build();
const sanitized = await sanitize(capture, vault);

// This is the exact string the agent puts into the message.
const wire = renderPage(sanitized.dom);

// ---------------------------------------------------------------- private

for (const secret of SECRETS) {
  if (wire.includes(secret)) fails.push(`LEAK: "${secret}" is in what the model receives`);
}
want(!wire.includes("invoice/8871"), "the URL path survived; it named the customer");

// The label of a field must be sanitized as thoroughly as its value. Seeing
// `textbox "+91 98765 43210" = "<PHONE_1>"` in a payload means the tokenizing
// achieved nothing for that field.
want(!/textbox "\+91/.test(wire), `a field label still shows the raw value: ${wire.match(/.*\+91.*/)?.[0]}`);
want(!wire.includes("aria-label"), "aria-label leaked into the payload unscanned");
want(wire.includes("URL: https://billing.example.in"), `the origin was lost: ${wire.slice(0, 80)}`);
want(sanitized.report.residual.length === 0,
  `residual: ${sanitized.report.residual.map((f) => f.kind).join(", ")}`);

// ----------------------------------------------------------------- usable

// Every element the planner could act on must carry an id, and every id must
// exist in the tree - otherwise the planner points at things that are not there.
const idsInTree = new Set([...walkCapture(sanitized.dom.root)].map((x) => x.id));
const idsOnWire = [...wire.matchAll(/^\s*\[(\d+)\]/gm)].map((m) => Number(m[1]));
want(idsOnWire.length > 5, `too few elements rendered: ${idsOnWire.length}`);
want(idsOnWire.every((x) => idsInTree.has(x)),
  "an id was rendered that does not exist in the tree");

// The page has to remain recognisable as a page.
for (const keep of [
  "Billing",                 // heading
  "Password",                // a label is not a secret
  "autocomplete=name",       // field purpose the planner needs
  "Forward this invoice",    // the button the task is about
  "Billing help",
  "help.example.in",
  "Invoice for",             // prose around the tokens
  "Remit to IFSC",
  "Ship to",
]) {
  want(wire.includes(keep), `the page lost "${keep}" and is no longer usable`);
}

// Tokens must actually be present, or nothing was tokenized at all.
for (const token of ["<NAME_", "<EMAIL_", "<PAN_", "<AADHAAR_", "<IFSC_", "<PHONE_"]) {
  want(wire.includes(token), `no ${token}…> in the rendered page`);
}

// A filled password is visible as filled, without its value existing anywhere.
const secretToken = wire.match(/<SECRET_\d+>/)?.[0];
want(secretToken !== undefined, "a filled password did not become a sealed token");
want(secretToken === undefined || vault.resolve(secretToken) === undefined,
  "a sealed password token resolved to a value");

// ------------------------------------------------------------ joinable

// The architecture's own example: the request has to line up with the page.
const task = "forward the invoice from Sharma Traders to Priya Sharma";
const aligned = alignTask(task, vault.values());

want(!aligned.includes("Sharma Traders"), `the request still names the company: ${aligned}`);
want(!aligned.includes("Priya Sharma"), `the request still names the person: ${aligned}`);
want(aligned.startsWith("forward the invoice from "), `the request lost its shape: ${aligned}`);

// The token in the request must be the token on the page, or the join fails.
const orgToken = aligned.match(/<ORG_\d+>/)?.[0];
want(orgToken !== undefined, `the company was not tokenized in the request: ${aligned}`);
want(orgToken !== undefined && wire.includes(orgToken),
  `the request uses ${orgToken} but the page does not — the join key is broken`);

const nameToken = aligned.match(/<NAME_\d+>/)?.[0];
want(nameToken !== undefined && wire.includes(nameToken),
  `the request uses ${nameToken} but the page does not`);

// Aligning must not invent tokens for things the page never showed.
const unseen = alignTask("email bob@nowhere.example about lunch", vault.values());
want(unseen === "email bob@nowhere.example about lunch",
  `alignment altered a value the vault never held: ${unseen}`);

// -------------------------------------- the user's own words are scanned

// A value the page never showed has no token to align with, so alignment alone
// leaves it untouched. It still reaches the model, so it still has to be caught.
{
  const typed = "check my Aadhaar " + UNSEEN_AADHAAR + " and email me at raj@example.in";
  const alignedOnly = alignTask(typed, vault.values());
  want(alignedOnly.includes(UNSEEN_AADHAAR),
    "alignment touched a value the vault never held");

  const scanned = await sanitizeText(typed, vault);
  want(!scanned.text.includes(UNSEEN_AADHAAR),
    `an Aadhaar typed by the user reached the model: ${scanned.text}`);
  want(!scanned.text.includes("raj@example.in"),
    `an address typed by the user reached the model: ${scanned.text}`);
  want(scanned.text.startsWith("check my Aadhaar <"),
    `the request lost its shape: ${scanned.text}`);
  want(scanned.findings.length >= 2,
    `expected at least two findings in the request, got ${scanned.findings.length}`);
}

// -------------------------------------- the outgoing payload is re-scanned

{
  // What the agent actually checks at send time.
  const verdict = await scanText(wire);
  want(verdict.length === 0,
    `the send-time scan found PII in the payload: ${verdict.map((f) => f.kind + "=" + f.masked).join(", ")}`);

  // And it must not be vacuous - the same scan on a raw page must fire.
  const raw = await scanText("Contact priya.sharma@example.in about PAN AAACR5055K.");
  want(raw.length >= 2,
    `the send-time scan is not detecting anything at all: ${raw.length} finding(s)`);
}

// ------------------------------------------------------ round trip back

// Whatever the planner says back in tokens must resolve to the real values.
const spoken = `I forwarded it from ${orgToken} to ${nameToken}.`;
const revealed = vault.resolveAll(spoken);
want(revealed.text.includes("Sharma Traders"), `resolving back failed: ${revealed.text}`);
want(revealed.text.includes("Priya Sharma"), `resolving back failed: ${revealed.text}`);
want(revealed.unknown.length === 0, `unexpected unknown tokens: ${revealed.unknown.join(", ")}`);

// A token the vault never issued must be refused, not silently passed through.
const forged = vault.resolveAll("type <EMAIL_99> into the box");
want(forged.unknown.includes("<EMAIL_99>"), "a forged token was not reported");
want(forged.text.includes("<EMAIL_99>"), "a forged token was substituted with something");

console.log(JSON.stringify({
  alignedTask: aligned,
  wirePreview: wire.split("\n").slice(0, 14),
  tokensOnWire: [...new Set([...wire.matchAll(/<[A-Z][A-Z0-9]*_\d+>/g)].map((m) => m[0]))].sort(),
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

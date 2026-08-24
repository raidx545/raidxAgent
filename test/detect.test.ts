import { detect } from "../src/pii/detect";
import { verhoeffCheckDigit } from "../src/pii/checksums";
import type { CapturedNode, DomCapture } from "../src/capture/types";

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 100, 20], visible: true, children: [], ...p,
});

const aadhaarPayload = "34567890123";
const AADHAAR = aadhaarPayload + verhoeffCheckDigit(aadhaarPayload);
const NOT_AADHAAR = aadhaarPayload + ((verhoeffCheckDigit(aadhaarPayload) + 5) % 10);

const nodes: CapturedNode[] = [
  // --- tier 1: the page declares the field's purpose ---
  n({ tag: "input", role: "password", label: "Password", attrs: { type: "password", autocomplete: "current-password" } }),
  n({ tag: "input", role: "textbox", label: "Card number", attrs: { autocomplete: "cc-number" }, value: "4111 1111 1111 1111" }),
  n({ tag: "input", role: "textbox", label: "Email", attrs: { type: "email" }, value: "priya.sharma@example.in" }),
  n({ tag: "input", role: "textbox", label: "Aadhaar Number", attrs: { name: "aadhaar_no" }, value: AADHAAR }),
  n({ tag: "input", role: "textbox", label: "Street address", attrs: { autocomplete: "address-line1" }, value: "12 MG Road" }),

  // --- tier 2: free text, pattern + checksum ---
  n({ tag: "p", text: `Invoice for Sharma Traders. PAN: AAACR5055K, GSTIN 27AAACR5055K1Z7 and bad GSTIN 27AAACR5055K1ZW. Contact +91 98765 43210.` }),
  n({ tag: "p", text: `Pay to A/c 123456789012 at IFSC SBIN0001234 or UPI priya@okhdfcbank.` }),
  n({ tag: "p", text: `Order 987654321098 shipped on 12/03/2024. Ref ${NOT_AADHAAR}.` }),
  n({ tag: "p", text: `DOB: 14/08/1991. Server 192.168.10.44.` }),
  n({ tag: "p", text: `Timestamps 1710000000000 and 1710000000001 are not identifiers.` }),

  // --- tier 3: pixel-shaped ---
  n({ tag: "img", role: "image", label: "Profile photo of Priya", attrs: { alt: "Profile photo of Priya" }, bbox: [10, 10, 64, 64] }),
  n({ tag: "img", role: "image", attrs: { srcHost: "gravatar.com" }, bbox: [10, 90, 48, 48] }),
  n({ tag: "canvas", role: "canvas", label: "Signature pad", bbox: [10, 150, 300, 120] }),
  n({ tag: "img", role: "image", attrs: { alt: "Aadhaar card scan" }, bbox: [10, 300, 400, 250] }),
  n({ tag: "img", role: "image", attrs: { alt: "company logo" }, bbox: [500, 10, 200, 40] }),
];

const capture: DomCapture = {
  url: "https://billing.example.in/invoice/8871",
  origin: "https://billing.example.in",
  title: "Invoice",
  capturedAt: Date.now(),
  viewport: { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0, pageHeight: 2400 },
  root: n({ tag: "body", role: "document", children: nodes }),
  stats: { examined: 40, kept: nodes.length + 1, pruned: 24 },
};

const result = await detect(capture);

const kinds = result.findings.map((f) => f.kind);
const has = (k: string) => kinds.some((x) => x === k);
const fails: string[] = [];
const want = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };

want(has("credential_field"), "missed password field (tier 1)");
want(has("payment_field"), "missed cc-number field (tier 1)");
want(has("email"), "missed email");
want(has("aadhaar"), "missed valid Aadhaar");
want(has("postal_address"), "missed address-line1 autocomplete");
want(has("pan"), "missed PAN");
want(has("gstin"), "missed GSTIN");
want(has("phone"), "missed Indian mobile");
want(has("ifsc"), "missed IFSC");
want(has("upi_id"), "missed UPI VPA");
want(has("date_of_birth"), "missed labelled DOB");
want(has("ip_address"), "missed IPv4");
want(has("face_or_photo"), "missed avatar/photo");
want(has("signature"), "missed signature pad");
want(has("scanned_document"), "missed ID card scan");

// The password field's contents must never be recorded.
const pw = result.findings.find((f) => f.kind === "credential_field");
want(pw?.value === undefined, "password field value was recorded");

// The invalid-checksum number must NOT be reported as Aadhaar.
const aadhaarFindings = result.findings.filter((f) => f.kind === "aadhaar");
want(aadhaarFindings.every((f) => f.value?.replace(/\s/g, "") !== NOT_AADHAAR),
  "reported a number with a bad Verhoeff digit as Aadhaar");
want(result.stats.checksumRejected > 0, "checksum rejections were not counted");

// Timestamps must not be misread as bank accounts (no context cue nearby).
const bank = result.findings.filter((f) => f.kind === "bank_account");
want(bank.every((f) => !f.value?.startsWith("17100000")),
  "a bare timestamp was reported as a bank account");
want(bank.some((f) => f.value === "123456789012"), "missed the A/c-cued bank account");

// Spans must be real substrings at the reported offsets.
const nodeById = new Map<number, CapturedNode>();
const walk = (x: CapturedNode) => { nodeById.set(x.id, x); x.children.forEach(walk); };
walk(capture.root);
for (const f of result.findings) {
  if (!f.span || f.value === undefined) continue;
  const src = f.field === "text" ? nodeById.get(f.nodeId)!.text ?? ""
            : f.field === "value" ? nodeById.get(f.nodeId)!.value ?? ""
            : nodeById.get(f.nodeId)!.label ?? "";
  if (src.slice(f.span[0], f.span[1]) !== f.value) {
    fails.push(`span mismatch for ${f.kind}: [${f.span}] gives "${src.slice(f.span[0], f.span[1])}" not "${f.value}"`);
  }
}

// Masked values must not leak the raw value.
for (const f of result.findings) {
  if (f.value && f.value.length > 6 && f.masked.includes(f.value)) {
    fails.push(`masked value leaks raw for ${f.kind}`);
  }
}

console.log(JSON.stringify({
  found: result.findings.map((f) => `${f.kind}[T${f.tier}/${f.confidence}/${f.shape}] ${f.masked}`),
  stats: result.stats,
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

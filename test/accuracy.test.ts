import { detect } from "../src/pii/detect";
import { verhoeffCheckDigit } from "../src/pii/checksums";
import type { CapturedNode, DomCapture } from "../src/capture/types";
import type { PiiKind } from "../src/pii/types";

/**
 * How accurate is detection, measured rather than asserted.
 *
 * Two corpora. The first is PII written the way it actually appears on Indian
 * and international pages - every spacing, separator and prefix a real form or
 * signature block uses. Each item must be found, with the right kind, and the
 * matched value must be the *whole* thing: a phone number found without its
 * country code is half a leak.
 *
 * The second is text that looks like PII and is not - timestamps, order and
 * tracking numbers, coordinates, version strings, hashes, prices, headings.
 * Nothing in it may fire. A detector that tokenizes an order number is not
 * being cautious; it is destroying the page the user asked about.
 *
 * Both are curated, so both targets are absolute: every positive found, no
 * negative fired. The report prints the misses by kind so a regression names
 * itself.
 */

// ------------------------------------------------------------------ helpers

function aadhaar(payload11: string): string {
  return payload11 + verhoeffCheckDigit(payload11);
}

/** Appends a Luhn check digit. */
function luhnComplete(payload: string): string {
  let sum = 0;
  let double = true;
  for (let i = payload.length - 1; i >= 0; i--) {
    let v = Number(payload[i]);
    if (double) { v *= 2; if (v > 9) v -= 9; }
    sum += v;
    double = !double;
  }
  return payload + String((10 - (sum % 10)) % 10);
}

/** Appends the GSTIN mod-36 check character. */
function gstinComplete(first14: string): string {
  const A = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = A.indexOf(first14[i]);
    const w = code * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(w / 36) + (w % 36);
  }
  return first14 + A[(36 - (sum % 36)) % 36];
}

const AADHAAR = aadhaar("34567890123");
const AADHAAR2 = aadhaar("56781234567");
const VID = (() => {
  // A Virtual ID is 16 digits with a Verhoeff check, first digit 2-9.
  const p = "912345678901234";
  return p + verhoeffCheckDigit(p);
})();
const VISA = luhnComplete("411111111111111");
const MASTERCARD = luhnComplete("530000000000000");
const RUPAY = luhnComplete("608000000000000");
const AMEX = luhnComplete("37828224631000");
const GSTIN = gstinComplete("27AAACR5055K1Z");

// ------------------------------------------------------------ positive corpus
//
// Each: the text as it would appear, the kind expected, and the exact value
// the finding must cover. `contains` is used where the surrounding label is
// legitimately part of what a page shows and only the value matters.

interface Positive {
  text: string;
  kind: PiiKind;
  value: string;
  note: string;
}

const POSITIVES: Positive[] = [
  // -- Aadhaar --------------------------------------------------------------
  { text: `Aadhaar: ${AADHAAR.slice(0, 4)} ${AADHAAR.slice(4, 8)} ${AADHAAR.slice(8)}`, kind: "aadhaar", value: `${AADHAAR.slice(0, 4)} ${AADHAAR.slice(4, 8)} ${AADHAAR.slice(8)}`, note: "spaced 4-4-4" },
  { text: `UID ${AADHAAR}`, kind: "aadhaar", value: AADHAAR, note: "unspaced" },
  { text: `Aadhaar No. ${AADHAAR.slice(0, 4)}-${AADHAAR.slice(4, 8)}-${AADHAAR.slice(8)}`, kind: "aadhaar", value: `${AADHAAR.slice(0, 4)}-${AADHAAR.slice(4, 8)}-${AADHAAR.slice(8)}`, note: "hyphenated" },
  { text: `आधार संख्या ${AADHAAR2}`, kind: "aadhaar", value: AADHAAR2, note: "Hindi label" },
  { text: `VID: ${VID.slice(0, 4)} ${VID.slice(4, 8)} ${VID.slice(8, 12)} ${VID.slice(12)}`, kind: "aadhaar", value: `${VID.slice(0, 4)} ${VID.slice(4, 8)} ${VID.slice(8, 12)} ${VID.slice(12)}`, note: "16-digit Virtual ID" },

  // -- phone ----------------------------------------------------------------
  { text: "Call 98765 43210 today", kind: "phone", value: "98765 43210", note: "5-5" },
  { text: "Mobile: 9876543210", kind: "phone", value: "9876543210", note: "plain 10" },
  { text: "Ph +91 98765 43210", kind: "phone", value: "+91 98765 43210", note: "+91 spaced" },
  { text: "Ph +91-9876543210", kind: "phone", value: "+91-9876543210", note: "+91 hyphen" },
  { text: "WhatsApp +919876543210", kind: "phone", value: "+919876543210", note: "+91 glued" },
  { text: "Tel: 09876543210", kind: "phone", value: "09876543210", note: "trunk 0" },
  { text: "Contact 0 98765 43210", kind: "phone", value: "0 98765 43210", note: "trunk 0 spaced" },
  { text: "Reach me on 9876 543 210", kind: "phone", value: "9876 543 210", note: "4-3-3" },
  { text: "Cell (91) 98765-43210", kind: "phone", value: "(91) 98765-43210", note: "parenthesised code" },
  { text: "Mob. 91 98765 43210", kind: "phone", value: "91 98765 43210", note: "91 no plus" },
  { text: "Office: 011-2345 6789", kind: "phone", value: "011-2345 6789", note: "Delhi landline" },
  { text: "Landline 022 2345 6789", kind: "phone", value: "022 2345 6789", note: "Mumbai landline" },
  { text: "US office +1 (415) 555-2671", kind: "phone", value: "+1 (415) 555-2671", note: "US" },
  { text: "UK +44 20 7946 0958", kind: "phone", value: "+44 20 7946 0958", note: "UK" },

  // -- email ----------------------------------------------------------------
  { text: "Write to priya.sharma@example.in", kind: "email", value: "priya.sharma@example.in", note: "plain" },
  { text: "Email: R.K_Narayan+work@sub.example.co.uk.", kind: "email", value: "R.K_Narayan+work@sub.example.co.uk", note: "plus, underscore, multi-TLD, trailing period" },
  { text: "Contact: priya [at] example [dot] in", kind: "email", value: "priya [at] example [dot] in", note: "bracket obfuscated" },
  { text: "Mail me: priya(at)example(dot)com", kind: "email", value: "priya(at)example(dot)com", note: "paren obfuscated" },
  { text: "priya AT example DOT in", kind: "email", value: "priya AT example DOT in", note: "word obfuscated" },

  // -- PAN / GSTIN ----------------------------------------------------------
  { text: "PAN: AAACR5055K", kind: "pan", value: "AAACR5055K", note: "plain" },
  { text: "PAN aaacr5055k", kind: "pan", value: "aaacr5055k", note: "lowercase" },
  { text: "Permanent Account Number AAACR 5055 K", kind: "pan", value: "AAACR 5055 K", note: "spaced" },
  { text: `GSTIN ${GSTIN}`, kind: "gstin", value: GSTIN, note: "valid check char" },
  { text: `GST No: ${GSTIN.slice(0, 2)} ${GSTIN.slice(2, 12)} ${GSTIN.slice(12)}`, kind: "gstin", value: `${GSTIN.slice(0, 2)} ${GSTIN.slice(2, 12)} ${GSTIN.slice(12)}`, note: "spaced" },

  // -- cards ----------------------------------------------------------------
  { text: `Card ${VISA.slice(0, 4)} ${VISA.slice(4, 8)} ${VISA.slice(8, 12)} ${VISA.slice(12)}`, kind: "payment_card", value: `${VISA.slice(0, 4)} ${VISA.slice(4, 8)} ${VISA.slice(8, 12)} ${VISA.slice(12)}`, note: "Visa spaced" },
  { text: `${MASTERCARD}`, kind: "payment_card", value: MASTERCARD, note: "Mastercard bare" },
  { text: `RuPay ${RUPAY.slice(0, 4)}-${RUPAY.slice(4, 8)}-${RUPAY.slice(8, 12)}-${RUPAY.slice(12)}`, kind: "payment_card", value: `${RUPAY.slice(0, 4)}-${RUPAY.slice(4, 8)}-${RUPAY.slice(8, 12)}-${RUPAY.slice(12)}`, note: "RuPay hyphenated" },
  { text: `Amex ${AMEX.slice(0, 4)} ${AMEX.slice(4, 10)} ${AMEX.slice(10)}`, kind: "payment_card", value: `${AMEX.slice(0, 4)} ${AMEX.slice(4, 10)} ${AMEX.slice(10)}`, note: "Amex 4-6-5" },

  // -- banking --------------------------------------------------------------
  { text: "IFSC SBIN0001234", kind: "ifsc", value: "SBIN0001234", note: "SBI" },
  { text: "IFSC: HDFC0000123", kind: "ifsc", value: "HDFC0000123", note: "HDFC" },
  { text: "ifsc code kkbk0000261", kind: "ifsc", value: "kkbk0000261", note: "lowercase Kotak" },
  { text: "A/c No. 123456789012", kind: "bank_account", value: "123456789012", note: "with cue" },
  { text: "UPI: priya@okhdfcbank", kind: "upi_id", value: "priya@okhdfcbank", note: "GPay" },
  { text: "Pay to 9876543210@ybl", kind: "upi_id", value: "9876543210@ybl", note: "PhonePe numeric" },
  { text: "priya.s@oksbi", kind: "upi_id", value: "priya.s@oksbi", note: "GPay SBI" },
  { text: "VPA rahul@axisbank", kind: "upi_id", value: "rahul@axisbank", note: "bank handle" },
  { text: "rahul@icici", kind: "upi_id", value: "rahul@icici", note: "iMobile" },
  { text: "pay@wahdfcbank", kind: "upi_id", value: "pay@wahdfcbank", note: "WhatsApp Pay" },
  { text: "shop@paytm", kind: "upi_id", value: "shop@paytm", note: "Paytm" },

  // -- other identifiers ----------------------------------------------------
  { text: "Passport No: J8369854", kind: "passport", value: "J8369854", note: "with cue" },
  { text: "Voter ID / EPIC: ABC1234567", kind: "voter_id", value: "ABC1234567", note: "with cue" },
  { text: "Vehicle MH 12 AB 1234", kind: "vehicle_number", value: "MH 12 AB 1234", note: "spaced" },
  { text: "Reg no. DL8CAF5031", kind: "vehicle_number", value: "DL8CAF5031", note: "compact" },
  { text: "Server 10.0.0.12", kind: "ip_address", value: "10.0.0.12", note: "IPv4" },

  // -- dates of birth -------------------------------------------------------
  { text: "DOB: 14/08/1991", kind: "date_of_birth", value: "14/08/1991", note: "numeric" },
  { text: "Date of Birth 1991-08-14", kind: "date_of_birth", value: "1991-08-14", note: "ISO" },
  { text: "Born on 14 August 1991", kind: "date_of_birth", value: "14 August 1991", note: "textual month" },
  { text: "Birthday: August 14, 1991", kind: "date_of_birth", value: "August 14, 1991", note: "US textual" },
  { text: "Birth date 14-Aug-91", kind: "date_of_birth", value: "14-Aug-91", note: "short month" },

  // -- people and organisations --------------------------------------------
  { text: "Dear Mr. Rahul Verma,", kind: "person_name", value: "Rahul Verma", note: "honorific" },
  { text: "Regards, Ananya Bhatt", kind: "person_name", value: "Ananya Bhatt", note: "cue" },
  { text: "Dr Priya Sharma will see you", kind: "person_name", value: "Priya Sharma", note: "Dr no period" },
  { text: "Bill to: Bharat Kumar", kind: "person_name", value: "Bharat Kumar", note: "given name that is also a country word" },
  { text: "Attn: May Fernandes", kind: "person_name", value: "May Fernandes", note: "given name that is also a month" },
  { text: "Smt. Sunita Devi", kind: "person_name", value: "Sunita Devi", note: "Smt honorific" },
  { text: "Invoice for Sharma Traders Pvt Ltd", kind: "org_name", value: "Sharma Traders Pvt Ltd", note: "legal suffix" },
  { text: "Supplier: Bank of Baroda", kind: "org_name", value: "Bank of Baroda", note: "connector inside org" },
  { text: "Tata Consultancy Services", kind: "org_name", value: "Tata Consultancy Services", note: "trade suffix" },

  // -- addresses ------------------------------------------------------------
  { text: "Flat 4B, 17/2 Brigade Road", kind: "postal_address", value: "Flat 4B, 17/2 Brigade Road", note: "flat + slash number" },
  { text: "H. No. 8, Sector 15", kind: "postal_address", value: "H. No. 8, Sector 15", note: "house number" },
  { text: "2nd Floor, MG Road", kind: "postal_address", value: "2nd Floor, MG Road", note: "ordinal, weak word rescued by a named road" },
  { text: "Office: MG Road, Bengaluru 560001", kind: "postal_address", value: "MG Road", note: "named street with no number, beside a city" },
  { text: "Regd. office: Anna Salai, Chennai", kind: "postal_address", value: "Anna Salai", note: "named street beside a city, Tamil street word" },
  { text: "Sector 62, Noida 201301", kind: "pincode", value: "201301", note: "real PIN beside its city" },
  { text: "Mob 9876 543210", kind: "phone", value: "9876 543210", note: "4-6 with a space — a real Indian format" },
  { text: "Bengaluru 560001", kind: "pincode", value: "560001", note: "PIN with city" },
  { text: "Pincode: 400001", kind: "pincode", value: "400001", note: "PIN with label" },
];

// ------------------------------------------------------------ negative corpus
//
// PII-shaped text that is not PII. None of it may produce a finding.

const NEGATIVES: { text: string; note: string }[] = [
  { text: "Order #402-8871234-1234567 shipped", note: "Amazon-style order id (17 digits)" },
  { text: "Tracking 1Z999AA10123456784", note: "UPS tracking" },
  { text: "AWB 123456789012", note: "12-digit airway bill, fails Verhoeff" },
  { text: "Timestamp 1710000000000", note: "epoch ms" },
  { text: "Unix time 1710000000", note: "epoch s" },
  { text: "Version 2.4.1.9000", note: "version string" },
  { text: "Build 20240315.1", note: "build number" },
  { text: "Coordinates 12.9716, 77.5946", note: "lat/long" },
  { text: "ISBN 978-3-16-148410-0", note: "ISBN-13" },
  { text: "Price ₹12,34,567.00", note: "Indian lakh formatting" },
  { text: "Total 1,234,567", note: "thousands" },
  { text: "Meeting on 12/03/2024 at 10:30", note: "bare date and time" },
  { text: "Due 2024-03-15", note: "bare ISO date" },
  { text: "Ticket PNR 4521367890", note: "10-digit PNR starting 4 - not a mobile" },
  { text: "SKU 98765432101", note: "11 digits starting 9" },
  { text: "Invoice INV-2024-000123", note: "invoice number" },
  { text: "Batch B1234567", note: "7 digits after letter" },
  { text: "Hash 3f2a9c1e7b4d", note: "hex" },
  { text: "UUID 550e8400-e29b-41d4-a716-446655440000", note: "uuid" },
  { text: "Model XPS 15 9530", note: "product model" },
  { text: "HTTP 200 OK, 404 Not Found", note: "status codes" },
  { text: "Screen 1920 x 1080 at 60 Hz", note: "resolution" },
  { text: "Chapter 3, Section 4.2, Page 17", note: "document structure" },
  { text: "Terms and Conditions Apply", note: "capitalised heading" },
  { text: "Learn More About Our Premium Plans", note: "capitalised CTA" },
  { text: "Monday March 2024 Summary Report", note: "date words" },
  { text: "Bangalore Chennai Mumbai Delhi", note: "cities" },
  { text: "Made in India", note: "country" },
  { text: "Login Password Reset Help", note: "UI words" },
  { text: "GST 18% CGST 9% SGST 9%", note: "tax words" },
  { text: "ABCDE1234Z is a placeholder", note: "PAN shape, invalid holder type Z" },
  { text: "Sample card 4111 1111 1111 1112", note: "fails Luhn" },
  { text: "Ref 27AAACR5055K1ZW", note: "GSTIN shape, bad check char" },
  { text: "Code 1234 5678 9012", note: "12 digits starting 1 - never an Aadhaar" },
  { text: "Reads 192.168.1", note: "incomplete IP" },
  { text: "Speed 300.0.0.1 Mbps", note: "not an IP - octet 300" },
  { text: "Pin the tab, then unpin it", note: "'pin' as a verb" },
  { text: "The Quick Brown Fox", note: "title case sentence" },
  { text: "Read the Wall Street Journal", note: "named street with no place context" },
  { text: "The Beatles recorded Abbey Road in 1969", note: "named street that is a record" },
  { text: "Amount payable: 500000", note: "6-digit amount, no place context" },

  // -- shapes the permissive phone pattern must not take ---------------------
  { text: "Look at the dot com bubble of 1999", note: "'at ... dot com' in prose" },
  { text: "We arrive at home dot and unpack", note: "'at' and 'dot' as words" },
  { text: "Lottery 78 90 12 34 56", note: "spaced digit pairs" },
  { text: "Qty 65 Price 12345 Total 803425", note: "quantities and totals" },
  { text: "Starts 2024-06-15 09:30, ends 2024-06-15 17:45", note: "datetimes" },
  { text: "Range 7000-8000 units, 9000-9999 reserved", note: "numeric ranges starting 6-9" },
  { text: "Sector 62 to Sector 137 along the expressway", note: "sector numbers, no PIN" },
  { text: "Invoice INV-7135-391841 paid", note: "4-6 hyphenated id after a prefix" },
  { text: "Ref 634795 5590 approved", note: "6-4 split adding to ten digits" },
  { text: "Ratio 65:35 and 70:30", note: "ratios" },
  { text: "Rs 65,000 and Rs 98,765", note: "Indian comma prices" },
  { text: "Odds 9/2, 7/4, 6/5", note: "fractions" },
  { text: "Room 604, Floor 6, Tower 9", note: "small numbers starting 6-9" },
  { text: "Score 98765 vs 43210", note: "two five-digit scores, non-adjacent" },
];

// --------------------------------------------- randomised stress: precision
//
// The phone pattern is permissive about grouping on purpose, which is exactly
// where a false positive would come from. Generate several thousand number-
// bearing strings that are *not* phone numbers - prices, dates, times, ranges,
// coordinates, ids of every width but ten - and count what fires. Any ten-digit
// run starting 6-9 is a phone number to any detector without a checksum, so
// those are deliberately absent; everything else here should be silent.

function seeded(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}
const rand = seeded(20260910);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const digits = (n: number, first = "123456789"): string => {
  let out = pick(first.split(""));
  while (out.length < n) out += String(Math.floor(rand() * 10));
  return out;
};
// A digit run that could never be an Indian mobile: wrong length, or starts 1-5.
const notMobile = (n: number): string => (n === 10 ? digits(10, "12345") : digits(n));

const STRESS: string[] = [];
for (let i = 0; i < 3000; i++) {
  const kind = Math.floor(rand() * 12);
  switch (kind) {
    case 0: STRESS.push(`Price ₹${digits(2)},${digits(3)}.${digits(2)}`); break;
    case 1: STRESS.push(`On ${digits(2, "0123").padStart(2, "0")}/${digits(2, "01")}/20${digits(2)}`); break;
    case 2: STRESS.push(`At ${digits(2, "01")}:${digits(2, "0123")} on 20${digits(2)}-${digits(2, "01")}-${digits(2, "0123")}`); break;
    case 3: STRESS.push(`Order ${notMobile(pick([7, 8, 9, 11, 12, 13]))}`); break;
    case 4: STRESS.push(`Lat ${digits(2)}.${digits(4)}, Lng ${digits(2)}.${digits(4)}`); break;
    case 5: STRESS.push(`Range ${notMobile(4)}-${notMobile(4)} units`); break;
    case 6: STRESS.push(`Ref ${notMobile(pick([4, 5, 6]))} ${notMobile(pick([4, 5, 6]))}`.replace(/^Ref ([6-9]\d{4}) ([6-9]?\d{4,5})$/, "Ref 1$1 2$2")); break;
    case 7: STRESS.push(`Version ${digits(1)}.${digits(2)}.${digits(4)}`); break;
    case 8: STRESS.push(`Score ${notMobile(5)} to ${notMobile(5)} points`); break;
    case 9: STRESS.push(`Weight ${digits(2)} kg, height ${digits(3)} cm, age ${digits(2)}`); break;
    case 10: STRESS.push(`Pages ${notMobile(3)}–${notMobile(3)}, Vol. ${digits(2)}`); break;
    default: STRESS.push(`Invoice INV-${digits(4)}-${notMobile(6)}`); break;
  }
}



// ----------------------------------------------------------------- run

let id = 0;
const node = (text: string): CapturedNode => ({
  id: ++id, tag: "p", role: "paragraph", label: "", text,
  attrs: {}, bbox: [0, 0, 400, 20], visible: true, children: [],
});

async function detectText(text: string) {
  id = 0;
  const capture: DomCapture = {
    url: "https://example.in/", origin: "https://example.in", title: "t", capturedAt: 1,
    viewport: { width: 1000, height: 800, dpr: 1, scrollX: 0, scrollY: 0, pageHeight: 800 },
    root: { id: 0, tag: "body", role: "document", label: "", attrs: {}, bbox: [0, 0, 1000, 800],
      visible: true, children: [node(text)] },
    stats: { examined: 1, kept: 2, pruned: 0 },
  };
  const result = await detect(capture);
  return result.findings.filter((f) => f.shape === "text");
}

const missed: string[] = [];
const wrongSpan: string[] = [];
const byKind = new Map<PiiKind, { total: number; found: number }>();

for (const p of POSITIVES) {
  const row = byKind.get(p.kind) ?? { total: 0, found: 0 };
  row.total++;
  byKind.set(p.kind, row);

  const findings = await detectText(p.text);
  const exact = findings.find((f) => f.kind === p.kind && f.value === p.value);
  if (exact) { row.found++; continue; }

  const partial = findings.find((f) => f.kind === p.kind && p.value.includes(f.value ?? " "));
  if (partial) {
    wrongSpan.push(`${p.kind} (${p.note}): found "${partial.value}" — should be "${p.value}"`);
    continue;
  }
  const others = findings.map((f) => `${f.kind}:"${f.value}"`).join(", ") || "nothing";
  missed.push(`${p.kind} (${p.note}): "${p.text}" → ${others}`);
}

const falsePositives: string[] = [];
for (const n of NEGATIVES) {
  const findings = await detectText(n.text);
  for (const f of findings) {
    falsePositives.push(`${f.kind} "${f.value}" in "${n.text}" (${n.note})`);
  }
}

const stressHits: string[] = [];
for (const text of STRESS) {
  const findings = await detectText(text);
  for (const f of findings) stressHits.push(`${f.kind} "${f.value}" in "${text}"`);
}
const stressRate = stressHits.length / STRESS.length;

const recall = (POSITIVES.length - missed.length - wrongSpan.length) / POSITIVES.length;

console.log(JSON.stringify({
  positives: POSITIVES.length,
  negatives: NEGATIVES.length,
  recall: `${(recall * 100).toFixed(1)}%`,
  falsePositives: falsePositives.length,
  stress: {
    samples: STRESS.length,
    fired: stressHits.length,
    rate: `${(stressRate * 100).toFixed(2)}%`,
    examples: stressHits.slice(0, 8),
  },
  byKind: Object.fromEntries([...byKind].map(([k, v]) => [k, `${v.found}/${v.total}`])),
  missed,
  wrongSpan,
  falsePositiveDetail: falsePositives,
  // Both corpora are curated, so both targets are absolute.
  // The stress set has no phone numbers in it by construction, so the bar is
  // absolute there too.
  pass: missed.length === 0 && wrongSpan.length === 0 && falsePositives.length === 0 && stressHits.length === 0,
}, null, 2));

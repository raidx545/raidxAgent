import { scanText, detect } from "../src/pii/detect";
import { Vault } from "../src/vault/vault";
import { findApprox } from "../src/pii/fuzzy";
import { isIndianMobile, isDrivingLicence, isIban, isSsn, isMrzLine } from "../src/pii/checksums";
import type { CapturedNode, DomCapture } from "../src/capture/types";

/**
 * The kinds of PII a leak audit found going straight through.
 *
 * Pictures of an ID card, a bank slip, an OTP message, a passport page and a
 * table of customers were run through the whole pipeline and the redacted
 * image read back. Everything below was readable afterwards - some of it
 * because no detector knew the kind at all, some because a detector knew it
 * and a small mistake let it past.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

const kinds = async (text: string) => (await scanText(text)).map((f) => `${f.kind}:${f.value}`);
const has = async (text: string, kind: string, value: string) => {
  const found = await kinds(text);
  want(found.includes(`${kind}:${value}`), `${JSON.stringify(text)} did not yield ${kind}:${value} - got ${found.join(" | ") || "nothing"}`);
};
const lacks = async (text: string, kind: string) => {
  const found = await kinds(text);
  want(!found.some((f) => f.startsWith(`${kind}:`)), `${JSON.stringify(text)} wrongly yielded ${kind}: ${found.join(" | ")}`);
};

// ---------------------------------------------- a validator that ate the 91 series
//
// "91" was stripped as a country code whatever the length, so 9123456780 - a
// ten-digit mobile starting 91 - became eight digits and was rejected.

want(isIndianMobile("9123456780"), "a mobile in the 91 series was rejected");
want(isIndianMobile("+91 9123456780") && isIndianMobile("919123456780") && isIndianMobile("09123456780"),
  "a 91-series mobile with its country code or trunk zero was rejected");
want(!isIndianMobile("23456780"), "eight digits passed as a mobile");
await has("Mob 9123456780", "phone", "9123456780");

// ---------------------------------------------------------- kinds that were missing

await has("DL No: MH12 20110012345", "driving_licence", "MH12 20110012345");
await has("Licence DL-0420110149646 valid", "driving_licence", "DL-0420110149646");
want(!isDrivingLicence("ZZ12 20110012345"), "a licence with no such state code passed");
want(!isDrivingLicence("MH12 18990012345"), "a licence issued in 1899 passed");

await has("SSN 536-22-4187", "ssn", "536-22-4187");
want(!isSsn("666-12-3456") && !isSsn("000-12-3456") && !isSsn("912-12-3456"), "a never-issued SSN range passed");

want(isIban("GB82 WEST 1234 5698 7654 32"), "a valid IBAN was rejected");
want(!isIban("GB82 WEST 1234 5698 7654 33"), "an IBAN with a wrong check passed");
await has("Pay to GB82 WEST 1234 5698 7654 32", "bank_account", "GB82 WEST 1234 5698 7654 32");

const MRZ1 = "P<INDSHARMA<<PRIYA<<<<<<<<<<<<<<<<<<<<<<<<<";
const MRZ2 = "J8369854<4IND9001014F2601012<<<<<<<<<<<<<<04";
want(isMrzLine(MRZ1) && isMrzLine(MRZ2), "a passport machine-readable line was not recognised");
await has(MRZ2, "passport", MRZ2);
await lacks("THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG", "passport");

// One-time codes, both ways round.
await has("Your OTP for login is 482913. Do not share it.", "otp", "482913");
await has("482913 is your verification code", "otp", "482913");
await has("Use one-time password 5521 to continue", "otp", "5521");
await lacks("Order 482913 shipped", "otp");

// Secrets by shape and by label.
await has("API key: sk-live-4f9a8b7c6d5e4f3a2b1c0d9e", "secret", "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e");
await has("token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "secret", "ghp_abcdefghijklmnopqrstuvwxyz0123456789");
await has("Password: Tiger@2024!", "secret", "Tiger@2024!");
// The label's value is on its own line: "API key:" ending one OCR line must
// not take the next line's label as the key.
await lacks("API key:\nPassword:", "secret");
// "PIN" is the postcode in an Indian address, not a secret.
await lacks("Bengaluru PIN: 560025", "secret");

// ----------------------------------------------------------------- name cues

await has("Name: RAHUL VERMA", "person_name", "RAHUL VERMA");
await has("Name:Priya Sharma", "person_name", "Priya Sharma");
await has("S/O Ram Kumar Verma", "person_name", "Ram Kumar Verma");
await has("Account Holder: Anita Desai", "person_name", "Anita Desai");
await has("ACCOUNT HOLDER: ANITA DESAI", "person_name", "ANITA DESAI");
await has("MR. RAHUL VERMA", "person_name", "RAHUL VERMA");
// A name does not run on into the next line's label.
{
  const found = await kinds("Name: RAHUL VERMA\nDOB: 14/08/1991");
  want(found.includes("person_name:RAHUL VERMA"), `a name ran across a line break: ${found.join(" | ")}`);
}
// "Name" without a colon is ordinary English, and "to" is not a cue.
await lacks("Name your price", "person_name");
await lacks("Sign in to Google", "person_name");
// Lower-case "miss" is a verb.
await lacks("Don't miss Diwali Sale", "person_name");

// --------------------------------------------------- names under a column header

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 100, 20], visible: true, children: [], ...p,
});
function page(children: CapturedNode[]): DomCapture {
  return {
    url: "https://crm.example.com/", origin: "https://crm.example.com", title: "Customers", capturedAt: 1,
    viewport: { width: 1200, height: 800, dpr: 1, scrollX: 0, scrollY: 0, pageHeight: 800 },
    root: { ...n({ tag: "body", role: "document" }), children },
    stats: { examined: 1, kept: 1, pruned: 0 },
  };
}
const namesIn = async (capture: DomCapture) =>
  (await detect(capture)).findings.filter((f) => f.kind === "person_name").map((f) => f.value);

{
  id = 0;
  const table = page([
    n({ tag: "th", role: "th", text: "Customer Name", bbox: [20, 100, 160, 24] }),
    n({ tag: "th", role: "th", text: "Mobile", bbox: [300, 100, 120, 24] }),
    n({ tag: "td", role: "td", text: "Arjun Mehta", bbox: [20, 130, 160, 24] }),
    n({ tag: "td", role: "td", text: "98760 12345", bbox: [300, 130, 120, 24] }),
    n({ tag: "td", role: "td", text: "Neha Kapoor", bbox: [20, 160, 160, 24] }),
    n({ tag: "td", role: "td", text: "70112 23344", bbox: [300, 160, 120, 24] }),
  ]);
  const names = await namesIn(table);
  want(names.includes("Arjun Mehta") && names.includes("Neha Kapoor"),
    `names in a "Customer Name" column were not found: ${names.join(", ")}`);
}
{
  // A record laid out as label and value side by side.
  id = 0;
  const record = page([
    n({ tag: "dt", role: "dt", text: "Full name", bbox: [20, 100, 90, 20] }),
    n({ tag: "dd", role: "dd", text: "Meera Nair", bbox: [140, 100, 120, 20] }),
  ]);
  const names = await namesIn(record);
  want(names.includes("Meera Nair"), `a name beside its "Full name" label was not found: ${names.join(", ")}`);
}
{
  // A form: "Name" label with other labels under it - none of them names.
  id = 0;
  const form = page([
    n({ tag: "span", text: "Name", bbox: [20, 100, 60, 20] }),
    n({ tag: "span", text: "Date Of Birth", bbox: [20, 140, 100, 20] }),
    n({ tag: "span", text: "Email Address", bbox: [20, 180, 100, 20] }),
    n({ tag: "span", text: "WhatsApp", bbox: [20, 220, 100, 20] }),
  ]);
  const names = await namesIn(form);
  want(names.length === 0, `form labels under "Name" were taken for names: ${names.join(", ")}`);
}

// ------------------------------------------------------------ sealed kinds
//
// An OTP or a password on screen authorises whoever holds it. The vault must
// never hold the value - nothing can resolve or type a sealed token.

{
  const vault = new Vault();
  const otp = vault.tokenize("482913", "otp");
  const secret = vault.tokenize("Tiger@2024!", "secret");
  want(vault.resolve(otp) === undefined, "an OTP token resolved to its value");
  want(vault.resolve(secret) === undefined, "a password token resolved to its value");
  want(vault.tokenize("482913", "otp") === otp, "the same OTP seen twice got two tokens");
  want(vault.tokenize("111111", "otp") !== otp, "two different OTPs shared a token");
  want(!vault.values().some((v) => v.value === "482913" || v.value === "Tiger@2024!"),
    "a sealed value is listed among the vault's known values");
  want(vault.resolve(vault.tokenize("98765 43210", "phone")) === "98765 43210", "an ordinary value stopped resolving");
}

// -------------------------------------------------- finding known values in OCR

const approx = (text: string, value: string) => findApprox(text, value).map(([a, b]) => text.slice(a, b));
want(approx("Mob 9876543210", "98765 43210").includes("9876543210"), "a phone without its space was not matched");
want(approx("Call 98765-43210", "98765 43210").includes("98765-43210"), "a phone with a hyphen was not matched");
want(approx("Signed: KAVYA lYER", "Kavya Iyer").includes("KAVYA lYER"), "a name with I read as l was not matched");
want(approx("priya.sharma@exampie.in", "priya.sharma@example.in").length === 1, "an email one letter off was not matched");
want(approx("Contact Kavya Iyer today", "Kavya Iyer")[0] === "Kavya Iyer", "the matched span is not the name itself");
want(approx("rahul", "Rahu").length === 0, "a four-letter value matched with an edit");
want(approx("Arjun Mehta", "Neha Kapoor").length === 0, "two different names matched");
want(approx("98765 43219", "98765 43210").length === 1 && approx("12345 67890", "98765 43210").length === 0,
  "the edit allowance is wrong: one digit off should match, an unrelated number should not");

// ------------------------------------------ found on the ID card test page
//
// Each of these was readable in the image the extension sent for
// dist/id-cards-page.html, or covered something that is not private.

const { repairLabels, repairCase, mrzNames } = await import("../src/sanitize/ocr-screenshot");
const { correctIdentifiers } = await import("../src/pii/ocr-correct");

// OCR misreads a label as readily as a value, and a misread label is no cue.
want(repairLabels("Surmame\nSHARMA").text === "Surname\nSHARMA", "a misread 'Surname' was not repaired");
want(repairLabels("Sumame").text === "Surname", "'Sumame' was not repaired");
want(repairLabels("Sunday").text === "Sunday", "an ordinary word was turned into a label");
want(repairLabels("Password: Tiger@2024!").text === "Password: Tiger@2024!", "'Password' was repaired into another label");
{
  const r = repairLabels("x Sumame\nSHARMA");
  const at = r.text.indexOf("SHARMA");
  want(r.from[at] === "x Sumame\nSHARMA".indexOf("SHARMA"), "a repaired label moved the offsets of what follows it");
}
want(repairCase("Elector's Name : Meenakshi lyer") === "Elector's Name : Meenakshi Iyer", "an I read as l was not repaired");
want(repairCase("hello lucky day") === "hello lucky day", "an l after a lower-case word was changed");

// A passport's machine-readable zone names the holder, however OCR read the fillers.
want(JSON.stringify(mrzNames("P<INDSHARMA<<AARAV<<<<<<<<<<<<<<<<<<<<<<<<<<")) === '["SHARMA","AARAV"]', "clean MRZ names were not parsed");
want(JSON.stringify(mrzNames("P<INDSHARMA<K<AARAV<LLLLLLLLLLLLLLLLLLLLLLLLKL")) === '["SHARMA","AARAV"]',
  `MRZ names with fillers read as K and L were not parsed: ${JSON.stringify(mrzNames("P<INDSHARMA<K<AARAV<LLLLLLLLLLLLLLLLLLLLLLLLKL"))}`);
want(isMrzLine("P<INDSHARMA<K<AARAV<LLLLLLLLLLLLLLLLLLLLLLLLKL"), "an MRZ line with misread fillers was not recognised");
want(isMrzLine("P<INDSHARMA<<AARAV<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"), "an MRZ line a couple of fillers long was not recognised");

// The name on an Aadhaar card has no label - it is the line above the birth date.
await has("Government of India\nAarav Sharma\nDOB: 17/03/1994\nMale", "person_name", "Aarav Sharma");
// A label is not a name: "Customer" is a cue, "ID" is the rest of the label.
await lacks("Customer ID 84720193", "person_name");
await has("Customer ID 84720193", "identity_field", "84720193");
await lacks("holder's name, DOB, both MRZ lines", "person_name");
// The whole address, label to PIN, not only its street line.
{
  const found = await kinds("Address:\nS/O Rakesh Sharma,\nFlat 12B, 44/1 Residency Road,\nRichmond Town, Bengaluru,\nKarnataka - 560025");
  want(found.some((f) => f.startsWith("postal_address:") && f.includes("Richmond Town") && f.includes("560025")),
    `the address block was not covered from label to PIN: ${found.join(" | ")}`);
}
// A PIN code needs a place or its own label - not the word "PIN" somewhere nearby.
await lacks("Reference 634795 5590 is a tracking code. PIN code lookup is free.", "pincode");
await has("PIN: 560025", "pincode", "560025");
// "Elector" is a voter card's cue as much as "election" is.
await has("Elector Photo Identity Card\nKRN4829163", "voter_id", "KRN4829163");
// OCR's "A/c" is "Alc".
await has("Alc No. 50100482917365", "bank_account", "50100482917365");
// A card's expiry after its label.
await has("VALID THRU 08/29", "payment_field", "08/29");
// An amount is not an identifier, however its digits bend.
want(!correctIdentifiers("Total 21,712").some((c) => c.kind === "pan"), "'Total 21,712' was corrected into a PAN");

console.log(JSON.stringify({ failures: fails, pass: fails.length === 0 }, null, 2));

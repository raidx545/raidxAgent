import * as C from "../src/pii/checksums";

const fails: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  if (got !== want) fails.push(`${name}: got ${got}, want ${want}`);
};

// --- Verhoeff: round-trip. Append the computed check digit, must validate. ---
let roundTripOk = 0;
for (let i = 0; i < 3000; i++) {
  let payload = "";
  for (let j = 0; j < 11; j++) payload += Math.floor(Math.random() * 10);
  const full = payload + C.verhoeffCheckDigit(payload);
  if (C.verhoeff(full)) roundTripOk++;
}
eq("verhoeff round-trip (3000 random)", roundTripOk, 3000);

// --- Verhoeff must REJECT single-digit errors and adjacent transpositions ---
// (that is the whole point of Verhoeff over a naive mod-10)
let caughtSingle = 0, singleTrials = 0, caughtTrans = 0, transTrials = 0;
for (let i = 0; i < 2000; i++) {
  let payload = "";
  for (let j = 0; j < 11; j++) payload += Math.floor(Math.random() * 10);
  const full = payload + C.verhoeffCheckDigit(payload);

  const pos = Math.floor(Math.random() * 12);
  const wrong = String((Number(full[pos]) + 1 + Math.floor(Math.random() * 9)) % 10);
  if (wrong !== full[pos]) {
    singleTrials++;
    const corrupted = full.slice(0, pos) + wrong + full.slice(pos + 1);
    if (!C.verhoeff(corrupted)) caughtSingle++;
  }

  const p = Math.floor(Math.random() * 11);
  if (full[p] !== full[p + 1]) {
    transTrials++;
    const swapped = full.slice(0, p) + full[p + 1] + full[p] + full.slice(p + 2);
    if (!C.verhoeff(swapped)) caughtTrans++;
  }
}
eq("verhoeff catches ALL single-digit errors", caughtSingle, singleTrials);
eq("verhoeff catches ALL adjacent transpositions", caughtTrans, transTrials);

// --- Luhn against published test card numbers ---
for (const [n, want] of [
  ["4111111111111111", true],   // Visa test
  ["4012888888881881", true],   // Visa test
  ["5555555555554444", true],   // Mastercard test
  ["378282246310005", true],    // Amex test
  ["6011111111111117", true],   // Discover test
  ["4111111111111112", false],  // last digit wrong
  ["1234567890123456", false],
] as [string, boolean][]) {
  eq(`luhn(${n})`, C.luhn(n), want);
}
eq("brand 4111...", C.cardBrand("4111111111111111"), "Visa");
eq("brand 5555...", C.cardBrand("5555555555554444"), "Mastercard");
eq("brand 3782...", C.cardBrand("378282246310005"), "Amex");
eq("isPaymentCard rejects repdigit", C.isPaymentCard("4444444444444444"), false);
eq("isPaymentCard accepts spaced", C.isPaymentCard("4111 1111 1111 1111"), true);

// --- Aadhaar rules ---
const aadhaarPayload = "23456789012";
const validAadhaar = aadhaarPayload + C.verhoeffCheckDigit(aadhaarPayload);
eq("valid aadhaar accepted", C.isAadhaar(validAadhaar), true);
eq("aadhaar accepts spaced form", C.isAadhaar(validAadhaar.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3")), true);
eq("aadhaar rejects leading 0", C.isAadhaar("0" + validAadhaar.slice(1)), false);
eq("aadhaar rejects leading 1", C.isAadhaar("1" + validAadhaar.slice(1)), false);
eq("aadhaar rejects repdigit", C.isAadhaar("222222222222"), false);
eq("aadhaar rejects 11 digits", C.isAadhaar(aadhaarPayload), false);

// How often does a RANDOM 12-digit number pass? Should be about 1 in 10.
let falsePositives = 0;
const N = 100000;
for (let i = 0; i < N; i++) {
  let n = String(2 + Math.floor(Math.random() * 8));
  for (let j = 0; j < 11; j++) n += Math.floor(Math.random() * 10);
  if (C.isAadhaar(n)) falsePositives++;
}
const rate = falsePositives / N;

// --- PAN ---
eq("pan valid P", C.isPan("ABCPE1234F"), true);
eq("pan valid C", C.isPan("AAACR5055K"), true);
eq("pan rejects bad holder type", C.isPan("ABCXE1234F"), false);
eq("pan rejects wrong shape", C.isPan("ABCD1234EF"), false);
eq("pan lowercase ok", C.isPan("abcpe1234f"), true);

// --- IFSC / mobile / passport / voter ---
eq("ifsc valid", C.isIfsc("SBIN0001234"), true);
eq("ifsc rejects non-zero 5th", C.isIfsc("SBIN1001234"), false);
eq("mobile valid", C.isIndianMobile("9876543210"), true);
eq("mobile with +91", C.isIndianMobile("+91 98765 43210"), true);
eq("mobile rejects leading 5", C.isIndianMobile("5876543210"), false);
eq("mobile rejects repdigit", C.isIndianMobile("9999999999"), false);
eq("passport valid", C.isIndianPassport("A1234567"), true);
eq("passport rejects Q", C.isIndianPassport("Q1234567"), false);
eq("voter valid", C.isVoterId("ABC1234567"), true);

// --- GSTIN: build one from a known-good PAN and verify checksum logic ---
const gstBody = "27AAACR5055K1Z";
const ALPH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
let sum = 0;
for (let i = 0; i < 14; i++) {
  const w = ALPH.indexOf(gstBody[i]) * (i % 2 === 0 ? 1 : 2);
  sum += Math.floor(w / 36) + (w % 36);
}
const gstin = gstBody + ALPH[(36 - (sum % 36)) % 36];
eq("gstin self-consistent", C.isGstin(gstin), true);
eq("gstin rejects wrong check char", C.isGstin(gstBody + (ALPH[(36 - (sum % 36)) % 36] === "A" ? "B" : "A")), false);
eq("gstin rejects bad state code", C.isGstin("99" + gstin.slice(2)), false);

console.log(JSON.stringify({
  aadhaarRandomPassRate: `${(rate * 100).toFixed(2)}% (expect ~10% — pattern alone would be 100%)`,
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

/**
 * Checksum validators. Every one of these turns a pattern that would otherwise
 * fire on any run of digits into a test with a ~1-in-10 (or better) false
 * positive rate. Order matters in the detector: pattern first because it is
 * cheap, checksum second because it is certain.
 */

// --- Verhoeff (Aadhaar) ---------------------------------------------------
// Dihedral group D5 multiplication table.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

// Permutation table, applied cyclically by position.
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** True when the digit string carries a valid Verhoeff check digit. */
export function verhoeff(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c][P[i % 8][Number(reversed[i])]];
  }
  return c === 0;
}

/** Computes the Verhoeff check digit for a payload. Used to build test data. */
export function verhoeffCheckDigit(payload: string): number {
  const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];
  let c = 0;
  const reversed = payload.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = D[c][P[(i + 1) % 8][Number(reversed[i])]];
  }
  return INV[c];
}

/**
 * An Aadhaar number is 12 digits, never starts with 0 or 1, and carries a
 * Verhoeff check digit. All three together make this reliable.
 */
export function isAadhaar(raw: string): boolean {
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^[2-9]\d{11}$/.test(digits)) return false;
  // A repdigit passes Verhoeff surprisingly often and is never a real number.
  if (/^(\d)\1{11}$/.test(digits)) return false;
  return verhoeff(digits);
}

// --- Luhn (payment cards) -------------------------------------------------

export function luhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Card brand from the issuer identification number, or undefined. */
export function cardBrand(digits: string): string | undefined {
  if (/^4\d{12}(\d{3})?(\d{3})?$/.test(digits)) return "Visa";
  if (/^(5[1-5]\d{4}|222[1-9]\d{2}|22[3-9]\d{3}|2[3-6]\d{4}|27[01]\d{3}|2720\d{2})\d{10}$/.test(digits))
    return "Mastercard";
  if (/^3[47]\d{13}$/.test(digits)) return "Amex";
  if (/^6(?:011|5\d{2}|4[4-9]\d)\d{12}$/.test(digits)) return "Discover";
  if (/^(6521|6522|60|81|82)\d+$/.test(digits)) return "RuPay";
  return undefined;
}

export function isPaymentCard(raw: string): boolean {
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  return luhn(digits);
}

// --- PAN (Indian income tax) ----------------------------------------------

/** Fourth character encodes holder type; anything else is not a real PAN. */
const PAN_HOLDER_TYPES = new Set(["P", "C", "H", "F", "A", "T", "B", "L", "J", "G", "K"]);

export function isPan(raw: string): boolean {
  const value = raw.toUpperCase().replace(/\s/g, "");
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(value)) return false;
  return PAN_HOLDER_TYPES.has(value[3]);
}

// --- GSTIN ----------------------------------------------------------------

const GST_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * 15 characters: 2-digit state code, a PAN, an entity number, 'Z', then a
 * mod-36 check character computed with alternating weights.
 */
export function isGstin(raw: string): boolean {
  const value = raw.toUpperCase().replace(/\s/g, "");
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(value)) return false;

  const state = Number(value.slice(0, 2));
  if (state < 1 || state > 38) return false;

  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = GST_ALPHABET.indexOf(value[i]);
    if (code < 0) return false;
    const weighted = code * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(weighted / 36) + (weighted % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  return GST_ALPHABET[check] === value[14];
}

// --- IFSC -----------------------------------------------------------------

/** Four-letter bank code, a reserved '0', then a six-character branch code. */
export function isIfsc(raw: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(raw.toUpperCase().replace(/\s/g, ""));
}

// --- Indian mobile --------------------------------------------------------

export function isIndianMobile(raw: string): boolean {
  const digits = raw.replace(/[\s()+-]/g, "");
  const local = digits.replace(/^(91|0)/, "");
  if (!/^[6-9]\d{9}$/.test(local)) return false;
  if (/^(\d)\1{9}$/.test(local)) return false;
  return true;
}

// --- Indian passport ------------------------------------------------------

export function isIndianPassport(raw: string): boolean {
  return /^[A-PR-WY][1-9]\d{5}[1-9]$/.test(raw.toUpperCase().replace(/\s/g, ""));
}

// --- Voter ID (EPIC) ------------------------------------------------------

export function isVoterId(raw: string): boolean {
  return /^[A-Z]{3}\d{7}$/.test(raw.toUpperCase().replace(/\s/g, ""));
}

// --- Vehicle registration -------------------------------------------------

export function isVehicleNumber(raw: string): boolean {
  return /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(raw.toUpperCase().replace(/[\s-]/g, ""));
}

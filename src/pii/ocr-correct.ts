import type { PiiKind } from "./types";
import * as check from "./checksums";

/**
 * Reading identifiers the way a person does: by their shape.
 *
 * OCR does not know that a PAN is five letters, four digits and a letter. It
 * sees "AAACR5055K" as a jumble and, unsure, reads what it thinks is likeliest -
 * "AAACRS055K", "AAACR5O55K" - and the validator, which is strict on purpose,
 * throws the whole thing away. On a clean render Tesseract reports 73%
 * confidence on a PAN against 95% on the words around it; on a real page that
 * uncertainty becomes a wrong character, and the identifier goes to the model
 * in plain sight.
 *
 * Every Indian identifier has a fixed template, so the ambiguity is resolvable
 * by position: a character in a digit slot that looks like a letter can only be
 * the digit it resembles, and the other way round. Where the identifier carries
 * a checksum - Aadhaar, GSTIN, a payment card - the checksum then confirms the
 * correction was right. Where it does not, the number of corrections is capped,
 * so a word that merely resembles an identifier is not bent into one.
 *
 * Only OCR text goes through this. Text from the DOM is exact, and correcting
 * it would add false positives to a channel that has none.
 */

/** What each character might have been, if it sits in a digit slot. */
const TO_DIGIT: Record<string, string> = {
  O: "0", o: "0", Q: "0", D: "0",
  I: "1", l: "1", i: "1", "|": "1", "!": "1", L: "1",
  Z: "2", z: "2",
  E: "3",
  A: "4",
  S: "5", s: "5",
  G: "6", b: "6",
  T: "7", Y: "7",
  B: "8",
  g: "9", q: "9",
};

/** What each character might have been, if it sits in a letter slot. */
const TO_LETTER: Record<string, string> = {
  "0": "O", "1": "I", "2": "Z", "3": "E", "4": "A", "5": "S", "6": "G", "7": "T", "8": "B", "9": "G",
  "|": "I", "!": "I",
};

/**
 * Slot classes: L letter, D digit, X either, 0 the literal zero, Z the literal Z.
 */
interface Template {
  kind: PiiKind;
  /** Documentation only; names what the non-fixed slots mean. */
  kindNote?: string;
  slots: string;
  /** Final say, after the slots have been filled. */
  validate: (value: string) => boolean;
  /** Corrections allowed without a checksum to back them. */
  maxCorrections: number;
  why: string;
}

const TEMPLATES: Template[] = [
  {
    kind: "aadhaar",
    slots: "DDDDDDDDDDDD",
    validate: check.isAadhaar,
    // Verhoeff catches every single-character error; the count is not needed.
    maxCorrections: 12,
    why: "12 digits with a valid Verhoeff check digit, read from an image",
  },
  {
    kind: "aadhaar",
    slots: "DDDDDDDDDDDDDDDD",
    validate: check.isAadhaarVid,
    maxCorrections: 16,
    why: "16-digit Virtual ID with a valid Verhoeff check digit, read from an image",
  },
  {
    kind: "gstin",
    slots: "DDLLLLLDDDDLXZX",
    validate: check.isGstin,
    maxCorrections: 15,
    why: "GSTIN with a valid mod-36 check character, read from an image",
  },
  {
    kind: "pan",
    slots: "LLLLLDDDDL",
    validate: check.isPan,
    // No checksum, so a cap is what stands between a PAN and any ten-character
    // word with numbers in the middle.
    maxCorrections: 2,
    why: "PAN shape with a valid holder-type letter, read from an image",
  },
  {
    kind: "ifsc",
    // B is the branch code: alphanumeric, but resolved all-or-nothing (see fit).
    kindNote: "branch",
    slots: "LLLL0BBBBBB",
    validate: check.isKnownIfsc,
    // Higher than PAN's cap because the real gate here is the bank code: the
    // first four letters must match a bank that exists, which no ordinary word
    // does. "SBIN0001234" read as "SBINOOO1234" needs three corrections - the
    // literal zero and two branch digits - so a cap of two rejected every
    // realistic misreading.
    maxCorrections: 6,
    why: "IFSC of a known bank, read from an image",
  },
];

/**
 * Kinds whose validator is a real checksum, so a correction that passes it is
 * proven rather than merely plausible. PAN's holder-type letter and IFSC's bank
 * code are constraints, not checksums.
 */
const CHECKSUMMED = new Set<PiiKind>(["aadhaar", "gstin", "payment_card"]);

/**
 * Kinds this module is about.
 *
 * Snapping only ever considers structured identifiers. A name or an
 * organisation from the tree has no template and no checksum, so "could OCR
 * have produced this?" is nearly always yes - and the answer would be to bend
 * any similar phrase into a finding. Those are matched literally elsewhere,
 * where an exact match is the whole test.
 */
const IDENTIFIERS = new Set<PiiKind>([
  "aadhaar", "pan", "gstin", "ifsc", "payment_card",
  "passport", "voter_id", "vehicle_number", "bank_account", "upi_id",
]);

/** Card numbers vary in length, so they are handled outside the fixed templates. */
const CARD_LENGTHS = { min: 13, max: 19 };

export interface Corrected {
  kind: PiiKind;
  /** Span within the line text, covering every word the identifier came from. */
  start: number;
  end: number;
  /** The identifier as it should read - what is tokenized. */
  value: string;
  /** The text as OCR gave it. */
  read: string;
  corrections: number;
  /**
   * True when the correction was confirmed rather than inferred - either a
   * checksum held, or the page's own tree carries the same identifier exactly.
   */
  proven: boolean;
  why: string;
}

/**
 * Glyphs that look like one another, as sets rather than as a direction.
 *
 * The two maps above answer "what digit could this letter be" and the reverse,
 * which is what a *typed* slot needs. Comparing a reading against a known truth
 * needs something else: `l` misread for `I` is a letter-for-letter confusion
 * that neither map covers, and it is among the commonest OCR makes.
 */
const LOOKALIKES: readonly string[] = [
  "0OoQD",
  "1Iil|!",
  "2Zz",
  "3E",
  "4A",
  "5Ss",
  "6Gb",
  "7TY",
  "8B",
  "9gq",
];

/**
 * The subset OCR genuinely confuses with digits, for slots where either a
 * letter or a digit is legitimate.
 *
 * `TO_DIGIT` is deliberately broad because in a slot that *must* hold a digit,
 * any letter is by definition a misreading and the nearest guess is the best
 * available. Where both are legal that reasoning collapses: `A` in an IFSC
 * branch code is far more likely to be the letter A than a misread 4. Only the
 * confusions that happen often enough to bet on are listed here.
 */
const AMBIGUOUS_DIGIT: Record<string, string> = {
  O: "0", o: "0",
  I: "1", l: "1", i: "1", "|": "1", "!": "1",
  Z: "2", z: "2",
  S: "5", s: "5",
  G: "6",
  B: "8",
};

/** Punctuation a page puts inside an identifier, and OCR faithfully reports. */
function strip(text: string): string {
  return text.replace(/[\s\-.:,;()]+/g, "");
}

/** Fills the slots of one template; undefined when a character fits nowhere. */
function fit(raw: string, slots: string): { value: string; corrections: number } | undefined {
  if (raw.length !== slots.length) return undefined;
  const chars: string[] = [];
  const branch: number[] = [];
  let corrections = 0;

  for (let i = 0; i < slots.length; i++) {
    const c = raw[i];
    const slot = slots[i];
    let out: string | undefined;

    if (slot === "D") {
      if (/\d/.test(c)) out = c;
      else if (TO_DIGIT[c]) { out = TO_DIGIT[c]; corrections++; }
    } else if (slot === "L") {
      if (/[A-Za-z]/.test(c)) out = c.toUpperCase();
      else if (TO_LETTER[c]) { out = TO_LETTER[c]; corrections++; }
    } else if (slot === "0") {
      if (c === "0") out = "0";
      else if (TO_DIGIT[c] === "0") { out = "0"; corrections++; }
    } else if (slot === "Z") {
      if (c === "Z" || c === "z") out = "Z";
      else if (c === "2" || c === "7") { out = "Z"; corrections++; }
    } else if (slot === "B") {
      // Settled below, once the whole run can be seen.
      if (/[A-Za-z0-9]/.test(c)) { out = c.toUpperCase(); branch.push(i); }
    } else {
      // X: either. Keep as read, uppercased.
      if (/[A-Za-z0-9]/.test(c)) out = c.toUpperCase();
    }

    if (out === undefined) return undefined;
    chars.push(out);
  }

  // A branch code is alphanumeric, so no single character can be settled on its
  // own - "O" is as valid a letter as it is a misread zero. The run decides:
  // Indian IFSC branch codes are overwhelmingly all-numeric (SBIN0001234,
  // HDFC0000123), so if *every* character could be a digit, they all are.
  //
  // Two things keep this safe rather than merely likely. All-or-nothing: one
  // character that cannot be a digit defeats the whole run. And the narrow
  // AMBIGUOUS_DIGIT set: "SBIN0AB1234" keeps its letters, because A is a rare
  // enough misreading of 4 that the letter is the better bet - whereas
  // "SBIN0OO1234" converts, because O for 0 is the commonest confusion there is.
  if (branch.length > 0) {
    const digits = branch.map((i) => {
      const c = chars[i];
      return /\d/.test(c) ? c : AMBIGUOUS_DIGIT[c] ?? AMBIGUOUS_DIGIT[c.toLowerCase()];
    });
    if (digits.every((d): d is string => d !== undefined)) {
      branch.forEach((i, k) => {
        if (chars[i] !== digits[k]) corrections++;
        chars[i] = digits[k] as string;
      });
    }
  }

  return { value: chars.join(""), corrections };
}

/**
 * Could OCR have produced `read` while looking at `truth`?
 *
 * Every position must either match, or be a confusion that runs the right way:
 * the character we read has to be a plausible misreading of the character that
 * is actually there.
 */
function couldMisread(read: string, truth: string): boolean {
  if (read.length !== truth.length) return false;
  for (let i = 0; i < read.length; i++) {
    const r = read[i];
    const t = truth[i];
    if (r.toUpperCase() === t.toUpperCase()) continue;
    if (LOOKALIKES.some((set) => set.includes(r) && set.includes(t))) continue;
    return false;
  }
  return true;
}

/** A run of digits with a Luhn check, allowing letter-for-digit confusions. */
function fitCard(raw: string): { value: string; corrections: number } | undefined {
  if (raw.length < CARD_LENGTHS.min || raw.length > CARD_LENGTHS.max) return undefined;
  let value = "";
  let corrections = 0;
  for (const c of raw) {
    if (/\d/.test(c)) value += c;
    else if (TO_DIGIT[c]) { value += TO_DIGIT[c]; corrections++; }
    else return undefined;
  }
  // Mostly digits to begin with, or it is a word.
  if (corrections > raw.length / 4) return undefined;
  if (!check.isPaymentCard(value) || !check.cardBrand(value)) return undefined;
  return { value, corrections };
}

/**
 * Finds identifiers in one line of OCR text, correcting characters by slot.
 *
 * Tries every single word and every run of up to four adjacent words joined
 * together, because OCR splits "AAACR 5055 K" and "3456 7890 1238" on the
 * spaces a page shows them with. The span reported covers the whole run.
 */
export function correctIdentifiers(
  text: string,
  /**
   * Identifiers the page's own tree already carries, exactly as it carries them.
   *
   * The tree is exact and the pixels are not, so where both show the same
   * identifier the tree simply wins - and it must, or the two mint different
   * tokens and one identifier reads as two placeholders, which is the failure
   * OCR tokenization exists to prevent.
   */
  known: ReadonlyArray<{ value: string; kind: PiiKind }> = [],
): Corrected[] {
  const truths = known
    .filter((k) => IDENTIFIERS.has(k.kind))
    .map((k) => ({ ...k, bare: strip(k.value).toUpperCase() }))
    // Shorter than this and a "misreading" is just a coincidence.
    .filter((k) => k.bare.length >= 8);

  const words: { text: string; start: number; end: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }

  const out: Corrected[] = [];
  const claimed: [number, number][] = [];
  const free = (s: number, e: number): boolean => !claimed.some(([a, b]) => s < b && e > a);

  for (let i = 0; i < words.length; i++) {
    for (let n = 4; n >= 1; n--) {
      if (i + n > words.length) continue;
      const run = words.slice(i, i + n);
      const start = run[0].start;
      const end = run[run.length - 1].end;
      if (!free(start, end)) continue;

      // Punctuation between groups - "3456-7890-1238", "AAACR5055K." - is not
      // part of the identifier.
      const raw = strip(run.map((w) => w.text).join(""));
      if (raw.length < 10 || raw.length > 19) continue;

      let best: Corrected | undefined;

      // 1. Does the tree already know this identifier? If exactly one known
      //    value could have been misread as what OCR gave us, that is not a
      //    guess - it is the same identifier, and we have its exact spelling.
      //    Two equally plausible matches prove nothing, so those fall through.
      const snapped = truths.filter((t) => couldMisread(raw, t.bare));
      if (snapped.length === 1) {
        const truth = snapped[0];
        let differs = 0;
        for (let k = 0; k < raw.length; k++) {
          if (raw[k].toUpperCase() !== truth.bare[k]) differs++;
        }
        best = {
          kind: truth.kind, start, end, value: truth.value, read: raw,
          corrections: differs, proven: true,
          why: "matches an identifier this page carries in its own markup, read from an image",
        };
      }

      for (const template of TEMPLATES) {
        if (best?.proven) break;
        const fitted = fit(raw, template.slots);
        if (!fitted) continue;
        if (fitted.corrections > template.maxCorrections) continue;
        if (!template.validate(fitted.value)) continue;
        const candidate: Corrected = {
          kind: template.kind, start, end, value: fitted.value, read: raw,
          corrections: fitted.corrections,
          // A checksum that holds after correcting is proof; a shape alone is not.
          proven: CHECKSUMMED.has(template.kind),
          why: template.why,
        };
        // Fewest corrections wins; a checksummed kind beats an uncheckummed one
        // at equal cost because it has been proven rather than merely fitted.
        if (!best || candidate.corrections < best.corrections) best = candidate;
      }

      if (!best) {
        const card = fitCard(raw);
        if (card) {
          best = {
            kind: "payment_card", start, end, value: card.value, read: raw,
            corrections: card.corrections, proven: true,
            why: "card number with a valid Luhn check digit and known issuer, read from an image",
          };
        }
      }

      if (best) {
        claimed.push([start, end]);
        out.push(best);
        break;
      }
    }
  }

  return out;
}

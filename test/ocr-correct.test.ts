import { correctIdentifiers } from "../src/pii/ocr-correct";
import { verhoeffCheckDigit } from "../src/pii/checksums";

/**
 * Recovering identifiers that OCR bent.
 *
 * Tesseract reports 73% confidence on a PAN against 95% on the words around
 * it, and on a real page that uncertainty becomes a wrong character: an S for
 * a 5, an O for a 0. The strict validators then reject the whole identifier and
 * it goes to the model in plain sight. Every Indian identifier has a fixed
 * shape, so the wrong character can be put right by its position - and where
 * a checksum exists, proven right.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

const AADHAAR = "34567890123" + verhoeffCheckDigit("34567890123");

const found = (text: string, kind: string): string | undefined =>
  correctIdentifiers(text).find((c) => c.kind === kind)?.value;

// ---------------------------------------------------------------- PAN

// The confusions Tesseract actually makes on "AAACR5055K".
for (const read of ["AAACRS055K", "AAACR5O55K", "AAACRSO55K", "AAACR5055K", "aaacr5055k"]) {
  want(found(`PAN ${read}`, "pan") === "AAACR5055K",
    `"${read}" was not recovered as AAACR5055K (got ${found(`PAN ${read}`, "pan")})`);
}

// OCR splits on the spaces a page shows: "AAACR 5055 K".
want(found("PAN: AAACR 5O55 K", "pan") === "AAACR5055K", "a spaced, confused PAN was not recovered");

// Three corrections is past the cap: a word, not a PAN.
want(found("AAACRSOSSK", "pan") === undefined, "three corrections were accepted for an uncheckummed PAN");

// The holder-type letter still has to be one that exists.
want(found("AAAXR5055K", "pan") === undefined, "an invalid holder type was accepted");

// ---------------------------------------------------------------- IFSC

// The fifth character is a literal zero, and OCR reads it as O every time.
want(found("IFSC SBINOOO1234", "ifsc") === "SBIN0001234", `"SBINOOO1234" was not recovered`);
want(found("IFSC HDFCO000123", "ifsc") === "HDFC0000123", `"HDFCO000123" was not recovered`);
// An unknown bank is not accepted on shape alone.
want(found("IFSC QQQQO001234", "ifsc") === undefined, "an unknown bank code was accepted");

// A branch code is alphanumeric, so no character settles on its own - the run
// decides, and only on confusions OCR actually makes. "OO1234" converts because
// O-for-0 is the commonest of them. "ABCDE1" and "AB1234" do not: A is a rare
// enough misreading of 4 that the letter is the better bet, and one such
// character defeats the whole run.
want(found("IFSC SBIN0ABCDE1", "ifsc") === "SBIN0ABCDE1",
  `an alphabetic branch code was bent: ${found("IFSC SBIN0ABCDE1", "ifsc")}`);
want(found("IFSC SBIN0AB1234", "ifsc") === "SBIN0AB1234",
  `a partly-alphabetic branch code was bent: ${found("IFSC SBIN0AB1234", "ifsc")}`);
// But a run made entirely of common confusions is one: SBIN0551234.
want(found("IFSC SBINOSS1234", "ifsc") === "SBIN0551234",
  `a branch of common confusions was not resolved: ${found("IFSC SBINOSS1234", "ifsc")}`);

// ------------------------------------------------- the DOM corrects the pixels

// Where the page carries the identifier in its tree as well as its image, the
// tree is exact and wins outright - and the value must be the tree's own
// string, or the two mint different tokens and one identifier reads as two
// placeholders.
{
  const tree = [{ value: "SBIN0001234", kind: "ifsc" as const }];
  const [hit] = correctIdentifiers("Branch IFSC SBlN0O01234 shown", tree);
  want(hit?.value === "SBIN0001234", `no snap to the tree's value: ${hit?.value}`);
  want(hit?.proven === true, "a snap to an exact tree value was not marked proven");
  want(hit?.read === "SBlN0O01234", `the read was not preserved: ${hit?.read}`);
}

// The tree's spelling wins even where the template would have produced another.
{
  const tree = [{ value: "SBIN0AB1234", kind: "ifsc" as const }];
  const [hit] = correctIdentifiers("IFSC SBIN0AB1234", tree);
  want(hit?.value === "SBIN0AB1234" && hit?.proven === true,
    `the tree's alphabetic branch was not honoured: ${hit?.value}`);
}

// Two equally plausible tree values prove nothing, so neither is chosen and the
// template decides instead.
{
  const tree = [
    { value: "SBIN0001234", kind: "ifsc" as const },
    { value: "SBIN0O01234", kind: "ifsc" as const },
  ];
  const [hit] = correctIdentifiers("IFSC SBINOOO1234", tree);
  want(hit?.proven === false,
    "an ambiguous match between two tree values was reported as proven");
  want(hit?.value === "SBIN0001234", `fell back to the wrong template value: ${hit?.value}`);
}

// A tree value that could not have been misread as this is not a match.
{
  const tree = [{ value: "HDFC0000123", kind: "ifsc" as const }];
  const [hit] = correctIdentifiers("IFSC SBINOOO1234", tree);
  want(hit?.value === "SBIN0001234" && hit?.proven === false,
    `an unrelated tree value was snapped to: ${hit?.value}`);
}

// Snapping must not resurrect something the templates would refuse: a tree
// value is only consulted for a run that is already identifier-shaped.
{
  const tree = [{ value: "HELLO WORLD", kind: "person_name" as const }];
  want(correctIdentifiers("HELLO WORLD", tree).length === 0,
    "a tree value dragged an ordinary phrase into being an identifier");
}

// ---------------------------------------------------------------- Aadhaar

const confused = AADHAAR.replace("0", "O").replace("5", "S");
want(found(`Aadhaar ${confused}`, "aadhaar") === AADHAAR, `"${confused}" was not recovered as ${AADHAAR}`);
const spaced = `${AADHAAR.slice(0, 4)} ${AADHAAR.slice(4, 8).replace("8", "B")} ${AADHAAR.slice(8)}`;
want(found(`UID ${spaced}`, "aadhaar") === AADHAAR, `"${spaced}" was not recovered`);
// Verhoeff must still hold: a corrected number that fails the check is nothing.
const wrong = AADHAAR.slice(0, 11) + String((Number(AADHAAR[11]) + 1) % 10);
want(found(`Aadhaar ${wrong.replace("0", "O")}`, "aadhaar") === undefined, "a wrong check digit was accepted after correction");

// ---------------------------------------------------------------- GSTIN

want(found("GSTIN 27AAACR5O55K1Z7", "gstin") === "27AAACR5055K1Z7", "a GSTIN with O for 0 was not recovered");
want(found("GSTIN 27AAACRS055K1Z7", "gstin") === "27AAACR5055K1Z7", "a GSTIN with S for 5 was not recovered");

// ---------------------------------------------------------------- cards

const VISA = "4111111111111111";
want(found(`Card ${VISA.slice(0, 4)} ${VISA.slice(4, 8).replace("1", "I")} ${VISA.slice(8, 12)} ${VISA.slice(12)}`, "payment_card") === VISA,
  "a card with I for 1 was not recovered");

// ---------------------------------------------------------------- not identifiers

// Words and codes that resemble identifiers must stay words.
for (const text of [
  "Order INV-2024-000123 shipped",
  "Version 2.4.1.9000 released",
  "HELLO WORLD THIS IS TEXT",
  "The password is Tr0ub4dor&3 today",
  "Serial ABCDE12345 on the box",       // PAN shape, holder type E is not valid
  "Ref 402-8871234-1234567 paid",       // 17 digits, fails brand
]) {
  const hits = correctIdentifiers(text);
  want(hits.length === 0, `"${text}" produced ${hits.map((h) => `${h.kind}:${h.value}`).join(", ")}`);
}

// ------------------------------------------------- proven versus merely fitted

// A checksum that still holds after correcting is proof. A shape is not: PAN's
// holder-type letter and IFSC's bank code are constraints, and the confidence
// the finding carries should say so.
want(correctIdentifiers(`Aadhaar ${confused}`)[0]?.proven === true,
  "a corrected Aadhaar with a valid Verhoeff digit was not marked proven");
want(correctIdentifiers("GSTIN 27AAACR5O55K1Z7")[0]?.proven === true,
  "a corrected GSTIN with a valid check character was not marked proven");
want(correctIdentifiers("PAN AAACRS055K")[0]?.proven === false,
  "a PAN corrected on shape alone was marked proven");
want(correctIdentifiers("IFSC SBINOOO1234")[0]?.proven === false,
  "an IFSC corrected on shape alone was marked proven");

// ---------------------------------------------------------------- spans

// The span covers every word the identifier was assembled from, so the burn
// box covers all of it.
const hit = correctIdentifiers("PAN: AAACR 5O55 K end")[0];
want(hit?.start === 5 && hit?.end === 17, `span was ${hit?.start}-${hit?.end}, expected 5-17`);
want(hit?.read === "AAACR5O55K" && hit?.corrections === 1, `read=${hit?.read} corrections=${hit?.corrections}`);
want(hit?.proven === false, "a PAN fitted by shape was reported as proven");

console.log(JSON.stringify({
  samples: {
    "AAACRS055K": found("PAN AAACRS055K", "pan"),
    "SBINOOO1234": found("IFSC SBINOOO1234", "ifsc"),
    "27AAACR5O55K1Z7": found("GSTIN 27AAACR5O55K1Z7", "gstin"),
  },
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

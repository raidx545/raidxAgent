import type { CapturedNode, DomCapture } from "../capture/types";
import { walkCapture } from "../capture/dom";
import type { Confidence, Detector, Field, Finding, PiiKind } from "./types";
import { fieldText, mask } from "./types";
import {
  CITIES,
  HONORIFICS,
  NAME_CUES,
  NOT_A_NAME,
  ORG_CONNECTORS,
  ORG_SUFFIXES,
  STATES,
  STREET_TYPES,
} from "./entities";

/**
 * Tier 3, text half: people, organisations, and postal addresses in prose.
 *
 * These are the entities with no checksum to validate against, which is why
 * they were the last gap in the pipeline. The usual answer is a named-entity
 * model, and one can still be plugged in - but a model is 60 MB, slow, and, on
 * Indian names in particular, unreliable.
 *
 * The approach here is different: the page usually tells you the names, if you
 * read the parts of it a text-only detector ignores. A field labelled "Full
 * Name", a `<meta name="author">` tag, schema.org microdata, an email local
 * part - each of these names an entity outright. Harvest those, then find every
 * other occurrence of the same string in the page and tokenize it consistently.
 *
 * Strategies run strongest-first, and each one refuses ground an earlier one
 * already claimed:
 *
 *   1. Gazetteer built from this page's own structure   - certain / high
 *   2. Honorific followed by proper nouns               - high
 *   3. Cue phrase followed by proper nouns              - high / medium
 *   4. Organisation legal suffix                        - high
 *   5. Postal address by street type, city, state, PIN  - high / medium
 *   6. Bare capitalised sequences                       - low, off by default
 *
 * Strategy 6 is where false positives live, so it is opt-in.
 */

export interface EntityOptions {
  /**
   * Report capitalised word sequences that no other strategy explains.
   * Catches names the page never labels, at the cost of tokenizing product
   * names and headings too. Off by default.
   */
  aggressive?: boolean;
}

let options: EntityOptions = {};

export function setEntityOptions(next: EntityOptions): void {
  options = next;
}

const SCANNED: Field[] = [
  "text",
  "value",
  "label",
  "attr:alt",
  "attr:title",
  "attr:name",
  "attr:aria-label",
];

/**
 * A proper-noun run: "Priya Sharma", "Sharma Traders", "R. K. Narayan".
 *
 * Unicode-aware, so accented and non-Latin cased scripts work rather than
 * quietly falling out of every pattern. Scripts without letter case -
 * Devanagari, Tamil, Arabic - cannot be matched this way at all; those names
 * are caught by the gazetteer, which matches literal strings and does not care
 * about case or script.
 */
const LETTER = "[\\p{L}\\p{M}'’.-]";
const PROPER = `\\p{Lu}${LETTER}*(?:\\s+(?:\\p{Lu}${LETTER}*|` +
  [...ORG_CONNECTORS].join("|") + "))*";

const RE_HONORIFIC = new RegExp(
  `\\b(?:${HONORIFICS})\\.?\\s+(${PROPER})`,
  "gu",
);

const RE_CUE = new RegExp(
  `\\b(?:${NAME_CUES})\\b\\s*[:,-]?\\s+(${PROPER})`,
  "gu",
);

const RE_ORG = new RegExp(
  `\\b(${PROPER}\\s+(?:${ORG_SUFFIXES}))(?!\\p{L})`,
  "gu",
);

/**
 * A house or plot number followed by a street-type word.
 *
 * The number half has to cope with "42", "17/B", "12-A", and "No. 8" - Indian
 * addresses combine digits and letters freely, and a pattern that only accepts
 * digits silently drops the first half of "17/B", leaving it in the output.
 */
const RE_STREET = new RegExp(
  `\\b(?:(?:No\\.?|Flat|Plot|Door|H\\.?\\s?No\\.?|Shop|Unit)\\s*)?` +
    `\\d+[A-Za-z]?(?:[/-][\\dA-Za-z]+)*,?\\s+` +
    `(?:[A-Z][A-Za-z'’.-]+\\s+){0,4}(?:${STREET_TYPES})\\b`,
  "gi",
);

/** Six-digit Indian PIN, which never starts with zero. */
const RE_PIN = /\b[1-9]\d{5}\b/g;

const RE_CAPS = new RegExp(
  `\\p{Lu}\\p{Ll}{2,}(?:\\s+\\p{Lu}\\p{Ll}{2,}){1,3}`,
  "gu",
);

const PLACES = new Set([...STATES, ...CITIES].map((p) => p.toLowerCase()));

/** Attributes whose value being an email marks the element as a person. */
const IDENTITY_ATTRS = ["email", "data-email", "data-hovercard-id"];

/** Attributes that hold the display name on such an element. */
const NAME_ATTRS = ["name", "title", "aria-label", "data-name"];

/** Elements where `name` means a form field, not a person. */
const FORM_TAGS = new Set(["input", "select", "textarea", "form", "button", "meta", "param"]);

/** Loose enough to recognise an address, not used for detection. */
const EMAIL_SHAPED = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

/** Occupied character ranges, so strategies do not double-report. */
class Claims {
  private readonly byField = new Map<string, [number, number][]>();

  free(key: string, start: number, end: number): boolean {
    const taken = this.byField.get(key) ?? [];
    return !taken.some(([s, e]) => start < e && end > s);
  }

  take(key: string, start: number, end: number): void {
    const taken = this.byField.get(key) ?? [];
    taken.push([start, end]);
    this.byField.set(key, taken);
  }
}

/** A match a strategy proposes, before conflicts between strategies are settled. */
interface Candidate {
  kind: PiiKind;
  span: [number, number];
  value: string;
  confidence: Confidence;
  why: string;
}

const RANK: Record<Confidence, number> = { certain: 0, high: 1, medium: 2, low: 3 };

/**
 * Settles overlaps between strategies by preferring the longest match.
 *
 * This ordering is not cosmetic. The gazetteer learns surnames - "Sharma" from
 * priya.sharma@... - and a surname routinely appears *inside* a company name.
 * Letting the shorter, more confident match win would tokenize "Sharma" and
 * leave "Traders Pvt Ltd" sitting in the output: a partially redacted
 * organisation, which is worse than either alternative.
 *
 * The longest match is also the most protective, because an entity that
 * contains another hides both.
 */
function settle(candidates: Candidate[], claims: Claims, key: string): Candidate[] {
  const ordered = [...candidates].sort((a, b) => {
    const lengthA = a.span[1] - a.span[0];
    const lengthB = b.span[1] - b.span[0];
    if (lengthA !== lengthB) return lengthB - lengthA;
    return RANK[a.confidence] - RANK[b.confidence];
  });

  const kept: Candidate[] = [];
  for (const candidate of ordered) {
    const [start, end] = candidate.span;
    if (!claims.free(key, start, end)) continue;
    claims.take(key, start, end);
    kept.push(candidate);
  }
  return kept;
}

/**
 * Grows a known-name match outward over adjacent title-case words.
 *
 * Deliberately narrow: one word on each side, each of which must look like a
 * name on its own and produce a phrase that still looks like a name together.
 * Any wider and it starts eating sentences.
 */
function widen(
  text: string,
  start: number,
  end: number,
): { span: [number, number]; phrase: string } | undefined {
  const WORD = /\p{Lu}\p{Ll}+/u;

  let from = start;
  let to = end;

  const before = text.slice(0, start).match(/(\p{Lu}\p{Ll}+)\s$/u);
  if (before && WORD.test(before[1]) && plausibleName(before[1])) {
    from = start - before[0].length;
  }

  const after = text.slice(end).match(/^\s(\p{Lu}\p{Ll}+)/u);
  if (after && WORD.test(after[1]) && plausibleName(after[1])) {
    to = end + after[0].length;
  }

  if (from === start && to === end) return undefined;

  const phrase = text.slice(from, to);
  if (!plausibleName(phrase)) return undefined;
  return { span: [from, to], phrase };
}

/**
 * Is this phrase plausibly a name rather than an ordinary capitalised phrase?
 *
 * The stopword check runs on every word, because a single common word is
 * usually enough to give away a heading or a sentence start.
 */
function plausibleName(phrase: string): boolean {
  // Never treat our own output as an entity. Once a name has been replaced by
  // <ORG_1>, that token lives in the tree and in attributes; a gazetteer that
  // learns it would match it everywhere and report the sanitized page as still
  // full of PII. The residual check is what surfaced this.
  if (/<[A-Z][A-Z0-9]*_\d+>/.test(phrase)) return false;

  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;

  const meaningful = words.filter((w) => !ORG_CONNECTORS.has(w.toLowerCase()));
  if (meaningful.length === 0) return false;

  for (const word of meaningful) {
    const bare = word.replace(/[^\p{L}]/gu, "").toLowerCase();
    // Single initials such as "R." are fine.
    if (bare.length <= 1) continue;
    if (NOT_A_NAME.has(bare)) return false;
  }

  // A place name is a place, not a person.
  if (PLACES.has(phrase.trim().toLowerCase())) return false;

  return true;
}

/**
 * Drops leading words that cannot start a name.
 *
 * A greedy pattern happily swallows the sentence in front of what it was
 * looking for - "Invoice for Sharma Traders" reads as one organisation unless
 * something rejects "Invoice" as an opening word. Returns how far the phrase
 * moved so the span can follow it.
 */
function trimLeading(phrase: string): { phrase: string; shift: number } {
  let shift = 0;
  let rest = phrase;

  for (;;) {
    const match = /^(\S+)(\s+)/.exec(rest);
    if (!match) break;
    const bare = match[1].replace(/[^\p{L}]/gu, "").toLowerCase();
    if (!bare) break;
    if (!NOT_A_NAME.has(bare) && !ORG_CONNECTORS.has(bare)) break;
    shift += match[0].length;
    rest = rest.slice(match[0].length);
  }

  return { phrase: rest, shift };
}

/** Trims trailing punctuation and connectors a greedy match may have taken. */
function trimPhrase(phrase: string): string {
  let out = phrase.replace(/[\s.,;:!?'"()\[\]-]+$/, "");
  let changed = true;
  while (changed) {
    changed = false;
    const words = out.split(/\s+/);
    const last = words[words.length - 1]?.toLowerCase();
    if (words.length > 1 && last && ORG_CONNECTORS.has(last)) {
      words.pop();
      out = words.join(" ");
      changed = true;
    }
  }
  return out;
}

/**
 * Names this page states about itself.
 *
 * Every source here is one the page author chose to mark up, which is why this
 * strategy carries the highest confidence in the tier.
 */
function buildGazetteer(capture: DomCapture, priorFindings: Finding[]): Map<string, PiiKind> {
  const gazetteer = new Map<string, PiiKind>();

  const add = (raw: string | undefined, kind: PiiKind): void => {
    const value = trimPhrase((raw ?? "").trim());
    // Two characters is not a name; forty is a sentence.
    if (value.length < 3 || value.length > 60) return;
    if (!/[A-Za-z]/.test(value)) return;
    if (!plausibleName(value)) return;
    gazetteer.set(value, kind);
  };

  for (const node of walkCapture(capture.root)) {
    // -- identity annotations -------------------------------------------
    //
    // An element carrying an email address in an attribute is a person, and
    // whatever the page calls that element is that person's name. This is how
    // mail and chat clients mark up a sender, and it is the difference between
    // reading fifty names off an inbox and reading none of them: they carry no
    // honorific, no cue phrase, and no labelled field, so nothing else in this
    // tier would ever fire on them.
    const annotated = IDENTITY_ATTRS.map((a) => node.attrs[a]).find(
      (value) => value && EMAIL_SHAPED.test(value),
    );

    if (annotated) {
      // A robot address, or a display name that echoes its own domain, is a
      // brand rather than a person. Both are tokenized either way; getting the
      // kind right only changes which token prefix the planner sees.
      const local = annotated.split("@")[0]?.toLowerCase() ?? "";
      const domain = annotated.split("@")[1]?.toLowerCase() ?? "";
      const robot = /^(no-?reply|do-?not-?reply|notifications?|notify|info|support|hello|team|mail|alerts?)$/.test(local);

      const kindOf = (value: string | undefined): PiiKind => {
        const bare = (value ?? "").toLowerCase().replace(/[^a-z]/g, "");
        const echoesDomain = bare.length > 2 && domain.replace(/[^a-z]/g, "").includes(bare);
        return robot || echoesDomain ? "org_name" : "person_name";
      };

      for (const attr of NAME_ATTRS) {
        add(node.attrs[attr], kindOf(node.attrs[attr]));
      }
      // The visible text of an annotated element is usually the display name.
      add(node.text, kindOf(node.text));
    }

    // A `name` attribute on something that is not a form control is a label
    // for a thing, not for a field - "aadhaar_no" cannot pass plausibleName,
    // but "Ananya Bhatt" can. Skipped when the element was annotated, because
    // that branch already classified it and knows more: it saw the address.
    if (!annotated && node.attrs.name && !FORM_TAGS.has(node.tag)) {
      add(node.attrs.name, "person_name");
    }
    for (const attr of ["data-name", "data-user-name", "data-sender"]) {
      add(node.attrs[attr], "person_name");
    }

    const itemprop = (node.attrs.itemprop ?? "").toLowerCase();
    const itemtype = (node.attrs.itemtype ?? "").toLowerCase();
    const rel = (node.attrs.rel ?? "").toLowerCase();

    // schema.org microdata: the page has declared what this is.
    if (itemprop === "name" || itemprop === "givenname" || itemprop === "familyname") {
      const kind: PiiKind = itemtype.includes("organization") ? "org_name" : "person_name";
      add(node.text ?? node.value ?? node.label, kind);
    }
    if (itemprop === "author" || rel === "author") {
      add(node.text ?? node.label, "person_name");
    }

    // A field the page labelled as a name: its value is a real name.
    if (node.tag === "meta" && (node.attrs.name ?? "").toLowerCase() === "author") {
      add(node.attrs.content, "person_name");
    }
  }

  // Tier 1 already identified name-shaped fields; their values are names.
  for (const finding of priorFindings) {
    if (finding.tier !== 1 || !finding.value) continue;
    if (finding.kind === "person_name") add(finding.value, "person_name");
    if (finding.kind === "org_name") add(finding.value, "org_name");
  }

  // An email local part frequently spells the owner's name outright.
  for (const finding of priorFindings) {
    if (finding.kind !== "email" || !finding.value) continue;
    const local = finding.value.split("@")[0] ?? "";
    const parts = local.split(/[._-]+/).filter((p) => /^[A-Za-z]{3,}$/.test(p));
    if (parts.length < 2) continue;
    const titled = parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase());
    add(titled.join(" "), "person_name");
    // The surname alone is often what appears in the page body.
    if (titled.length >= 2) add(titled[titled.length - 1], "person_name");
  }

  return gazetteer;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let seq = 0;

function make(
  node: CapturedNode,
  field: Field,
  kind: PiiKind,
  span: [number, number],
  value: string,
  confidence: Confidence,
  why: string,
): Finding {
  return {
    id: `t3e-${seq++}`,
    kind,
    shape: "text",
    tier: 3,
    confidence,
    nodeId: node.id,
    field,
    span,
    value,
    masked: mask(value),
    bbox: node.bbox,
    why,
    action: "replace-span",
  };
}

export const tier3Entities: Detector = {
  tier: 3,
  name: "Entities (names, organisations, addresses)",

  run(capture: DomCapture, priorFindings: Finding[]): Finding[] {
    seq = 0;
    const findings: Finding[] = [];
    const claims = new Claims();

    // Ground already covered by tiers 1 and 2 is off limits - an email is an
    // email, not a name, even though it contains one.
    for (const finding of priorFindings) {
      if (finding.shape !== "text" || !finding.field || !finding.span) continue;
      claims.take(`${finding.nodeId} ${finding.field}`, finding.span[0], finding.span[1]);
    }

    const gazetteer = buildGazetteer(capture, priorFindings);

    for (const node of walkCapture(capture.root)) {
      for (const field of SCANNED) {
        const text = fieldText(node, field);
        if (!text) continue;
        const key = `${node.id} ${field}`;

        // Every strategy proposes; none of them claims. Conflicts are settled
        // afterwards by length, so a short match can never fragment a long one.
        const candidates: Candidate[] = [];
        const propose = (
          kind: PiiKind,
          span: [number, number],
          value: string,
          confidence: Confidence,
          why: string,
        ): void => {
          candidates.push({ kind, span, value, confidence, why });
        };

        // -- 1. gazetteer: every occurrence of a name the page declared ------
        for (const [name, kind] of gazetteer) {
          // Unicode boundaries: "Mansi Gupta" inside a Devanagari sentence has
          // no ASCII letter beside it, but it does have letters.
          const pattern = new RegExp(
            `(?<!\\p{L})${escapeRegex(name)}(?!\\p{L})`,
            "gu",
          );
          let hit: RegExpExecArray | null;
          while ((hit = pattern.exec(text)) !== null) {
            const start = hit.index;
            const end = start + name.length;
            propose(kind, [start, end], name, "certain",
              "this page names this entity in its own markup");

            // Knowing a surname tells you more than where that surname is.
            // "Gupta" learnt from an address makes "Mansi Gupta" in a sentence
            // a name too - the given name beside a known family name is the
            // one case where extending a match is safe, and it is how a person
            // who is never annotated still gets caught.
            if (kind !== "person_name") continue;
            const wider = widen(text, start, end);
            if (wider) {
              propose("person_name", wider.span, wider.phrase, "high",
                "capitalised word beside a name this page already declared");
            }
          }
        }

        // -- 2. honorific ---------------------------------------------------
        collect(RE_HONORIFIC, text, (phrase, start) => {
          const { phrase: name, shift } = trimLeading(phrase);
          if (!plausibleName(name)) return;
          propose("person_name", [start + shift, start + shift + name.length], name, "high",
            "follows a title such as Mr or Dr");
        });

        // -- 3. cue phrase --------------------------------------------------
        collect(RE_CUE, text, (phrase, start) => {
          const { phrase: name, shift } = trimLeading(phrase);
          if (!plausibleName(name)) return;
          const kind: PiiKind = new RegExp(`(?:${ORG_SUFFIXES})$`).test(name)
            ? "org_name"
            : "person_name";
          propose(kind, [start + shift, start + shift + name.length], name, "high",
            "follows a phrase that introduces a person or company");
        });

        // -- 4. organisation legal suffix -----------------------------------
        collect(RE_ORG, text, (phrase, start) => {
          const { phrase: name, shift } = trimLeading(phrase);
          // A suffix on its own is not a company: "Ltd" needs a name in front.
          if (!/\s/.test(name)) return;
          propose("org_name", [start + shift, start + shift + name.length], name, "high",
            "ends in a company legal form or trade suffix");
        });

        // -- 5. postal address ----------------------------------------------
        // An <address> element is the page saying so directly.
        if (node.tag === "address" && field === "text") {
          propose("postal_address", [0, text.length], text, "certain",
            "inside an <address> element");
        }

        RE_STREET.lastIndex = 0;
        let street: RegExpExecArray | null;
        while ((street = RE_STREET.exec(text)) !== null) {
          const phrase = trimPhrase(street[0]);
          if (phrase.length < 6) continue;
          propose("postal_address", [street.index, street.index + phrase.length], phrase, "high",
            "house number followed by a street-type word");
        }

        // A PIN code only counts with a place name or an address cue nearby.
        RE_PIN.lastIndex = 0;
        let pin: RegExpExecArray | null;
        while ((pin = RE_PIN.exec(text)) !== null) {
          const around = text.slice(Math.max(0, pin.index - 70), pin.index + 70).toLowerCase();
          const nearPlace =
            [...PLACES].some((p) => around.includes(p)) ||
            /\b(pin|pincode|postal|address|state|district)\b/.test(around);
          if (!nearPlace) continue;
          propose("pincode", [pin.index, pin.index + pin[0].length], pin[0], "high",
            "six-digit PIN beside a place name or address label");
        }

        // -- 6. bare capitalised runs, opt-in -------------------------------
        if (options.aggressive) {
          RE_CAPS.lastIndex = 0;
          let caps: RegExpExecArray | null;
          while ((caps = RE_CAPS.exec(text)) !== null) {
            const phrase = trimPhrase(caps[0]);
            if (!plausibleName(phrase)) continue;
            propose("person_name", [caps.index, caps.index + phrase.length], phrase, "low",
              "capitalised word sequence with no other explanation");
          }
        }

        for (const winner of settle(candidates, claims, key)) {
          findings.push(
            make(node, field, winner.kind, winner.span, winner.value,
              winner.confidence, winner.why),
          );
        }
      }
    }

    // Emitted in candidate order per field; sort so the result reads in
    // document order the way every other detector's output does.
    findings.sort((a, b) => a.nodeId - b.nodeId || (a.span?.[0] ?? 0) - (b.span?.[0] ?? 0));
    return findings;
  },
};

/**
 * Runs a capture-group pattern and reports the group's own offset, not the
 * whole match's - the cue or title in front of a name is not part of it.
 */
function collect(
  pattern: RegExp,
  text: string,
  onMatch: (phrase: string, start: number) => void,
): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    const group = match[1];
    if (!group) continue;
    const trimmed = trimPhrase(group);
    if (!trimmed) continue;
    onMatch(trimmed, match.index + match[0].indexOf(group));
  }
}

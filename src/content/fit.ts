/**
 * Turning what the planner wrote into what the field will actually hold.
 *
 * The agent writes a field's value directly, and a browser that is handed a
 * value it does not like does not complain - it drops it. "23/09/2026" in a
 * date input, "12,000" in a number input and "3:30 PM" in a time input all
 * left the field empty, and each was reported as typed. A maxlength, on the
 * other hand, is only enforced on keystrokes: "+91 98765 43210" went into a
 * ten-character mobile field whole, and the form submitted a value it was
 * built to refuse.
 *
 * So the text is fitted to the field first, and only in ways that cannot
 * change what it means: an unambiguous date rewritten in the one format a date
 * input accepts, thousands separators taken out of a number, spaces taken out
 * of a phone number. Anything that would need a guess - 04/05/2026, which is
 * April in one country and May in another - is refused with the format the
 * field needs, never silently guessed.
 *
 * Nothing here repeats the value in a message. The text may be a private value
 * resolved from the vault, and a message goes back to the model.
 */

export interface FieldShape {
  /** The input's `type`; "textarea" for a textarea. */
  type: string;
  /** The `maxLength` property; -1 or undefined when there is none. */
  maxLength?: number;
  inputMode?: string;
  /** What the field is called, to recognise a phone field typed as text. */
  label?: string;
}

export type Fitted =
  | { ok: true; value: string; note?: string }
  | { ok: false; reason: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthOf(word: string): number | undefined {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return undefined;
  const index = MONTHS.findIndex((m) => w.startsWith(m));
  if (index < 0) return undefined;
  // "march" and "mar" yes, "marzipan" no: the rest must be the month's own name.
  const full = new Date(Date.UTC(2000, index, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" }).toLowerCase();
  return full.startsWith(w) || (index === 8 && w === "sept") ? index + 1 : undefined;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function realDate(y: number, m: number, d: number): string | undefined {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

const AMBIGUOUS_DATE =
  "the date could be read either way round (day/month or month/day), so nothing was typed. " +
  "Give it as YYYY-MM-DD.";

/** A date in YYYY-MM-DD, or why it cannot be read without guessing. */
export function isoDate(text: string): { value: string } | { reason: string } {
  const t = text.trim();
  let m: RegExpMatchArray | null;

  if ((m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    const v = realDate(+m[1], +m[2], +m[3]);
    return v ? { value: v } : { reason: "that is not a real date." };
  }

  if ((m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
    if (m[3].length !== 4) {
      return { reason: "the year has only two digits, so the century is a guess. Give it as YYYY-MM-DD." };
    }
    const a = +m[1], b = +m[2], y = +m[3];
    let day: number, month: number;
    if (a === b) { day = a; month = b; }
    else if (a > 12 && b <= 12) { day = a; month = b; }
    else if (b > 12 && a <= 12) { day = b; month = a; }
    else if (a > 12 && b > 12) return { reason: "that is not a real date." };
    else return { reason: AMBIGUOUS_DATE };
    const v = realDate(y, month, day);
    return v ? { value: v } : { reason: "that is not a real date." };
  }

  // 23 Sep 2026, 23rd September, 2026, 23-Sep-2026
  if ((m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]*([a-z]+\.?)[\s\-/.,]*(\d{4})$/i))) {
    const month = monthOf(m[2]);
    const v = month ? realDate(+m[3], month, +m[1]) : undefined;
    if (v) return { value: v };
  }
  // September 23, 2026 / Sep 23 2026
  if ((m = t.match(/^([a-z]+\.?)[\s\-/.,]*(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]*(\d{4})$/i))) {
    const month = monthOf(m[1]);
    const v = month ? realDate(+m[3], month, +m[2]) : undefined;
    if (v) return { value: v };
  }

  return { reason: "a date field only accepts a full date. Give it as YYYY-MM-DD." };
}

/** A time in HH:MM (or HH:MM:SS), from 24-hour or am/pm writing. */
export function isoTime(text: string): { value: string } | { reason: string } {
  const m = text.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2}))?\s*([ap])\.?\s*m\.?$|^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/i);
  const fail = { reason: "a time field needs a time such as 15:30 or 3:30 pm." };
  if (!m) return fail;

  let hour: number, minute: number, second: number | undefined;
  if (m[4]) {
    hour = +m[1]; minute = m[2] ? +m[2] : 0; second = m[3] ? +m[3] : undefined;
    if (hour < 1 || hour > 12) return fail;
    hour = (hour % 12) + (m[4].toLowerCase() === "p" ? 12 : 0);
  } else {
    hour = +m[5]; minute = +m[6]; second = m[7] ? +m[7] : undefined;
    if (hour > 23) return fail;
  }
  if (minute > 59 || (second !== undefined && second > 59)) return fail;
  return { value: `${pad(hour)}:${pad(minute)}${second !== undefined ? `:${pad(second)}` : ""}` };
}

function isoMonth(text: string): { value: string } | { reason: string } {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  const ok = (y: number, mo: number) =>
    y >= 1000 && y <= 9999 && mo >= 1 && mo <= 12 ? { value: `${pad(y, 4)}-${pad(mo)}` } : undefined;
  if ((m = t.match(/^(\d{4})[-/.](\d{1,2})$/))) { const v = ok(+m[1], +m[2]); if (v) return v; }
  if ((m = t.match(/^(\d{1,2})[-/.](\d{4})$/))) { const v = ok(+m[2], +m[1]); if (v) return v; }
  if ((m = t.match(/^([a-z]+\.?)[\s\-/.,]*(\d{4})$/i))) {
    const mo = monthOf(m[1]);
    const v = mo ? ok(+m[2], mo) : undefined;
    if (v) return v;
  }
  return { reason: "a month field needs a month and year, as YYYY-MM." };
}

function isoDateTime(text: string): { value: string } | { reason: string } {
  const t = text.trim();
  const iso = t.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/);
  if (iso) return { value: `${iso[1]}T${iso[2]}` };
  const split = t.match(/^(.*?)[\sT,]+(\d{1,2}(?:[:.]\d{2}){0,2}\s*(?:[ap]\.?\s*m\.?)?)$/i);
  if (!split) return { reason: "a date-and-time field needs both, as YYYY-MM-DDTHH:MM." };
  const date = isoDate(split[1]);
  if ("reason" in date) return date;
  const time = isoTime(split[2]);
  if ("reason" in time) return time;
  return { value: `${date.value}T${time.value}` };
}

function plainNumber(text: string): { value: string } | { reason: string } {
  // Separators and a currency sign are how people write numbers; the field
  // wants the digits. Removing them loses nothing.
  const stripped = text.trim()
    .replace(/^(rs\.?|inr|usd|eur|gbp)\s*/i, "")
    .replace(/(rs\.?|inr)$/i, "")
    .replace(/[₹$€£\s_]/g, "");
  // A comma is a thousands separator only when groups of digits follow it
  // the way they do in 12,000 or 1,20,000. "12,5" is a decimal comma, and
  // reading it as 125 would be off by a factor of ten.
  if (stripped.includes(",") && !/^[-+]?\d{1,3}(,\d{2,3})*,\d{3}(\.\d+)?$/.test(stripped)) {
    return { reason: "the commas in it could be decimal commas, so its value is a guess. Write the number without them." };
  }
  const bare = stripped.replace(/,/g, "");
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(bare)) return { value: bare };
  return { reason: "a number field only accepts a number." };
}

/** Removes the characters that only format a value. */
function unformatted(text: string): string {
  return text.replace(/[\s\-().]/g, "");
}

/**
 * Fits text to a field, or says why it will not go in.
 */
export function fitToField(text: string, field: FieldShape): Fitted {
  const type = field.type.toLowerCase();
  let value = text;
  let note: string | undefined;

  const convert = (result: { value: string } | { reason: string }, what: string): Fitted | undefined => {
    if ("reason" in result) return { ok: false, reason: `This is a ${what} field and ${result.reason}` };
    if (result.value !== value) note = `rewritten in the ${what} field's own format`;
    value = result.value;
    return undefined;
  };

  if (text.trim() !== "") {
    const refused =
      type === "date" ? convert(isoDate(text), "date")
      : type === "time" ? convert(isoTime(text), "time")
      : type === "month" ? convert(isoMonth(text), "month")
      : type === "datetime-local" ? convert(isoDateTime(text), "date-and-time")
      : type === "number" || type === "range" ? convert(plainNumber(text), "number")
      : undefined;
    if (refused) return refused;
  }

  const max = field.maxLength ?? -1;
  if (max >= 0 && [...value].length > max) {
    const bare = unformatted(value);
    const phoneLike = type === "tel" || field.inputMode === "tel" || field.inputMode === "numeric" ||
      /^\+?[\d\s\-().]+$/.test(value);
    const phoneField = type === "tel" || field.inputMode === "tel" ||
      /phone|mobile|\btel\b|contact\s*n|whatsapp/i.test(field.label ?? "");

    if ([...bare].length <= max && phoneLike) {
      value = bare;
      note = `stripped of spaces and dashes to fit its ${max}-character limit`;
    } else if (phoneField && /^(\+|00|0)/.test(bare)) {
      // "+91 98765 43210" in a ten-digit mobile field: the field wants the
      // national number, and the extra leading digits are a country code or a
      // trunk zero. Only a short prefix is dropped - a field that is five
      // digits short is asking for something else, not this number.
      const digits = bare.replace(/^\+|^00/, "");
      const extra = digits.length - max;
      if (/^\d+$/.test(digits) && extra > 0 && extra <= 3) {
        value = digits.slice(extra);
        note = `shortened to its ${max}-digit limit by dropping the country code`;
      }
    }

    if ([...value].length > max) {
      return {
        ok: false,
        reason: `This field accepts at most ${max} characters and the text is ${[...text].length}, ` +
          `so nothing was typed. A person typing it would have been cut off part-way.`,
      };
    }
  }

  return { ok: true, value, note };
}

import { fitToField, isoDate, isoTime } from "../src/content/fit";

/**
 * Fitting what the planner wrote to what the field will hold.
 *
 * A browser handed a value its input type cannot hold drops it without a word:
 * "23/09/2026" in a date input left it empty and was reported as typed. The
 * fix rewrites a value only where the meaning is certain - and the half of
 * this file that matters most is the other half, the cases that must be
 * refused rather than guessed.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

const fit = (text: string, type: string, extra: Record<string, unknown> = {}) =>
  fitToField(text, { type, ...extra });
const value = (text: string, type: string, extra: Record<string, unknown> = {}) => {
  const r = fit(text, type, extra);
  return r.ok ? r.value : `REFUSED: ${r.reason}`;
};
const refused = (text: string, type: string, extra: Record<string, unknown> = {}) => !fit(text, type, extra).ok;

// ------------------------------------------------------------------ dates

for (const [text, iso] of [
  ["2026-09-23", "2026-09-23"],
  ["23/09/2026", "2026-09-23"],   // day > 12: only one reading
  ["09/23/2026", "2026-09-23"],   // month first, also unambiguous
  ["23-09-2026", "2026-09-23"],
  ["23.09.2026", "2026-09-23"],
  ["05/05/2026", "2026-05-05"],   // both readings agree
  ["23 Sep 2026", "2026-09-23"],
  ["23rd September, 2026", "2026-09-23"],
  ["September 23, 2026", "2026-09-23"],
  ["Sept 23 2026", "2026-09-23"],
  ["1 March 2024", "2024-03-01"],
] as const) {
  want(value(text, "date") === iso, `date "${text}" became ${value(text, "date")}, not ${iso}`);
}

// The guesses. 04/05 is April in one country and May in another; a date of
// birth entered a month out is worse than one not entered at all.
want(refused("04/05/2026", "date"), "an ambiguous day/month was guessed");
want(/YYYY-MM-DD/.test(("reason" in isoDate("04/05/2026") ? (isoDate("04/05/2026") as { reason: string }).reason : "")),
  "the ambiguous-date refusal does not say which format to use");
want(refused("23/09/26", "date"), "a two-digit year was given a century");
want(refused("31/02/2026", "date"), "the 31st of February was accepted");
want(refused("2026-02-30", "date"), "an ISO 30th of February was accepted");
want(refused("next Tuesday", "date"), "a relative date was accepted");
want(refused("23 Marzipan 2026", "date"), "a word starting like a month was read as one");

// ------------------------------------------------------------------ times

for (const [text, t] of [
  ["15:30", "15:30"], ["3:30 PM", "15:30"], ["3:30pm", "15:30"], ["3 pm", "15:00"],
  ["12 am", "00:00"], ["12:15 p.m.", "12:15"], ["09:05:30", "09:05:30"], ["7.45 am", "07:45"],
] as const) {
  want(value(text, "time") === t, `time "${text}" became ${value(text, "time")}, not ${t}`);
}
want(!("value" in isoTime("25:00")), "25:00 was accepted");
want(!("value" in isoTime("13 pm")), "13 pm was accepted");
want(!("value" in isoTime("15")), "a bare hour with no am/pm was accepted");

want(value("23 Sep 2026 3:30 PM", "datetime-local") === "2026-09-23T15:30",
  `a date and time became ${value("23 Sep 2026 3:30 PM", "datetime-local")}`);
want(value("Sep 2026", "month") === "2026-09", `a month became ${value("Sep 2026", "month")}`);

// ---------------------------------------------------------------- numbers

for (const [text, n] of [
  ["12,000", "12000"], ["1,20,000", "120000"], ["₹ 1,500.50", "1500.50"], ["Rs. 499", "499"],
  ["-42", "-42"], ["3.14", "3.14"], ["12 000", "12000"],
] as const) {
  want(value(text, "number") === n, `number "${text}" became ${value(text, "number")}, not ${n}`);
}
// A decimal comma read as a thousands separator is off by a factor of ten.
want(refused("12,5", "number"), "a decimal comma was read as a thousands separator");
want(refused("twelve", "number"), "a word was accepted as a number");

// -------------------------------------------------------------- maxlength

want(value("+91 98765 43210", "tel", { maxLength: 10 }) === "9876543210",
  `a +91 mobile in a 10-digit field became ${value("+91 98765 43210", "tel", { maxLength: 10 })}`);
want(value("098765 43210", "text", { maxLength: 10, label: "Mobile number" }) === "9876543210",
  "a trunk-zero mobile in a text-typed mobile field was not fitted");
want(value("3456 7890 1238", "text", { maxLength: 12 }) === "345678901238",
  "spaces were not removed from a grouped number to fit its limit");

// Dropping leading digits is only ever right for a phone number.
want(refused("0123456789012", "text", { maxLength: 10, label: "Order number" }),
  "leading digits were dropped from something that is not a phone number");
want(refused("Priya Sharma Enterprises", "text", { maxLength: 10 }),
  "prose over the limit was truncated or accepted instead of refused");
want(refused("+1 555 010 0199 000", "tel", { maxLength: 10 }),
  "a number far longer than the field lost its front instead of being refused");

// -------------------------------------------------------- left untouched

want(value("Asha", "text") === "Asha", "plain text was changed");
want(value("Hello, world", "textarea", { maxLength: -1 }) === "Hello, world", "a textarea with no limit was changed");
want(value("", "date") === "", "clearing a date field was refused");
want(fit("2026-09-23", "date").ok && !(fit("2026-09-23", "date") as { note?: string }).note,
  "an already-correct date was reported as rewritten");

console.log(JSON.stringify({ failures: fails, pass: fails.length === 0 }, null, 2));

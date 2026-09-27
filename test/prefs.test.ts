import {
  classifyTask, emptyPrefs, preferenceHint, preferredSites, recordUse, siteOf, knownCategories,
} from "../src/shared/prefs";
import { suggestionsFor } from "../src/shared/suggest";
import { normaliseSettings } from "../src/shared/types";
import type { PageProfile } from "../src/content/profile";

/**
 * The user's preferred sites, page suggestions, and the OCR setting.
 *
 * "Book a flight tomorrow from Delhi to Bengaluru" should go where the user
 * books flights. The panel should offer what fits the page open, not three
 * fixed examples. And a screenshot must never go out with its pictures unread.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

// ------------------------------------------------------ what a task is about

const cases: [string, string | undefined][] = [
  ["book a flight ticket for tomorrow from Delhi to Bengaluru", "flights"],
  ["book a hotel near the airport in Goa", "hotels"],
  ["check tatkal train tickets from Pune to Nagpur", "trains"],
  ["order a biryani for dinner", "food"],
  ["order milk and atta", "groceries"],
  ["buy a pair of running shoes under 3000", "shopping"],
  ["write a mail to Priya about the meeting", "email"],
  ["book 2 tickets for the new movie tonight", "movies"],
  ["what is the capital of France", undefined],
];
for (const [task, category] of cases) {
  want(classifyTask(task) === category, `"${task}" was classified as ${classifyTask(task)}, not ${category}`);
}

// ------------------------------------------------------------- learning

want(siteOf("https://www.MakeMyTrip.com/flights/") === "makemytrip.com", "the site of a URL keeps www. or case");
want(siteOf("chrome://newtab/") === undefined, "a browser page was taken for a site");

const T0 = 1_000_000;
let p = emptyPrefs();

// Visits: only known sites, and at most one per half hour.
p = recordUse(p, "makemytrip.com", "visit", T0);
p = recordUse(p, "makemytrip.com", "visit", T0 + 60_000);
want(p.uses.flights?.["makemytrip.com"]?.visits === 1, "two page loads in a minute counted as two visits");
p = recordUse(p, "makemytrip.com", "visit", T0 + 31 * 60_000);
want(p.uses.flights?.["makemytrip.com"]?.visits === 2, "a visit half an hour later was not counted");
p = recordUse(p, "my-bank.example.com", "visit", T0);
want(!JSON.stringify(p).includes("my-bank"), "a visit to a site not on the known list was recorded");

// Tasks: any site the user's task was finished on, under that task's kind.
p = recordUse(p, "regional-travels.in", "task", T0, "flights");
p = recordUse(p, "regional-travels.in", "task", T0 + 1, "flights");
want(p.uses.flights?.["regional-travels.in"]?.tasks === 2, "a finished task did not teach its site");
p = recordUse(p, "google.com", "task", T0, "flights");
want(!p.uses.flights?.["google.com"], "a search engine was learned as a preferred site");

// Ranking: a finished task weighs three visits; a pinned site always leads.
{
  const ranked = preferredSites(p, "flights").map((s) => s.host);
  want(ranked[0] === "regional-travels.in", `two finished tasks did not outrank two visits: ${ranked.join(", ")}`);
  const pinned = { ...p, pinned: { flights: "ixigo.com" } };
  const withPin = preferredSites(pinned, "flights");
  want(withPin[0].host === "ixigo.com" && withPin[0].pinned, "the pinned site was not first");
}

// ------------------------------------------------------------- the hint

{
  const hint = preferenceHint(p, "book a flight ticket for tomorrow from Delhi to Bengaluru");
  want(!!hint && hint.includes("regional-travels.in"), `the flight task was not pointed at the user's site: ${hint}`);
  want(!!hint && hint.includes("makemytrip.com"), "the second site was not offered as a fallback");
  want(preferenceHint(p, "book a flight on cleartrip.com to Goa") === undefined,
    "a task that names its own site was overridden by the preference");
  want(preferenceHint(p, "what is the capital of France") === undefined, "a task of no kind got a site hint");
  want(preferenceHint(emptyPrefs(), "book a flight to Goa") === undefined, "a hint was given with no history");
}

// --------------------------------------------------------------- suggestions

const profile = (over: Partial<PageProfile> = {}): PageProfile => ({
  search: false, fields: 0, login: false, payment: false, article: false, tables: 0,
  prices: 0, video: false, cart: false, pdf: false, ...over,
});

{
  // A new tab: the user's own sites first, and no generic duplicate of them.
  let q = emptyPrefs();
  for (let i = 0; i < 3; i++) q = recordUse(q, "makemytrip.com", "task", i, "flights");
  q = recordUse(q, "swiggy.com", "task", 1, "food");
  const labels = suggestionsFor({}, q).map((s) => s.label);
  want(labels[0] === "Book a flight on makemytrip.com", `a new tab did not lead with the user's site: ${labels.join(" | ")}`);
  want(!labels.includes("Book a flight"), `the generic flight suggestion duplicated the user's own: ${labels.join(" | ")}`);
  want(labels.length <= 4, "more than four suggestions");
  want(knownCategories(q)[0] === "flights", "the most used kind was not first");
}
{
  // Gmail: what a mailbox is for.
  const labels = suggestionsFor({ host: "mail.google.com", profile: profile() }, undefined).map((s) => s.label);
  want(labels.includes("Summarise my unread emails"), `Gmail did not suggest mail tasks: ${labels.join(" | ")}`);
}
{
  // An article: reading tasks. A sign-in page: never "fill this form".
  const article = suggestionsFor({ host: "example-blog.com", profile: profile({ article: true }) }, undefined).map((s) => s.label);
  want(article.includes("Summarise this page"), `an article did not offer a summary: ${article.join(" | ")}`);
  const login = suggestionsFor({ host: "example.com", profile: profile({ login: true, fields: 3 }) }, undefined).map((s) => s.label);
  want(!login.includes("Help me fill this form"), "a sign-in page offered to fill its form - credentials are never typed");
  const form = suggestionsFor({ host: "example.gov.in", profile: profile({ fields: 6 }) }, undefined).map((s) => s.label);
  want(form.includes("Help me fill this form"), `a long form did not offer help filling it: ${form.join(" | ")}`);
}
{
  // Suggestions put a prompt in the composer; they never carry page text.
  const all = suggestionsFor({ host: "flipkart.com", profile: profile({ prices: 20, cart: true }) }, undefined);
  want(all.every((s) => s.prompt.length > 0 && s.label.length > 0), "a suggestion had no prompt");
  want(all.some((s) => s.label === "Review my cart"), "a page with a cart did not offer to review it");
}

// ---------------------------------------------------------------- settings

want(normaliseSettings({ ocrMode: "off" }).ocrMode === "full", "a saved 'off' left OCR off");
want(normaliseSettings({ ocrMode: "images" }).ocrMode === "images", "a saved 'images' was changed");
want(normaliseSettings(undefined).suggestForPage && normaliseSettings(undefined).rememberSites,
  "suggestions or preferred sites are off by default");

console.log(JSON.stringify({ failures: fails, pass: fails.length === 0 }, null, 2));

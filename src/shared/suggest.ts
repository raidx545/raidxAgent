import type { PageProfile } from "../content/profile";
import { CATEGORY_LABEL, categoriesOfHost, knownCategories, preferredSites, type SiteCategory, type SitePrefs } from "./prefs";

/**
 * Tasks that fit the page in front of the user.
 *
 * The panel used to open on three fixed examples - summarise a page, find a
 * pricing plan, search Hacker News - whatever the user was looking at. These
 * come from the page instead: its site, and what it has on it (a form, a long
 * article, a table, prices, a search box), plus the sites the user prefers
 * when there is no page to work with. All of it is worked out here, in the
 * browser; nothing is asked of a model until the user picks one.
 *
 * A suggestion is put into the composer, not run, so it can be finished or
 * changed first - which is why some end mid-sentence.
 */

export interface Suggestion {
  label: string;
  /** What goes into the composer. */
  prompt: string;
}

export interface PageContext {
  /** Host without "www.", or undefined for a page the extension cannot read. */
  host?: string;
  path?: string;
  profile?: PageProfile;
}

const MAX = 4;

/** Tasks that fit a known kind of site. */
const BY_CATEGORY: Partial<Record<SiteCategory, Suggestion[]>> = {
  email: [
    { label: "Summarise my unread emails", prompt: "Summarise my unread emails, most important first." },
    { label: "Draft a reply to the latest email", prompt: "Draft a reply to the latest email in my inbox. Don't send it." },
    { label: "Find emails with attachments from last week", prompt: "Find emails with attachments from the last 7 days and list them." },
  ],
  flights: [
    { label: "Find the cheapest flight", prompt: "Find the cheapest flight from " },
    { label: "Compare flights on this page", prompt: "Compare the flights on this page by price, duration and stops." },
  ],
  trains: [
    { label: "Find trains between two cities", prompt: "Find trains from " },
    { label: "Check a PNR status", prompt: "Check the status of PNR " },
  ],
  buses: [{ label: "Find buses between two cities", prompt: "Find buses from " }],
  hotels: [
    { label: "Find a well-rated hotel", prompt: "Find a hotel rated 4+ in " },
    { label: "Compare the hotels on this page", prompt: "Compare the hotels on this page by price and rating." },
  ],
  cabs: [{ label: "Check a fare", prompt: "Check the cab fare from " }],
  food: [
    { label: "Reorder my last meal", prompt: "Open my past orders and reorder the last one. Ask me before paying." },
    { label: "Find a well-rated restaurant nearby", prompt: "Find a restaurant rated 4+ that delivers " },
  ],
  groceries: [{ label: "Add groceries to my cart", prompt: "Add these to my cart: " }],
  shopping: [
    { label: "Compare the products on this page", prompt: "Compare the products on this page by price and rating, and pick the best value." },
    { label: "Find a cheaper alternative", prompt: "Find a cheaper alternative to this product with similar ratings." },
  ],
  movies: [{ label: "Find showtimes", prompt: "Find showtimes for " }],
  calendar: [
    { label: "What's on my calendar this week?", prompt: "What's on my calendar this week? List it by day." },
    { label: "Find a free slot", prompt: "Find a free hour on my calendar " },
  ],
  docs: [{ label: "Summarise this document", prompt: "Summarise this document in five bullet points." }],
  video: [{ label: "Summarise this video's page", prompt: "Summarise what this video is about from its title, description and top comments." }],
  jobs: [{ label: "Find matching jobs", prompt: "Find jobs for " }],
  news: [{ label: "Summarise the top stories", prompt: "Summarise the top five stories on this page." }],
  stocks: [{ label: "Summarise my portfolio", prompt: "Summarise my portfolio: total value and the biggest movers today." }],
  maps: [{ label: "Get directions", prompt: "Get directions from " }],
  music: [{ label: "Play something", prompt: "Play " }],
  social: [{ label: "Summarise my feed", prompt: "Summarise the top posts in my feed." }],
};

/** What to offer a task kind when there is no page - "Book a flight on makemytrip.com". */
const START: Partial<Record<SiteCategory, (host: string) => Suggestion>> = {
  flights: (h) => ({ label: `Book a flight on ${h}`, prompt: `Book a flight on ${h} from ` }),
  trains: (h) => ({ label: `Book a train on ${h}`, prompt: `Book a train ticket on ${h} from ` }),
  buses: (h) => ({ label: `Book a bus on ${h}`, prompt: `Book a bus ticket on ${h} from ` }),
  hotels: (h) => ({ label: `Find a hotel on ${h}`, prompt: `Find a hotel on ${h} in ` }),
  cabs: (h) => ({ label: `Book a cab on ${h}`, prompt: `Book a cab on ${h} from ` }),
  food: (h) => ({ label: `Order food on ${h}`, prompt: `Order food on ${h}: ` }),
  groceries: (h) => ({ label: `Order groceries on ${h}`, prompt: `Order groceries on ${h}: ` }),
  shopping: (h) => ({ label: `Shop on ${h}`, prompt: `Find on ${h}: ` }),
  movies: (h) => ({ label: `Book a movie on ${h}`, prompt: `Book movie tickets on ${h} for ` }),
  email: (h) => ({ label: `Check my email on ${h}`, prompt: `Open ${h} and summarise my unread emails.` }),
  calendar: (h) => ({ label: `Check my calendar on ${h}`, prompt: `Open ${h} and tell me what's on today.` }),
};

/** When the user has no history and no page is open. */
const GENERIC: (Suggestion & { category?: SiteCategory })[] = [
  { label: "Write an email", prompt: "Write an email to ", category: "email" },
  { label: "Book a flight", prompt: "Book a flight from ", category: "flights" },
  { label: "Order food", prompt: "Order ", category: "food" },
  { label: "Research a topic", prompt: "Find three good sources on " },
];

export function suggestionsFor(
  page: PageContext,
  prefs: SitePrefs | undefined,
): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (s: Suggestion | undefined) => {
    if (s && out.length < MAX && !out.some((o) => o.label === s.label)) out.push(s);
  };

  // No readable page: offer to start the user's usual tasks on their usual sites.
  if (!page.host) {
    const covered = new Set<SiteCategory>();
    if (prefs) {
      for (const category of knownCategories(prefs)) {
        const site = preferredSites(prefs, category, 1)[0];
        const make = START[category];
        if (site && make) {
          add(make(site.host));
          covered.add(category);
        }
      }
    }
    // The generic version of a task the user's own site already offers is noise.
    for (const { category, ...s } of GENERIC) if (!category || !covered.has(category)) add(s);
    return out;
  }

  const profile = page.profile;
  const categories = categoriesOfHost(page.host);

  // What this site is for.
  for (const category of categories) for (const s of BY_CATEGORY[category] ?? []) add(s);

  // What this page has on it.
  if (profile) {
    if (profile.pdf) add({ label: "Summarise this PDF", prompt: "Summarise this PDF in five bullet points." });
    if (profile.cart) add({ label: "Review my cart", prompt: "List what's in my cart with prices and the total. Don't check out." });
    if (profile.prices >= 6) {
      add({ label: "List items by price", prompt: "List the items on this page with their prices, cheapest first." });
    }
    if (profile.tables > 0) add({ label: "Summarise the table", prompt: "Summarise the table on this page and point out anything unusual." });
    if (profile.fields >= 3 && !profile.login && !profile.payment) {
      add({ label: "Help me fill this form", prompt: "Fill in this form for me. Ask me for anything you don't know, and don't submit it." });
    }
    if (profile.article) {
      add({ label: "Summarise this page", prompt: "Summarise this page in five bullet points." });
      add({ label: "Explain this simply", prompt: "Explain the main point of this page in plain words." });
    }
    if (profile.video) add({ label: "What is this video about?", prompt: "What is this video about? Use its title, description and comments." });
    if (profile.search) add({ label: "Search this site", prompt: "Search this site for " });
    if (profile.login) add({ label: "What is this site?", prompt: "What is this site and what can I do here once signed in?" });
  }

  // Anything left: the page itself, then the user's usual tasks elsewhere.
  add({ label: "Summarise this page", prompt: "Summarise this page in five bullet points." });
  if (prefs && out.length < MAX) {
    for (const category of knownCategories(prefs)) {
      if (categories.includes(category)) continue;
      const site = preferredSites(prefs, category, 1)[0];
      const make = START[category];
      if (site && make) add(make(site.host));
    }
  }
  return out;
}

/** "Flights", "Shopping" - what the open site is for, for the panel's header line. */
export function siteKind(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const [first] = categoriesOfHost(host);
  return first ? CATEGORY_LABEL[first] : undefined;
}

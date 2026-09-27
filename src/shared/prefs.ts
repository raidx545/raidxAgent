/**
 * The sites the user goes to for things.
 *
 * "Book a flight tomorrow from Delhi to Bengaluru" names a goal, not a site,
 * and the agent used to pick one - usually whatever it thought of first. A
 * person has a site they use for flights, one for food, one for shopping, and
 * going anywhere else means a new login, a different layout and the wrong
 * saved addresses.
 *
 * So VLESS remembers, in this browser only (chrome.storage.local, never sent
 * anywhere as a list):
 *
 *   - where the user's own tasks were finished, per kind of task, and
 *   - optionally, the user's own visits to a fixed list of known booking,
 *     shopping, mail and media sites - never any other browsing.
 *
 * When a task names a kind of thing, the agent is told the user's usual site
 * for it: a host name, which says nothing about the user the site itself
 * would not already know.
 */

export type SiteCategory =
  | "flights" | "trains" | "buses" | "hotels" | "cabs"
  | "food" | "groceries" | "shopping" | "movies"
  | "email" | "calendar" | "docs" | "maps"
  | "video" | "music" | "jobs" | "social" | "stocks" | "news";

export const CATEGORY_LABEL: Record<SiteCategory, string> = {
  flights: "Flights", trains: "Trains", buses: "Buses", hotels: "Hotels", cabs: "Cabs",
  food: "Food delivery", groceries: "Groceries", shopping: "Shopping", movies: "Movies & events",
  email: "Email", calendar: "Calendar", docs: "Documents", maps: "Maps",
  video: "Video", music: "Music", jobs: "Jobs", social: "Social", stocks: "Investing", news: "News",
};

/**
 * What a task is about. Order matters: "book a hotel near the airport" is a
 * hotel, not a flight, so the more specific kinds come first.
 */
const TASK_WORDS: [SiteCategory, RegExp][] = [
  ["hotels", /\b(hotels?|stays?|resorts?|homestay|hostel|room for|check[\s-]?in|airbnb)\b/i],
  ["trains", /\b(trains?|railways?|irctc|tatkal|rajdhani|shatabdi|vande bharat|pnr)\b/i],
  ["buses", /\b(bus|buses|volvo sleeper)\b/i],
  ["flights", /\b(flights?|fly|flying|air ?tickets?|airfare|plane tickets?|airlines?)\b/i],
  ["cabs", /\b(cab|cabs|taxi|ride to|uber|ola|auto ?rickshaw)\b/i],
  ["groceries", /\b(groceries|grocery|vegetables|milk|atta|instamart|blinkit|zepto)\b/i],
  ["food", /\b(order (?:food|dinner|lunch|breakfast)|food delivery|biryani|pizza|burger|restaurant|takeaway|swiggy|zomato)\b/i],
  ["movies", /\b(movies?|film|cinema|show ?times?|concert|event tickets?|bookmyshow)\b/i],
  ["email", /\b(e-?mails?|mail|inbox|gmail|outlook|reply to|draft)\b/i],
  ["calendar", /\b(calendar|meeting|schedule|appointment|invite)\b/i],
  ["docs", /\b(document|google docs?|spreadsheet|sheet|slides|notes?)\b/i],
  ["maps", /\b(directions?|route to|how far|distance to|near me|maps?)\b/i],
  ["music", /\b(song|music|playlist|album|spotify)\b/i],
  ["video", /\b(videos?|youtube|watch|trailer|episode|series)\b/i],
  ["jobs", /\b(jobs?|hiring|resume|cv|openings?|vacanc(?:y|ies)|internships?)\b/i],
  ["stocks", /\b(stocks?|shares?|mutual funds?|portfolio|nifty|sensex|sip)\b/i],
  ["news", /\b(news|headlines)\b/i],
  ["shopping", /\b(buy|order|shop|shopping|price of|cheapest|deal|add to cart|purchase)\b/i],
  ["social", /\b(tweet|post on|linkedin|instagram|facebook|twitter)\b/i],
];

export function classifyTask(task: string): SiteCategory | undefined {
  for (const [category, words] of TASK_WORDS) if (words.test(task)) return category;
  return undefined;
}

/**
 * Sites whose kind is known. Visits to these - and only these - are counted
 * when learning from browsing is on; anything else the user visits is never
 * looked at.
 */
const KNOWN_SITES: Record<string, SiteCategory[]> = {
  "makemytrip.com": ["flights", "hotels", "trains", "buses"],
  "goibibo.com": ["flights", "hotels", "buses"],
  "cleartrip.com": ["flights", "hotels"],
  "ixigo.com": ["flights", "trains", "buses"],
  "easemytrip.com": ["flights", "hotels"],
  "yatra.com": ["flights", "hotels"],
  "skyscanner.co.in": ["flights"],
  "skyscanner.com": ["flights"],
  "goindigo.in": ["flights"],
  "airindia.com": ["flights"],
  "spicejet.com": ["flights"],
  "akasaair.com": ["flights"],
  "irctc.co.in": ["trains"],
  "confirmtkt.com": ["trains"],
  "redbus.in": ["buses"],
  "abhibus.com": ["buses"],
  "booking.com": ["hotels"],
  "agoda.com": ["hotels"],
  "airbnb.co.in": ["hotels"],
  "airbnb.com": ["hotels"],
  "oyorooms.com": ["hotels"],
  "uber.com": ["cabs", "food"],
  "olacabs.com": ["cabs"],
  "rapido.bike": ["cabs"],
  "swiggy.com": ["food", "groceries"],
  "zomato.com": ["food"],
  "blinkit.com": ["groceries"],
  "zeptonow.com": ["groceries"],
  "bigbasket.com": ["groceries"],
  "jiomart.com": ["groceries", "shopping"],
  "amazon.in": ["shopping", "groceries"],
  "amazon.com": ["shopping"],
  "flipkart.com": ["shopping", "groceries"],
  "myntra.com": ["shopping"],
  "ajio.com": ["shopping"],
  "meesho.com": ["shopping"],
  "nykaa.com": ["shopping"],
  "croma.com": ["shopping"],
  "tatacliq.com": ["shopping"],
  "bookmyshow.com": ["movies"],
  "district.in": ["movies"],
  "paytm.com": ["movies"],
  "mail.google.com": ["email"],
  "outlook.live.com": ["email"],
  "outlook.office.com": ["email"],
  "mail.yahoo.com": ["email"],
  "mail.proton.me": ["email"],
  "calendar.google.com": ["calendar"],
  "outlook.office365.com": ["calendar", "email"],
  "docs.google.com": ["docs"],
  "notion.so": ["docs"],
  "www.notion.so": ["docs"],
  "maps.google.com": ["maps"],
  "youtube.com": ["video"],
  "netflix.com": ["video"],
  "hotstar.com": ["video"],
  "primevideo.com": ["video"],
  "jiocinema.com": ["video"],
  "open.spotify.com": ["music"],
  "music.youtube.com": ["music"],
  "music.apple.com": ["music"],
  "gaana.com": ["music"],
  "linkedin.com": ["jobs", "social"],
  "naukri.com": ["jobs"],
  "indeed.com": ["jobs"],
  "foundit.in": ["jobs"],
  "x.com": ["social"],
  "twitter.com": ["social"],
  "instagram.com": ["social"],
  "facebook.com": ["social"],
  "kite.zerodha.com": ["stocks"],
  "zerodha.com": ["stocks"],
  "groww.in": ["stocks"],
  "upstox.com": ["stocks"],
  "moneycontrol.com": ["stocks", "news"],
  "timesofindia.indiatimes.com": ["news"],
  "thehindu.com": ["news"],
  "indianexpress.com": ["news"],
  "ndtv.com": ["news"],
  "bbc.com": ["news"],
};

/** Search engines and the like: where a task passes through, not where it is done. */
const NEVER_PREFERRED = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yahoo\.com|search\.brave\.com|localhost)$/;

/** The host as a person would name it: "www." dropped, lower case. */
export function siteOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** The kinds a known site serves; empty for any site not on the list. */
export function categoriesOfHost(host: string): SiteCategory[] {
  const bare = host.toLowerCase().replace(/^www\./, "");
  if (KNOWN_SITES[bare]) return KNOWN_SITES[bare];
  // "m.flipkart.com", "www.makemytrip.com/flights" and regional subdomains
  // belong to the site they sit under.
  for (const [known, categories] of Object.entries(KNOWN_SITES)) {
    if (bare.endsWith(`.${known}`)) return categories;
  }
  return [];
}

interface Use {
  /** Visits the user made. */
  visits: number;
  /** Tasks the agent finished there - stronger evidence than a visit. */
  tasks: number;
  last: number;
}

export interface SitePrefs {
  version: 1;
  uses: Partial<Record<SiteCategory, Record<string, Use>>>;
  /** Sites the user chose outright, per kind. Always first. */
  pinned: Partial<Record<SiteCategory, string>>;
}

export function emptyPrefs(): SitePrefs {
  return { version: 1, uses: {}, pinned: {} };
}

export function normalisePrefs(raw: unknown): SitePrefs {
  const value = raw as Partial<SitePrefs> | undefined;
  if (!value || value.version !== 1) return emptyPrefs();
  return { version: 1, uses: value.uses ?? {}, pinned: value.pinned ?? {} };
}

/** A visit counts once per half hour: one booking is many page loads. */
const VISIT_GAP_MS = 30 * 60 * 1000;

/**
 * Notes one use of a site. A visit needs the site to be a known one; a task
 * the user asked for may teach any site, since they chose it by asking.
 */
export function recordUse(
  prefs: SitePrefs,
  host: string,
  source: "visit" | "task",
  now: number,
  category?: SiteCategory,
): SitePrefs {
  const site = host.toLowerCase().replace(/^www\./, "");
  if (!site || NEVER_PREFERRED.test(site)) return prefs;
  const categories = category ? [category] : categoriesOfHost(site);
  if (source === "visit" && categoriesOfHost(site).length === 0) return prefs;

  const next: SitePrefs = { ...prefs, uses: { ...prefs.uses } };
  for (const c of categories) {
    const bucket = { ...(next.uses[c] ?? {}) };
    const use = { ...(bucket[site] ?? { visits: 0, tasks: 0, last: 0 }) };
    if (source === "task") use.tasks++;
    else if (use.visits === 0 || now - use.last >= VISIT_GAP_MS) use.visits++;
    else continue;
    use.last = now;
    bucket[site] = use;
    next.uses[c] = bucket;
  }
  return next;
}

export interface Preferred {
  host: string;
  pinned: boolean;
  visits: number;
  tasks: number;
}

/**
 * The user's sites for one kind of task, best first: the pinned one, then by
 * use - a finished task weighs three visits - then by how recently.
 */
export function preferredSites(prefs: SitePrefs, category: SiteCategory, limit = 3): Preferred[] {
  const bucket = prefs.uses[category] ?? {};
  const pinned = prefs.pinned[category];
  const ranked = Object.entries(bucket)
    .filter(([host]) => host !== pinned)
    .map(([host, use]) => ({ host, pinned: false, visits: use.visits, tasks: use.tasks, last: use.last }))
    .filter((s) => s.visits + s.tasks > 0)
    .sort((a, b) => (b.tasks * 3 + b.visits) - (a.tasks * 3 + a.visits) || b.last - a.last)
    .map(({ last: _last, ...rest }) => rest);
  const out: Preferred[] = pinned
    ? [{ host: pinned, pinned: true, visits: bucket[pinned]?.visits ?? 0, tasks: bucket[pinned]?.tasks ?? 0 }, ...ranked]
    : ranked;
  return out.slice(0, limit);
}

/** The kinds the user has sites for, most used first. */
export function knownCategories(prefs: SitePrefs): SiteCategory[] {
  const score = (c: SiteCategory) =>
    (prefs.pinned[c] ? 1000 : 0) +
    Object.values(prefs.uses[c] ?? {}).reduce((n, u) => n + u.tasks * 3 + u.visits, 0);
  const all = new Set<SiteCategory>([
    ...(Object.keys(prefs.uses) as SiteCategory[]),
    ...(Object.keys(prefs.pinned) as SiteCategory[]),
  ]);
  return [...all].filter((c) => score(c) > 0).sort((a, b) => score(b) - score(a));
}

/**
 * What the agent is told, for a task of a kind the user has a site for.
 * Undefined when the task names no kind, names a site itself, or the user has
 * no history for it - the agent then chooses as it always did.
 */
export function preferenceHint(prefs: SitePrefs, task: string): string | undefined {
  const category = classifyTask(task);
  if (!category) return undefined;
  // "on flipkart", "using amazon.in", a URL: the user has already chosen.
  if (/\b(on|using|via|from|at)\s+[a-z0-9-]+\.(com|in|co\.in|org|net|io)\b|https?:\/\//i.test(task)) return undefined;
  const sites = preferredSites(prefs, category);
  if (sites.length === 0) return undefined;
  const [first, ...rest] = sites;
  const why = first.pinned
    ? "the user chose it as their site for this"
    : `the user has used it ${first.tasks > 0 ? `for ${first.tasks} earlier task${first.tasks === 1 ? "" : "s"}` : `${first.visits} time${first.visits === 1 ? "" : "s"}`}`;
  return (
    `The user's usual site for ${CATEGORY_LABEL[category].toLowerCase()} is ${first.host} (${why}). ` +
    `Go there to do this task unless the task names another site` +
    (rest.length > 0 ? `; if it cannot, they also use ${rest.map((s) => s.host).join(" and ")}.` : ".")
  );
}

// ------------------------------------------------------------------ storage

const KEY = "sitePrefs";

export async function loadPrefs(): Promise<SitePrefs> {
  const stored = await chrome.storage.local.get(KEY);
  return normalisePrefs(stored[KEY]);
}

export async function savePrefs(prefs: SitePrefs): Promise<void> {
  await chrome.storage.local.set({ [KEY]: prefs });
}

/** Read, change and write back, so two writers do not lose each other's counts. */
let queue: Promise<unknown> = Promise.resolve();
export function updatePrefs(change: (prefs: SitePrefs) => SitePrefs): Promise<void> {
  const next = queue.then(async () => savePrefs(change(await loadPrefs())));
  queue = next.catch(() => undefined);
  return next;
}

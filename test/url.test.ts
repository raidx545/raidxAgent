import { isAddress, normaliseUrl, resolveUrlTokens } from "../src/background/url";

/**
 * What navigate does with what the planner wrote.
 *
 * "Starts with a dotted word" made "node.js tutorial" an address and
 * "localhost:3000" a search. And placeholders were resolved into URLs as raw
 * text, so "priya+work@example.in" reached Gmail as "priya work@example.in".
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

// ------------------------------------------------ address or search

for (const text of ["gmail.com", "mail.google.com/mail/u/0/#inbox", "https://example.com/a b",
  "localhost:3000", "localhost", "192.168.1.1", "127.0.0.1:8766/selftest.html", "en.wikipedia.org/wiki/India"]) {
  want(isAddress(text), `"${text}" was not recognised as an address`);
}
for (const text of ["node.js tutorial", "best laptops 2026", "e.g. something", "weather", "what is 3.5 kg in pounds"]) {
  want(!isAddress(text), `"${text}" was taken for an address`);
}

want(normaliseUrl("node.js tutorial") === "https://www.google.com/search?q=node.js%20tutorial",
  `a search with a dotted word became ${normaliseUrl("node.js tutorial")}`);
want(normaliseUrl("localhost:3000") === "http://localhost:3000",
  `localhost became ${normaliseUrl("localhost:3000")}`);
want(normaliseUrl("192.168.1.1") === "http://192.168.1.1", `a router address became ${normaliseUrl("192.168.1.1")}`);
want(normaliseUrl("gmail.com") === "https://gmail.com", `a domain became ${normaliseUrl("gmail.com")}`);
want(normaliseUrl("  https://example.com  ") === "https://example.com", "surrounding spaces were kept");

// ------------------------------------------------ placeholders in URLs

const values: Record<string, string> = {
  "<EMAIL_1>": "priya+work@example.in",
  "<NAME_1>": "Tom & Jerry #1",
  "<ORG_1>": "Sharma Traders",
};
const resolve = async (token: string) => values[token] ?? token;

const gmail = await resolveUrlTokens("https://mail.google.com/mail/u/0/#search/from:<EMAIL_1>", resolve);
want(gmail === "https://mail.google.com/mail/u/0/#search/from:priya%2Bwork%40example.in",
  `an address in a fragment was not encoded: ${gmail}`);
want(decodeURIComponent(new URL(gmail).hash.split(":")[1]) === "priya+work@example.in",
  "the encoded address does not decode back to the same address");

const query = await resolveUrlTokens("https://www.google.com/search?q=<NAME_1>&hl=en", resolve);
want(new URL(query).searchParams.get("q") === "Tom & Jerry #1" && new URL(query).searchParams.get("hl") === "en",
  `a value with & and # broke the query string: ${query}`);

// Not an address: it becomes a search, and normaliseUrl encodes it then.
const search = await resolveUrlTokens("<ORG_1> reviews", resolve);
want(search === "Sharma Traders reviews", `search text was encoded early: ${search}`);
want(normaliseUrl(search) === "https://www.google.com/search?q=Sharma%20Traders%20reviews",
  `search text was encoded twice: ${normaliseUrl(search)}`);

// No placeholders: nothing changes.
want(await resolveUrlTokens("https://example.com/a?b=c", resolve) === "https://example.com/a?b=c",
  "a URL without placeholders was changed");

console.log(JSON.stringify({ failures: fails, pass: fails.length === 0 }, null, 2));

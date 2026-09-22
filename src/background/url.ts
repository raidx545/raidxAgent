/**
 * Whether the planner wrote an address rather than something to search for.
 *
 * This used to be "starts with a dotted word", which made "node.js tutorial"
 * the address https://node.js tutorial, and made "localhost:3000" - which has
 * no dot - a Google search. An address has no spaces, and its host is a
 * dotted name, localhost, or an IP, optionally with a port.
 */
export function isAddress(raw: string): boolean {
  const text = raw.trim();
  if (/^https?:\/\//i.test(text)) return true;
  if (text === "" || /\s/.test(text)) return false;
  const host = text.split(/[/?#]/, 1)[0];
  return /^(localhost|(?:[\w-]+\.)+[a-z][a-z0-9-]*|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d{1,5})?$/i.test(host);
}

export function normaliseUrl(raw: string): string {
  const text = raw.trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (isAddress(text)) {
    // A development server or a router page does not speak https.
    const local = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[)/i.test(text);
    return `${local ? "http" : "https"}://${text}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

const TOKEN = /<[A-Z][A-Z0-9]*_\d+>/g;

/**
 * Swaps placeholders in a URL for their values, encoded for where they sit.
 *
 * Resolution is a plain text substitution everywhere else, which is right for
 * typing and wrong here: a value dropped raw into a query string is read by
 * the server as URL syntax. "priya+work@example.in" arrives as
 * "priya work@example.in" - a different recipient - and an "&" or "#" in a
 * name cuts the URL off at that point. After the host, every value is
 * percent-encoded.
 *
 * Text that is not an address is left alone: it becomes a search, and
 * normaliseUrl encodes the whole of it then. Encoding here as well would
 * encode it twice.
 */
export async function resolveUrlTokens(
  url: string,
  resolve: (token: string) => Promise<string>,
): Promise<string> {
  if (!isAddress(url.replace(TOKEN, "x"))) {
    let out = url;
    for (const token of new Set(url.match(TOKEN) ?? [])) out = out.split(token).join(await resolve(token));
    return out;
  }
  const scheme = url.match(/^[a-z][a-z0-9+.-]*:\/\//i)?.[0].length ?? 0;
  const rest = url.slice(scheme).search(/[/?#]/);
  const pathStart = rest < 0 ? url.length : scheme + rest;

  let out = "";
  let last = 0;
  for (const match of url.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    const value = await resolve(match[0]);
    out += url.slice(last, at) + (at >= pathStart ? encodeURIComponent(value) : value);
    last = at + match[0].length;
  }
  return out + url.slice(last);
}

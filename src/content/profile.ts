/**
 * What kind of page this is, in facts rather than content.
 *
 * The side panel suggests tasks that fit the page open in front of the user.
 * Working that out must not cost their privacy: nothing here reads a value, a
 * name or a sentence - only whether the page has a search box, a form, a long
 * article, a table, prices, a video. It never leaves the browser either; the
 * panel turns it into suggestions on its own.
 */

export interface PageProfile {
  /** The page has a search box of its own. */
  search: boolean;
  /** Visible fields a person fills in, not counting search boxes. */
  fields: number;
  /** A password field is showing: this is a sign-in page. */
  login: boolean;
  /** A payment form: card number, CVV or UPI fields. */
  payment: boolean;
  /** Long-form reading: an article, a post, documentation. */
  article: boolean;
  /** Data tables with several rows. */
  tables: number;
  /** Prices shown on the page, capped - a listing has many, a product page a few. */
  prices: number;
  video: boolean;
  /** A basket or cart is on screen. */
  cart: boolean;
  /** The page is a PDF viewer. */
  pdf: boolean;
}

function visible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

export function profilePage(): PageProfile {
  const inputs = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input, textarea, select",
  )].filter((el) => visible(el) && !(el instanceof HTMLInputElement && ["hidden", "submit", "button", "image", "reset"].includes(el.type)));

  const isSearch = (el: Element) =>
    (el instanceof HTMLInputElement && el.type === "search") ||
    el.getAttribute("role") === "searchbox" ||
    !!el.closest("[role=search], form[role=search]") ||
    /^(q|query|search|s|keyword|k)$/i.test(el.getAttribute("name") ?? "") ||
    /search/i.test(`${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("placeholder") ?? ""}`);

  const search = inputs.some(isSearch);
  const fields = inputs.filter((el) => !isSearch(el) && !(el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type))).length;
  const login = inputs.some((el) => el instanceof HTMLInputElement && el.type === "password");
  const payment = inputs.some((el) =>
    /cc-number|cc-csc|cc-exp/.test(el.getAttribute("autocomplete") ?? "") ||
    /card.?number|cvv|cvc|upi/i.test(`${el.getAttribute("name") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("placeholder") ?? ""}`));

  const main = document.querySelector("article, main, [role=main]") ?? document.body;
  const paragraphs = [...main.querySelectorAll("p")].filter((p) => (p.textContent ?? "").trim().length > 80);
  const article = !!document.querySelector("article") || paragraphs.length >= 5;

  const tables = [...document.querySelectorAll("table, [role=grid], [role=table]")]
    .filter((t) => visible(t) && t.querySelectorAll("tr, [role=row]").length >= 3).length;

  // Counted, not read: how many price-shaped strings are on the page.
  const text = (document.body.innerText ?? "").slice(0, 200_000);
  const prices = Math.min(50, (text.match(/(?:₹|Rs\.?|INR|\$|€|£)\s?\d[\d,]*(?:\.\d{2})?/g) ?? []).length);

  const video = [...document.querySelectorAll("video")].some(visible);
  const cart = /\b(add to (?:cart|bag|basket)|your (?:cart|bag|basket)|proceed to (?:checkout|buy))\b/i.test(text);
  const pdf = document.contentType === "application/pdf" || /\.pdf($|\?)/i.test(location.pathname);

  return { search, fields, login, payment, article, tables, prices, video, cart, pdf };
}

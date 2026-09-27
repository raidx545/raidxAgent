import { TranscriptView } from "../../src/sidepanel/transcript";
import { suggestionsFor } from "../../src/shared/suggest";
import { recordUse, emptyPrefs } from "../../src/shared/prefs";
import type { TranscriptEntry } from "../../src/shared/types";

/**
 * The side panel, driven by a scripted run.
 *
 * The panel itself can only be opened by Chrome as part of the extension, which
 * makes every visual change to it awkward to check. This page loads the real
 * stylesheet, markup and transcript view and plays a realistic task through
 * them. `?empty` shows the empty state with the suggestions the real panel
 * would make on a travel site, and `?newtab` those for a tab with no page.
 */

const params = new URLSearchParams(location.search);
const container = document.getElementById("transcript") as HTMLElement;
const view = new TranscriptView(container);
const empty = document.getElementById("empty") as HTMLElement;
const jump = document.getElementById("jump") as HTMLElement;

// The user's history: flights on makemytrip, food on swiggy, mail in gmail.
let prefs = emptyPrefs();
for (let i = 0; i < 4; i++) prefs = recordUse(prefs, "makemytrip.com", "task", i, "flights");
for (let i = 0; i < 3; i++) prefs = recordUse(prefs, "swiggy.com", "task", i, "food");
prefs = recordUse(prefs, "mail.google.com", "task", 1, "email");

if (params.has("empty") || params.has("newtab")) {
  const newTab = params.has("newtab");
  const host = newTab ? undefined : "makemytrip.com";
  document.getElementById("site-host")!.textContent = host ?? "New tab";
  document.getElementById("site-kind")!.textContent = newTab ? "" : "Flights";
  document.getElementById("site-badge")!.textContent = host ? "m" : "";
  document.getElementById("site-badge")!.hidden = !host;
  document.getElementById("empty-title")!.textContent = newTab ? "What can I do for you?" : "What should I do here?";
  const list = document.getElementById("suggestions")!;
  const suggestions = suggestionsFor(
    newTab ? {} : { host, profile: { search: true, fields: 4, login: false, payment: false, article: false, tables: 0, prices: 18, video: false, cart: false, pdf: false } },
    prefs,
  );
  for (const s of suggestions) {
    const b = document.createElement("button");
    b.className = "suggestion";
    b.type = "button";
    b.innerHTML = `<span></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
    b.querySelector("span")!.textContent = s.label;
    list.appendChild(b);
  }
  (document.getElementById("send") as HTMLButtonElement).disabled = true;
} else {
  const entry = (e: Partial<TranscriptEntry> & { id: string; role: TranscriptEntry["role"] }) =>
    view.render({ text: "", ...e } as TranscriptEntry);

  empty.classList.add("hidden");

  entry({ id: "u1", role: "user", text: "book a flight ticket for tomorrow from Delhi to Bengaluru" });
  entry({ id: "p0", role: "system", tone: "info", text: "Your usual site for flights: makemytrip.com" });
  entry({ id: "s0", role: "system", tone: "info", text: "Using OpenRouter openai/gpt-5.4-mini" });
  entry({ id: "s1", role: "system", tone: "privacy", text: "Protected 18 private values · 6 inside images · 1 picture blacked out" });
  entry({ id: "a1", role: "assistant", text: "Opening makemytrip.com's flight search with Delhi → Bengaluru for tomorrow." });

  const steps: [string, string][] = [
    ["navigate", "Opened makemytrip.com."],
    ["click", "Clicked the \"From\" field."],
    ["type", 'Filled in the "From" field and pressed Enter.'],
    ["type", 'Filled in the "To" field and pressed Enter.'],
    ["click", "Clicked tomorrow's date."],
    ["click", 'Clicked the "Search" button. Results opened.'],
    ["scroll", "Scrolled down."],
  ];
  steps.forEach(([action, text], i) =>
    entry({ id: `t${i}`, role: "step", action: action as TranscriptEntry["action"], text }),
  );

  entry({
    id: "a2", role: "assistant",
    text: "The cheapest non-stop is IndiGo 6E 2131 at 06:10, ₹4,812. I've stopped before booking — want me to continue with it?",
  });
  entry({ id: "w1", role: "system", tone: "warning", text: "1 picture could not be read and was blacked out." });
  entry({ id: "e1", role: "error", text: "Stopped — this is going in circles. The same action was tried 4 times with no change." });
  entry({ id: "t9", role: "step", action: "click", text: "Click Book", pending: true });

  (document.getElementById("progress") as HTMLElement).textContent = "8 actions";
  document.getElementById("status-dot")!.classList.add("running");
  document.getElementById("send")!.classList.add("hidden");
  document.getElementById("stop")!.classList.remove("hidden");

  if (params.has("confirm")) {
    document.getElementById("confirm-text")!.textContent = 'Click "Book now" on MakeMyTrip — Flight Booking?';
    document.getElementById("confirm")!.classList.remove("hidden");
  }
  jump.classList.add("hidden");
}

// The menu opens in the preview too, so it can be looked at.
const menuBtn = document.getElementById("menu-btn")!;
menuBtn.addEventListener("click", () => {
  const menu = document.getElementById("menu")!;
  const open = menu.classList.toggle("hidden") === false;
  menuBtn.setAttribute("aria-expanded", String(open));
});
if (params.has("menu")) menuBtn.click();

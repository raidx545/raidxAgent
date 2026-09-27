import type { ProviderId } from "../background/providers/types";
import type { Settings } from "../shared/types";
import { normaliseSettings } from "../shared/types";
import { PROVIDERS, PROVIDER_IDS, listModels } from "../shared/models";
import {
  CATEGORY_LABEL, loadPrefs, preferredSites, savePrefs, siteOf, updatePrefs,
  type SiteCategory, type SitePrefs,
} from "../shared/prefs";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const tabsEl = $("provider-tabs");
const providerHint = $("provider-hint");
const apiKeyEl = $<HTMLInputElement>("apiKey");
const baseUrlEl = $<HTMLInputElement>("baseUrl");
const baseUrlRow = $("base-url-row");
const keyHint = $("key-hint");
const modelEl = $<HTMLInputElement>("model");
const modelList = $<HTMLDataListElement>("model-list");
const modelStatus = $("model-status");
const maxStepsEl = $<HTMLInputElement>("maxSteps");
const reasoningEl = $<HTMLSelectElement>("reasoningEffort");
const ocrEl = $<HTMLSelectElement>("ocrMode");
const confirmRiskyEl = $<HTMLInputElement>("confirmRisky");
const sendScreenshotEl = $<HTMLInputElement>("sendScreenshot");
const fullPageCaptureEl = $<HTMLInputElement>("fullPageCapture");
const suggestEl = $<HTMLInputElement>("suggestForPage");
const rememberEl = $<HTMLInputElement>("rememberSites");
const learnEl = $<HTMLInputElement>("learnFromBrowsing");
const ocrRow = $("ocr-row");
const sitesEl = $("sites");
const pinCategory = $<HTMLSelectElement>("pin-category");
const pinHost = $<HTMLInputElement>("pin-host");
const refreshBtn = $<HTMLButtonElement>("refresh-models");
const savedEl = $("saved");

/** Working copy. Edits to the visible fields are folded in on provider switch. */
let settings: Settings = normaliseSettings(undefined);

/** Live model lists, per provider, once fetched. */
const fetched = new Map<ProviderId, string[]>();

function captureVisibleFields(): void {
  settings.apiKeys[settings.provider] = apiKeyEl.value.trim();
  settings.models[settings.provider] = modelEl.value.trim();
  // The base URL belongs to the custom provider alone, so it is only read back
  // while that provider is the one on screen.
  if (settings.provider === "custom") settings.customBaseUrl = baseUrlEl.value.trim();
}

function renderModelOptions(): void {
  const provider = PROVIDERS[settings.provider];
  const options = fetched.get(settings.provider) ?? provider.suggested;
  modelList.innerHTML = "";
  for (const id of options) {
    const option = document.createElement("option");
    option.value = id;
    modelList.appendChild(option);
  }
}

function render(): void {
  const provider = PROVIDERS[settings.provider];

  tabsEl.querySelectorAll("button").forEach((button) => {
    button.setAttribute(
      "aria-selected",
      String(button.dataset.provider === settings.provider),
    );
  });

  const custom = provider.id === "custom";

  providerHint.innerHTML = custom
    ? "Point VLESS at any OpenAI-compatible server. Nothing about it is assumed — the " +
      "base URL, the key and the model id are all yours to set."
    : `Get a key at <a href="${provider.keyUrl}" target="_blank" rel="noreferrer">` +
      `${new URL(provider.keyUrl).host}</a>.` +
      (provider.id === "openrouter"
        ? " OpenRouter proxies many vendors' models behind one key."
        : "");

  baseUrlRow.hidden = !custom;
  baseUrlEl.value = settings.customBaseUrl;
  keyHint.textContent = custom
    ? "Leave empty for a local server that does not ask for one."
    : "Each provider's key is remembered separately, so switching back does not lose it.";

  apiKeyEl.value = settings.apiKeys[provider.id] ?? "";
  apiKeyEl.placeholder = provider.keyHint;
  modelEl.value = settings.models[provider.id] ?? provider.defaultModel;
  maxStepsEl.value = String(settings.maxSteps);
  reasoningEl.value = settings.reasoningEffort;
  ocrEl.value = settings.ocrMode;
  confirmRiskyEl.checked = settings.confirmRisky;
  sendScreenshotEl.checked = settings.sendScreenshot;
  fullPageCaptureEl.checked = settings.fullPageCapture;
  suggestEl.checked = settings.suggestForPage;
  rememberEl.checked = settings.rememberSites;
  learnEl.checked = settings.learnFromBrowsing;
  syncDependents();

  renderModelOptions();
}

/** Settings that mean nothing while their parent is off are shown as such. */
function syncDependents(): void {
  ocrRow.style.opacity = sendScreenshotEl.checked ? "" : ".5";
  ocrEl.disabled = !sendScreenshotEl.checked;
  learnEl.disabled = !rememberEl.checked;
}
sendScreenshotEl.addEventListener("change", syncDependents);
rememberEl.addEventListener("change", syncDependents);

// ------------------------------------------------------- preferred websites
//
// Saved as they are changed - they are the user's own record, not a setting
// that needs a key to be valid - and shown per kind of task, the pinned site
// first.

const CATEGORIES = Object.keys(CATEGORY_LABEL) as SiteCategory[];
for (const category of CATEGORIES) {
  const option = document.createElement("option");
  option.value = category;
  option.textContent = CATEGORY_LABEL[category];
  pinCategory.appendChild(option);
}

function renderSites(prefs: SitePrefs): void {
  sitesEl.innerHTML = "";
  const rows = CATEGORIES
    .map((category) => ({ category, sites: preferredSites(prefs, category, 6) }))
    .filter((row) => row.sites.length > 0);

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-sites";
    empty.textContent = "No preferred websites yet. They appear here as you finish tasks, or set one below.";
    sitesEl.appendChild(empty);
    return;
  }

  for (const { category, sites } of rows) {
    const row = document.createElement("div");
    row.className = "site-row";
    const name = document.createElement("div");
    name.className = "site-cat";
    name.textContent = CATEGORY_LABEL[category];
    const chips = document.createElement("div");
    chips.className = "chips";

    for (const site of sites) {
      const chip = document.createElement("span");
      chip.className = `chip${site.pinned ? " pinned" : ""}`;
      const host = document.createElement("span");
      host.textContent = site.host;
      chip.appendChild(host);
      const uses = site.tasks + site.visits;
      if (!site.pinned && uses > 0) {
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = `×${uses}`;
        count.title = `${site.tasks} task(s), ${site.visits} visit(s)`;
        chip.appendChild(count);
      }
      if (!site.pinned) {
        const pin = document.createElement("button");
        pin.type = "button";
        pin.textContent = "Prefer";
        pin.setAttribute("aria-label", `Prefer ${site.host} for ${CATEGORY_LABEL[category]}`);
        pin.addEventListener("click", () => void change((p) => ({ ...p, pinned: { ...p.pinned, [category]: site.host } })));
        chip.appendChild(pin);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", `Remove ${site.host} from ${CATEGORY_LABEL[category]}`);
      remove.addEventListener("click", () => void change((p) => {
        const uses = { ...p.uses, [category]: { ...(p.uses[category] ?? {}) } };
        delete uses[category]![site.host];
        const pinned = { ...p.pinned };
        if (pinned[category] === site.host) delete pinned[category];
        return { ...p, uses, pinned };
      }));
      chip.appendChild(remove);
      chips.appendChild(chip);
    }
    row.append(name, chips);
    sitesEl.appendChild(row);
  }
}

async function change(edit: (prefs: SitePrefs) => SitePrefs): Promise<void> {
  await updatePrefs(edit);
  renderSites(await loadPrefs());
}

$("pin-add").addEventListener("click", () => {
  const raw = pinHost.value.trim();
  const host = siteOf(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  if (!host || !host.includes(".")) {
    pinHost.setCustomValidity("Enter a website such as makemytrip.com");
    pinHost.reportValidity();
    return;
  }
  pinHost.setCustomValidity("");
  const category = pinCategory.value as SiteCategory;
  pinHost.value = "";
  void change((p) => ({ ...p, pinned: { ...p.pinned, [category]: host } }));
});
pinHost.addEventListener("input", () => pinHost.setCustomValidity(""));

$("sites-clear").addEventListener("click", () => {
  if (!confirm("Forget every preferred website VLESS has learned or you have set?")) return;
  void savePrefs({ version: 1, uses: {}, pinned: {} }).then(async () => renderSites(await loadPrefs()));
});

for (const id of PROVIDER_IDS) {
  const button = document.createElement("button");
  button.type = "button";
  button.role = "tab";
  button.dataset.provider = id;
  button.textContent = PROVIDERS[id].label;
  button.addEventListener("click", () => {
    // Keep whatever the user typed for the provider they are leaving.
    captureVisibleFields();
    settings.provider = id;
    modelStatus.textContent = "";
    render();
  });
  tabsEl.appendChild(button);
}

refreshBtn.addEventListener("click", async () => {
  const provider = settings.provider;
  refreshBtn.disabled = true;
  modelStatus.textContent = "Fetching…";

  try {
    const models = await listModels(provider, apiKeyEl.value.trim(), baseUrlEl.value.trim());
    fetched.set(provider, models);
    renderModelOptions();
    modelStatus.textContent = `${models.length} models available. Click the field to browse them.`;
  } catch (error) {
    modelStatus.textContent =
      error instanceof Error ? `Could not fetch: ${error.message}` : "Could not fetch models.";
  } finally {
    refreshBtn.disabled = false;
  }
});

$("save").addEventListener("click", async () => {
  captureVisibleFields();
  settings.maxSteps = Math.min(200, Math.max(5, Number(maxStepsEl.value) || 40));
  settings.reasoningEffort =
    reasoningEl.value === "off" || reasoningEl.value === "deep" ? reasoningEl.value : "standard";
  settings.ocrMode = ocrEl.value === "images" ? "images" : "full";
  settings.suggestForPage = suggestEl.checked;
  settings.rememberSites = rememberEl.checked;
  settings.learnFromBrowsing = learnEl.checked;
  settings.confirmRisky = confirmRiskyEl.checked;
  settings.sendScreenshot = sendScreenshotEl.checked;
  settings.fullPageCapture = fullPageCaptureEl.checked;

  if (settings.provider === "custom") {
    const url = settings.customBaseUrl;
    if (!url) {
      savedEl.className = "bad";
      savedEl.textContent = "Add a base URL before saving.";
      return;
    }
    // Catch a typo here rather than as an opaque network error mid-task.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      savedEl.className = "bad";
      savedEl.textContent = "That base URL is not a valid http:// or https:// address.";
      return;
    }
    if (!settings.models.custom) {
      savedEl.className = "bad";
      savedEl.textContent = "Enter a model id — Refresh list will ask the server for them.";
      return;
    }
  } else if (!settings.apiKeys[settings.provider]) {
    savedEl.className = "bad";
    savedEl.textContent = `Add a ${PROVIDERS[settings.provider].label} key before saving.`;
    return;
  }

  await chrome.storage.local.set({ settings });
  savedEl.className = "ok";
  savedEl.textContent = "Saved";
  setTimeout(() => (savedEl.textContent = ""), 1800);
});

void (async () => {
  const stored = await chrome.storage.local.get("settings");
  settings = normaliseSettings(stored.settings);
  render();
  renderSites(await loadPrefs());
})();

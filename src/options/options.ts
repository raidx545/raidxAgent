import type { ProviderId } from "../background/providers/types";
import type { Settings } from "../shared/types";
import { normaliseSettings } from "../shared/types";
import { PROVIDERS, PROVIDER_IDS, listModels } from "../shared/models";

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

  renderModelOptions();
}

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
  settings.ocrMode = ocrEl.value === "off" || ocrEl.value === "full" ? ocrEl.value : "images";
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
})();

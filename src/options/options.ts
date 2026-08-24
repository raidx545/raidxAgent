import type { ProviderId } from "../background/providers/types";
import type { Settings } from "../shared/types";
import { normaliseSettings } from "../shared/types";
import { PROVIDERS, PROVIDER_IDS, listModels } from "../shared/models";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const tabsEl = $("provider-tabs");
const providerHint = $("provider-hint");
const apiKeyEl = $<HTMLInputElement>("apiKey");
const modelEl = $<HTMLInputElement>("model");
const modelList = $<HTMLDataListElement>("model-list");
const modelStatus = $("model-status");
const maxStepsEl = $<HTMLInputElement>("maxSteps");
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

  providerHint.innerHTML =
    `Get a key at <a href="${provider.keyUrl}" target="_blank" rel="noreferrer">` +
    `${new URL(provider.keyUrl).host}</a>.` +
    (provider.id === "openrouter"
      ? " OpenRouter proxies many vendors' models behind one key."
      : "");

  apiKeyEl.value = settings.apiKeys[provider.id] ?? "";
  apiKeyEl.placeholder = provider.keyHint;
  modelEl.value = settings.models[provider.id] ?? provider.defaultModel;
  maxStepsEl.value = String(settings.maxSteps);
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
    const models = await listModels(provider, apiKeyEl.value.trim());
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
  settings.confirmRisky = confirmRiskyEl.checked;
  settings.sendScreenshot = sendScreenshotEl.checked;
  settings.fullPageCapture = fullPageCaptureEl.checked;

  if (!settings.apiKeys[settings.provider]) {
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

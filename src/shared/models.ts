import type { ProviderId } from "../background/providers/types";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Where the user goes to get a key. */
  keyUrl: string;
  keyHint: string;
  /** Starting points only — the options page can refresh this list live. */
  suggested: string[];
  defaultModel: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    suggested: [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-4-8",
      "claude-fable-5",
    ],
    defaultModel: "claude-opus-5",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    // Verified against a live catalogue, but vendors ship constantly — the
    // Refresh button in the options page is the authority, not this list.
    suggested: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.1", "gpt-5"],
    defaultModel: "gpt-5.5",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-v1-…",
    suggested: [
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.5",
      "google/gemini-3.1-pro-preview",
      "x-ai/grok-4.6",
      "deepseek/deepseek-v4-pro",
    ],
    defaultModel: "anthropic/claude-opus-5",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/**
 * Fetches the models a provider currently offers. The bundled suggestions go
 * stale as vendors ship; this is how the user gets the real list.
 *
 * Uses plain fetch rather than the SDKs so the options page stays small.
 */
export async function listModels(
  provider: ProviderId,
  apiKey: string,
): Promise<string[]> {
  if (provider === "openrouter") {
    // OpenRouter's catalogue is public — no key needed.
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id)).sort();
  }

  if (!apiKey) throw new Error("Enter an API key first.");

  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
      // Embeddings, audio, and image models cannot drive an agent loop.
      .filter((id) => /^(gpt|o\d|chatgpt)/.test(id))
      .sort();
  }

  const response = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for any Anthropic API call made straight from a browser.
      "anthropic-dangerous-direct-browser-access": "true",
    },
  });
  if (!response.ok) throw new Error(`Anthropic returned ${response.status}`);
  const body = (await response.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
}

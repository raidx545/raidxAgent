import type { Settings } from "../../shared/types";
import { createAnthropicPlanner } from "./anthropic";
import { createOpenAIPlanner } from "./openai";
import type { Planner } from "./types";
import { PlannerError } from "./types";

/** Builds the planner for whichever provider the user has selected. */
export function createPlanner(settings: Settings): Planner {
  const provider = settings.provider;
  const apiKey = settings.apiKeys[provider] ?? "";
  const model = settings.models[provider] ?? "";

  // A custom server may legitimately need no key - a local Ollama does not -
  // but it cannot work without somewhere to send the request.
  if (provider === "custom" && !settings.customBaseUrl.trim()) {
    throw new PlannerError(
      "No base URL set for the custom provider. Open the extension options and add one, " +
        "for example http://localhost:11434/v1.",
    );
  }
  if (!apiKey && provider !== "custom") {
    throw new PlannerError(
      `No API key set for ${provider}. Open the extension options and add one.`,
    );
  }
  if (!model) {
    throw new PlannerError(`No model chosen for ${provider}. Pick one in the extension options.`);
  }

  return provider === "anthropic"
    ? createAnthropicPlanner(apiKey, model)
    : createOpenAIPlanner(provider, apiKey, model, settings.customBaseUrl.trim());
}

export type { Planner };
export { PlannerError };

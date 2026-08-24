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

  if (!apiKey) {
    throw new PlannerError(
      `No API key set for ${provider}. Open the extension options and add one.`,
    );
  }
  if (!model) {
    throw new PlannerError(`No model chosen for ${provider}. Pick one in the extension options.`);
  }

  return provider === "anthropic"
    ? createAnthropicPlanner(apiKey, model)
    : createOpenAIPlanner(provider, apiKey, model);
}

export type { Planner };
export { PlannerError };

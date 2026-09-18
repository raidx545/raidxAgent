import { toMessages } from "../src/background/providers/anthropic";
import { THINKING_BUDGET } from "../src/background/providers/types";
import type { ConvMessage } from "../src/background/providers/types";

/**
 * Carrying the model's reasoning across a tool-use exchange.
 *
 * With extended thinking on, Anthropic returns thinking blocks alongside the
 * tool calls, and every one of them has to come back unmodified on the next
 * request - the signature is checked. A turn that drops them is rejected, so
 * the failure mode is not "slightly worse reasoning", it is a run that dies at
 * the second step with an API error.
 *
 * They also have to come *first* in the assistant turn, before any text or
 * tool_use block.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

const thinking = {
  type: "thinking",
  thinking: "The compose dialog is open, so the To field should be in the tree.",
  signature: "sig-abc123",
};

const conversation: ConvMessage[] = [
  { role: "user", content: "write a mail" },
  {
    role: "assistant",
    text: "Opening compose.",
    toolCalls: [{ id: "call_1", name: "navigate", input: { url: "https://mail.google.com" } }],
    reasoning: [thinking],
  },
  { role: "tool", results: [{ id: "call_1", content: "Navigated." }] },
];

const built = toMessages(conversation);
const assistant = built[1];
const content = assistant.content as unknown as Array<Record<string, unknown>>;

// -------------------------------------------------------- the blocks survive

want(Array.isArray(content), "the assistant turn collapsed to a bare string");
want(
  content.some((b) => b.type === "thinking" && b.signature === "sig-abc123"),
  "the thinking block was dropped — the next request would be rejected",
);

// -------------------------------------------------------------- and go first

want(content[0]?.type === "thinking", `a ${String(content[0]?.type)} block came before thinking`);

// ------------------------------------------------- unmodified, not rebuilt

const returned = content.find((b) => b.type === "thinking");
want(
  returned?.thinking === thinking.thinking && returned?.signature === thinking.signature,
  "the thinking block was altered on the way back — the signature check will fail",
);

// ---------------------------------------------- and the rest still comes too

want(content.some((b) => b.type === "text"), "the assistant's prose was lost");
want(
  content.some((b) => b.type === "tool_use" && b.id === "call_1"),
  "the tool call was lost",
);

// ------------------------------------- a turn with no reasoning still works
//
// Thinking is a setting, and the two providers that have no such concept must
// keep producing well-formed turns.

const plain = toMessages([
  { role: "user", content: "hello" },
  { role: "assistant", text: "hi", toolCalls: [] },
]);
const plainContent = plain[1].content as unknown as Array<Record<string, unknown>>;
want(plainContent.length === 1 && plainContent[0].type === "text",
  "a turn without reasoning gained blocks it should not have");

// An assistant turn that is empty in every respect still must not be empty.
const empty = toMessages([
  { role: "user", content: "hello" },
  { role: "assistant", text: "", toolCalls: [] },
]);
want((empty[1].content as unknown[]).length > 0, "an empty assistant turn stayed empty");

// -------------------------------------------------------------- the budgets

want(THINKING_BUDGET.off === 0, "the off setting still buys reasoning tokens");
want(THINKING_BUDGET.standard > 1024, "the standard budget is below Anthropic's minimum");
want(THINKING_BUDGET.deep > THINKING_BUDGET.standard, "deep does not think harder than standard");

// ------------------------------------------------- the custom OpenAI-compatible provider
//
// "custom" is any server speaking OpenAI's chat-completions API: a gateway, a
// self-hosted model, or Ollama / LM Studio on localhost. Nothing about it is
// known in advance, so the two things it cannot work without - a base URL and a
// model id - have to be refused clearly, while the one thing a local server
// genuinely does not need - a key - must not be demanded.

{
  const { createPlanner, PlannerError } = await import("../src/background/providers/index");
  const { normaliseSettings } = await import("../src/shared/types");

  const custom = (over: Record<string, unknown> = {}) =>
    normaliseSettings({
      provider: "custom",
      customBaseUrl: "http://localhost:11434/v1",
      models: { custom: "llama3.2" },
      apiKeys: { custom: "" },
      ...over,
    });

  const refusal = (settings: unknown): string => {
    try {
      createPlanner(settings as never);
      return "";
    } catch (error) {
      return error instanceof PlannerError ? error.message : `wrong error type: ${String(error)}`;
    }
  };

  // A local server needs no key, and demanding one would make Ollama unusable.
  const planner = createPlanner(custom());
  want(!!planner, "a custom provider with no key was refused");
  // The label names the host, because the wire log's job is to say where the
  // bytes went - "Custom llama3.2" would not answer that.
  want(planner.label.includes("localhost:11434"),
    `the label does not name the host: ${planner.label}`);
  want(planner.label.includes("llama3.2"), `the label does not name the model: ${planner.label}`);

  want(/base URL/i.test(refusal(custom({ customBaseUrl: "" }))),
    `no base URL was not refused clearly: ${refusal(custom({ customBaseUrl: "" }))}`);
  want(/model/i.test(refusal(custom({ models: { custom: "" } }))),
    "a missing model id was not refused clearly");

  // The other three still require a key - only "custom" is exempt.
  want(/API key/i.test(refusal(normaliseSettings({ provider: "openai" }))),
    "OpenAI without a key was not refused");
  want(/API key/i.test(refusal(normaliseSettings({ provider: "anthropic" }))),
    "Anthropic without a key was not refused");

  // A key, when given, is used rather than ignored.
  want(!!createPlanner(custom({ apiKeys: { custom: "sk-test" } })),
    "a custom provider with a key was refused");
}

console.log(JSON.stringify({
  assistantBlockOrder: content.map((b) => b.type),
  budgets: THINKING_BUDGET,
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

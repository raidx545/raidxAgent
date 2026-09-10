import Anthropic from "@anthropic-ai/sdk";
import type {
  ConvMessage,
  Planner,
  PlannerRequest,
  PlannerTurn,
  StopReason,
  ToolSpec,
} from "./types";
import { PlannerError, THINKING_BUDGET, parseArguments } from "./types";

/** Splits a PNG data URL into the parts the API wants. */
function imageBlock(dataUrl: string): Anthropic.ImageBlockParam | undefined {
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) return undefined;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: match[1] as "image/png",
      data: match[2],
    },
  };
}

export function toMessages(messages: ConvMessage[]): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    if (message.role === "user") {
      return { role: "user", content: message.content };
    }

    if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      // Thinking blocks come first and must be byte-identical to what the model
      // produced - the signature is checked. A tool-use turn that drops them is
      // rejected outright, which is why they are carried through the loop.
      for (const block of message.reasoning ?? []) {
        content.push(block as Anthropic.ContentBlockParam);
      }
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      // An assistant turn cannot be empty.
      if (content.length === 0) content.push({ type: "text", text: "(no output)" });
      return { role: "assistant", content };
    }

    return {
      role: "user",
      content: message.results.map(
        (result): Anthropic.ToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: result.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        }),
      ),
    };
  });
}

function toTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));
}

function toStopReason(raw: string | null): StopReason {
  if (raw === "tool_use") return "tool_use";
  if (raw === "max_tokens") return "max_tokens";
  if (raw === "refusal") return "refusal";
  return "end_turn";
}

export function createAnthropicPlanner(apiKey: string, model: string): Planner {
  const client = new Anthropic({
    apiKey,
    // The extension is the client; there is no server of ours to proxy through.
    dangerouslyAllowBrowser: true,
  });

  return {
    label: `Anthropic ${model}`,

    async run({ system, messages, tools, signal, onText, image, effort = "standard" }: PlannerRequest): Promise<PlannerTurn> {
      const built = toMessages(messages);

      // Attach the screenshot to the newest user turn, so the model sees the
      // page as it looks now rather than as it looked several steps ago.
      if (image) {
        const block = imageBlock(image);
        const last = built[built.length - 1];
        if (block && last?.role === "user") {
          const content = typeof last.content === "string"
            ? [{ type: "text" as const, text: last.content }]
            : [...last.content];
          // Image first: the model reads it as context for the text that follows.
          built[built.length - 1] = { role: "user", content: [block, ...content] };
        }
      }

      // Extended thinking, when asked for. The budget is reasoning tokens the
      // model spends working out its approach before it commits to a tool
      // call - which is exactly the step that was missing when it clicked the
      // same button four times without ever asking why the first three did
      // nothing. max_tokens has to cover the budget as well as the reply.
      const budget = THINKING_BUDGET[effort];
      const thinking: Anthropic.ThinkingConfigParam | undefined =
        budget > 0 ? { type: "enabled", budget_tokens: budget } : undefined;

      const stream = client.messages.stream(
        {
          model,
          max_tokens: 8000 + budget,
          system,
          tools: toTools(tools),
          messages: built,
          ...(thinking ? { thinking } : {}),
        },
        { signal },
      );

      stream.on("text", onText);

      let response: Anthropic.Message;
      try {
        response = await stream.finalMessage();
      } catch (error) {
        throw describe(error);
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      const toolCalls = response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: parseArguments(block.input),
        }));

      // Kept opaque and handed straight back on the next request.
      const reasoning = response.content.filter(
        (block) => block.type === "thinking" || block.type === "redacted_thinking",
      );

      return {
        text,
        toolCalls,
        ...(reasoning.length > 0 ? { reasoning } : {}),
        stopReason: toStopReason(response.stop_reason),
        refusal:
          response.stop_reason === "refusal"
            ? (response.stop_details?.category ?? "unspecified")
            : undefined,
      };
    },
  };
}

function describe(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new PlannerError("Anthropic rejected your API key. Check it in the extension options.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new PlannerError("Anthropic rate-limited this request. Wait a moment and retry.");
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new PlannerError(
      "Anthropic does not recognise that model id. Pick another one in the extension options.",
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new PlannerError(`Anthropic API error ${error.status}: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

import type {
  AgentEvent,
  PageSnapshot,
  Settings,
  TranscriptEntry,
} from "../shared/types";
import { SYSTEM_PROMPT, taskPrompt } from "./prompt";
import { TOOLS, PAGE_ACTIONS } from "./tools";
import { TabController, execute, isRestricted } from "./executor";
import { detectInjection, gate } from "./safety";
import { createPlanner } from "./providers";
import type { ConvMessage, ToolOutcome } from "./providers/types";

let counter = 0;
const nextId = () => `e${++counter}`;

/** Compact page rendering. This is the only view of the page the model gets. */
function renderSnapshot(snapshot: PageSnapshot): string {
  const lines = snapshot.elements.map((el) => {
    const parts = [`[${el.id}] ${el.role}`];
    if (el.name) parts.push(JSON.stringify(el.name));
    if (el.value) parts.push(`= ${JSON.stringify(el.value)}`);
    const attrs = el.attrs
      ? Object.entries(el.attrs)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      : "";
    if (attrs) parts.push(`(${attrs})`);
    return parts.join(" ");
  });

  return [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Scroll: ${snapshot.scroll.y} of ${snapshot.scroll.maxY}`,
    "",
    `Elements${snapshot.truncated ? " (list truncated — scroll for more)" : ""}:`,
    ...lines,
    "",
    "Page text:",
    snapshot.text,
  ].join("\n");
}

export interface AgentDeps {
  settings: Settings;
  emit: (event: AgentEvent) => void;
  /** Resolves true when the user approves a gated action. */
  askConfirm: (id: string, summary: string) => Promise<boolean>;
  signal: AbortSignal;
}

/**
 * Runs one task to completion: perceive, plan, act, verify, repeat, until the
 * model stops calling tools or a limit is reached.
 */
export async function runTask(
  task: string,
  startTabId: number,
  deps: AgentDeps,
): Promise<void> {
  const { settings, emit, askConfirm, signal } = deps;

  const planner = createPlanner(settings);

  let controller = new TabController(startTabId);
  const tab = await chrome.tabs.get(startTabId);

  if (isRestricted(tab.url)) {
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "error",
        text: `I can't work on ${tab.url} — Chrome blocks extensions on its own pages. Open a normal website and try again.`,
      },
    });
    return;
  }

  emit({
    kind: "entry",
    entry: { id: nextId(), role: "system", text: `Using ${planner.label}.` },
  });

  await controller.waitForLoad();
  let snapshot = await controller.snapshot();

  const messages: ConvMessage[] = [
    {
      role: "user",
      content:
        taskPrompt(task, tab.url ?? "", tab.title ?? "") +
        (snapshot ? `\n\n--- Current page ---\n${renderSnapshot(snapshot)}` : ""),
    },
  ];

  if (snapshot) warnIfInjected(snapshot, emit);

  for (let step = 0; step < settings.maxSteps; step++) {
    if (signal.aborted) return;

    // Stream so the user sees reasoning as it arrives rather than staring at a
    // spinner for the length of a long turn.
    const entryId = nextId();
    let opened = false;

    const onText = (delta: string): void => {
      if (!opened) {
        opened = true;
        emit({ kind: "entry", entry: { id: entryId, role: "assistant", text: delta } });
      } else {
        emit({ kind: "patch", id: entryId, text: delta });
      }
    };

    let turn;
    try {
      turn = await planner.run({
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
        signal,
        onText,
      });
    } catch (error) {
      if (signal.aborted) return;
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

    if (turn.stopReason === "refusal") {
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: `The model declined this request (${turn.refusal ?? "unspecified"}).`,
        },
      });
      return;
    }

    // No tools left to call — the model has given its final answer.
    if (turn.toolCalls.length === 0) return;

    const results: ToolOutcome[] = [];

    for (const call of turn.toolCalls) {
      if (signal.aborted) return;

      const action = { name: call.name as never, input: call.input };
      const stepId = nextId();

      emit({
        kind: "entry",
        entry: {
          id: stepId,
          role: "step",
          action: call.name as never,
          text: describeIntent(call.name, call.input),
          pending: true,
        },
      });

      const decision = gate(action, snapshot, settings.confirmRisky);

      if (decision.verdict === "refuse") {
        emit({ kind: "patch", id: stepId, text: `Blocked — ${decision.reason}`, pending: false });
        results.push({ id: call.id, content: decision.reason, isError: true });
        continue;
      }

      if (decision.verdict === "confirm") {
        const approved = await askConfirm(stepId, decision.summary);
        if (!approved) {
          emit({ kind: "patch", id: stepId, text: "Declined by user.", pending: false });
          results.push({
            id: call.id,
            isError: true,
            content:
              "The user declined this action. Do not retry it. Ask them what they want instead, or continue with the rest of the task.",
          });
          continue;
        }
      }

      const outcome = await execute(controller, action);
      controller = outcome.controller;
      const { result } = outcome;

      emit({ kind: "patch", id: stepId, text: result.detail, pending: false });

      // Verify: re-perceive after anything that could have changed the page, so
      // the next turn plans against reality instead of against stale ids.
      let observation = result.detail;
      const mayHaveChanged = PAGE_ACTIONS.has(call.name)
        ? call.name !== "find_text" && call.name !== "wait"
        : true;

      if (mayHaveChanged) {
        const fresh = result.snapshot ?? (await controller.snapshot());
        if (fresh) {
          const navigated = snapshot && fresh.url !== snapshot.url;
          snapshot = fresh;
          warnIfInjected(fresh, emit);
          observation +=
            (navigated ? "\n\nThe page navigated." : "") +
            `\n\n--- Page after this action ---\n${renderSnapshot(fresh)}`;
        }
      }

      results.push({ id: call.id, content: observation, isError: !result.ok });
    }

    messages.push({ role: "tool", results });
  }

  emit({
    kind: "entry",
    entry: {
      id: nextId(),
      role: "error",
      text: `Stopped after ${settings.maxSteps} steps without finishing. Narrow the task, or raise the step limit in options.`,
    },
  });
}

let lastWarned = "";
function warnIfInjected(snapshot: PageSnapshot, emit: (e: AgentEvent) => void): void {
  const found = detectInjection(snapshot);
  if (!found || found === lastWarned) return;
  lastWarned = found;
  emit({
    kind: "entry",
    entry: {
      id: nextId(),
      role: "system",
      text: `Heads up: this page contains text addressed to an AI agent — "${found.slice(0, 120)}". I'm treating it as page content, not as an instruction.`,
    },
  });
}

function describeIntent(name: string, input: Record<string, unknown>): string {
  const reason = typeof input.reason === "string" ? input.reason : "";
  switch (name) {
    case "click":
      return reason || `Click element ${input.element_id}`;
    case "type":
      return reason || `Type into element ${input.element_id}`;
    case "navigate":
      return `Go to ${input.url}`;
    case "open_tab":
      return `Open ${input.url} in a new tab`;
    case "read_page":
      return "Read the page";
    case "scroll":
      return `Scroll ${input.direction}`;
    case "find_text":
      return `Look for "${input.query}"`;
    default:
      return reason || name.replace(/_/g, " ");
  }
}

export type { TranscriptEntry };

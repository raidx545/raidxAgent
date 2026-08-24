import type { AgentEvent, Settings, TranscriptEntry } from "../shared/types";
import type { Capture, DomCapture } from "../capture/types";
import { walkCapture } from "../capture/dom";
import { alignTask, renderPage } from "./wire";
import { SYSTEM_PROMPT, taskPrompt } from "./prompt";
import { TOOLS, PAGE_ACTIONS } from "./tools";
import { TabController, execute, isRestricted } from "./executor";
import { captureTab } from "./inspect";
import { detectInjection, gate } from "./safety";
import { createPlanner } from "./providers";
import type { ConvMessage, ToolOutcome } from "./providers/types";
import { sanitize, sanitizeText, type SanitizedCapture } from "../sanitize/sanitize";
import { recordWire, tokensIn } from "./wirelog";
import { scanText } from "../pii/detect";
import type { RemoteVault } from "../vault/remote";
import { remoteSource } from "../vault/remote";
import type { SpanRectRequest, SpanRectResult } from "../capture/spans";

let counter = 0;
const nextId = () => `e${++counter}`;

export interface AgentDeps {
  settings: Settings;
  emit: (event: AgentEvent) => void;
  askConfirm: (id: string, summary: string) => Promise<boolean>;
  signal: AbortSignal;
  /** The session vault. Shared across turns so tokens stay stable. */
  vault: RemoteVault;
}

/**
 * Runs one task to completion: perceive, sanitize, plan, act, verify, repeat.
 *
 * The sanitization step is not optional and not a filter bolted on the end. The
 * planner is never shown a raw page - `perceive` and `sanitize` are the same
 * step from its point of view, and there is no code path that renders an
 * unsanitized capture into a message.
 */
export async function runTask(
  task: string,
  startTabId: number,
  deps: AgentDeps,
): Promise<void> {
  const { settings, emit, askConfirm, signal, vault } = deps;

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
    entry: {
      id: nextId(),
      role: "system",
      text: `Using ${planner.label}. Page content is tokenized before it leaves this browser.`,
    },
  });

  /** Ids the planner has actually been shown; anything else is not real. */
  let issuedIds = new Set<number>();
  let current: SanitizedCapture | undefined;

  const perceive = async (): Promise<SanitizedCapture | undefined> => {
    const raw = await captureTab(controller.tabId, { fullPage: settings.fullPageCapture });
    if (!raw.dom) return undefined;

    if (detectInjection(raw.dom)) {
      warnInjected(raw.dom, emit);
    }

    const sanitized = await sanitizeCapture(raw, controller, vault);
    issuedIds = new Set([...walkCapture(sanitized.dom.root)].map((n) => n.id));
    current = sanitized;
    return sanitized;
  };

  const first = await perceive();
  if (!first) {
    emit({
      kind: "entry",
      entry: { id: nextId(), role: "error", text: "The page did not respond to the capture." },
    });
    return;
  }

  reportSanitization(first, emit);

  // The task is tokenized in the same vault as the page.
  //
  // Without this the whole scheme collapses: the planner would be told to
  // "forward the invoice from Sharma Traders" while the page says <ORG_3>, and
  // it could never connect the two. Tokens only work as join keys when both
  // sides of the join go through the same vault.
  // Two different jobs, in this order.
  //
  // Aligning replaces values the page already showed, so both sides of the
  // join carry one token. Sanitizing then catches identifiers the user typed
  // that the page never had - those have no token to align with, and they
  // reach the model exactly like page content does.
  const aligned = alignTask(task, await vault.knownValues());
  const scanned = await sanitizeText(aligned, remoteSource(vault));
  const tokenizedTask = scanned.text;

  if (scanned.findings.length > 0) {
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text:
          `Your request contained ${scanned.findings.length} value(s) worth protecting ` +
          `(${[...new Set(scanned.findings.map((f) => f.kind))].join(", ")}). ` +
          `They were tokenized before the request left this browser.`,
      },
    });
  }

  if (tokenizedTask !== task) {
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text: `Your request mentions details that are on the page; both now read the same token. The model sees: ${tokenizedTask}`,
      },
    });
  }

  const messages: ConvMessage[] = [
    {
      role: "user",
      content:
        taskPrompt(tokenizedTask, first.dom.url, first.dom.title) +
        `\n\n--- Current page ---\n${renderPage(first.dom)}`,
    },
  ];

  for (let step = 0; step < settings.maxSteps; step++) {
    if (signal.aborted) return;

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

    // Record what is about to leave, and check it one more time.
    //
    // Everything upstream has already sanitized this. Scanning again here is
    // the point: it is the last moment before the bytes go, it runs on the real
    // page rather than a fixture, and if it ever finds something the user is
    // told immediately rather than after the fact.
    const outgoing = messages
      .map((m) =>
        m.role === "user"
          ? { role: "user", text: m.content }
          : m.role === "assistant"
            ? { role: "assistant", text: m.text || "(tool calls only)" }
            : { role: "tool", text: m.results.map((r) => r.content).join("\n---\n") },
      );
    const wireText = outgoing.map((m) => m.text).join("\n");
    const leaked = await scanText(wireText);
    const image = settings.sendScreenshot ? current?.screenshot?.dataUrl : undefined;

    recordWire({
      turn: step + 1,
      destination: planner.label,
      systemChars: SYSTEM_PROMPT.length,
      messages: outgoing,
      image: image ? { dataUrl: image, bytes: image.length } : undefined,
      tokens: tokensIn(wireText),
      leaked,
      totalChars: SYSTEM_PROMPT.length + wireText.length,
    });

    if (leaked.length > 0) {
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text:
            `⚠ ${leaked.length} value(s) reached the outgoing payload unsanitized ` +
            `(${[...new Set(leaked.map((f) => f.kind))].join(", ")}). ` +
            `Open the wire log to see exactly what was sent.`,
        },
      });
    }

    let turn;
    try {
      turn = await planner.run({
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
        signal,
        onText,
        // The redacted screenshot, when there is one. Faces are destroyed and
        // tokenized text is painted over with the same token the tree uses.
        image,
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

    if (turn.toolCalls.length === 0) {
      // The final answer may name tokens; the user should see real values.
      if (turn.text) await revealForUser(turn.text, entryId, vault, emit);
      return;
    }

    const results: ToolOutcome[] = [];

    for (const call of turn.toolCalls) {
      if (signal.aborted) return;

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

      // -- 1. the element must be one we actually showed it -----------------
      const targeted = call.input.element_id;
      if (typeof targeted === "number" && !issuedIds.has(targeted)) {
        const reason =
          `There is no element ${targeted} on this page. Element ids are only valid ` +
          `for the most recent page read — call read_page and use the new ids.`;
        emit({ kind: "patch", id: stepId, text: `Rejected — ${reason}`, pending: false });
        results.push({ id: call.id, content: reason, isError: true });
        continue;
      }

      // -- 2. the safety gate, against the page the model was shown ---------
      const action = { name: call.name as never, input: call.input };
      const decision = gate(action, current?.dom, settings.confirmRisky);

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

      // -- 3. resolve tokens, at the last possible moment -------------------
      const resolved = await resolveInputs(call.input, vault);
      if (resolved.unknown.length > 0) {
        const reason =
          `Refusing: ${resolved.unknown.join(", ")} ${resolved.unknown.length === 1 ? "is" : "are"} ` +
          `not a token this browser issued. Only use tokens exactly as they appear on the page.`;
        emit({ kind: "patch", id: stepId, text: `Blocked — ${reason}`, pending: false });
        results.push({ id: call.id, content: reason, isError: true });
        continue;
      }
      if (resolved.sealed.length > 0) {
        const reason =
          `${resolved.sealed.join(", ")} stands for a value this browser deliberately never read, ` +
          `such as a password. There is nothing behind it. Ask the user to fill that field themselves.`;
        emit({ kind: "patch", id: stepId, text: `Blocked — ${reason}`, pending: false });
        results.push({ id: call.id, content: reason, isError: true });
        continue;
      }

      const outcome = await execute(controller, { name: call.name as never, input: resolved.input });
      controller = outcome.controller;
      const { result } = outcome;

      emit({ kind: "patch", id: stepId, text: result.detail, pending: false });

      // -- 4. verify: re-perceive, sanitized, so ids stay in step -----------
      let observation = result.detail;
      const mayHaveChanged = PAGE_ACTIONS.has(call.name)
        ? call.name !== "find_text" && call.name !== "wait"
        : true;

      if (mayHaveChanged) {
        const fresh = await perceive();
        if (fresh) {
          const navigated = fresh.dom.url !== current?.dom.url;
          observation +=
            (navigated ? "\n\nThe page navigated." : "") +
            `\n\n--- Page after this action ---\n${renderPage(fresh.dom)}`;
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

/** Runs the sanitizer, wiring rect resolution back to the page. */
async function sanitizeCapture(
  raw: Capture,
  controller: TabController,
  vault: RemoteVault,
): Promise<SanitizedCapture> {
  const resolveRects = (requests: SpanRectRequest[]): Promise<SpanRectResult[]> =>
    controller.spanRects(requests);

  return sanitize(raw, remoteSource(vault), undefined, resolveRects);
}

/** Swaps tokens back for real values in every string the planner supplied. */
async function resolveInputs(
  input: Record<string, unknown>,
  vault: RemoteVault,
): Promise<{ input: Record<string, unknown>; unknown: string[]; sealed: string[] }> {
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  const sealed: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" || !value.includes("<")) {
      out[key] = value;
      continue;
    }
    const result = await vault.resolve(value);
    out[key] = result.text;
    unknown.push(...result.unknown);
    sealed.push(...result.sealed);
  }

  return { input: out, unknown: [...new Set(unknown)], sealed: [...new Set(sealed)] };
}

/**
 * Puts real values back into the answer shown to the user.
 *
 * Three kinds of placeholder can appear, and they need different endings:
 *
 *   a token this vault issued  -> the real value, which is the whole point
 *   a sealed token             -> there is no value; say so in words, because
 *                                 "<SECRET_10>" on screen reads as a bug
 *   a token we never issued    -> the model invented it; flag it rather than
 *                                 quietly leaving it, since an invented
 *                                 placeholder means an invented claim
 */
async function revealForUser(
  text: string,
  entryId: string,
  vault: RemoteVault,
  emit: (event: AgentEvent) => void,
): Promise<void> {
  if (!text.includes("<")) return;

  const { text: resolved, unknown, sealed } = await vault.resolve(text);

  let shown = resolved;
  for (const token of sealed) {
    shown = shown.split(token).join("(not captured — you would need to enter this yourself)");
  }
  for (const token of unknown) {
    shown = shown.split(token).join("(unrecognised placeholder)");
  }

  if (shown !== text) {
    emit({ kind: "patch", id: entryId, text: shown, replace: true });
  }

  if (unknown.length > 0) {
    emit({
      kind: "entry",
      entry: {
        id: nextId(),
        role: "system",
        text:
          `The answer referred to ${unknown.join(", ")}, which this browser never issued. ` +
          `That part of the answer is not backed by anything on the page — treat it with suspicion.`,
      },
    });
  }
}

function reportSanitization(capture: SanitizedCapture, emit: (e: AgentEvent) => void): void {
  const r = capture.report;
  const swapped = r.tokenize.spansReplaced + r.tokenize.fieldsReplaced;
  const bits = [`${swapped} value(s) tokenized`, `${r.tokenize.fieldsSealed} sealed`];
  if (r.redact.regionsBurned > 0) bits.push(`${r.redact.regionsBurned} image region(s) destroyed`);
  if (r.redact.textSpansCovered > 0) {
    bits.push(`${r.redact.textSpansCovered} text span(s) painted over in the screenshot`);
  }
  if (r.residual.length > 0) {
    bits.push(`⚠ ${r.residual.length} finding(s) survived sanitization`);
  }
  emit({ kind: "entry", entry: { id: nextId(), role: "system", text: bits.join(" · ") } });
}

let lastWarned = "";
function warnInjected(capture: DomCapture, emit: (e: AgentEvent) => void): void {
  const found = detectInjection(capture);
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

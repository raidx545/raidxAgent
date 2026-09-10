import type { AgentEvent, Settings, TranscriptEntry } from "../shared/types";
import type { Capture, DomCapture } from "../capture/types";
import { walkCapture } from "../capture/dom";
import { alignTask, pageBlock, pruneStalePages, renderPage } from "./wire";
import { SYSTEM_PROMPT, taskPrompt } from "./prompt";
import { TOOLS, PAGE_ACTIONS } from "./tools";
import { TabController, execute, isRestricted } from "./executor";
import { captureTab } from "./inspect";
import { detectInjection, gate } from "./safety";
import { createPlanner } from "./providers";
import type { ConvMessage, ToolOutcome } from "./providers/types";
import { DEFAULT_POLICY, sanitize, sanitizeText, type SanitizedCapture } from "../sanitize/sanitize";
import { remoteOcr } from "./ocr-remote";
import { recordWire, tokensIn } from "./wirelog";
import { scanText } from "../pii/detect";
import type { RemoteVault } from "../vault/remote";
import { remoteSource } from "../vault/remote";
import type { SpanRectRequest, SpanRectResult } from "../capture/spans";

/**
 * Entry ids, unique for the life of this worker *instantiation*.
 *
 * A bare counter was not. Chrome terminates an idle MV3 service worker
 * whenever it likes, and the counter restarted at one while the side panel -
 * a separate document that stays open - kept every node it had already
 * rendered under those ids. The next task's `e1` collided with the previous
 * task's `e1`, and the panel wrote an assistant's prose into a step's grid,
 * which laid it out two characters per line near the top of the transcript.
 *
 * The nonce makes a collision across a restart impossible; the panel also
 * refuses to reuse a node whose role changed, so neither half relies on the
 * other being correct.
 */
const RUN_NONCE = Math.random().toString(36).slice(2, 8);
let counter = 0;
const nextId = () => `e${RUN_NONCE}-${++counter}`;

/** One earlier task in this session, and how it ended. */
export interface TaskMemory {
  task: string;
  answer: string;
}

export interface AgentDeps {
  settings: Settings;
  emit: (event: AgentEvent) => void;
  askConfirm: (id: string, summary: string) => Promise<boolean>;
  /** Puts a question to the user; resolves undefined if nobody answers. */
  askUser: (id: string, question: string) => Promise<string | undefined>;
  signal: AbortSignal;
  /** The session vault. Shared across turns so tokens stay stable. */
  vault: RemoteVault;
  /**
   * What happened earlier in this session, newest last.
   *
   * Without it every task starts from nothing, and "now send it to him as well"
   * has no him. The vault is shared across the session, so a token in an
   * earlier answer still names the same thing now.
   */
  history?: TaskMemory[];
}

/**
 * The fingerprint of an action, for spotting one being repeated.
 *
 * The planner's `reason` is deliberately left out. It is free text the model
 * rewrites every time - "open compose", "click the Compose button", "try
 * Compose again" - so including it made four identical clicks look like four
 * different actions, and the guard that exists to stop exactly that never
 * fired. Key order is normalised for the same reason.
 */
export function actionSignature(
  name: string,
  input: Record<string, unknown>,
  url: string,
): string {
  const { reason: _reason, ...rest } = input;
  const keys = Object.keys(rest).sort();
  return `${name} ${JSON.stringify(rest, keys)} @ ${url}`;
}

/** How many recent actions to remember for the repeat guard. */
const RECENT_LIMIT = 24;

/**
 * Actions that only look at the page. These neither reset the scroll budget
 * nor count as a repeat - a planner may legitimately read the page twice while
 * working out what to do inside a dialog.
 */
const LOOKING_AROUND = new Set(["read_page", "find_text", "wait", "list_tabs", "ask_user"]);

/** Scrolls allowed in a row before the agent is told to try something else. */
export const SCROLL_LIMIT = 8;

/**
 * How an action counts against the scroll budget.
 *
 * The repeat guard cannot police scrolling, and the reason is structural: it
 * fires when an action repeats *and the page did not change*, but a scroll
 * always changes the page, which clears the guard's memory. So scrolling gets
 * its own budget, and this decides what spends and what refills it:
 *
 *   "scroll" - spends one
 *   "look"   - spends nothing and refills nothing; reading the page is how you
 *              decide where to scroll next, so if it refilled the budget,
 *              interleaving one read per scroll would make the cap unreachable
 *   "act"    - refills it; doing something real is progress
 */
export function scrollBudgetEffect(name: string): "scroll" | "look" | "act" {
  if (name === "scroll") return "scroll";
  return LOOKING_AROUND.has(name) ? "look" : "act";
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
): Promise<string | undefined> {
  const { settings, emit, askConfirm, askUser, signal, vault, history = [] } = deps;

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
  /** How many messages the send-time scan has already covered. */
  let scannedUpTo = 0;
  /**
   * The last few actions, so a stuck agent is stopped rather than left running.
   *
   * Repeating one action that changes nothing is the classic browser-agent
   * failure: the model acts, sees a page it cannot distinguish from the one
   * before, and concludes the action did not happen. Whatever the cause - an
   * element that moved, a render budget that hid the result, a page that
   * genuinely ignored the click - burning the step limit on it helps nobody.
   */
  const recentActions: string[] = [];
  const REPEAT_LIMIT = 3;
  /**
   * Scrolls since the last action that did something other than look around.
   *
   * The repeat guard cannot see a scroll loop, and the reason is structural: it
   * fires when an action is repeated *and the page did not change*, but a scroll
   * always changes the page, which clears the guard's memory. So an agent that
   * scrolls a hundred pixels at a time down a three-thousand-pixel page burns
   * thirty steps and never trips anything - which is exactly what "mark all
   * unread emails as read" did.
   *
   * Scrolling needs its own budget: any page is covered in a handful of
   * screens, and past that the answer is not further down, it is that the
   * approach is wrong.
   */
  let scrollsSinceAct = 0;
  let lastPageSignature = "";
  let current: SanitizedCapture | undefined;

  const perceive = async (): Promise<SanitizedCapture | undefined> => {
    // The tab can be closed, navigated to a browser page, or crash while a
    // task is running. Each of those threw an unhandled error mid-loop before;
    // they are ordinary events and should end the task with a sentence.
    let raw;
    try {
      raw = await captureTab(controller.tabId, {
        fullPage: settings.fullPageCapture,
        // No image is going to the planner, so do not take, align or redact
        // one. This was the slowest part of every step when the setting was
        // off, and all of it was thrown away.
        screenshot: settings.sendScreenshot,
      });
    } catch (error) {
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text: `Lost the page: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      return undefined;
    }
    if (!raw.dom) return undefined;

    if (detectInjection(raw.dom)) {
      warnInjected(raw.dom, emit);
    }

    const sanitized = await sanitizeCapture(raw, controller, vault, settings);
    issuedIds = new Set([...walkCapture(sanitized.dom.root)].map((n) => n.id));

    // A page that actually changed clears the repeat memory: repeating an
    // action is only a problem when nothing came of it.
    const signature = renderPage(sanitized.dom);
    if (signature !== lastPageSignature) {
      lastPageSignature = signature;
      recentActions.length = 0;
    }

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
        taskPrompt(tokenizedTask, first.dom.url, first.dom.title, history) + pageBlock(first.dom),
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
    // Only the newest page survives into the payload. Nine stale copies are
    // both the bulk of the cost and the likeliest source of a wrong click.
    const pruned = pruneStalePages(messages);

    const outgoing = pruned
      .map((m) =>
        m.role === "user"
          ? { role: "user", text: m.content }
          : m.role === "assistant"
            ? { role: "assistant", text: m.text || "(tool calls only)" }
            : { role: "tool", text: m.results.map((r) => r.content).join("\n---\n") },
      );
    const wireText = outgoing.map((m) => m.text).join("\n");

    // Scan only what has not been scanned before. Re-reading the whole history
    // every turn makes the send-time check cost O(turns squared) for no gain -
    // earlier messages were scanned when they were new and have not changed.
    const freshText = outgoing.slice(scannedUpTo).map((m) => m.text).join("\n");
    scannedUpTo = outgoing.length;
    const leaked = await scanText(freshText);
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
            `⚠ ${leaked.length} value(s) reached the outgoing payload unsanitized: ` +
            leaked.map((f) => `${f.kind} ${f.masked}`).join(", ") +
            `. Open the wire log — this turn is flagged there with the exact text.`,
        },
      });
    }

    let turn;
    try {
      turn = await planner.run({
        system: SYSTEM_PROMPT,
        messages: pruned,
        tools: TOOLS,
        signal,
        onText,
        // The redacted screenshot, when there is one. Faces are destroyed and
        // tokenized text is painted over with the same token the tree uses.
        image,
        effort: settings.reasoningEffort,
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

    messages.push({
      role: "assistant",
      text: turn.text,
      toolCalls: turn.toolCalls,
      // Carried, never inspected: the next request has to hand these back.
      ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
    });

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

    if (turn.stopReason === "max_tokens" && turn.toolCalls.length === 0) {
      // The model ran out of room mid-thought. Treating that as a finished
      // answer would silently present a truncated result as a complete one.
      emit({
        kind: "entry",
        entry: {
          id: nextId(),
          role: "error",
          text:
            "The model hit its output limit before finishing this step. " +
            "The reply above is cut off — narrow the task, or reduce how much of the page is in view.",
        },
      });
      return;
    }

    if (turn.toolCalls.length === 0) {
      // The final answer may name tokens; the user should see real values.
      if (turn.text) await revealForUser(turn.text, entryId, vault, emit);
      // Returned in tokenized form: the next task in this session is tokenized
      // through the same vault, so the two will agree on names.
      return turn.text || undefined;
    }

    const results: ToolOutcome[] = [];

    /**
     * Whether an action this turn may have changed the page.
     *
     * The model sometimes emits several tool calls in one turn. Every one of
     * them was planned against the page read *before* the turn, so once the
     * first has changed the page, the rest are aimed at a layout that no longer
     * exists. Re-reading between them does not help: ids are reassigned on every
     * read, and an id that exists in both the old and new numbering passes the
     * "did we issue this" check while now naming a different element - which is
     * how a second click in a turn lands on the wrong thing.
     *
     * So after the first page-changing action, the remaining calls are returned
     * unrun with the new page attached, and the planner plans again from it.
     * One perception per turn, not one per call, is also most of the speed-up.
     */
    let pageDirty = false;
    let dirtiedBy = "";

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

      // -- planned against a page that is gone? -------------------------------
      if (pageDirty) {
        const reason =
          `Not run: the page changed after the ${dirtiedBy} earlier in this turn, so this ` +
          `call was aimed at a layout that no longer exists. The current page is attached ` +
          `to the last result - plan the next step from it. One action per turn is safest.`;
        emit({ kind: "patch", id: stepId, text: "Skipped — the page changed first.", pending: false });
        results.push({ id: call.id, content: reason, isError: true });
        continue;
      }

      // -- a question for the user, not an action on the page ----------------
      if (call.name === "ask_user") {
        const question = String(call.input.question ?? "").trim();
        if (!question) {
          results.push({ id: call.id, content: "ask_user needs a question.", isError: true });
          emit({ kind: "patch", id: stepId, text: "Empty question.", pending: false });
          continue;
        }

        // The question is shown to a person, so it carries real values; the
        // answer goes to the model, so it is tokenized like the task was.
        const { text: shown } = await vault.resolve(question);
        emit({ kind: "patch", id: stepId, text: `Asked: ${shown}`, pending: true });
        const answer = await askUser(stepId, shown);

        if (answer === undefined) {
          emit({ kind: "patch", id: stepId, text: `Asked: ${shown} — no answer.`, pending: false });
          results.push({
            id: call.id,
            isError: true,
            content:
              "The user did not answer. Either finish with what you have and say what you " +
              "were missing, or stop.",
          });
          continue;
        }

        emit({ kind: "patch", id: stepId, text: `Asked: ${shown} — answered.`, pending: false });
        const aligned = alignTask(answer, await vault.knownValues());
        const { text: safeAnswer } = await sanitizeText(aligned, remoteSource(vault));
        results.push({ id: call.id, content: `The user answered: ${safeAnswer}` });
        continue;
      }

      // -- 0a. has this run out of patience for scrolling? -------------------
      const budget = scrollBudgetEffect(call.name);
      if (budget === "scroll") {
        scrollsSinceAct++;
        if (scrollsSinceAct > SCROLL_LIMIT) {
          const reason =
            `Refusing: this is the ${scrollsSinceAct}th scroll in a row without doing anything ` +
            `else. Whatever you are looking for is not further down. Stop scrolling and either ` +
            `act on what is already on screen, use find_text to locate the control by name, go ` +
            `straight to a URL that shows it, or tell the user you cannot find it. If you need ` +
            `to cover ground, scroll a whole screen at a time rather than a hundred pixels.`;
          emit({ kind: "patch", id: stepId, text: "Refused — too much scrolling.", pending: false });
          results.push({ id: call.id, content: reason, isError: true });
          continue;
        }
      } else if (budget === "act") {
        scrollsSinceAct = 0;
      }

      // -- 0. has this exact action just been tried, to no effect? ----------
      //
      // Only actions that are *supposed* to change something are counted.
      // Reading and searching deliberately change nothing, so "the page did not
      // change" says nothing about them - and counting them stopped perfectly
      // sensible runs where the planner read the page a few times while working
      // inside a dialog.
      const readOnly = call.name === "read_page" || call.name === "find_text";
      const signature = actionSignature(call.name, call.input, current?.dom.url ?? "");
      if (!readOnly) {
        recentActions.push(signature);
        if (recentActions.length > RECENT_LIMIT) recentActions.shift();
      }
      const repeats = readOnly ? 0 : recentActions.filter((s) => s === signature).length;

      if (repeats > REPEAT_LIMIT) {
        emit({ kind: "patch", id: stepId, text: "Stopped — this is going in circles.", pending: false });
        emit({
          kind: "entry",
          entry: {
            id: nextId(),
            role: "error",
            text:
              `The same action has been attempted ${repeats} times with no change to the page, ` +
              `so I have stopped rather than keep going. ` +
              `Either the page ignored it, or what it produced is not visible in the part of the ` +
              `page I can see. Try scrolling first, or give me a more specific instruction.`,
          },
        });
        return;
      }

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

      // The transcript is for the user, so it shows the real detail.
      emit({ kind: "patch", id: stepId, text: result.detail, pending: false });

      // The conversation is not. Tool results are built in the page and in the
      // tabs API - element inner text, matched page text, tab titles, full URLs
      // - and none of that has been through the sanitizer. It is a whole
      // channel into the payload that bypassed every other control.
      const safeDetail = await sanitizeDetail(result.detail, vault);

      // -- 4. note whether the page needs re-reading; do it once, below -------
      const mayHaveChanged = PAGE_ACTIONS.has(call.name)
        ? call.name !== "find_text" && call.name !== "wait"
        : call.name !== "list_tabs";
      if (mayHaveChanged) {
        pageDirty = true;
        dirtiedBy = call.name;
      }

      results.push({ id: call.id, content: safeDetail, isError: !result.ok });
    }

    // -- verify: re-perceive once, sanitized, so ids stay in step ------------
    if (pageDirty && results.length > 0) {
      const before = current?.dom.url;
      const fresh = await perceive();
      const last = results[results.length - 1];
      if (fresh) {
        last.content +=
          (fresh.dom.url !== before ? "\n\nThe page navigated." : "") + pageBlock(fresh.dom);
      } else {
        // No page means no ids, so the next turn could only guess. Stop.
        last.content += "\n\nThe page could not be read after this action, so the task cannot continue.";
        last.isError = true;
        messages.push({ role: "tool", results });
        return undefined;
      }
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
  return undefined;
}

/**
 * Sanitizes a tool result before it enters the conversation.
 *
 * Two passes, for the same reason the task needs two: aligning reuses the token
 * a value already has, so the planner keeps seeing one name for one thing;
 * sanitizing then catches anything the page had not shown before.
 */
async function sanitizeDetail(detail: string, vault: RemoteVault): Promise<string> {
  if (!detail) return detail;
  const aligned = alignTask(detail, await vault.knownValues());
  const { text } = await sanitizeText(aligned, remoteSource(vault));
  return text;
}

/** Runs the sanitizer, wiring rect resolution back to the page. */
async function sanitizeCapture(
  raw: Capture,
  controller: TabController,
  vault: RemoteVault,
  settings: Settings,
): Promise<SanitizedCapture> {
  const resolveRects = (requests: SpanRectRequest[]): Promise<SpanRectResult[]> =>
    controller.spanRects(requests);

  // OCR only matters when the picture is going somewhere.
  const policy = { ...DEFAULT_POLICY, ocr: settings.sendScreenshot ? settings.ocrMode : ("off" as const) };
  return sanitize(raw, remoteSource(vault), policy, resolveRects, remoteOcr());
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
    case "ask_user":
      return "Ask you something";
    default:
      return reason || name.replace(/_/g, " ");
  }
}

export type { TranscriptEntry };

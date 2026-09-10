import type {
  AgentEvent,
  PanelCommand,
  Settings,
  TranscriptEntry,
} from "../shared/types";
import { normaliseSettings } from "../shared/types";
import { runTask, type TaskMemory } from "./agent";
import { captureTab } from "./inspect";
import { RemoteVault } from "../vault/remote";
import { wireRecords, clearWire } from "./wirelog";
import { TabController } from "./executor";

// The side panel can be closed and reopened mid-run, so the transcript lives
// here rather than in the panel's own memory.
let transcript: TranscriptEntry[] = [];
let running = false;
let abort: AbortController | null = null;

const pendingConfirms = new Map<string, (approved: boolean) => void>();
const pendingQuestions = new Map<string, (answer: string | undefined) => void>();

/** The question currently waiting on the user, kept as state for the same reason as the confirmation. */
let awaitingQuestion: { id: string; question: string } | undefined;

/**
 * What this session has done so far, so the next task can refer back to it.
 *
 * Kept with the transcript and cleared with it. Six is plenty: a follow-up
 * reaches back one or two tasks, not twenty, and every entry is on the wire
 * for every step of the next task.
 */
let history: TaskMemory[] = [];
const HISTORY_LIMIT = 6;

/** Longer than a confirmation: the user may have to go and find the answer. */
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The confirmation currently waiting for an answer.
 *
 * Kept as state, not just fired as an event. The banner used to be rendered
 * only from the live `confirm` message, and `emit` swallows a send failure when
 * no panel is listening - so closing or reloading the side panel lost the
 * question, and the promise behind it never settled. The task hung for ever
 * with no error and nothing on screen.
 *
 * Both tasks that stalled ended in Send or Forward, which is exactly what the
 * gate asks about.
 */
let awaitingConfirm: { id: string; summary: string } | undefined;

/**
 * How long to wait for an answer before declining.
 *
 * A confirmation that is never answered should not hold a task open for ever.
 * Declining is the safe direction: the action was one the user has to approve,
 * so silence must not approve it.
 */
const CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * The session vault.
 *
 * It is a handle, not the mappings themselves - those live in an offscreen
 * document that Chrome does not terminate on the service worker's idle timer.
 * This worker can be torn down and restarted without losing a single token.
 */
const vault = new RemoteVault();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  return normaliseSettings(stored.settings);
}

/** Broadcasts to the panel; a closed panel simply has no receiver. */
function emit(event: AgentEvent): void {
  if (event.kind === "entry") {
    transcript.push(event.entry);
  } else if (event.kind === "patch") {
    const entry = transcript.find((e) => e.id === event.id);
    if (entry) {
      // Text deltas append; step updates and explicit replacements overwrite.
      if (event.text !== undefined) {
        entry.text =
          entry.role === "assistant" && !event.replace ? entry.text + event.text : event.text;
      }
      if (event.pending !== undefined) entry.pending = event.pending;
    }
  }
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

function askConfirm(id: string, summary: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (approved: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      awaitingConfirm = undefined;
      resolve(approved);
    };

    const timer = setTimeout(() => {
      if (!settled) {
        emit({
          kind: "entry",
          entry: {
            id: `c-${Date.now()}`,
            role: "error",
            text:
              "Nobody answered the confirmation, so I declined it and stopped. " +
              "Reopen the side panel before running a task that needs approval.",
          },
        });
      }
      settle(false);
    }, CONFIRM_TIMEOUT_MS);

    pendingConfirms.set(id, settle);
    awaitingConfirm = { id, summary };
    emit({ kind: "confirm", id, summary });
  });
}

function askUser(id: string, question: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      awaitingQuestion = undefined;
      pendingQuestions.delete(id);
      resolve(answer);
    };

    const timer = setTimeout(() => {
      if (!settled) {
        emit({
          kind: "entry",
          entry: {
            id: `q-${Date.now()}`,
            role: "error",
            text: "Nobody answered the question, so I carried on without it.",
          },
        });
      }
      settle(undefined);
    }, QUESTION_TIMEOUT_MS);

    pendingQuestions.set(id, settle);
    awaitingQuestion = { id, question };
    emit({ kind: "question", id, question });
  });
}

async function start(task: string, tabId: number): Promise<void> {
  if (running) return;

  const settings = await loadSettings();

  running = true;
  abort = new AbortController();
  emit({ kind: "status", running: true });
  emit({ kind: "entry", entry: { id: `u-${Date.now()}`, role: "user", text: task } });

  try {
    const answer = await runTask(task, tabId, {
      settings, emit, askConfirm, askUser, signal: abort.signal, vault, history,
    });
    if (answer) {
      history.push({ task, answer });
      if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    }
  } catch (error) {
    emit({
      kind: "entry",
      entry: {
        id: `err-${Date.now()}`,
        role: "error",
        text: error instanceof Error ? error.message : String(error),
      },
    });
  } finally {
    running = false;
    abort = null;
    // Nothing is waiting on an answer once the run is over.
    for (const resolve of pendingConfirms.values()) resolve(false);
    pendingConfirms.clear();
    awaitingConfirm = undefined;
    for (const resolve of pendingQuestions.values()) resolve(undefined);
    pendingQuestions.clear();
    awaitingQuestion = undefined;
    emit({ kind: "status", running: false });
  }
}

chrome.runtime.onMessage.addListener(
  (command: PanelCommand, _sender, sendResponse: (r: unknown) => void) => {
    switch (command.kind) {
      case "run":
        void start(command.task, command.tabId);
        sendResponse({ ok: true });
        return false;

      case "stop":
        abort?.abort();
        for (const resolve of pendingConfirms.values()) resolve(false);
        pendingConfirms.clear();
        awaitingConfirm = undefined;
        for (const resolve of pendingQuestions.values()) resolve(undefined);
        pendingQuestions.clear();
        awaitingQuestion = undefined;
        running = false;
        emit({ kind: "status", running: false });
        emit({
          kind: "entry",
          entry: { id: `s-${Date.now()}`, role: "system", text: "Stopped." },
        });
        sendResponse({ ok: true });
        return false;

      case "reset":
        abort?.abort();
        transcript = [];
        history = [];
        running = false;
        // A new task is a new session. Keeping the old mappings would let a
        // token minted on one site resolve while working on another.
        void vault.clear();
        clearWire();
        sendResponse({ ok: true });
        return false;

      case "confirm-reply": {
        const resolve = pendingConfirms.get(command.id);
        pendingConfirms.delete(command.id);
        resolve?.(command.approved);
        sendResponse({ ok: true });
        return false;
      }

      case "question-reply": {
        const resolve = pendingQuestions.get(command.id);
        // The answer is the user's own words; it shows in the transcript as such.
        if (resolve) {
          emit({ kind: "entry", entry: { id: `ua-${Date.now()}`, role: "user", text: command.answer } });
        }
        // An empty answer is a skip, which the agent treats as no answer at all.
        resolve?.(command.answer.trim() || undefined);
        sendResponse({ ok: true });
        return false;
      }

      case "inspect": {
        const tabId = command.tabId;
        void (async () => {
          try {
            const target =
              tabId ??
              (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
            if (!target) throw new Error("No tab to inspect.");
            sendResponse({
              ok: true,
              capture: await captureTab(target, { fullPage: command.fullPage === true }),
            });
          } catch (error) {
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        // Async response — keep the channel open.
        return true;
      }

      case "vault-mint": {
        void (async () => {
          try {
            const { tokens, size } = await vault.mint(command.requests);
            sendResponse({ ok: true, tokens, size, hosting: vault.hosting });
          } catch (error) {
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        return true;
      }

      case "vault-view": {
        void (async () => {
          const view = await vault.view();
          sendResponse({ ok: true, ...view, hosting: vault.hosting });
        })();
        return true;
      }

      case "vault-clear": {
        void (async () => {
          await vault.clear();
          sendResponse({ ok: true });
        })();
        return true;
      }

      case "vault-resolve": {
        void (async () => {
          try {
            sendResponse({ ok: true, ...(await vault.resolve(command.text)) });
          } catch (error) {
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        return true;
      }

      case "span-rects": {
        void (async () => {
          try {
            const controller = new TabController(command.tabId);
            sendResponse({ ok: true, rects: await controller.spanRects(command.requests) });
          } catch (error) {
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        return true;
      }

      case "wire-log":
        sendResponse({ ok: true, records: wireRecords() });
        return false;

      case "wire-clear":
        clearWire();
        sendResponse({ ok: true });
        return false;

      case "get-state":
        // The pending confirmation goes with the transcript. Without it a panel
        // that was closed when the question was asked comes back showing a
        // running task and no way to answer it.
        sendResponse({
          transcript,
          running,
          pendingConfirm: awaitingConfirm,
          pendingQuestion: awaitingQuestion,
        });
        return false;

      default:
        return false;
    }
  },
);

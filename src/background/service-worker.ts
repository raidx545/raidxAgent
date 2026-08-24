import type {
  AgentEvent,
  PanelCommand,
  Settings,
  TranscriptEntry,
} from "../shared/types";
import { normaliseSettings } from "../shared/types";
import { runTask } from "./agent";
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
    pendingConfirms.set(id, resolve);
    emit({ kind: "confirm", id, summary });
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
    await runTask(task, tabId, { settings, emit, askConfirm, signal: abort.signal, vault });
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
        sendResponse({ transcript, running });
        return false;

      default:
        return false;
    }
  },
);

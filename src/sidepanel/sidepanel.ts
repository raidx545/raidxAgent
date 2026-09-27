import type { AgentEvent, PanelCommand, TranscriptEntry } from "../shared/types";
import type { Suggestion } from "../shared/suggest";
import { TranscriptView } from "./transcript";

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const transcriptEl = $("transcript");
const emptyEl = $("empty");
const inputEl = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("send");
const stopBtn = $<HTMLButtonElement>("stop");
const statusDot = $("status-dot");
const confirmEl = $("confirm");
const confirmText = $("confirm-text");
const questionEl = $("question");
const questionText = $("question-text");
const questionInput = $<HTMLTextAreaElement>("question-input");
let pendingQuestionId: string | null = null;

const view = new TranscriptView(transcriptEl);
const jumpBtn = $("jump");
const progressEl = $("progress");
let pendingConfirmId: string | null = null;

function send(command: PanelCommand): Promise<unknown> {
  return chrome.runtime.sendMessage(command).catch(() => undefined);
}

function atBottom(): boolean {
  return (
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60
  );
}

/**
 * Follows the transcript only while the reader is already at the bottom.
 *
 * Yanking the view down while someone is reading an earlier answer is worse
 * than not following at all, so when they have scrolled up the new content is
 * announced with a button instead.
 */
function settle(wasAtBottom: boolean): void {
  if (wasAtBottom) {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    jumpBtn.classList.add("hidden");
  } else {
    jumpBtn.classList.remove("hidden");
  }
}

function render(entry: TranscriptEntry): void {
  emptyEl.classList.add("hidden");
  const stick = atBottom();
  view.render(entry);
  if (entry.role === "step") showProgress();
  settle(stick);
}

/** Actions taken in the run now in progress. */
function showProgress(): void {
  if (!statusDot.classList.contains("running")) return;
  const count = view.steps;
  progressEl.textContent = count === 0 ? "" : `${count} action${count === 1 ? "" : "s"}`;
}

function setRunning(running: boolean): void {
  statusDot.classList.toggle("running", running);
  // The count belongs to the run, not to the transcript, so it clears when the
  // run ends rather than sitting there as a stale total.
  if (!running) progressEl.textContent = "";
  else showProgress();
  sendBtn.classList.toggle("hidden", running);
  stopBtn.classList.toggle("hidden", !running);
  inputEl.disabled = running;
  inputEl.placeholder = running ? "Working… press stop to cancel" : "Ask VLESS to do something…";
  syncSend();
}

/** Run is only offered when there is something to run. */
function syncSend(): void {
  sendBtn.disabled = inputEl.value.trim().length === 0;
}

chrome.runtime.onMessage.addListener((event: AgentEvent) => {
  switch (event.kind) {
    case "entry":
      render(event.entry);
      break;

    case "patch": {
      const stick = atBottom();
      if (!view.patch(event.id, { text: event.text, pending: event.pending, replace: event.replace })) {
        break;
      }
      settle(stick);
      break;
    }

    case "status":
      setRunning(event.running);
      break;

    case "confirm":
      pendingConfirmId = event.id;
      confirmText.textContent = event.summary;
      confirmEl.classList.remove("hidden");
      break;

    case "question":
      showQuestion(event.id, event.question);
      break;
  }
});

function showQuestion(id: string, question: string): void {
  pendingQuestionId = id;
  questionText.textContent = question;
  questionInput.value = "";
  questionEl.classList.remove("hidden");
  questionInput.focus();
}

function answerQuestion(answer: string | null): void {
  if (!pendingQuestionId) return;
  // Skipping sends an empty answer, which the agent reads as "no answer".
  void send({ kind: "question-reply", id: pendingQuestionId, answer: answer ?? "" });
  pendingQuestionId = null;
  questionEl.classList.add("hidden");
}

$("question-send").addEventListener("click", () => {
  const answer = questionInput.value.trim();
  if (answer) answerQuestion(answer);
});
$("question-skip").addEventListener("click", () => answerQuestion(null));
questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const answer = questionInput.value.trim();
    if (answer) answerQuestion(answer);
  }
});

function answerConfirm(approved: boolean): void {
  if (!pendingConfirmId) return;
  void send({ kind: "confirm-reply", id: pendingConfirmId, approved });
  pendingConfirmId = null;
  confirmEl.classList.add("hidden");
}

$("confirm-yes").addEventListener("click", () => answerConfirm(true));
$("confirm-no").addEventListener("click", () => answerConfirm(false));

async function submit(): Promise<void> {
  const task = inputEl.value.trim();
  if (!task) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  inputEl.value = "";
  inputEl.style.height = "auto";
  syncSend();
  await send({ kind: "run", task, tabId: tab.id });
}

$<HTMLFormElement>("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});

stopBtn.addEventListener("click", () => void send({ kind: "stop" }));

$("new-task").addEventListener("click", () => {
  void send({ kind: "reset" });
  view.clear();
  progressEl.textContent = "";
  emptyEl.classList.remove("hidden");
  jumpBtn.classList.add("hidden");
  setRunning(false);
  void loadSuggestions();
  inputEl.focus();
});

jumpBtn.addEventListener("click", () => {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  jumpBtn.classList.add("hidden");
});

// Reaching the bottom by hand dismisses the button too.
transcriptEl.addEventListener("scroll", () => {
  if (atBottom()) jumpBtn.classList.add("hidden");
});

// ---------------------------------------------------------------- the menu
//
// Three things most people open rarely - the privacy check, the wire log and
// settings - sat as four text buttons across a narrow header. They live
// behind one button now, and the header shows only what is used every task.

const menuBtn = $<HTMLButtonElement>("menu-btn");
const menuEl = $("menu");

function setMenu(open: boolean): void {
  menuEl.classList.toggle("hidden", !open);
  menuBtn.setAttribute("aria-expanded", String(open));
  if (open) menuEl.querySelector<HTMLButtonElement>("button")?.focus();
}
menuBtn.addEventListener("click", () => setMenu(menuEl.classList.contains("hidden")));
document.addEventListener("click", (event) => {
  if (!menuEl.classList.contains("hidden") && !(event.target as Element).closest(".menu-wrap")) setMenu(false);
});
menuEl.addEventListener("keydown", (event) => {
  const items = [...menuEl.querySelectorAll<HTMLButtonElement>("button")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "Escape") { setMenu(false); menuBtn.focus(); }
  else if (event.key === "ArrowDown") { event.preventDefault(); items[(at + 1) % items.length].focus(); }
  else if (event.key === "ArrowUp") { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
});

const openPage = (path: string) => { setMenu(false); void chrome.tabs.create({ url: chrome.runtime.getURL(path) }); };
$("settings").addEventListener("click", () => { setMenu(false); void chrome.runtime.openOptionsPage(); });
// Exactly what left this browser, with a PII verdict per turn.
$("wire").addEventListener("click", () => openPage("wirelog.html"));
// The capture + PII layer runs standalone; it does not involve the planner.
$("inspect").addEventListener("click", () => openPage("inspector.html"));

// ----------------------------------------------------------- suggestions
//
// Tasks that fit the page that is open, worked out in the browser from what
// kind of page it is. Picking one fills the composer - it does not run - so it
// can be finished or changed first.

const suggestionsEl = $("suggestions");
const siteHost = $("site-host");
const siteKind = $("site-kind");
const siteBadge = $("site-badge");
const emptyTitle = $("empty-title");

interface SuggestionsReply { host?: string; kind?: string; enabled: boolean; suggestions: Suggestion[] }

let suggestionRequest = 0;

async function loadSuggestions(): Promise<void> {
  if (emptyEl.classList.contains("hidden")) return;
  const request = ++suggestionRequest;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  suggestionsEl.innerHTML = '<div class="suggestions-loading"></div><div class="suggestions-loading"></div>';
  const reply = (await send({ kind: "suggestions", tabId: tab?.id })) as SuggestionsReply | undefined;
  if (request !== suggestionRequest) return;

  const host = reply?.host;
  siteHost.textContent = host ?? "New tab";
  siteKind.textContent = reply?.kind ?? "";
  siteBadge.textContent = (host ?? "").replace(/^(m|app|mail|web)\./, "").charAt(0);
  siteBadge.hidden = !host;
  emptyTitle.textContent = host ? "What should I do here?" : "What can I do for you?";

  suggestionsEl.innerHTML = "";
  if (!reply?.enabled) return;
  for (const suggestion of reply.suggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion";
    button.setAttribute("role", "listitem");
    const label = document.createElement("span");
    label.textContent = suggestion.label;
    button.append(label);
    button.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>');
    button.addEventListener("click", () => {
      inputEl.value = suggestion.prompt;
      inputEl.dispatchEvent(new Event("input"));
      inputEl.focus();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    });
    suggestionsEl.appendChild(button);
  }
}

// The page changes under the panel: another tab, or this one navigating.
chrome.tabs.onActivated.addListener(() => void loadSuggestions());
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === "complete" && tab.active) void loadSuggestions();
});

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
});

// Grow the composer with its content, up to the CSS max-height.
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${inputEl.scrollHeight}px`;
  syncSend();
});
syncSend();

// The panel can be reopened mid-run — rebuild from the worker's transcript.
void (async () => {
  const state = (await chrome.runtime.sendMessage({ kind: "get-state" })) as
    | {
        transcript: TranscriptEntry[];
        running: boolean;
        pendingConfirm?: { id: string; summary: string };
        pendingQuestion?: { id: string; question: string };
      }
    | undefined;
  if (!state) {
    void loadSuggestions();
    return;
  }
  state.transcript.forEach(render);
  if (state.transcript.length === 0) void loadSuggestions();
  setRunning(state.running);

  // A question asked while this panel was closed is still waiting. Without
  // this, reopening the panel shows a running task and no way to answer it,
  // and the task waits until it times out.
  if (state.pendingConfirm) {
    pendingConfirmId = state.pendingConfirm.id;
    confirmText.textContent = state.pendingConfirm.summary;
    confirmEl.classList.remove("hidden");
  }
  if (state.pendingQuestion) {
    showQuestion(state.pendingQuestion.id, state.pendingQuestion.question);
  }

  transcriptEl.scrollTop = transcriptEl.scrollHeight;
})();

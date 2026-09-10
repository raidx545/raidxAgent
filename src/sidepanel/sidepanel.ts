import type { AgentEvent, PanelCommand, TranscriptEntry } from "../shared/types";
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
});

jumpBtn.addEventListener("click", () => {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  jumpBtn.classList.add("hidden");
});

// Reaching the bottom by hand dismisses the button too.
transcriptEl.addEventListener("scroll", () => {
  if (atBottom()) jumpBtn.classList.add("hidden");
});

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Exactly what left this browser, with a PII verdict per turn.
$("wire").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("wirelog.html") });
});

// The capture + PII layer runs standalone; it does not involve the planner.
$("inspect").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("inspector.html") });
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
});

document.querySelectorAll<HTMLElement>("[data-example]").forEach((el) => {
  el.addEventListener("click", () => {
    inputEl.value = el.dataset.example ?? "";
    inputEl.focus();
  });
});

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
  if (!state) return;
  state.transcript.forEach(render);
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

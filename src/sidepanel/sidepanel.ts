import type { AgentEvent, PanelCommand, TranscriptEntry } from "../shared/types";

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

/** Rendered entries, so patches can find their node without a re-render. */
const nodes = new Map<string, HTMLElement>();
let pendingConfirmId: string | null = null;

const GLYPHS: Record<string, string> = {
  click: "→",
  type: "⌨",
  select: "▾",
  scroll: "↕",
  key: "⏎",
  find_text: "⌕",
  wait: "◷",
  read_page: "◉",
  navigate: "⇢",
  go_back: "⇠",
  open_tab: "＋",
  switch_tab: "⇄",
  close_tab: "×",
  list_tabs: "☰",
};

function send(command: PanelCommand): Promise<unknown> {
  return chrome.runtime.sendMessage(command).catch(() => undefined);
}

function atBottom(): boolean {
  return (
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60
  );
}

function render(entry: TranscriptEntry): void {
  emptyEl.classList.add("hidden");
  const stick = atBottom();

  let node = nodes.get(entry.id);
  if (!node) {
    node = document.createElement("div");
    node.className = `entry ${entry.role}`;
    if (entry.role === "step") {
      node.innerHTML = `<span class="glyph"></span><span class="detail"></span>`;
    }
    nodes.set(entry.id, node);
    transcriptEl.appendChild(node);
  }

  if (entry.role === "step") {
    node.querySelector(".glyph")!.textContent = GLYPHS[entry.action ?? ""] ?? "•";
    node.querySelector(".detail")!.textContent = entry.text;
    node.classList.toggle("pending", entry.pending === true);
  } else {
    node.textContent = entry.text;
  }

  if (stick) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function setRunning(running: boolean): void {
  statusDot.classList.toggle("running", running);
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
      const node = nodes.get(event.id);
      if (!node) break;
      if (event.text !== undefined) {
        if (node.classList.contains("assistant")) {
          // Streamed prose arrives as deltas.
          node.textContent = (node.textContent ?? "") + event.text;
        } else if (node.classList.contains("step")) {
          node.querySelector(".detail")!.textContent = event.text;
        } else {
          node.textContent = event.text;
        }
      }
      if (event.pending !== undefined) node.classList.toggle("pending", event.pending);
      if (atBottom()) transcriptEl.scrollTop = transcriptEl.scrollHeight;
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
  nodes.clear();
  transcriptEl.querySelectorAll(".entry").forEach((n) => n.remove());
  emptyEl.classList.remove("hidden");
  setRunning(false);
});

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

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
    | { transcript: TranscriptEntry[]; running: boolean }
    | undefined;
  if (!state) return;
  state.transcript.forEach(render);
  setRunning(state.running);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
})();

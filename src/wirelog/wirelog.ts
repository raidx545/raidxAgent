import type { WireRecord } from "../background/wirelog";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const turnsEl = $("turns");
const statusEl = $("status");

let records: WireRecord[] = [];

function escape(text: string): string {
  return text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}

/** Highlights tokens so it is obvious at a glance what was substituted. */
function highlight(text: string): string {
  return escape(text).replace(
    /&lt;([A-Z][A-Z0-9]*_\d+)&gt;/g,
    '<span class="tok">&lt;$1&gt;</span>',
  );
}

function bytes(n: number): string {
  return n > 1_000_000 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function render(): void {
  if (records.length === 0) {
    turnsEl.innerHTML =
      `<p class="empty">Nothing sent yet. Run a task from the side panel, then refresh.</p>`;
    return;
  }

  turnsEl.innerHTML = records
    .slice()
    .reverse()
    .map((record) => {
      const clean = record.leaked.length === 0;
      const when = new Date(record.at).toLocaleTimeString();

      return `
        <details class="turn"${clean ? "" : " open"}>
          <summary>
            <strong>Turn ${record.turn}</strong>
            <span class="tag">${escape(record.destination)}</span>
            <span class="tag">${record.totalChars.toLocaleString()} chars</span>
            ${record.image ? `<span class="tag">image ${bytes(record.image.bytes)}</span>` : ""}
            <span class="tag">${record.tokens.length} token(s)</span>
            <span class="verdict ${clean ? "clean" : "dirty"}">
              ${clean ? "no PII in payload" : `${record.leaked.length} LEAK(S)`}
            </span>
            <span class="hint">${when}</span>
          </summary>
          <div class="body">
            ${
              clean
                ? ""
                : `<p class="verdict dirty">Survived sanitization: ${record.leaked
                    .map((f) => `${f.kind} (${escape(f.masked)})`)
                    .join(", ")}</p>`
            }

            <div class="msg">
              <h4>Tokens in this payload</h4>
              <pre>${record.tokens.length > 0 ? highlight(record.tokens.join("  ")) : "(none)"}</pre>
            </div>

            <div class="msg">
              <h4>System prompt</h4>
              <pre>${record.systemChars.toLocaleString()} characters (identical every turn, not repeated here)</pre>
            </div>

            ${record.messages
              .map(
                (m) => `
              <div class="msg">
                <h4>${escape(m.role)}</h4>
                <pre>${highlight(m.text)}</pre>
              </div>`,
              )
              .join("")}

            ${
              record.image?.dataUrl
                ? `<div class="msg shot">
                     <h4>Image attached — redacted screenshot</h4>
                     <img src="${record.image.dataUrl}">
                   </div>`
                : record.image
                  ? `<div class="msg"><h4>Image attached</h4>
                       <pre>${bytes(record.image.bytes)} — too large to keep a copy in the log</pre>
                     </div>`
                  : ""
            }
          </div>
        </details>`;
    })
    .join("");
}

async function load(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({ kind: "wire-log" })) as
    | { ok: true; records: WireRecord[] }
    | undefined;

  records = reply?.ok ? reply.records : [];

  const leaks = records.reduce((sum, r) => sum + r.leaked.length, 0);
  statusEl.textContent =
    records.length === 0
      ? ""
      : `${records.length} turn(s) sent · ` +
        `${records.reduce((sum, r) => sum + r.totalChars, 0).toLocaleString()} characters · ` +
        (leaks === 0
          ? "no PII found in any outgoing payload"
          : `${leaks} value(s) leaked — see the highlighted turns`);
  statusEl.classList.toggle("bad", leaks > 0);

  render();
}

$("refresh").addEventListener("click", () => void load());

$("clear").addEventListener("click", () => {
  void (async () => {
    await chrome.runtime.sendMessage({ kind: "wire-clear" });
    await load();
  })();
});

$("copy").addEventListener("click", () => {
  void (async () => {
    // Images are megabytes of base64 and useless in a diff; leave them out.
    const plain = records.map((r) => ({
      ...r,
      image: r.image ? { bytes: r.image.bytes } : undefined,
    }));
    await navigator.clipboard.writeText(JSON.stringify(plain, null, 2));
    statusEl.textContent = "Copied to the clipboard, without image data.";
  })();
});

void load();

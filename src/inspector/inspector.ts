import type { Capture, CapturedNode } from "../capture/types";
import { walkCapture } from "../capture/dom";
import type { Finding } from "../pii/types";
import type { SpanRectRequest, SpanRectResult } from "../capture/spans";
import { sanitize, type SanitizedCapture } from "../sanitize/sanitize";
import { ReplayMinter, type MintRequest, type TokenMinter } from "../vault/protocol";
import type { MinterSource } from "../vault/remote";
import type { VaultEntryView } from "../vault/vault";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const tabPicker = $<HTMLSelectElement>("tab-picker");
const statusEl = $("status");
const residualEl = $("residual-banner");
const summaryEl = $("summary");
const shot = $<HTMLCanvasElement>("shot");
const shotNote = $("shot-note");
const findingsEl = $("findings");
const filtersEl = $("filters");
const vaultEl = $("vault");
const vaultNote = $("vault-note");
const textviewEl = $("textview");
const treeEl = $("tree");
const treeStats = $("tree-stats");
const fullPageEl = $<HTMLInputElement>("full-page");

/**
 * The vault is not in this page.
 *
 * It lives in an offscreen document owned by the service worker, so scanning
 * three pages in a row shares one set of mappings and closing this tab does not
 * destroy them. That is also what the agent will do once this is wired in, so
 * the inspector exercises the real path rather than a convenient local copy.
 */
const vaultSource: MinterSource = {
  async prepare(requests: MintRequest[]): Promise<TokenMinter> {
    const response = (await chrome.runtime.sendMessage({
      kind: "vault-mint",
      requests,
    })) as { ok: true; tokens: string[] } | { ok: false; error: string } | undefined;

    if (!response?.ok) {
      throw new Error(response?.error ?? "The vault did not respond.");
    }
    return new ReplayMinter(requests, response.tokens);
  },
};

async function vaultView(): Promise<{
  entries: VaultEntryView[];
  size: number;
  hosting: string;
}> {
  const response = (await chrome.runtime.sendMessage({ kind: "vault-view" })) as
    | { ok: true; entries: VaultEntryView[]; size: number; hosting: string }
    | undefined;
  return response?.ok
    ? response
    : { entries: [], size: 0, hosting: "unavailable" };
}

let original: Capture | undefined;
let sanitized: SanitizedCapture | undefined;
let shotView: "redacted" | "original" = "redacted";
let textView: "after" | "before" = "after";
let activeFilter = "all";
let activeFinding: string | undefined;

const CONFIDENCE_COLOR: Record<Finding["confidence"], string> = {
  certain: "#e5484d",
  high: "#f5a524",
  medium: "#3b82f6",
  low: "#8b8f96",
};

function setStatus(text: string, bad = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("bad", bad);
}

function escape(text: string): string {
  return text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
}

function truncate(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + "…" : text;
}

async function loadTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  tabPicker.innerHTML = "";
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (/^(chrome|edge|about|devtools):/.test(tab.url)) continue;
    const option = document.createElement("option");
    option.value = String(tab.id);
    let host = tab.url;
    try {
      host = new URL(tab.url).host || tab.url;
    } catch {
      /* extension pages and file: urls have no host */
    }
    option.textContent = `${tab.title ?? "untitled"} — ${host}`;
    tabPicker.appendChild(option);
  }
  if (tabPicker.options.length === 0) {
    setStatus("No inspectable tabs open. Open a website or the fixture page first.", true);
  }
}

// ---------------------------------------------------------------- screenshot

async function drawShot(): Promise<void> {
  if (!original || !sanitized) return;

  const meta = shotView === "redacted" ? sanitized.screenshot : original.screenshot;
  const source = meta?.dataUrl;
  const ctx = shot.getContext("2d");
  if (!ctx) return;

  if (!source) {
    shot.width = 1;
    shot.height = 1;
    shotNote.textContent =
      sanitized.report.screenshotError ??
      "No screenshot was captured, so there was nothing to redact.";
    shotNote.classList.add("bad");
    return;
  }
  shotNote.classList.remove("bad");

  const image = new Image();
  image.src = source;
  await image.decode().catch(() => undefined);

  shot.width = image.naturalWidth;
  shot.height = image.naturalHeight;
  ctx.drawImage(image, 0, 0);

  const kb = (source.length / 1024).toFixed(0);
  const coverage =
    meta!.kind === "page"
      ? `whole page, ${meta!.tiles} screen(s) stitched` +
        (meta!.truncatedAtCssY ? ", truncated" : "") +
        (meta!.downscaledFrom ? ", downscaled for token cost" : "")
      : "viewport only";
  const r = sanitized.report.redact;
  const pixelFindings = sanitized.findings.filter((f) => f.shape === "pixel").length;

  if (shotView === "redacted") {
    const parts = [
      `${image.naturalWidth}x${image.naturalHeight} px, ${kb} KB, ${coverage}`,
      `${r.regionsBurned} of ${pixelFindings} region(s) destroyed`,
      `${r.pixelsBurned.toLocaleString()} pixels burned`,
    ];
    if (r.regionsOutsideViewport > 0) {
      // Say why plainly: this is the case that looks like a bug and is not.
      parts.push(
        `${r.regionsOutsideViewport} below the fold — not in this screenshot, ` +
          `so nothing to burn. Scroll the page to bring them into view and scan again.`,
      );
    }
    parts.push(`${r.textSpansCovered} text span(s) painted over with their token`);
    if (r.textSpansUnresolved > 0) {
      parts.push(`${r.textSpansUnresolved} text span(s) could not be located on screen`);
    }
    if (r.regionsSkipped > 0) parts.push(`${r.regionsSkipped} had no usable box`);
    shotNote.textContent = parts.join(" · ") + ". This is what the model would receive.";
  } else {
    shotNote.textContent =
      `${image.naturalWidth}x${image.naturalHeight} px, ${kb} KB, ${coverage} — original, ` +
      `never sent. Outlines mark the ${pixelFindings} region(s) that will be destroyed.`;
  }

  // On the original, outline the regions that will be destroyed. Same
  // document-coordinate projection the redactor uses, so what is outlined here
  // is exactly what gets burned there.
  if (shotView === "original" && meta) {
    const v = original.dom.viewport;
    for (const finding of sanitized.findings) {
      if (finding.shape !== "pixel") continue;
      const [bx, by, bw, bh] = finding.bbox;
      const x = (bx + v.scrollX - meta.originX) * meta.scale;
      const y = (by + v.scrollY - meta.originY) * meta.scale;
      ctx.strokeStyle = CONFIDENCE_COLOR[finding.confidence];
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, bw * meta.scale, bh * meta.scale);
    }
  }
}

// ------------------------------------------------------------------- summary

let vaultSize = 0;

function renderSummary(): void {
  if (!sanitized) return;
  const r = sanitized.report;

  const cells: [string, string | number][] = [
    ["findings", sanitized.findings.length],
    ["spans tokenized", r.tokenize.spansReplaced],
    ["fields replaced", r.tokenize.fieldsReplaced],
    ["fields sealed", r.tokenize.fieldsSealed],
    ["regions burned", r.redact.regionsBurned],
    ["text spans covered", r.redact.textSpansCovered],
    ["below the fold", r.redact.regionsOutsideViewport],
    ["tokens minted", r.tokensMinted],
    ["vault size", vaultSize],
    ["checksum rejects", r.detection.checksumRejected],
    ["page tokens escaped", r.tokenize.tokensEscaped],
    ["total time", `${r.elapsedMs} ms`],
  ];

  summaryEl.innerHTML = cells
    .map(([k, n]) => `<div class="stat"><span class="n">${n}</span><span class="k">${k}</span></div>`)
    .join("");
  summaryEl.classList.remove("hidden");

  const residual = r.residual;
  residualEl.className = `residual ${residual.length === 0 ? "clean" : "dirty"}`;
  residualEl.innerHTML =
    residual.length === 0
      ? `<strong>No PII survived.</strong>
         <span class="sub">The detector was re-run over the sanitized output and found nothing.
         Field metadata (labels, autocomplete) is preserved on purpose — a form the planner
         cannot recognise is useless.</span>`
      : `<strong>${residual.length} finding(s) survived sanitization.</strong>
         <span class="sub">${residual
           .map((f) => `${f.kind} (${f.masked})`)
           .join(", ")}</span>`;
  residualEl.classList.remove("hidden");
}

// -------------------------------------------------------------------- vault

async function renderVault(): Promise<void> {
  const { entries, hosting } = await vaultView();
  vaultNote.textContent =
    `${entries.length} mapping(s), in memory only · hosted ${hosting}` +
    (hosting === "in-process"
      ? " (degraded: mappings will be lost if the worker restarts)"
      : "");

  if (entries.length === 0) {
    vaultEl.innerHTML = `<p class="hint" style="padding:14px">Vault is empty.</p>`;
    return;
  }

  vaultEl.innerHTML = `
    <table>
      <thead><tr><th>Token</th><th>Kind</th><th>Hidden value</th><th>Len</th><th>Uses</th></tr></thead>
      <tbody>
        ${entries
          .map(
            (e) => `<tr>
              <td class="tok">${escape(e.token)}</td>
              <td>${e.kind}${e.sealed ? ' <span class="sealed">sealed</span>' : ""}</td>
              <td class="pv">${escape(e.preview)}</td>
              <td>${e.length || "—"}</td>
              <td>${e.uses}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

// ----------------------------------------------------------------- findings

function renderFilters(): void {
  if (!sanitized) return;
  const kinds = new Map<string, number>();
  for (const finding of sanitized.findings) {
    kinds.set(finding.kind, (kinds.get(finding.kind) ?? 0) + 1);
  }

  const options: [string, string][] = [
    ["all", `all (${sanitized.findings.length})`],
    ...Array.from(kinds.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => [kind, `${kind} (${n})`] as [string, string]),
  ];

  filtersEl.innerHTML = "";
  for (const [value, label] of options) {
    const button = document.createElement("button");
    button.textContent = label;
    button.setAttribute("aria-pressed", String(value === activeFilter));
    button.addEventListener("click", () => {
      activeFilter = value;
      renderFilters();
      renderFindings();
    });
    filtersEl.appendChild(button);
  }
}

function renderFindings(): void {
  if (!sanitized) return;

  const shown =
    activeFilter === "all"
      ? sanitized.findings
      : sanitized.findings.filter((f) => f.kind === activeFilter);

  if (shown.length === 0) {
    findingsEl.innerHTML = `<p class="hint" style="padding:14px">No findings.</p>`;
    return;
  }

  findingsEl.innerHTML = "";
  for (const finding of shown) {
    const row = document.createElement("div");
    row.className = `finding${finding.id === activeFinding ? " active" : ""}`;
    row.innerHTML = `
      <span class="kind">${finding.kind}</span>
      <span>
        <span class="tag ${finding.shape}">${finding.shape === "pixel" ? "burn" : "tokenize"}</span>
        <span class="tag${finding.confidence === "certain" ? " certain" : ""}">T${finding.tier} · ${finding.confidence}</span>
      </span>
      <span class="val">${escape(finding.masked)}${
        finding.span
          ? ` <span class="lbl">@${finding.field} [${finding.span[0]}–${finding.span[1]}]</span>`
          : ""
      }</span>
      <span class="why">${escape(finding.why)} · node ${finding.nodeId} · ${finding.action}</span>
    `;
    row.addEventListener("click", () => {
      activeFinding = activeFinding === finding.id ? undefined : finding.id;
      renderFindings();
      void drawShot();
    });
    findingsEl.appendChild(row);
  }
}

// ------------------------------------------------------- before/after text

/** Paragraph-level before/after, so the span swaps are visible in context. */
function renderTextView(): void {
  if (!original || !sanitized) return;

  const before = new Map<number, string>();
  for (const node of walkCapture(original.dom.root)) {
    const text = node.text ?? node.value ?? "";
    if (text.trim().length > 12) before.set(node.id, text);
  }

  const after = new Map<number, string>();
  for (const node of walkCapture(sanitized.dom.root)) {
    const text = node.text ?? node.value ?? "";
    if (text.trim().length > 0) after.set(node.id, text);
  }

  // Only show nodes whose text actually changed — that is where the work is.
  const changed = [...before.keys()].filter((id) => before.get(id) !== after.get(id));

  if (changed.length === 0) {
    textviewEl.innerHTML = `<p class="empty">No text on this page needed tokenizing.</p>`;
    return;
  }

  textviewEl.innerHTML = changed
    .slice(0, 40)
    .map((id) => {
      const raw = textView === "after" ? (after.get(id) ?? "") : (before.get(id) ?? "");
      const html = escape(raw);
      return `<p>${
        textView === "after"
          ? html.replace(/&lt;([A-Z][A-Z0-9]*_\d+)&gt;/g, '<span class="tok">&lt;$1&gt;</span>')
          : `<span class="was">${html}</span>`
      }</p>`;
    })
    .join("");
}

// --------------------------------------------------------------------- tree

function renderTree(): void {
  if (!sanitized) return;

  const flagged = new Map<number, Finding[]>();
  for (const finding of sanitized.findings) {
    const list = flagged.get(finding.nodeId) ?? [];
    list.push(finding);
    flagged.set(finding.nodeId, list);
  }

  const lines: string[] = [];
  const render = (node: CapturedNode, depth: number): void => {
    if (depth > 14) return;
    const marks = flagged.get(node.id);
    const indent = "  ".repeat(depth);
    const label = node.label || node.text || node.value || "";
    lines.push(
      `${indent}<span class="lbl">${node.id}</span> ${node.tag}` +
        ` <span class="role">${node.role}</span>` +
        (label ? ` <span class="lbl">${escape(truncate(label, 60))}</span>` : "") +
        (marks ? ` <span class="flag">⚑ ${marks.map((m) => m.kind).join(", ")}</span>` : ""),
    );
    for (const child of node.children) render(child, depth + 1);
  };
  // The sanitized tree, because that is what the planner would be handed.
  render(sanitized.dom.root, 0);

  treeEl.innerHTML = lines.join("\n");

  let total = 0;
  for (const _ of walkCapture(sanitized.dom.root)) total++;
  const s = sanitized.dom.stats;
  const v = sanitized.dom.viewport;
  treeStats.textContent =
    `sanitized tree · ${total} nodes kept · ${s.examined} examined · ` +
    `${s.pruned} pruned · viewport ${v.width}x${v.height} @${v.dpr}x · ` +
    `url reduced to ${sanitized.dom.url}`;
}

// --------------------------------------------------------------------- scan

async function scan(): Promise<void> {
  const tabId = Number(tabPicker.value);
  if (!tabId) return;

  activeFinding = undefined;
  activeFilter = "all";

  const fullPage = fullPageEl.checked;
  setStatus(
    fullPage
      ? "Capturing the whole page — this scrolls the tab and takes about half a second per screen…"
      : "Capturing…",
  );

  const response = (await chrome.runtime.sendMessage({
    kind: "inspect",
    tabId,
    fullPage,
  })) as
    | { ok: true; capture: Capture }
    | { ok: false; error: string }
    | undefined;

  if (!response?.ok) {
    setStatus(response?.error ?? "Capture failed.", true);
    return;
  }

  original = response.capture;
  setStatus("Detecting and sanitizing…");

  try {
    // The page is the only thing that can measure a Range, so rect resolution
    // hops back through the worker to the tab we just captured.
    const resolveRects = async (requests: SpanRectRequest[]): Promise<SpanRectResult[]> => {
      const reply = (await chrome.runtime.sendMessage({
        kind: "span-rects",
        tabId,
        requests,
      })) as { ok: true; rects: SpanRectResult[] } | { ok: false } | undefined;
      return reply?.ok ? reply.rects : [];
    };

    sanitized = await sanitize(original, vaultSource, undefined, resolveRects);
    vaultSize = (await vaultView()).size;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
    return;
  }

  renderSummary();
  await renderVault();
  renderFilters();
  renderFindings();
  renderTextView();
  renderTree();
  await drawShot();

  const r = sanitized.report;
  setStatus(
    `${sanitized.dom.url} — ${sanitized.findings.length} findings, ` +
      `${r.tokenize.spansReplaced + r.tokenize.fieldsReplaced} value(s) tokenized, ` +
      `${r.redact.regionsBurned} region(s) burned, ` +
      `${r.residual.length} residual. ${r.elapsedMs} ms.`,
  );
}

// -------------------------------------------------------------------- wiring

$("scan").addEventListener("click", () => void scan());

$("clear-vault").addEventListener("click", () => {
  void (async () => {
    await chrome.runtime.sendMessage({ kind: "vault-clear" });
    vaultSize = 0;
    await renderVault();
    setStatus("Vault cleared. Every token issued so far is now unresolvable.");
  })();
});

for (const [id, apply] of [
  ["shot-switch", (v: string) => { shotView = v as typeof shotView; void drawShot(); }],
  ["text-switch", (v: string) => { textView = v as typeof textView; renderTextView(); }],
] as const) {
  $(id).addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest("button");
    if (!button?.dataset.view) return;
    for (const sibling of $(id).querySelectorAll("button")) {
      sibling.setAttribute("aria-pressed", String(sibling === button));
    }
    apply(button.dataset.view);
  });
}

void loadTabs();
void renderVault();

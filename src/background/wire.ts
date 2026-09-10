import type { CapturedNode, DomCapture } from "../capture/types";
import type { ConvMessage } from "./providers/types";
import { NEVER_ALIGN } from "../pii/entities";

/**
 * Everything that crosses the wire is built here.
 *
 * Both functions are pure and take only a sanitized capture, which is the
 * point: there is exactly one place that turns a page into text for a model,
 * it can be tested on its own, and it has no way to reach an unsanitized
 * capture even by accident.
 */

/**
 * A company's legal form, at the end of its name.
 *
 * Deliberately narrower than the detector's suffix list: this one only holds
 * incorporation types, not the trade words ("Traders", "Exports") that are part
 * of the name people actually say.
 */
const LEGAL_FORM =
  /\s+(?:Pvt\.?\s*Ltd\.?|Private\s+Limited|Public\s+Limited|Limited|Ltd\.?|LLP|LLC|Inc\.?|Incorporated|Corp\.?|Corporation|PLC|GmbH)\.?$/i;

/** How many element lines to send before asking the planner to scroll. */
const MAX_LINES = 400;

/**
 * Marks a rendered page inside a message. One marker for every case, so the
 * pruner below can find them all reliably.
 */
export const PAGE_MARKER = "--- Page ---";

const SUPERSEDED =
  "(the page as it was at this step — superseded, and its element ids are no " +
  "longer valid; the current page is in the most recent message)";

/** Wraps a rendered page so it can be recognised and later pruned. */
export function pageBlock(capture: DomCapture): string {
  // A page whose own text happens to contain the marker would make the
  // pruner cut at the wrong place. Bend such text slightly so the marker we
  // write is the only one in the block.
  const body = renderPage(capture).split(PAGE_MARKER).join("--- Page ---".replace("---", "-\u2011-"));
  return `\n\n${PAGE_MARKER}\n${body}`;
}

/**
 * Removes every page render except the newest.
 *
 * A step appends a fresh page to the history, so by turn ten the planner is
 * handed ten of them and only the last describes the page in front of it. The
 * other nine are not merely wasted tokens - they are full of element ids that
 * have since been reissued, which is exactly the material a planner needs to
 * click the wrong thing.
 *
 * A page block always runs to the end of the string it sits in, so pruning is a
 * truncation rather than a splice.
 */
export function pruneStalePages(messages: ConvMessage[]): ConvMessage[] {
  const strip = (text: string): string => {
    const at = text.lastIndexOf(PAGE_MARKER);
    return at === -1 ? text : `${text.slice(0, at)}${SUPERSEDED}`;
  };

  const carries = (message: ConvMessage): boolean =>
    message.role === "user"
      ? message.content.includes(PAGE_MARKER)
      : message.role === "tool"
        ? message.results.some((r) => r.content.includes(PAGE_MARKER))
        : false;

  // Everything before the newest page-bearing message loses its page.
  let newest = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (carries(messages[i])) {
      newest = i;
      break;
    }
  }
  if (newest <= 0) return messages;

  return messages.map((message, index) => {
    if (index >= newest || !carries(message)) return message;
    if (message.role === "user") return { ...message, content: strip(message.content) };
    if (message.role === "tool") {
      return { ...message, results: message.results.map((r) => ({ ...r, content: strip(r.content) })) };
    }
    return message;
  });
}

/**
 * Renders a sanitized page for the planner.
 *
 * Element ids survive untouched. They are how the planner acts, they are
 * meaningless outside this session, and they say nothing about anyone - so
 * tokenizing them would cost the agent its only way to point at things and buy
 * no privacy at all.
 */
export function renderPage(capture: DomCapture): string {
  const lines: { text: string; visible: boolean; inDialog: boolean }[] = [];
  let dialogOpen = false;

  const render = (node: CapturedNode, depth: number, insideDialog: boolean): void => {
    const indent = "  ".repeat(Math.min(depth, 8));
    const label = node.label || node.text || "";
    const structural = node.role === "generic" || node.role === "document";

    const isDialog =
      node.visible && (node.role === "dialog" || node.attrs["aria-modal"] === "true");
    if (isDialog) dialogOpen = true;
    const inDialog = insideDialog || isDialog;

    if (label || node.value || !structural) {
      const parts = [`${indent}[${node.id}] ${node.role}`];
      if (label) parts.push(JSON.stringify(label.slice(0, 160)));
      if (node.value) parts.push(`= ${JSON.stringify(node.value.slice(0, 160))}`);

      const hints: string[] = [];
      if (node.attrs.type) hints.push(`type=${node.attrs.type}`);
      if (node.attrs.autocomplete) hints.push(`autocomplete=${node.attrs.autocomplete}`);
      if (node.attrs.hrefHost) hints.push(`href=${node.attrs.hrefHost}`);
      if (node.attrs.disabled) hints.push("disabled");
      if (!node.visible) hints.push("offscreen");
      if (hints.length > 0) parts.push(`(${hints.join(" ")})`);

      lines.push({ text: parts.join(" "), visible: node.visible, inDialog });
    }

    for (const child of node.children) render(child, depth + 1, inDialog);
  };

  render(capture.root, 0, false);

  // Spend the budget by importance, not by position in the markup.
  //
  // Truncating in document order is badly wrong on a long application: an inbox
  // appends its compose dialog near the *end* of the DOM after thousands of
  // rows, so a first-N cut drops the one part of the page the user just opened.
  //
  // Dropping only the off-screen lines was not enough either. A real inbox has
  // several hundred *visible* elements of its own, so the budget was still
  // exhausted before the dialog - and the planner was told a dialog was open
  // while being shown none of it. It clicked Compose, saw no compose window,
  // concluded nothing had happened, and clicked again.
  //
  // An open modal wins outright: the page behind it is not interactive, so
  // rendering four hundred rows nobody can click in preference to the fields
  // somebody is typing into has it exactly backwards.
  const rank = (line: { visible: boolean; inDialog: boolean }): number =>
    line.inDialog ? 0 : line.visible ? 1 : 2;

  const chosen = new Set<number>();
  for (const tier of [0, 1, 2]) {
    for (let i = 0; i < lines.length; i++) {
      if (chosen.size >= MAX_LINES) break;
      if (rank(lines[i]) === tier) chosen.add(i);
    }
  }

  // Emit in document order, so the indentation still describes real structure.
  const shown = lines.filter((_, i) => chosen.has(i));

  const droppedDialog = lines.filter((l, i) => rank(l) === 0 && !chosen.has(i)).length;
  const droppedVisible = lines.filter((l, i) => rank(l) === 1 && !chosen.has(i)).length;
  const droppedOffscreen = lines.filter((l, i) => rank(l) === 2 && !chosen.has(i)).length;

  const trailer: string[] = [];
  if (droppedVisible > 0) {
    trailer.push(`… ${droppedVisible} more element(s) on screen did not fit`);
  }
  if (droppedOffscreen > 0) {
    trailer.push(
      `… ${droppedOffscreen} more element(s) are on the page but off screen; scroll to bring them into view`,
    );
  }
  if (droppedDialog > 0) {
    trailer.push(`… ${droppedDialog} element(s) inside the open dialog did not fit`);
  }

  return [
    `URL: ${capture.url}`,
    `Title: ${capture.title}`,
    // On an application shell the window never moves, so reporting its offset
    // told the planner "0 of 900" on an inbox thousands of rows deep.
    `Scroll: ${capture.viewport.contentScrollY ?? capture.viewport.scrollY} of ` +
      `${capture.viewport.contentHeight ?? capture.viewport.pageHeight}` +
      (capture.viewport.contentHeight !== undefined ? " (this page scrolls an inner panel)" : ""),
    dialogOpen
      ? "A dialog is open and is listed first below. Work inside it; the page behind it is not interactive."
      : "",
    "",
    "Elements:",
    ...shown.map((l) => l.text),
    ...trailer,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Rewrites the user's request into the same tokens the page carries.
 *
 * Without this the scheme collapses. The planner would be told to "forward the
 * invoice from Sharma Traders" while the page reads `<ORG_3>`, and it could
 * never connect the two - the tokens would be noise rather than join keys.
 *
 * This does not detect PII in the request. It aligns the request with what the
 * vault already knows, which is a deliberately smaller job: a name the page
 * never showed has no token to align with, and passing it through unchanged is
 * correct, because it came from the user rather than from a website.
 */
export function alignTask(task: string, known: { value: string; token: string }[]): string {
  // People do not type a company's legal form. The page says "Sharma Traders
  // Pvt Ltd"; the request says "Sharma Traders". Matching only the exact stored
  // string breaks the join on precisely the case this is for, so each known
  // value also contributes an alias with one trailing legal form removed.
  //
  // Only the legal form is stripped, never a trade word - taking "Traders" off
  // as well would leave "Sharma", and a surname is far too common to map onto
  // a company token.
  const expanded = known.flatMap((entry) => {
    const alias = entry.value.replace(LEGAL_FORM, "").trim();
    return alias !== entry.value && alias.length >= 3
      ? [entry, { value: alias, token: entry.token }]
      : [entry];
  });

  // Longest first, so "Sharma Traders" wins over the "Sharma" inside it.
  const sorted = expanded.sort((a, b) => b.value.length - a.value.length);

  let out = task;
  for (const { value, token } of sorted) {
    if (!alignable(value)) continue;
    const pattern = new RegExp(`(?<!\\p{L})${escapeRegex(value)}(?!\\p{L})`, "giu");
    out = out.replace(pattern, token);
  }
  return out;
}

/**
 * May this value be substituted into text the user wrote?
 *
 * Alignment is a literal replace, so a value that is also an ordinary English
 * word rewrites the instruction rather than protecting it. This is the guard
 * that was missing when "you" - harvested from Gmail's "me, you" participant
 * list - turned "the oldest sender you can see" into "the oldest sender
 * <NAME_21> can see".
 *
 * A multi-word value is safe even if one of its words is common: "Bank of
 * Baroda" means the bank wherever it appears. Only a single common word is
 * refused.
 */
export function alignable(value: string): boolean {
  const trimmed = value.trim();
  // Two characters match far too much to be worth aligning.
  if (trimmed.length < 3) return false;
  if (/\s/.test(trimmed)) return true;
  return !NEVER_ALIGN.has(trimmed.toLowerCase().replace(/[^\p{L}]/gu, ""));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import type { CapturedNode, DomCapture } from "../capture/types";

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
 * Renders a sanitized page for the planner.
 *
 * Element ids survive untouched. They are how the planner acts, they are
 * meaningless outside this session, and they say nothing about anyone - so
 * tokenizing them would cost the agent its only way to point at things and buy
 * no privacy at all.
 */
export function renderPage(capture: DomCapture): string {
  const lines: string[] = [];

  const render = (node: CapturedNode, depth: number): void => {
    const indent = "  ".repeat(Math.min(depth, 8));
    const label = node.label || node.text || "";
    const structural = node.role === "generic" || node.role === "document";

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

      lines.push(parts.join(" "));
    }

    for (const child of node.children) render(child, depth + 1);
  };

  render(capture.root, 0);

  const shown = lines.slice(0, MAX_LINES);
  const trailer =
    lines.length > MAX_LINES
      ? `… ${lines.length - MAX_LINES} more elements below; scroll to bring them into view`
      : "";

  return [
    `URL: ${capture.url}`,
    `Title: ${capture.title}`,
    `Scroll: ${capture.viewport.scrollY} of ${capture.viewport.pageHeight}`,
    "",
    "Elements:",
    ...shown,
    trailer,
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
    // Two characters match far too much to be worth aligning.
    if (value.length < 3) continue;
    const pattern = new RegExp(`(?<!\\p{L})${escapeRegex(value)}(?!\\p{L})`, "giu");
    out = out.replace(pattern, token);
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

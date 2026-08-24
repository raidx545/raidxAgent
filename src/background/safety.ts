import type { AgentAction } from "../shared/types";
import type { CapturedNode, DomCapture } from "../capture/types";
import { allText, findNode } from "../capture/dom";

/**
 * Field kinds we refuse to fill regardless of what the planner asked for.
 * The user types these themselves; the agent never handles them.
 */
const CREDENTIAL_PATTERNS = [
  /\bpassword\b/i,
  /\bpasscode\b/i,
  /\bcvv\b/i,
  /\bcvc\b/i,
  /\bcard\s*number\b/i,
  /\bcredit\s*card\b/i,
  /\bdebit\s*card\b/i,
  /\bexpiry\b/i,
  /\bssn\b/i,
  /\bsocial\s*security\b/i,
  /\baadhaar\b/i,
  /\bpan\s*(card|number)\b/i,
  /\bpassport\b/i,
  /\bifsc\b/i,
  /\baccount\s*number\b/i,
  /\bone[-\s]?time\s*(code|password)\b/i,
  /\botp\b/i,
  /\bapi[-\s]?key\b/i,
  /\bsecret\b/i,
];

/** Wording on a control that means the click has consequences off this page. */
const IRREVERSIBLE_PATTERNS = [
  /\b(buy|purchase|place\s*order|checkout|pay|payment)\b/i,
  /\b(send|reply|forward|post|publish|tweet|share)\b/i,
  /\b(delete|remove|discard|erase|deactivate|close\s*account)\b/i,
  /\b(confirm|submit|book\s*now|reserve|apply\s*now)\b/i,
  /\b(transfer|withdraw|donate|subscribe|upgrade)\b/i,
  /\b(sign\s*up|create\s*account|register)\b/i,
  /\b(accept|agree)\b/i,
];

export type Gate =
  | { verdict: "allow" }
  | { verdict: "refuse"; reason: string }
  | { verdict: "confirm"; summary: string };

function elementOf(capture: DomCapture | undefined, id: unknown): CapturedNode | undefined {
  if (!capture || typeof id !== "number") return undefined;
  return findNode(capture.root, id);
}

/** The words a page uses for an element, for matching against risk patterns. */
function describe(node: CapturedNode): string {
  return [node.label, node.text, node.attrs.name, node.attrs.placeholder, node.attrs["aria-label"]]
    .filter(Boolean)
    .join(" ");
}

function looksCredential(node: CapturedNode | undefined): boolean {
  if (!node) return false;
  if (node.role === "password") return true;
  if ((node.attrs.type ?? "").toLowerCase() === "password") return true;
  return CREDENTIAL_PATTERNS.some((p) => p.test(`${describe(node)} ${node.attrs.type ?? ""}`));
}

/**
 * Decides whether an action runs, needs the user's sign-off, or is refused
 * outright. Runs before every action — the planner's own judgement is a
 * suggestion, not the authority.
 */
export function gate(
  action: AgentAction,
  capture: DomCapture | undefined,
  confirmRisky: boolean,
): Gate {
  const el = elementOf(capture, action.input.element_id);

  if (action.name === "type") {
    if (looksCredential(el)) {
      return {
        verdict: "refuse",
        reason:
          `Refusing to type into ${JSON.stringify(el ? describe(el).slice(0, 40) : "this field")} — it looks like a ` +
          `credential or payment field. Tell the user to fill it in themselves, then continue ` +
          `once they confirm they have.`,
      };
    }
    // Catch secrets being typed into an innocuously-named field.
    const text = String(action.input.text ?? "");
    if (/^(sk-|ghp_|xox[baprs]-|AKIA)/.test(text) || /\b\d{13,19}\b/.test(text.replace(/[\s-]/g, ""))) {
      return {
        verdict: "refuse",
        reason:
          "Refusing to type that value — it looks like an API key or a card number. " +
          "The user should enter it themselves.",
      };
    }
  }

  if (!confirmRisky) return { verdict: "allow" };

  if (action.name === "click" && el) {
    const label = `${describe(el)} ${el.role}`;
    if (IRREVERSIBLE_PATTERNS.some((p) => p.test(label))) {
      return {
        verdict: "confirm",
        summary: `Click ${JSON.stringify(describe(el).slice(0, 60))} on ${capture?.title ?? "this page"}?`,
      };
    }
  }

  if (action.name === "type" && action.input.submit === true && el) {
    // Submitting a form is only risky when the form is not obviously a search.
    const isSearch = /search|query|find|filter/i.test(`${describe(el)} ${el.role}`);
    if (!isSearch) {
      return {
        verdict: "confirm",
        summary:
          `Fill ${JSON.stringify(describe(el).slice(0, 40))} and submit the form on ` +
          `${capture?.title ?? "this page"}?`,
      };
    }
  }

  return { verdict: "allow" };
}

/**
 * Page text can contain instructions aimed at an AI agent. We do not act on
 * them, and we tell the user when we see them.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /\b(system\s*prompt|you\s+are\s+now)\b/i,
  /\bas\s+an?\s+ai\s+(agent|assistant)[,:]/i,
  /\bdisregard\s+(your|the)\s+(instructions|rules)/i,
];

export function detectInjection(capture: DomCapture): string | undefined {
  const text = allText(capture.root);
  const hit = INJECTION_PATTERNS.find((p) => p.test(text));
  if (!hit) return undefined;
  return text.match(hit)?.[0];
}

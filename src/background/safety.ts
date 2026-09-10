import type { AgentAction } from "../shared/types";
import type { CapturedNode, DomCapture } from "../capture/types";
import { allText, findNode } from "../capture/dom";

/**
 * Field kinds we refuse to fill regardless of what the planner asked for.
 * The user types these themselves; the agent never handles them.
 */
/**
 * Secrets. The agent never needs these and must never type one.
 *
 * The test is whether the value authenticates or authorises. A password, a
 * one-time code, a CVV: knowing it is the whole of the permission it grants, so
 * an agent that can type it can be tricked into granting that permission.
 * Refusal here is unconditional and not affected by any setting.
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
  /\bone[-\s]?time\s*(code|password)\b/i,
  /\botp\b/i,
  /\bapi[-\s]?key\b/i,
  /\bsecret\b/i,
  /\bsecurity\s*(code|answer)\b/i,
];

/**
 * Identifiers. These are asked for, not used to prove anything.
 *
 * Aadhaar, PAN, passport, account number - a form legitimately wants them and
 * filling them in is much of what an agent is for on an Indian government or
 * banking site. Refusing outright, as this once did, made those pages
 * impossible: the single most valuable thing the agent could do was the one
 * thing it would not.
 *
 * They are still not ordinary. Every one is confirmed with the user, whatever
 * the confirmation setting says, and the value is resolved from the vault at
 * the keystroke - so it reaches the field without ever reaching the model.
 */
const IDENTIFIER_PATTERNS = [
  /\baadhaar\b/i,
  /\baadhar\b/i,
  /\bpan\s*(card|number)\b/i,
  /\bpermanent\s*account\b/i,
  /\bpassport\b/i,
  /\bssn\b/i,
  /\bsocial\s*security\b/i,
  /\bifsc\b/i,
  /\baccount\s*number\b/i,
  /\bvoter\s*(id|card)\b/i,
  /\bdriving\s*licen[cs]e\b/i,
  /\bgstin?\b/i,
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

function looksIdentifier(node: CapturedNode | undefined): boolean {
  if (!node) return false;
  return IDENTIFIER_PATTERNS.some((p) => p.test(`${describe(node)} ${node.attrs.name ?? ""}`));
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
    // Identifiers are settled first, and the order is load-bearing: "PAN Card
    // Number" contains "card number", so a secrets-first test refuses India's
    // tax identifier as though it were a payment card - and refusing it makes
    // every government form impossible.
    if (looksIdentifier(el)) {
      return {
        verdict: "confirm",
        summary:
          `Fill ${JSON.stringify(el ? describe(el).slice(0, 40) : "this field")} with the ` +
          `identifier it asks for?`,
      };
    }

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
    // Pressing Enter in a text box is usually how you *fill in* a form, not how
    // you commit it. Composing a message means typing a recipient and pressing
    // Enter to turn it into a chip, then a subject, then a body - three
    // confirmations for three keystrokes that change nothing outside the draft,
    // before the one that matters.
    //
    // What actually needs approval is the click on Send, Pay or Delete, and
    // that is caught above by the click rule. Credential fields are refused
    // outright regardless. So this rule only has to cover the case where Enter
    // itself commits something: an unknown form with no obvious entry purpose.
    const ordinaryEntry =
      /search|query|find|filter|recipient|\bto\b|\bcc\b|\bbcc\b|subject|message|body|compose|note|comment|description|title/i.test(
        `${describe(el)} ${el.role}`,
      );
    if (!ordinaryEntry) {
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

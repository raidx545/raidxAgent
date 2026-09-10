import { gate } from "../src/background/safety";
import type { CapturedNode, DomCapture } from "../src/capture/types";
import type { AgentAction } from "../src/shared/types";

/**
 * What the safety gate asks about, and what it lets through.
 *
 * Two tasks stalled on this: "search for that mail and forward it" and "write a
 * mail to this person". Composing a message means typing a recipient and
 * pressing Enter to commit the chip, then a subject, then a body - and every
 * one of those was raising a confirmation. Three questions for three keystrokes
 * that change nothing outside a draft, before the one keystroke that matters.
 *
 * The gate has to stay firm on the action that actually sends, and get out of
 * the way of the ones that fill in a form.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 200, 20], visible: true, children: [], ...p,
});

/** A compose window, with the fields a mail client actually has. */
function compose(): DomCapture {
  id = 0;
  const nodes = [
    n({ tag: "input", role: "combobox", label: "To recipients", attrs: { "aria-label": "To recipients" } }),
    n({ tag: "input", role: "textbox", label: "Subject" }),
    n({ tag: "div", role: "textbox", label: "Message Body" }),
    n({ tag: "input", role: "textbox", label: "Search mail" }),
    n({ tag: "button", role: "button", text: "Send" }),
    n({ tag: "button", role: "button", text: "Discard draft" }),
    n({ tag: "input", role: "password", label: "Password", attrs: { type: "password" } }),
    // An unknown form: Enter here really might commit something.
    n({ tag: "input", role: "textbox", label: "Transfer amount" }),
    n({ tag: "input", role: "textbox", label: "Aadhaar Number", attrs: { name: "aadhaar_no" } }),
    n({ tag: "input", role: "textbox", label: "PAN Card Number", attrs: { name: "pan_card" } }),
    n({ tag: "input", role: "textbox", label: "Card number", attrs: { autocomplete: "cc-number" } }),
    n({ tag: "input", role: "textbox", label: "Display name" }),
  ];
  return {
    url: "https://mail.example.com/u/0/#inbox",
    origin: "https://mail.example.com",
    title: "Inbox",
    capturedAt: Date.now(),
    viewport: { width: 1400, height: 900, dpr: 2, scrollX: 0, scrollY: 0, pageHeight: 2000 },
    root: n({ tag: "body", role: "document", children: nodes }),
    stats: { examined: 20, kept: 9, pruned: 11 },
  };
}

const page = compose();
const byLabel = (label: string): number => {
  const walk = (x: CapturedNode): CapturedNode | undefined =>
    x.label === label || x.text === label ? x : x.children.map(walk).find(Boolean);
  const hit = walk(page.root);
  if (!hit) throw new Error(`fixture: no element labelled ${label}`);
  return hit.id;
};

const verdict = (action: AgentAction) => gate(action, page, true).verdict;

// ------------------------------------- filling in a draft must not interrupt

for (const field of ["To recipients", "Subject", "Message Body"]) {
  want(
    verdict({ name: "type", input: { element_id: byLabel(field), text: "x", submit: true } }) ===
      "allow",
    `typing into "${field}" and pressing Enter asked for confirmation — this is what stalled compose`,
  );
}

want(
  verdict({ name: "type", input: { element_id: byLabel("Search mail"), text: "x", submit: true } }) ===
    "allow",
  "searching asked for confirmation",
);

// -------------------------------------------- but the send still must not go

want(
  verdict({ name: "click", input: { element_id: byLabel("Send") } }) === "confirm",
  "clicking Send did NOT ask for confirmation — this is the whole point of the gate",
);
want(
  verdict({ name: "click", input: { element_id: byLabel("Discard draft") } }) === "confirm",
  "discarding a draft did not ask for confirmation",
);

// An unfamiliar form where Enter could commit something is still gated.
want(
  verdict({ name: "type", input: { element_id: byLabel("Transfer amount"), text: "500", submit: true } }) ===
    "confirm",
  "an unknown form was submitted without asking",
);

// ------------------------------------------------- credentials stay refused

want(
  verdict({ name: "type", input: { element_id: byLabel("Password"), text: "hunter2" } }) === "refuse",
  "a password field was not refused",
);

// Narrowing the submit rule must not have narrowed the credential rule: even
// with confirmation turned off entirely, a password is still refused.
want(
  gate({ name: "type", input: { element_id: byLabel("Password"), text: "hunter2" } }, page, false)
    .verdict === "refuse",
  "a password was allowed once confirmation was switched off",
);

// And with confirmation off, an ordinary click is not gated.
want(
  gate({ name: "click", input: { element_id: byLabel("Send") } }, page, false).verdict === "allow",
  "the confirmation setting had no effect on clicks",
);

// --------------------------- identifiers are confirmed, secrets are refused
//
// Refusing an identifier outright made every government form impossible: the
// most valuable thing the agent could do was the one thing it would not.

for (const field of ["Aadhaar Number", "PAN Card Number"]) {
  want(
    verdict({ name: "type", input: { element_id: byLabel(field), text: "x" } }) === "confirm",
    `"${field}" was not confirmed — refusing it blocks form filling, allowing it is too loose`,
  );
  // And the confirmation is not a convenience setting: it holds either way.
  want(
    gate({ name: "type", input: { element_id: byLabel(field), text: "x" } }, page, false)
      .verdict === "confirm",
    `"${field}" was allowed silently once confirmation was switched off`,
  );
}

// The order of the two checks matters: "PAN Card Number" contains "card
// number", so a secrets-first test refuses India's tax identifier as a payment
// card. A real payment card must still be refused.
want(
  verdict({ name: "type", input: { element_id: byLabel("Card number"), text: "4111" } }) === "refuse",
  "a real card number was not refused",
);

console.log(JSON.stringify({
  identifiers: ["Aadhaar Number","PAN Card Number","Card number"].map(
    (f) => `${f}: ${verdict({ name: "type", input: { element_id: byLabel(f), text: "x" } })}`,
  ),
  composeFieldsAllowed: ["To recipients", "Subject", "Message Body"].map(
    (f) => `${f}: ${verdict({ name: "type", input: { element_id: byLabel(f), text: "x", submit: true } })}`,
  ),
  sendStillGated: verdict({ name: "click", input: { element_id: byLabel("Send") } }),
  unknownFormStillGated: verdict({
    name: "type",
    input: { element_id: byLabel("Transfer amount"), text: "500", submit: true },
  }),
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

import { alignTask, alignable } from "../src/background/wire";
import { detect } from "../src/pii/detect";
import type { CapturedNode, DomCapture } from "../src/capture/types";

/**
 * Aligning the user's request with the page must not rewrite the request.
 *
 * Alignment is a literal find-and-replace of vault values, so it is only as
 * safe as the values in the vault - and a vault holds whatever the page called
 * a person. Gmail lists a thread's participants as "me, you", so "you" was
 * learnt as a name, and this happened:
 *
 *   asked: "scroll to the bottom of my inbox and tell me the oldest sender
 *           you can see"
 *   sent:  "... the oldest sender <NAME_21> can see"
 *
 * The instruction was destroyed by the layer meant to protect it, and the model
 * was left answering a question nobody asked. Length alone cannot prevent this:
 * "Raj" is three letters and is a name.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

// -------------------------------------------------- the failure, reproduced

const vault = [
  { value: "you", token: "<NAME_21>" },
  { value: "me", token: "<NAME_22>" },
  { value: "Priya Sharma", token: "<NAME_1>" },
  { value: "Raj", token: "<NAME_2>" },
  { value: "Sharma Traders Pvt Ltd", token: "<ORG_1>" },
  { value: "Bank of Baroda", token: "<ORG_2>" },
  { value: "mail", token: "<ORG_9>" },
];

const asked = "scroll to the bottom of my inbox and tell me the oldest sender you can see";
const sent = alignTask(asked, vault);

want(sent === asked, `the request was rewritten:\n  asked: ${asked}\n  sent:  ${sent}`);
want(!sent.includes("<NAME_21>"), '"you" was replaced by a token');
want(!sent.includes("<NAME_22>"), '"me" was replaced by a token');
want(!sent.includes("<ORG_9>"), '"mail" was replaced by a token');

// -------------------------------------- but real entities are still aligned

const real = alignTask("forward the invoice from Sharma Traders to Priya Sharma", vault);
want(real.includes("<ORG_1>"), `the company was not aligned: ${real}`);
want(real.includes("<NAME_1>"), `the person was not aligned: ${real}`);
want(!real.includes("Sharma"), `a real name survived alignment: ${real}`);

// A three-letter name is still a name.
want(alignTask("tell Raj about it", vault).includes("<NAME_2>"), "a short real name was not aligned");

// A multi-word value containing a common word is safe: it means the entity.
want(
  alignTask("pay Bank of Baroda", vault).includes("<ORG_2>"),
  "a multi-word organisation containing a common word was not aligned",
);

// ------------------------------------------------------- the predicate itself

for (const word of ["you", "me", "my", "it", "the", "and", "one", "email", "reply", "no"]) {
  want(!alignable(word), `"${word}" is treated as alignable`);
}
for (const value of ["Raj", "Priya Sharma", "Bank of Baroda", "9876543210", "priya@example.in"]) {
  want(alignable(value), `"${value}" is refused for alignment`);
}
// Case must not be a way around it.
want(!alignable("You") && !alignable("YOU"), "capitalisation defeats the guard");

// ------------------------------- and the value should not enter the vault

// A participant field whose value is "you" is not a name, and tier 1 - which
// has no plausibility check of its own - used to tokenize it anyway.
// Ids are explicit: the tree literal builds children before the root, so an
// auto-incrementing id numbers them in the opposite order to the one that reads
// naturally - and the assertions below name a node.
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: 0, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 100, 20], visible: true, children: [], ...p,
});

const YOU_FIELD = 1;
const NAME_FIELD = 2;

const page: DomCapture = {
  url: "https://mail.example.com/", origin: "https://mail.example.com", title: "Inbox",
  capturedAt: 1,
  viewport: { width: 1000, height: 800, dpr: 1, scrollX: 0, scrollY: 0, pageHeight: 800 },
  root: n({ id: 0, tag: "body", role: "document", children: [
    n({ id: YOU_FIELD, tag: "input", role: "textbox", label: "Display name", value: "you" }),
    n({ id: NAME_FIELD, tag: "input", role: "textbox", label: "Display name", value: "Priya Sharma" }),
  ]}),
  stats: { examined: 3, kept: 3, pruned: 0 },
};

const found = await detect(page);
const names = found.findings.filter((f) => f.kind === "person_name");

want(!names.some((f) => f.value === "you"), '"you" was captured as a name value from a field');
want(names.some((f) => f.value === "Priya Sharma"), "a real name in the same kind of field was lost");

// The field itself is still reported - the planner has to be able to see the
// form - it simply has nothing worth tokenizing, so it is sealed rather than
// replaced.
const emptied = names.find((f) => f.nodeId === YOU_FIELD && f.tier === 1);
want(!!emptied, "the field whose value was refused vanished from the findings entirely");
want(emptied?.value === undefined, `the refused value came back as ${JSON.stringify(emptied?.value)}`);

console.log(JSON.stringify({
  asked, sent,
  aligned: real,
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

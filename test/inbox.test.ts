import { detect, setEntityOptions } from "../src/pii/detect";
import { sanitize } from "../src/sanitize/sanitize";
import { Vault } from "../src/vault/vault";
import type { CapturedNode, DomCapture, Capture } from "../src/capture/types";
import type { Finding } from "../src/pii/types";

/**
 * An inbox is the hard case, and the one the project is actually aimed at.
 *
 * Every row carries a person's name with none of the signals the entity tier
 * normally relies on: no honorific, no cue phrase, no labelled field, and a
 * subject line that is prose rather than a form. Nothing in tiers 1 or 2 fires,
 * and a bare capitalised-words rule would tokenize half the interface.
 *
 * What saves it is that mail clients annotate the sender element with the
 * address - Gmail, Outlook, Slack and LinkedIn all do - so the page names the
 * person for us. This fixture mirrors that markup and checks we read it.
 */

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 400, 24], visible: true, children: [], ...p,
});

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

/** One inbox row, marked up the way a real client does. */
function row(sender: string, email: string, subject: string, snippet: string): CapturedNode {
  return n({
    tag: "tr",
    children: [
      n({ tag: "span", attrs: { email, name: sender }, text: sender }),
      n({ tag: "span", text: subject }),
      n({ tag: "span", text: snippet }),
    ],
  });
}

function build(): DomCapture {
  id = 0;
  const rows = [
    row("Ananya Bhatt", "ananya.bhatt@example.in",
        "Up to EUR 80K in funding for your deep-tech startup", "Apply Today!"),
    row("Shashank Tomar", "shashank@example.com",
        "Re: FIX : Working, remove some bugs (PR #1)",
        "shashank-tomar0 left a comment on the pull request."),
    row("Prachi Gupta", "prachi.gupta@example.in",
        "Turn your momentum into a campus leadership role!", "Apply Now!"),
    // A brand, not a person: the annotation says so and the name is an org.
    row("Devpost", "noreply@devpost.com",
        "Join Google Cloud & Partners for a Summer Hackathon",
        "Hey Raaz, ready to direct the next generation of AI?"),
    // Devanagari body text with a Latin name inside it.
    n({
      tag: "tr",
      children: [
        n({ tag: "span", attrs: { email: "notify@facebook.com", name: "Facebook" }, text: "Facebook" }),
        n({ tag: "span", text: "Mansi और अन्य लोगों से जुड़ें: उनसे संबंधित 2 अपडेट देखें" }),
        n({ tag: "span", text: "Raidx, आपके लिए Mansi Gupta की ओर से आए नोटिफ़िकेशन देखें." }),
      ],
    }),
    // Chrome-shaped decoys: interface furniture that must stay readable.
    n({ tag: "span", text: "Compose" }),
    n({ tag: "span", text: "Inbox" }),
    n({ tag: "span", text: "Search mail" }),
    n({ tag: "span", text: "Happening soon" }),
    n({ tag: "span", text: "Train trip with Indian Railways" }),
  ];

  return {
    url: "https://mail.example.com/u/0/#inbox",
    origin: "https://mail.example.com",
    title: "Inbox",
    capturedAt: Date.now(),
    viewport: { width: 1400, height: 900, dpr: 2, scrollX: 0, scrollY: 0, pageHeight: 1200 },
    root: n({ tag: "body", role: "document", children: rows }),
    stats: { examined: 60, kept: 30, pruned: 30 },
  };
}

setEntityOptions({ aggressive: false });
const found = await detect(build());

const named = (kind: string): (string | undefined)[] =>
  found.findings.filter((f: Finding) => f.kind === kind).map((f) => f.value);

const people = named("person_name");
const emails = named("email");

// --- senders must be found, from the annotation alone ----------------------
for (const sender of ["Ananya Bhatt", "Shashank Tomar", "Prachi Gupta"]) {
  want(people.includes(sender),
    `sender "${sender}" was not detected: ${JSON.stringify([...new Set(people)])}`);
}

// --- the annotated addresses must be found too -----------------------------
want(emails.includes("ananya.bhatt@example.in"),
  `an address in an email= attribute was not detected: ${JSON.stringify(emails)}`);

// --- a Latin name inside Devanagari text -----------------------------------
want(people.includes("Mansi Gupta"),
  `a name inside non-Latin text was missed: ${JSON.stringify([...new Set(people)])}`);

// --- a robot address is a brand, not a person ------------------------------
want(named("org_name").includes("Devpost"),
  `a no-reply sender was classified as a person: ${JSON.stringify([...new Set(people)])}`);
want(!people.includes("Devpost"), "Devpost was also reported as a person");

// --- interface furniture must survive --------------------------------------
for (const chrome of ["Compose", "Inbox", "Search mail", "Happening soon"]) {
  want(!people.includes(chrome), `interface text "${chrome}" was reported as a name`);
}

// --- end to end: nothing leaks, the interface still reads ------------------
const capture: Capture = { dom: build() };
const vault = new Vault();
const out = await sanitize(capture, vault);
const wire = JSON.stringify(out.dom);

for (const secret of [
  "Ananya Bhatt", "Shashank Tomar", "Prachi Gupta", "Mansi Gupta",
  "ananya.bhatt@example.in", "prachi.gupta@example.in",
]) {
  if (wire.includes(secret)) fails.push(`LEAK: "${secret}" survived into the output`);
}

want(out.report.residual.length === 0,
  `residual: ${out.report.residual.map((f) => f.kind + "=" + f.masked).join(", ")}`);

// The agent still has to be able to use this page.
for (const keep of ["Compose", "Inbox", "Search mail", "Apply Now!"]) {
  want(wire.includes(keep), `the interface lost "${keep}" and is no longer usable`);
}

// Token stability is what makes this usable at all: the same person seen in the
// sender cell and in a snippet must carry one token, or the planner cannot join
// "the mail from X" to the row showing X.
const tokens = [...wire.matchAll(/<NAME_\d+>/g)].map((m) => m[0]);
const distinct = new Set(tokens);
want(distinct.size <= people.length,
  `more tokens than names: ${distinct.size} tokens for ${new Set(people).size} names`);

console.log(JSON.stringify({
  detectedPeople: [...new Set(people)],
  detectedEmails: [...new Set(emails)],
  tokensInOutput: [...distinct].sort(),
  sampleRow: (() => {
    const walk = (x: CapturedNode): CapturedNode[] => [x, ...x.children.flatMap(walk)];
    return walk(out.dom.root).map((x) => x.text).filter(Boolean).slice(0, 6);
  })(),
  failures: fails,
  pass: fails.length === 0,
}, null, 2));

import { detect, setEntityOptions } from "../src/pii/detect";
import type { CapturedNode, DomCapture } from "../src/capture/types";
import type { Finding } from "../src/pii/types";

/**
 * Entity detection is the one tier with no checksum behind it, so it is judged
 * on both halves: what it catches, and what it leaves alone. The decoy block is
 * as important as the positive block - a name detector that fires on "Privacy
 * Policy" makes every page unreadable to the planner.
 */

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 100, 20], visible: true, children: [], ...p,
});

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

async function scan(nodes: CapturedNode[], aggressive = false): Promise<Finding[]> {
  setEntityOptions({ aggressive });
  const capture: DomCapture = {
    url: "https://example.in/p", origin: "https://example.in", title: "t",
    capturedAt: Date.now(),
    viewport: { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0, pageHeight: 2000 },
    root: n({ tag: "body", role: "document", children: nodes }),
    stats: { examined: 1, kept: 1, pruned: 0 },
  };
  const result = await detect(capture);
  return result.findings;
}

const textOf = (fs: Finding[], kind: string) =>
  fs.filter((f) => f.kind === kind).map((f) => f.value);

// ---------------------------------------------------------------- positives

{
  const found = await scan([
    // A labelled name field seeds the gazetteer...
    n({ tag: "input", role: "textbox", label: "Full Name",
        attrs: { autocomplete: "name" }, value: "Priya Sharma" }),
    // ...so this bare mention elsewhere must also be caught.
    n({ tag: "p", text: "Priya Sharma approved the request on Tuesday." }),
    n({ tag: "p", text: "Escalate to Dr. Anil Kumar Verma before Friday." }),
    n({ tag: "p", text: "Dear Rajesh, your order has shipped." }),
    n({ tag: "p", text: "Billed to: Sharma Traders Pvt Ltd" }),
    n({ tag: "p", text: "Vendor: Verma Exports and Imports LLP handles the shipment." }),
    n({ tag: "address", text: "42 MG Road, Indiranagar, Bengaluru, Karnataka 560038" }),
    n({ tag: "p", text: "Deliver to 17/B Nehru Nagar, Pune 411014, Maharashtra." }),
  ]);

  const names = textOf(found, "person_name");
  const orgs = textOf(found, "org_name");
  const addrs = textOf(found, "postal_address");
  const pins = textOf(found, "pincode");

  want(names.filter((x) => x === "Priya Sharma").length >= 2,
    `gazetteer did not propagate "Priya Sharma" to prose: ${JSON.stringify(names)}`);
  want(names.some((x) => x?.includes("Anil Kumar Verma")),
    `honorific name missed: ${JSON.stringify(names)}`);
  want(names.some((x) => x === "Rajesh"), `cue name missed: ${JSON.stringify(names)}`);
  want(orgs.some((x) => x?.includes("Sharma Traders")),
    `org with legal suffix missed: ${JSON.stringify(orgs)}`);
  want(orgs.some((x) => x?.includes("Verma Exports")),
    `org with connector word missed: ${JSON.stringify(orgs)}`);
  want(addrs.some((x) => x?.includes("MG Road")),
    `<address> element missed: ${JSON.stringify(addrs)}`);
  want(addrs.some((x) => x === "17/B Nehru Nagar"),
    `street address did not include the house number: ${JSON.stringify(addrs)}`);
  want(pins.some((x) => x === "411014"), `PIN beside a city missed: ${JSON.stringify(pins)}`);
}

// ---------------------------------------------------------- email -> name

{
  const found = await scan([
    n({ tag: "input", role: "textbox", label: "Email",
        attrs: { type: "email" }, value: "meera.iyer@example.in" }),
    n({ tag: "p", text: "The ticket was reassigned to Meera Iyer this morning." }),
  ]);
  want(textOf(found, "person_name").some((x) => x === "Meera Iyer"),
    `name inferred from an email local part was not applied: ${JSON.stringify(textOf(found, "person_name"))}`);
}

// ------------------------------------------------------------- microdata

{
  const found = await scan([
    n({ tag: "span", text: "Kavya Reddy",
        attrs: { itemprop: "name", itemtype: "https://schema.org/Person" } }),
    n({ tag: "p", text: "Kavya Reddy filed three reports." }),
  ]);
  want(textOf(found, "person_name").filter((x) => x === "Kavya Reddy").length >= 2,
    `microdata name not harvested: ${JSON.stringify(textOf(found, "person_name"))}`);
}

// ------------------------------------------------------------------ decoys

{
  const found = await scan([
    n({ tag: "p", text: "Privacy Policy and Terms of Service apply to all users." }),
    n({ tag: "p", text: "Total Amount Due is shown in the Order Summary below." }),
    n({ tag: "p", text: "Monday Tuesday Wednesday are covered by this Shipping Policy." }),
    n({ tag: "p", text: "Click Here to Learn More about our Premium Plan." }),
    n({ tag: "h2", text: "Frequently Asked Questions" }),
    n({ tag: "p", text: "Contact Support for help with your Account Settings." }),
    n({ tag: "p", text: "New Delhi and Mumbai are served by this route." }),
  ]);

  const noisy = found.filter((f) => f.kind === "person_name" || f.kind === "org_name");
  want(noisy.length === 0,
    `false positives on ordinary capitalised text: ${JSON.stringify(noisy.map((f) => f.kind + "=" + f.value))}`);
}

// --------------------------------------------- overlap with earlier tiers

{
  const found = await scan([
    n({ tag: "p", text: "Write to Priya Sharma at priya.sharma@example.in today." }),
  ]);
  const email = found.find((f) => f.kind === "email");
  const names = found.filter((f) => f.kind === "person_name");
  want(!!email, "email finding disappeared once entities ran");
  // The name inside the email address must not be reported separately.
  for (const name of names) {
    if (!name.span || !email?.span) continue;
    const overlaps = name.span[0] < email.span[1] && name.span[1] > email.span[0];
    want(!overlaps, `entity finding overlaps the email span: ${name.value}`);
  }
}

// ------------------------------------------------ aggressive mode is opt-in

{
  const quiet = await scan([n({ tag: "p", text: "Ananya Krishnan attended the review." })], false);
  const loud = await scan([n({ tag: "p", text: "Ananya Krishnan attended the review." })], true);
  want(textOf(quiet, "person_name").length === 0,
    "an unlabelled bare name fired without aggressive mode");
  want(textOf(loud, "person_name").some((x) => x === "Ananya Krishnan"),
    `aggressive mode did not catch a bare name: ${JSON.stringify(textOf(loud, "person_name"))}`);
  setEntityOptions({ aggressive: false });
}

// ----------------------------------------------- cross-origin frame regions

{
  const found = await scan([
    n({ tag: "iframe", role: "frame", attrs: { frameHost: "ads.example.com", crossOrigin: "true" },
        bbox: [0, 0, 300, 250] }),
    n({ tag: "iframe", role: "frame", attrs: { frameHost: "example.in", crossOrigin: "false" },
        bbox: [0, 300, 300, 250] }),
  ]);
  // Both frames must be burned. A same-origin frame is readable in principle,
  // but the content script never walks it, so its pixels are just as
  // uninspected as a cross-origin frame's.
  const frames = found.filter((f) => f.kind === "unverified_region");
  want(frames.length === 2,
    `expected both frames to be flagged, got ${frames.length}`);
  want(frames.every((f) => f.shape === "pixel" && f.action === "burn-region"),
    "an uninspected frame was not marked for burning");
  want(frames.some((f) => f.why.includes("same-origin")),
    "the same-origin frame was exempted despite never being walked");
}

console.log(JSON.stringify({ failures: fails, pass: fails.length === 0 }, null, 2));

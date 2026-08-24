# RAIDX Agent

A Chrome extension that operates the browser for you. You give it a goal in the
side panel; it reads the page, decides on one action, takes it, looks at what
changed, and repeats until the task is done — the same loop Comet and Atlas run.

This is the **baseline agent**. The PII tokenization layer from the SIH
architecture is not in it yet; see [Where the privacy layer goes](#where-the-privacy-layer-goes).

## Install

```bash
npm install && npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the `dist/` folder.

Open the extension's **Details → Extension options**, pick a provider, and paste
its API key. Keys live in `chrome.storage.local` and are only ever sent to the
provider you selected.

| Provider | Key from | Notes |
|---|---|---|
| Anthropic | console.anthropic.com | Default. Native tool-use. |
| OpenAI | platform.openai.com | Chat Completions with function calling. |
| OpenRouter | openrouter.ai | One key, 400+ models across vendors. |

Each provider's key and chosen model are remembered separately, so switching
back and forth costs nothing. The model field is free text — type any id the
provider accepts — and **Refresh list** pulls the live catalogue from the
provider so the bundled suggestions can't go stale on you.

Click the toolbar icon to open the side panel, then give it a task.

During development, `npm run dev` rebuilds on save; hit the reload icon on the
extension card to pick up changes.

## How it works

```
side panel ──task──▶ service worker ──▶ Claude ──tool call──▶ content script ──▶ page
     ▲                     │                ▲                        │
     └──── events ─────────┘                └──── fresh snapshot ────┘
```

Three isolated realms, talking only through the message types in
[`src/shared/types.ts`](src/shared/types.ts):

- **Content script** ([`perceive.ts`](src/content/perceive.ts),
  [`act.ts`](src/content/act.ts)) is the only code that touches the DOM. It
  flattens the page into a numbered list of interactive elements with accessible
  names, and executes clicks and keystrokes.
- **Service worker** ([`agent.ts`](src/background/agent.ts)) runs the planning
  loop and gates every action before it happens. It talks to a `Planner`
  interface, not to a vendor — the adapters in
  [`providers/`](src/background/providers) normalise Anthropic's content blocks
  and OpenAI's `tool_calls` into one shape, so the loop has no idea which
  provider is behind it.
- **Side panel** ([`sidepanel.ts`](src/sidepanel/sidepanel.ts)) streams the
  transcript and prompts for confirmations.

### The four decisions that make it work

**The model sees element ids, never selectors.** Each page read returns
`[12] link "Sign in" (href=github.com/login)`. The planner picks id 12; the
content script resolves it against the registry from that same read. The model
never writes a CSS selector or an XPath, so it cannot invent one.

**Ids die when the page changes.** After every action that could mutate the
page, the worker re-perceives and appends the fresh snapshot to the tool result.
A stale id resolves to nothing and returns an error telling the planner to read
the page again — rather than silently clicking the wrong element.

**Actions are replayed as real input.** A bare `el.click()` and `el.value = x`
are ignored by React and most modern frameworks. `act.ts` replays the full
pointer sequence, and writes input values through the native prototype setter so
React's value tracker doesn't swallow the event. This is verified against a
React-controlled input, not assumed.

**The gate runs before the action, not inside the prompt.**
[`safety.ts`](src/background/safety.ts) inspects every action against the
snapshot the model was looking at. Password, card, and ID fields are refused
outright — the prompt says so too, but the prompt is not the enforcement.
Irreversible-looking clicks pause for the user.

## What it will not do

Refused in code, regardless of what the task says:

- Typing into password, CVV, card-number, OTP, Aadhaar, PAN, or API-key fields
- Typing a value that pattern-matches a key or a card number

Paused for your approval (when *Ask before anything irreversible* is on):

- Clicking anything labelled buy, pay, send, post, delete, confirm, subscribe,
  sign up, or accept
- Submitting a form that isn't a search

Page text is treated as data. If a page contains text addressed to an AI agent,
the agent flags it in the transcript and keeps going rather than obeying it.

## Layout

```
src/
  manifest.json
  background/
    service-worker.ts   message routing, transcript, run lifecycle
    agent.ts            the perceive → plan → act → verify loop
    providers/
      types.ts          provider-neutral messages, tools, and turns
      anthropic.ts      content blocks ⇄ canonical
      openai.ts         tool_calls ⇄ canonical (OpenAI and OpenRouter)
      index.ts          picks the planner from settings
    tools.ts            the agent's entire action surface
    prompt.ts           system prompt
    executor.ts         routes actions to the page or the tabs API
    safety.ts           credential refusal, confirmation gate, injection detection
  content/
    perceive.ts         DOM → numbered element list
    act.ts              element id → real user input
    content.ts          message handler
  capture/
    types.ts            capture shapes: nodes, bboxes, viewport
    dom.ts              DOM -> pruned tree with roles, labels, bboxes
  pii/
    types.ts            findings, shapes, tiers, masking
    checksums.ts        Verhoeff, Luhn, PAN, GSTIN, IFSC, and friends
    tier1-dom.ts        what the page declares about its own fields
    tier2-patterns.ts   pattern, then checksum
    tier3-pixels.ts     image regions + the ML classifier seam
    detect.ts           runs the tiers, suppresses covered ground
  inspector/            standalone capture + detection UI
  sidepanel/            transcript UI
  options/              provider, keys, model, and preferences
  shared/
    types.ts            wire types and settings (with legacy migration)
    models.ts           provider catalogue and live model listing
```

## The capture &amp; PII layer

This is the privacy layer's foundation, built and testable **on its own** — it
runs no model and the agent loop does not call it yet. Open the side panel and
click **PII scan**, or load `inspector.html` directly.

### Capture

[`capture/dom.ts`](src/capture/dom.ts) builds a pruned DOM tree — roles,
accessible labels, own-text, form values, and a viewport-relative bbox per node.
Layout wrappers are dropped and their children hoisted, so a page that presents
~800 elements comes back as ~600 meaningful nodes with the shape intact.
[`background/inspect.ts`](src/background/inspect.ts) pairs that with a
`captureVisibleTab` screenshot, and the capture records `dpr`, scroll offset,
and viewport size so a bbox can be mapped onto screenshot pixels.

Password field contents are never read into the capture at all. The *existence*
of the field is the finding; its value is not needed and so is not taken.

### Detection: cheapest and most certain first

| Tier | Source | Cost | Certainty |
|---|---|---|---|
| 1 | [`tier1-dom.ts`](src/pii/tier1-dom.ts) — `autocomplete` tokens, `input[type]`, field names | ~free | highest |
| 2 | [`tier2-patterns.ts`](src/pii/tier2-patterns.ts) — regex, then a checksum | cheap | high |
| 3 | [`tier3-entities.ts`](src/pii/tier3-entities.ts) — names, orgs, addresses | cheap | high |
| 3 | [`tier3-pixels.ts`](src/pii/tier3-pixels.ts) — image regions | needs a model | heuristic today |

Tier 1 is first because it is both the cheapest *and* the most reliable: an
input carrying `autocomplete="cc-number"` is a payment field with certainty, no
matching required. Tier 2 only sees what tier 1 could not settle, and tier 3
only ever looks at image-shaped regions.

**The checksum is what makes tier 2 usable.** `\d{12}` matches a timestamp, an
order id, and an Aadhaar number alike. Measured over 100,000 random 12-digit
strings, the pattern alone fires on 100% and the Verhoeff check cuts that to
**10.07%** — and Verhoeff catches 100% of single-digit errors and 100% of
adjacent transpositions, which is exactly why UIDAI uses it over a mod-10 sum.
Implemented and verified: Verhoeff (Aadhaar), Luhn + brand (cards), PAN holder
type, GSTIN mod-36, IFSC, Indian mobile, passport, EPIC, vehicle registration.

Findings are **span-level** — `[start, end]` within one field — not whole
strings, so tokenization can swap `Sharma Traders` inside a sentence and leave
the sentence intact.

### Shape decides fate

Every finding carries `shape`, and this is the distinction the whole design
rests on: `text` can be tokenized and swapped back from the vault; `pixel` can
only be destroyed. Tier 3 sets a deliberately low bar for `pixel` findings — a
redacted stock photo costs nothing, a leaked face costs everything.

### Entities: names, organisations, addresses

These are the only PII with no checksum to validate against, which is why they
were the last gap. The usual answer is a 60 MB named-entity model, slow and
unreliable on Indian names.

[`tier3-entities.ts`](src/pii/tier3-entities.ts) takes a different route: **the
page usually tells you the names**, if you read the parts a text-only detector
ignores. A field labelled "Full Name", `<meta name="author">`, schema.org
microdata, an email local part — each names an entity outright. Harvest those
into a gazetteer, then find every other occurrence across the page.

Six strategies, each proposing candidates:

| # | Strategy | Confidence |
|---|---|---|
| 1 | Gazetteer built from the page's own markup | certain |
| 1b | A capitalised word beside a name already known | high |
| 2 | Honorific — "Dr. Anil Kumar Verma" | high |
| 3 | Cue phrase — "Billed to:", "Dear", "Attn:" | high |
| 4 | Legal suffix — "Sharma Traders Pvt Ltd" | high |
| 5 | Address — street type, PIN beside a place name, `<address>` | certain / high |
| 6 | Bare capitalised runs | low, **opt-in** |

**Identity annotations are the highest-value seed.** Real applications mark up
the element showing a person with their address — `email="…"`,
`data-hovercard-id="…"` — and Gmail, Outlook, Slack, LinkedIn and Jira all do
some version of it. That single rule is the difference between reading fifty
sender names off an inbox and reading none of them: an inbox row has no
honorific, no cue phrase and no labelled field, so nothing else in this tier
would ever fire on it.

A no-reply address, or a display name that echoes its own domain, marks the
entity as a brand rather than a person.

Knowing one name also unlocks others: a surname learnt from `prachi.gupta@…`
makes *"Mansi Gupta"* a name when it appears in a sentence — which is how a
person the page never annotates still gets caught, in any script.

Matching is Unicode-aware, so accented and non-Latin cased scripts work.
Scripts without letter case cannot be matched by pattern at all; those rely on
the gazetteer, which compares literal strings and does not care about script.

**Conflicts are settled by longest match, not by confidence.** That ordering is
load-bearing. The gazetteer learns surnames — "Sharma" from `priya.sharma@…` —
and a surname routinely sits inside a company name. Letting the shorter, more
confident match win tokenizes "Sharma" and leaves `Traders Pvt Ltd` in the
output: a *partially* redacted organisation, worse than either alternative.

Precision comes from a stopword list applied to every word, plus leading-word
trimming so a greedy pattern cannot swallow the sentence in front of what it
matched. Strategy 6 is where false positives live, so `aggressiveNames` is off
by default.

### Regions we cannot read

An iframe paints into the screenshot but contributes nothing to the DOM tree,
so no text detector can ever see inside it. Those regions are flagged
`unverified_region` and burned by default — **we do not ship pixels we were
never able to inspect**.

Same-origin frames are burned too, which is worth stating plainly: they *could*
be read in principle, but the content script runs only in the top frame, so in
practice their contents are exactly as uninspected as a cross-origin frame's.
Exempting them on the strength of what is theoretically readable would ship
pixels nothing ever looked at.

`burnUnverifiedRegions: false` turns this off, at the cost of shipping
uninspected pixels.

### What is honest about the pixel tier

There is no ML model in this repo. [`tier3-pixels.ts`](src/pii/tier3-pixels.ts)
classifies image regions from DOM metadata (alt text, avatar hosts, aspect
ratio, `<canvas>` opacity) and reports `confidence` accordingly. A face in an
unlabelled photo is not detected. `setImageClassifier()` is the seam where a
real face/OCR model plugs in without touching anything else.

### Capture correctness

Two guards that were bugs before they were guards, both in
[`inspect.ts`](src/background/inspect.ts):

- **`captureVisibleTab` captures whichever tab is *active*, not the tab id you
  pass it.** Scanning a background tab returned another page's pixels, which
  the redactor would then burn using the first page's coordinates. The target
  tab must now be active and its window focused, or no screenshot is taken.
- **The DOM and the pixels must describe the same scroll position.** bboxes are
  viewport-relative, so a page scrolling between the two captures shifts every
  region. The capture is now taken, re-checked, and retried up to three times;
  if it will not settle, the screenshot is dropped rather than mis-burned.

### The vault outlives the worker

Chrome terminates an idle MV3 service worker after about thirty seconds, which
would take every mapping with it mid-task. The vault therefore lives in an
**offscreen document** ([`offscreen/vault-host.ts`](src/offscreen/vault-host.ts)),
which has no idle timer.

This does not weaken the in-memory rule: an offscreen document is a page, not
storage. Nothing touches disk, and closing it destroys the mappings exactly as
dropping the object would.

Because the vault is now behind an async boundary and the tokenizer needs a
token the instant it finds a span, the tree walk runs **twice** — once against
a collector that records what it would ask for, once against a replayer holding
the answers. `ReplayMinter` throws rather than guessing if the two sequences
ever diverge, and `replay.test.ts` asserts both paths produce byte-identical
trees. If `chrome.offscreen` is unavailable the vault degrades to in-process
and the inspector says so; it never fails silently.

### Try it

Load [`test/pii-fixture.html`](test/pii-fixture.html) in a tab — synthetic data
with genuinely valid checksums, plus a decoy section of look-alikes that must
produce no findings — then run **PII scan** against it.

## The sanitization layer

Built and tested **standalone** — the agent loop does not call it yet. Side panel
&rarr; **PII scan** opens the inspector, which runs the whole thing and shows you
before and after.

```
capture ──▶ detect ──┬── text-shaped ──▶ tokenize ──▶ vault
                     └── pixel-shaped ─▶ burn on canvas
```

Detection runs before anything changes, because you cannot hide what you have
not found. The split by shape is not two sequential steps — text is *renamed*
and can come back; pixels are *destroyed* and cannot. They are siblings.

### The vault

[`vault/vault.ts`](src/vault/vault.ts) holds `token <-> value`, in memory, for
one session. It has no serialise method by design, and `toJSON()` returns
`{vault:"sealed"}` so a stray `console.log` cannot spill it.

The same value always gets the same token within a session — that is what makes
tokens *join keys* rather than noise. If "Sharma Traders" is `<ORG_1>` in the
task, it must be `<ORG_1>` on the page, or the planner cannot connect them.

**Sealed tokens** are the answer to "don't let the model think the field is
empty". A filled password field becomes `<SECRET_1>`: the planner can see the
field is populated — an empty field and a filled one are different facts — but
there is no value behind that token anywhere, and resolving it returns
`undefined` forever.

Knowing a field is filled without reading it takes one deliberate step: the
capture records `attrs.filled` as a single boolean for password inputs. Not the
length — a password's length is itself a hint — just whether anything is there.

### Tokenizing text

[`sanitize/tokenize.ts`](src/sanitize/tokenize.ts) replaces spans, not strings:

```
before   Invoice for Sharma Traders. PAN AAACR5055K, GSTIN 27AAACR5055K1Z7.
after    Invoice for Sharma Traders. PAN <PAN_1>, GSTIN <GSTIN_1>.
```

The sentence still reads, so the planner can still reason about it. Field
labels and `autocomplete` attributes are deliberately **preserved** — a form the
planner cannot recognise as a form is useless, and the label "Password" is not
itself a secret.

The URL is reduced to its origin, because a path routinely carries identifiers.

**Token collision is handled.** A page containing the literal text `<EMAIL_1>`
would otherwise be resolved into a real address it never had. Page-supplied
token syntax is rewritten to `‹EMAIL_1›` on the way in, so token syntax is
something only we can produce.

### Whole-page screenshots

`captureVisibleTab` can only ever photograph the viewport, so a full-page image
is assembled by scrolling and stitching ([`stitch.ts`](src/background/stitch.ts)).
Toggle **Whole page** in the inspector; it is on by default.

Four things make this harder than it sounds, and each is handled explicitly:

- **Chrome caps captures at two per second.** Verified against the docs. Tiles
  are spaced 550 ms apart, so a tall page costs about half a second per screen.
- **Sticky and fixed elements paint into every tile.** A pinned header would
  appear once per slice. They are hidden after the first tile and restored
  afterwards ([`fullpage.ts`](src/capture/fullpage.ts)).
- **`scrollTo` does not always land where you asked** — pages clamp at the
  bottom, animate, and grow as lazy images load. Every tile reports where it
  *actually* is, and the stitcher places it there.
- **The DOM is walked after the scrolling finishes**, because scrolling changes
  layout and every bbox would otherwise describe a page that no longer exists.

The image is capped (24 tiles, 20,000 px) and downscaled to a 2,000 px long
edge before delivery — a full-page capture at `devicePixelRatio` is enormous,
and every pixel becomes tokens that are resent on each turn.

### One coordinate frame

A viewport shot and a stitched page shot have different origins, so the image
carries its own frame and everything converts through document coordinates:

```
documentX = bbox.x + viewport.scrollX
imageX    = (documentX - shot.originX) * shot.scale
```

For a viewport shot the origin *is* the scroll offset, so the second line
collapses to `bbox.x * scale` — one code path, both modes. Getting this wrong
burns rectangles in the wrong place, which is worse than not burning at all,
so the browser self-test captures while scrolled to y=700 and checks that
regions at document y≈1400 and y≈2100 are destroyed.

### Text in the screenshot gets the same token

This is the half that makes the tree's work count, and it was missing.

Tokenizing an email into `<EMAIL_1>` in the DOM while leaving it legible in the
screenshot achieves **nothing** — both go to the model, and the picture hands
the value straight back. So every span the tokenizer replaced is also painted
over in the image, with the very same token:

```
Invoice INV-8871 — <ORG_1>
Contact <EMAIL_1> about this invoice.
Call <PHONE_1> during working hours.
PAN <PAN_1>, GSTIN <GSTIN_1>.
This line holds nothing sensitive and must stay readable.   <- untouched
```

Finding where a span is *painted* takes some care. Detection reports character
offsets into a whitespace-collapsed string, which line up with nothing in the
DOM. [`dom.ts`](src/capture/dom.ts) therefore builds a per-character index back
to the original text nodes as it collapses, and
[`spans.ts`](src/capture/spans.ts) turns an offset pair into a `Range` and asks
the browser for its client rects — one per line, so a wrapped span does not
black out half the paragraph.

Only a node's own text can be measured precisely; an `<input>` value has no
Range and a label may live elsewhere. Those fall back to the element's box,
which over-covers rather than under-covers — the safe direction when the
alternative is leaving PII legible.

### Burning pixels

[`sanitize/redact.ts`](src/sanitize/redact.ts) fills regions with solid black on
an `OffscreenCanvas`. Not a blur — a blur is a reversible transform. Not a
translucent overlay — that still ships the pixels underneath. A 3px bleed covers
edges, and each burned region is stamped with its vault token so the planner
knows a photo is there, can refer to it, and never sees a pixel of it.

It **fails closed**: any error returns no screenshot at all, because an
unredacted screenshot is never an acceptable fallback.

### Checking our own work

`sanitize()` re-runs the detector over its own output and reports what survived
as `residual`. Tier-1 findings are excluded — field metadata is *supposed* to
survive — so a non-zero residual means a real value got through. The inspector
shows this as a banner, and the test asserts it is zero.

## Seeing what the model got

Side panel &rarr; **Wire log** ([`wirelog.html`](src/wirelog/)) lists every
payload this extension has sent, exactly as it was sent: each message, the
attached redacted screenshot, the tokens in it, and the character count.

The important column is the verdict. **Every outgoing payload is re-scanned for
PII at the moment of sending**, and the result is recorded per turn. The tests
assert nothing leaks on fixtures; this asserts it on whatever page you are
really on, every turn, and says so loudly in the transcript when something
survives. A privacy claim that is only checked in CI is a claim about CI.

**Copy as JSON** exports the log without image data, which is the artifact to
put in front of anyone who asks what left the machine.

### The request is scanned too

Aligning the request with the page and sanitizing it are different jobs, and it
needs both:

- **Aligning** replaces values the page already showed, so both sides of the
  join carry one token.
- **Sanitizing** catches identifiers the user typed that the page never had.
  Someone who types *"check my Aadhaar 3456 7890 1238"* has put an identifier
  into the request, and the request goes to the model exactly as the page does.
  A value the page never showed has no token to align with, so alignment alone
  would let it straight through.

`sanitizeText()` wraps the string in a one-node capture and runs the real
pipeline over it, rather than a second simpler path that would drift from the
first.

## Tests

```bash
npm test
```

Four suites, all Node-runnable:

| Suite | What it pins down |
|---|---|
| `checksums` | Verhoeff round-trips; catches 100% of single-digit errors and 100% of adjacent transpositions; Luhn against published test cards; the 10.07% random-pass measurement |
| `detect` | All three tiers fire; bad-checksum values rejected; timestamps not read as accounts; every span is a real substring at its offset |
| `vault` | Token stability, sealed tokens never resolve, `JSON.stringify` cannot leak, page-planted tokens neutralised |
| `entities` | Gazetteer propagates a labelled name into prose; honorifics, cues, legal suffixes, addresses; **zero false positives on a decoy block** of ordinary capitalised text; aggressive mode stays opt-in |
| `replay` | The two-pass vault path produces a **byte-identical** tree to the direct path, in one round trip; the replay guard throws on divergence |
| `inbox` | A mail-client fixture: every sender detected from its annotation alone, a name inside Devanagari text, robot senders classed as brands, and **the interface still readable** — "Compose", "Inbox", "Search mail" all survive |
| `wire` | **The exact string the model receives**: no secret in it, tokens present, element ids valid, the page still usable ("Password", `autocomplete=name`, "Forward this invoice" all survive), and the request joins to the page through the same token. Also: an identifier the user *typed* is tokenized even though the page never showed it, and the send-time scan finds nothing in the payload while still firing on raw text |
| `sanitize` | **No secret survives into the serialised output**; residual is zero; sentence structure and form metadata preserved; original capture never mutated |

### The browser half

`OffscreenCanvas` does not exist in Node, so canvas redaction cannot be covered
by `npm test`. `npm run build` therefore also emits **`dist/selftest.html`** — a
self-contained page (no extension, no server) that builds a page with real PII
and real coloured regions, runs the whole pipeline over it, then reads the
output pixels back to prove the regions were *actually* destroyed rather than
merely reported as destroyed.

Open it in any Chrome tab. It also renders a realistic before/after pair, so
you can see what the model receives. Current result — 33/33:

```
ok  the face region was destroyed              — 57,600 -> 0 pixels
ok  the signature region was destroyed         — 64,000 -> 0 pixels
ok  the control region survived untouched      — 24,000 -> 24,000 pixels
ok  a filled password became a sealed token    — 1 field(s) sealed
ok  no residual PII in the sanitized tree
ok  full page: below-the-fold face destroyed   — 57,600 -> 0 at document y~1400
ok  full page: captured while scrolled away    — scrollY was 700
ok  off-image: regions counted as outside      — 2 outside, 0 burned
ok  text pixels: those spans were located       — 4/4 measured exactly
ok  text pixels: every PII pixel was destroyed  — 50,437 -> 0 pixels
ok  text pixels: tree and image agree on token  — <EMAIL_1>
ok  actions: typing reached the right element   — value is "quarterly"
ok  actions: clicking reached the right element — handler fired 1 time(s)
ok  actions: an unknown id is refused, not guessed
```

The action checks matter because integration changed which registry actions
resolve against. They drive real clicks and keystrokes through a live DOM and
check the *effects*, not the return values.

That middle line is the one that matters: the marker is painted over exactly
the pixels where detected PII is rendered, measured with the same Range code
the redactor uses. Zero survivors is the only acceptable answer.

The page also renders the redacted screenshot exactly as the model would
receive it: black boxes stamped `<PHOTO_1>` and `<SIGNATURE_1>`.

## The privacy layer is wired in

The agent no longer has a way to see a raw page. Every turn runs:

```
capture ──▶ sanitize ──▶ render ──▶ planner
                            │
      redacted screenshot ──┘
```

**One page, one id space.** The agent used to keep a second, flatter view with
its own element ids. Once the planner started reading the sanitized tree, those
two registries would have disagreed and every click would have landed on the
wrong element — silently, since both ids are just numbers. There is now a
single capture tree; actions resolve against the same ids the planner is shown.

**`renderPage()` in [`wire.ts`](src/background/wire.ts) is the only thing that
turns a page into text for a model.** It is pure, takes a sanitized capture, and
has no way to reach an unsanitized one. That is what makes it testable, and
`wire.test.ts` asserts against the exact string the model receives.

**The request is tokenized in the same vault as the page.** Without it the whole
scheme collapses: the planner would be told to *"forward the invoice from Sharma
Traders"* while the page reads `<ORG_1>`, and could never connect them.
`alignTask()` rewrites the request through the same vault, so both sides of the
join carry the same token.

People do not type a company's legal form, so each known value also contributes
an alias with one trailing incorporation type removed — the page's *"Sharma
Traders Pvt Ltd"* and the user's *"Sharma Traders"* reach the same token. Only
the legal form is stripped, never a trade word: taking off "Traders" too would
leave "Sharma", and a surname is far too common to map onto a company.

**Four gates run before any action touches the page**, in this order:

1. **The element id must be one we actually issued.** Ids come from the set the
   planner was last shown, so a hallucinated `element_id` is refused rather than
   resolved against whatever happens to sit at that index.
2. **The safety gate**, checked against the page the model was shown.
3. **Token resolution, at the last possible moment.** A token the vault never
   issued is refused — it can only have come from the model or the page.
4. **A sealed token is refused outright.** `<SECRET_1>` stands for a value this
   browser deliberately never read; there is nothing behind it.

The final answer is resolved back to real values before the *user* sees it —
they should read "Sharma Traders", not `<ORG_1>`.

## Known limits

- One frame per tab — the content script does not run in iframes, so agents
  cannot act inside embedded checkout or payment widgets.
- The screenshot channel exists in the capture layer but the *planner* still
  works from text and DOM only, so canvas-rendered UI remains invisible to it.
- Tier 3 has no ML model behind it yet; it routes regions and classifies from
  metadata. Faces in an unlabelled photo are not detected.
- **Text baked into an image is not detected.** An Aadhaar number inside a JPEG
  is invisible to every text detector, so the image is only redacted if the
  region itself was flagged. OCR on flagged regions, fed back through tier 2's
  checksums, is the remaining piece.
- Entity detection is deterministic, not a model. A name the page never labels,
  never annotates, never introduces with a cue, and never places beside a name
  already known is only caught in aggressive mode — and aggressive mode also tokenizes product names and headings. The
  vocabulary in [`entities.ts`](src/pii/entities.ts) is tuned for Indian and
  English text and will need extending for other scripts.
- Iframe *contents* are never inspected — the content script runs only in the
  top frame — so every frame is blacked out rather than analysed. That is safe
  but blunt: legitimate embeds such as maps and videos go black. Walking frames
  with `all_frames` and merging their coordinates is the fix, and would let the
  burn be narrowed to what is actually sensitive.
- A full-page capture scrolls the tab, which is visible to the user and briefly
  disruptive. Pages with infinite scroll or scroll-triggered animation may
  stitch imperfectly; the viewport mode is exact and always available.
- Regions still outside the delivered image — beyond the tile cap, or in
  viewport mode below the fold — have no pixels to burn. Sound, since those
  pixels are not in the image either, and reported separately as
  `regionsOutsideViewport` so it does not read as a failure.
- Scanning a background tab briefly brings it to the front and puts the previous
  tab back. Unavoidable: `captureVisibleTab` photographs whichever tab is
  active, so the alternative is photographing the wrong page.
- Chrome's own pages (`chrome://`, the Web Store) are off limits to all
  extensions, and the agent says so rather than failing quietly.

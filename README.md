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
  sidepanel/            transcript UI
  options/              provider, keys, model, and preferences
  shared/
    types.ts            wire types and settings (with legacy migration)
    models.ts           provider catalogue and live model listing
```

## Where the privacy layer goes

The SIH design tokenizes PII before anything crosses the wire. Two seams in this
codebase are where that lands, and both already exist as single choke points:

- `renderSnapshot()` in [`agent.ts`](src/background/agent.ts) is the only place
  a page becomes text for the model. Detection and tokenization go here: the
  snapshot goes in, `<ORG_3>`-shaped tokens come out, and the vault holds the
  mapping.
- The `gate()` call in the same file is the only place an action is inspected
  before it runs. Token → real value resolution goes here, at the last possible
  moment before `execute()`.

Nothing else needs to change: the planner already reasons over opaque ids rather
than page content, which is most of the way to reasoning over opaque tokens.

## Known limits

- One frame per tab — the content script does not run in iframes, so agents
  cannot act inside embedded checkout or payment widgets.
- Text and DOM only; there is no screenshot channel yet, so canvas-rendered and
  image-only UI is invisible to the planner.
- Chrome's own pages (`chrome://`, the Web Store) are off limits to all
  extensions, and the agent says so rather than failing quietly.

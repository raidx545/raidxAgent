import type { CapturedNode, DomCapture } from "../src/capture/types";
import type { AgentEvent, ContentRequest } from "../src/shared/types";

/**
 * A whole run, from a page the agent cannot read.
 *
 * Two dead ends used to stop the run outright:
 *
 *  - Starting on a New Tab page - the most natural place to type "write a
 *    mail" - was refused before the model was even asked.
 *  - Navigating to an address that did not load left Chrome's error page in
 *    the tab, "Navigated to ..." was reported as success, and the capture that
 *    followed failed and ended the task.
 *
 * Neither needs a page to recover from. This drives the real agent loop
 * against a scripted model and a fake browser, and checks that the run gets
 * through both, and that the model is told the truth at each step.
 */

const fails: string[] = [];
const want = (c: boolean, m: string) => { if (!c) fails.push(m); };

// --------------------------------------------------------------- the browser

const tab = {
  id: 1, windowId: 1, active: true, status: "complete",
  url: "chrome://newtab/", title: "New Tab",
};
const deadHosts = new Set(["no-such-site.invalid"]);
const onErrorPage = () => deadHosts.has(new URL(tab.url).host);

let id = 0;
const n = (p: Partial<CapturedNode>): CapturedNode => ({
  id: id++, tag: "div", role: "generic", label: "", attrs: {},
  bbox: [0, 0, 400, 20], visible: true, children: [], ...p,
});
function examplePage(): DomCapture {
  id = 0;
  return {
    url: tab.url, origin: new URL(tab.url).origin, title: "Example Domain", capturedAt: Date.now(),
    generation: 1,
    viewport: { width: 1200, height: 800, dpr: 1, scrollX: 0, scrollY: 0, pageHeight: 800 },
    root: n({
      tag: "body", role: "document", children: [
        n({ tag: "h1", role: "heading", text: "Example Domain" }),
        n({ tag: "a", role: "link", text: "More information", attrs: { hrefHost: "iana.org" } }),
      ],
    }),
    stats: { examined: 3, kept: 3, pruned: 0 },
  };
}

(globalThis as Record<string, unknown>).chrome = {
  tabs: {
    get: async () => ({ ...tab }),
    query: async () => [{ ...tab }],
    update: async (_id: number, props: { url?: string }) => {
      if (props.url) {
        tab.url = props.url;
        tab.title = onErrorPage() ? new URL(props.url).host : "Example Domain";
      }
      return { ...tab };
    },
    sendMessage: async (_id: number, request: ContentRequest) => {
      if (onErrorPage() || tab.url.startsWith("chrome://")) throw new Error("Frame with ID 0 is showing error page");
      switch (request.kind) {
        case "capture": return { ok: true, detail: "", capture: examplePage() };
        case "span-rects": return { ok: true, detail: "", rects: [] };
        default: return { ok: true, detail: "ok" };
      }
    },
    captureVisibleTab: async () => { throw new Error("no screenshots in this test"); },
  },
  scripting: {
    executeScript: async () => {
      if (onErrorPage()) throw new Error("Frame with ID 0 is showing error page");
      return [{ result: true }];
    },
  },
  windows: {
    get: async () => ({ id: 1, focused: true }),
    getLastFocused: async () => ({ id: 1 }),
    update: async () => ({}),
  },
  runtime: { sendMessage: async () => undefined, getURL: (p: string) => p },
};

// ----------------------------------------------------------------- the model

const script = [
  { name: "navigate", args: { url: "no-such-site.invalid", reason: "open the site" } },
  { name: "navigate", args: { url: "example.com", reason: "try the real address" } },
  { text: "The page is titled Example Domain." },
];
const requests: string[] = [];

// Loaded by name: this project has no Node type declarations, and the test is
// the only place that needs a server.
interface Req { on(event: string, fn: (chunk?: unknown) => void): void }
interface Res { writeHead(status: number, headers: Record<string, string>): void; write(s: string): void; end(s: string): void }
interface Server { listen(port: number, host: string, cb: () => void): void; address(): { port: number }; close(): void }
const httpModule = "node:http";
const { createServer } = (await import(httpModule)) as {
  createServer(handler: (req: Req, res: Res) => void): Server;
};

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += String(chunk); });
  req.on("end", () => {
    requests.push(body);
    const step = script[requests.length - 1] ?? { text: "done" };
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: "x", object: "chat.completion.chunk", created: 0, model: "fake",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if ("name" in step) {
      res.write(chunk({
        role: "assistant",
        tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function",
          function: { name: step.name, arguments: JSON.stringify(step.args) } }],
      }));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ role: "assistant", content: step.text }));
      res.write(chunk({}, "stop"));
    }
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ------------------------------------------------------------------- the run

const { runTask } = await import("../src/background/agent");
const { RemoteVault } = await import("../src/vault/remote");
const { normaliseSettings } = await import("../src/shared/types");

const events: AgentEvent[] = [];
const answer = await runTask("what is the title of example.com?", 1, {
  settings: normaliseSettings({
    provider: "custom",
    customBaseUrl: `http://127.0.0.1:${port}/v1`,
    models: { custom: "fake" },
    sendScreenshot: false,
    fullPageCapture: false,
    ocrMode: "off",
    thinking: "off",
    maxSteps: 6,
  }),
  emit: (e) => events.push(e),
  askConfirm: async () => true,
  askUser: async () => undefined,
  signal: new AbortController().signal,
  vault: new RemoteVault(),
});
server.close();

const errors = events.flatMap((e) => (e.kind === "entry" && e.entry.role === "error" ? [e.entry.text] : []));

want(requests.length === 3, `the run stopped after ${requests.length} model call(s) instead of 3 - errors: ${errors.join(" | ")}`);
want(errors.length === 0, `the run reported errors: ${errors.join(" | ")}`);
want(/Example Domain/.test(answer ?? ""), `the run did not finish with the answer: ${answer}`);

// The first request: no page, and the model is told how to get one.
want(/No readable page/.test(requests[0] ?? ""), "the first request did not say there is no readable page");
want(!/"Example Domain"/.test(requests[0] ?? ""), "the first request described a page that was not loaded");

// The second: the failed navigation is a failure, not "Navigated to".
const second = requests[1] ?? "";
want(/Could not open/.test(second) && /could not be reached/.test(second),
  "the dead address was not reported as unreachable");
want(!/Navigated to https:\/\/no-such-site/.test(second), "the dead address was reported as navigated to");

// The third: the real page arrived.
want(/Example Domain/.test(requests[2] ?? ""), "the real page never reached the model");

console.log(JSON.stringify({ calls: requests.length, errors, answer, failures: fails, pass: fails.length === 0 }, null, 2));

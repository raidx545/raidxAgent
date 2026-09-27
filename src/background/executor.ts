import type { ActionResult, AgentAction, ContentRequest } from "../shared/types";
import type { DomCapture } from "../capture/types";
import type { SpanRectRequest, SpanRectResult } from "../capture/spans";
import { PAGE_ACTIONS } from "./tools";
import { normaliseUrl } from "./url";

/** Tracks which tab the agent is currently driving. */
export class TabController {
  constructor(public tabId: number) {}

  /**
   * Sends a message to the page, injecting the content script first if the tab
   * predates the extension being installed or reloaded.
   */
  private async send(request: ContentRequest): Promise<ActionResult> {
    try {
      return await answered(chrome.tabs.sendMessage(this.tabId, request));
    } catch (error) {
      // A page that went silent has the request - it may well have carried
      // it out. Injecting and sending again would do the click twice.
      if (error instanceof PageSilentError) throw new PageGoneError(error.message);
      try {
        await this.inject();
        return await answered(chrome.tabs.sendMessage(this.tabId, request));
      } catch (error) {
        if (error instanceof PageSilentError) throw new PageGoneError(error.message);
        // Chrome's own wording for a page that went away mid-action is
        // "Frame with ID 0 was removed" / "No tab with id". Left raw it ends
        // the task with a sentence about frames, which tells the planner
        // nothing it can act on - and the situation is ordinary: a click
        // navigated, and the page we were talking to no longer exists.
        throw new PageGoneError(describeGone(error));
      }
    }
  }

  private async inject(): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      files: ["content.js"],
    });
  }

  /**
   * Why this tab cannot be read, or undefined if it can.
   *
   * A navigation to a mistyped domain, or a site that is down, "succeeds" -
   * the tab loads Chrome's error page, which no extension may script. It was
   * reported as "Navigated to ..." and the capture that followed failed.
   */
  async unreadable(): Promise<string | undefined> {
    const tab = await chrome.tabs.get(this.tabId).catch(() => null);
    if (!tab) return "the tab was closed";
    if (isRestricted(tab.url)) return `the tab shows ${tab.url}, a browser page that extensions cannot read`;
    try {
      await chrome.scripting.executeScript({ target: { tabId: this.tabId }, func: () => true });
      return undefined;
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (/error page/i.test(raw)) {
        return "the site could not be reached - Chrome is showing its own error page (the address may be wrong, or the site is down)";
      }
      return `the page cannot be read: ${raw}`;
    }
  }

  /** Resolves once the tab has finished loading, or after a timeout. */
  async waitForLoad(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(this.tabId).catch(() => null);
      if (!tab) return;
      if (tab.status === "complete") {
        // The load event is not the page being ready. A client-rendered app
        // paints its real content some time after it, and a static page is
        // ready before it. Ask the page itself when it has stopped changing
        // rather than guessing with a fixed delay - this used to be 400ms,
        // which was too long for the second case and not enough for the first.
        //
        // A browser-internal page has no content script to ask; there is
        // nothing to settle there anyway.
        if (!isRestricted(tab.url)) {
          await this.send({ kind: "settle" }).catch(() => undefined);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Prepares the page for a full-page capture and returns its dimensions. */
  async fullPageBegin(): Promise<ActionResult["page"]> {
    const result = await this.send({ kind: "fullpage-begin" }).catch(() => undefined);
    return result?.page;
  }

  /** Scrolls to a document offset; reports where the page actually landed. */
  async fullPageScroll(y: number, hideSticky: boolean): Promise<ActionResult["page"]> {
    const result = await this.send({ kind: "fullpage-scroll", y, hideSticky }).catch(
      () => undefined,
    );
    return result?.page;
  }

  /** Restores scroll position and anything that was hidden for the capture. */
  async fullPageEnd(): Promise<void> {
    await this.send({ kind: "fullpage-end" }).catch(() => undefined);
  }

  /** Asks the page where a batch of character spans is painted. */
  async spanRects(requests: SpanRectRequest[]): Promise<SpanRectResult[]> {
    if (requests.length === 0) return [];
    const result = await this.send({ kind: "span-rects", requests }).catch(() => undefined);
    return result?.rects ?? [];
  }

  /** The PII layer's structured capture. Read-only, no model involved. */
  /** What kind of page this is, for suggestions. Undefined when it cannot be asked. */
  async profile(): Promise<ActionResult["profile"]> {
    const result = await this.send({ kind: "profile" }).catch(() => undefined);
    return result?.profile;
  }

  async captureDom(): Promise<DomCapture | undefined> {
    const result = await this.send({ kind: "capture" }).catch(() => undefined);
    return result?.capture;
  }

  async act(action: AgentAction, generation?: number): Promise<ActionResult> {
    return this.send({ kind: "act", action, generation });
  }
}

/** The page we were driving went away - normally because it navigated. */
export class PageGoneError extends Error {}

class PageSilentError extends Error {}

/**
 * The longest a page may take to answer one request.
 *
 * Nothing the content script does legitimately comes near it - the slowest
 * action waits four seconds for the page to settle. Without it, a page that
 * never replied held the run on one step for ever with the panel still saying
 * "Click ...": a tab frozen by a script, or blocked by an alert() the page
 * raised in response to the click.
 */
const PAGE_ANSWER_MS = 30_000;

function answered<T>(reply: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PageSilentError(
      `The page did not respond for ${PAGE_ANSWER_MS / 1000} seconds, so it is not known whether ` +
        `this action took effect. A browser dialog (alert, confirm, print) may be blocking the page, ` +
        `or the page is frozen. Read the page before doing anything else.`,
    )), PAGE_ANSWER_MS);
  });
  return Promise.race([reply, silent]).finally(() => clearTimeout(timer));
}

function describeGone(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/error page/i.test(raw)) {
    return "The tab is showing Chrome's error page - the site could not be reached - so there is nothing to act on. Navigate somewhere else.";
  }
  if (/frame with id|no tab with id|receiving end does not exist|message port closed/i.test(raw)) {
    return "The page navigated or closed while this action was running, so it could not be completed. Read the page again and continue from what is there now.";
  }
  return `The page could not be reached: ${raw}`;
}

/** URLs the content script can never run on, so the agent cannot work there. */
export function isRestricted(url: string | undefined): boolean {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://") ||
    url.startsWith("https://chromewebstore.google.com")
  );
}

/** The bit of a URL a person recognises. A full URL can carry an id. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}


/**
 * What a navigation actually led to.
 *
 * Where the tab ended up is reported, not where it was sent: a sign-in wall or
 * a regional redirect is the first thing the planner needs to know about, and
 * "Navigated to X" said the opposite.
 */
async function arrived(controller: TabController, url: string, verb: string): Promise<ActionResult> {
  const problem = await controller.unreadable();
  if (problem) {
    return {
      ok: false,
      detail: `Could not open ${url}: ${problem}. Check the address, or search for the site instead.`,
      summary: `Couldn't open ${hostOf(url)}.`,
    };
  }
  const landed = (await chrome.tabs.get(controller.tabId).catch(() => null))?.url ?? url;
  const moved = hostOf(landed) !== hostOf(url);
  return {
    ok: true,
    detail: moved ? `${verb} ${url} - it redirected to ${landed}.` : `${verb} ${landed}.`,
    summary: `Opened ${hostOf(moved ? landed : url)}.`,
  };
}

/**
 * Runs one action, routing page-level work to the content script and
 * tab-level work to the browser APIs. Returns the result plus, when the page
 * may have changed, a fresh snapshot so the planner never acts on stale ids.
 */
export async function execute(
  controller: TabController,
  action: AgentAction,
  /** The capture the action's element ids came from; see DomCapture.generation. */
  generation?: number,
): Promise<{ result: ActionResult; controller: TabController }> {
  const { name, input } = action;

  if (PAGE_ACTIONS.has(name)) {
    const tab = await chrome.tabs.get(controller.tabId).catch(() => null);
    if (isRestricted(tab?.url)) {
      return {
        result: {
          ok: false,
          detail:
            `This tab (${tab?.url ?? "unknown"}) is a browser-internal page that ` +
            `extensions cannot read. Navigate somewhere else first.`,
        },
        controller,
      };
    }
    try {
      return { result: await controller.act(action, generation), controller };
    } catch (error) {
      // A lost page is a tool result, not the end of the run.
      if (error instanceof PageGoneError) {
        return { result: { ok: false, detail: error.message }, controller };
      }
      throw error;
    }
  }

  switch (name) {
    case "navigate": {
      const url = normaliseUrl(String(input.url ?? ""));
      // Going to a page the extension cannot read would end the task with
      // "Lost the page" on the next capture. Say so now, while the planner can
      // still choose somewhere else.
      if (isRestricted(url)) {
        return {
          result: {
            ok: false,
            detail: `${url} is a browser-internal page and cannot be worked on. Choose a normal website.`,
          },
          controller,
        };
      }
      await chrome.tabs.update(controller.tabId, { url });
      await controller.waitForLoad();
      return { result: await arrived(controller, url, "Navigated to"), controller };
    }

    case "go_back": {
      await chrome.tabs.goBack(controller.tabId).catch(() => undefined);
      await controller.waitForLoad();
      const tab = await chrome.tabs.get(controller.tabId);
      return {
        result: {
          ok: true,
          detail: `Went back. Now on ${tab.url}.`,
          summary: `Went back to ${hostOf(tab.url ?? "")}.`,
        },
        controller,
      };
    }

    case "open_tab": {
      const url = normaliseUrl(String(input.url ?? ""));
      if (isRestricted(url)) {
        return {
          result: { ok: false, detail: `${url} is a browser-internal page and cannot be worked on.` },
          controller,
        };
      }
      const tab = await chrome.tabs.create({ url, active: true });
      const next = new TabController(tab.id!);
      await next.waitForLoad();
      const result = await arrived(next, url, `Opened in new tab ${tab.id} (agent focus moved there):`);
      if (result.ok) result.summary = `Opened ${hostOf(url)} in a new tab.`;
      return { result, controller: next };
    }

    case "list_tabs": {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const lines = tabs.map(
        (t) => `- id ${t.id}${t.id === controller.tabId ? " (current)" : ""}: ${t.title} — ${t.url}`,
      );
      return {
        result: {
          ok: true,
          detail: lines.join("\n"),
          summary: `Listed ${tabs.length} open tab${tabs.length === 1 ? "" : "s"}.`,
        },
        controller,
      };
    }

    case "switch_tab": {
      const tabId = Number(input.tab_id);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return { result: { ok: false, detail: `No tab ${tabId}.` }, controller };
      if (isRestricted(tab.url)) {
        return {
          result: {
            ok: false,
            detail: `Tab ${tabId} is on ${tab.url}, a browser-internal page the agent cannot work in.`,
          },
          controller,
        };
      }
      await chrome.tabs.update(tabId, { active: true });
      const next = new TabController(tabId);
      await next.waitForLoad();
      return {
        result: {
          ok: true,
          detail: `Switched to tab ${tabId}: ${tab.title}.`,
          summary: `Switched to ${tab.title ?? hostOf(tab.url ?? "")}.`,
        },
        controller: next,
      };
    }

    case "close_tab": {
      const tabId = Number(input.tab_id);

      // "Close this tab" is the ordinary way to ask, and refusing it outright -
      // which is what this did - made the request impossible to satisfy. The
      // real constraint is narrower: the agent needs *somewhere* to stand. So
      // move to another tab first, then close this one.
      if (tabId === controller.tabId) {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const other = tabs.find((t) => t.id !== undefined && t.id !== tabId && !isRestricted(t.url));
        if (!other?.id) {
          return {
            result: {
              ok: false,
              detail:
                "This is the only tab I can work in, so closing it would end the task. " +
                "Open another page first, or ask the user to close it themselves.",
            },
            controller,
          };
        }

        await chrome.tabs.update(other.id, { active: true });
        await chrome.tabs.remove(tabId).catch(() => undefined);
        const next = new TabController(other.id);
        await next.waitForLoad();
        return {
          result: {
            ok: true,
            detail: `Closed tab ${tabId}. Now working in tab ${other.id}: ${other.title ?? other.url}.`,
            summary: `Closed the tab. Now on ${other.title ?? hostOf(other.url ?? "")}.`,
          },
          controller: next,
        };
      }

      await chrome.tabs.remove(tabId).catch(() => undefined);
      return {
        result: {
          ok: true,
          detail: `Closed tab ${tabId}. Still working in tab ${controller.tabId}.`,
          summary: "Closed the tab.",
        },
        controller,
      };
    }

    default:
      return { result: { ok: false, detail: `Unknown tool ${name}.` }, controller };
  }
}

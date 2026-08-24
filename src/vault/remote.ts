import type { VaultEntryView } from "./vault";
import { Vault } from "./vault";
import type { MintRequest, TokenMinter, VaultRequest, VaultResponse } from "./protocol";

/**
 * A vault that lives somewhere else.
 *
 * `RemoteVault` is what the service worker holds. The mappings themselves are
 * in the offscreen document, which Chrome does not terminate on an idle timer,
 * so a worker restart mid-task no longer loses every token.
 *
 * If `chrome.offscreen` is unavailable, this falls back to an in-process vault
 * and says so. A degraded vault that works is better than a hard failure, but
 * it must be visible, not silent - `hosting` reports which one is live.
 */

const OFFSCREEN_PATH = "vault-host.html";

export type VaultHosting = "offscreen" | "in-process";

export class RemoteVault {
  private fallback: Vault | undefined;
  private ready: Promise<void> | undefined;
  private mode: VaultHosting = "offscreen";

  get hosting(): VaultHosting {
    return this.mode;
  }

  /**
   * Ensures the offscreen document exists. Chrome allows exactly one per
   * extension, and creating a second throws, so an existing document is
   * reused rather than replaced - which is also what keeps the mappings.
   */
  private async ensure(): Promise<void> {
    if (this.fallback) return;
    if (this.ready) return this.ready;

    this.ready = (async () => {
      if (!chrome.offscreen) {
        this.mode = "in-process";
        this.fallback = new Vault();
        return;
      }

      try {
        const existing = await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
        });
        if (existing.length > 0) return;

        await chrome.offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: ["WORKERS" as chrome.offscreen.Reason],
          justification:
            "Holds PII token mappings in memory for the length of a session, " +
            "outliving the service worker so tokens stay resolvable mid-task.",
        });
      } catch (error) {
        // Another call may have created it in the gap between check and create.
        const raced = String(error).includes("Only a single offscreen");
        if (!raced) {
          this.mode = "in-process";
          this.fallback = new Vault();
        }
      }
    })();

    return this.ready;
  }

  private async send(request: VaultRequest): Promise<VaultResponse> {
    await this.ensure();

    if (this.fallback) return this.local(request);

    try {
      const response = (await chrome.runtime.sendMessage(request)) as VaultResponse | undefined;
      if (!response) throw new Error("The vault document did not reply.");
      return response;
    } catch (error) {
      // The document went away - recreate it once, then give up and degrade.
      this.ready = undefined;
      await this.ensure();
      if (this.fallback) return this.local(request);
      try {
        const retry = (await chrome.runtime.sendMessage(request)) as VaultResponse | undefined;
        if (retry) return retry;
      } catch {
        /* fall through to the error below */
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Same operations, served from the in-process fallback vault. */
  private local(request: VaultRequest): VaultResponse {
    const vault = this.fallback!;
    switch (request.kind) {
      case "vault:mint":
        return {
          ok: true,
          kind: "mint",
          tokens: request.requests.map((entry) =>
            entry.op === "seal" ? vault.seal(entry.kind) : vault.tokenize(entry.value, entry.kind),
          ),
          size: vault.size,
        };
      case "vault:resolve":
        return { ok: true, kind: "resolve", ...vault.resolveAll(request.text) };
      case "vault:values":
        return { ok: true, kind: "values", values: vault.values() };
      case "vault:view":
        return {
          ok: true,
          kind: "view",
          entries: vault.view(),
          size: vault.size,
          ageMs: vault.ageMs,
        };
      case "vault:clear":
        vault.clear();
        return { ok: true, kind: "cleared" };
      case "vault:ping":
        return { ok: true, kind: "pong" };
      default:
        return { ok: false, error: "Unknown vault request." };
    }
  }

  /** Mints every token one sanitization pass needs, in a single round trip. */
  async mint(requests: MintRequest[]): Promise<{ tokens: string[]; size: number }> {
    if (requests.length === 0) return { tokens: [], size: await this.size() };
    const response = await this.send({ kind: "vault:mint", requests });
    if (!response.ok) throw new Error(`Vault could not mint tokens: ${response.error}`);
    if (response.kind !== "mint") throw new Error("Vault returned the wrong reply to a mint.");
    return { tokens: response.tokens, size: response.size };
  }

  /**
   * Swaps tokens back for real values.
   *
   * `unknown` lists tokens this vault never issued. That list is the whole
   * point of routing resolution through the vault rather than a plain string
   * replace: a token the client never minted can only have come from the model
   * or from the page, and neither is allowed to name a real value.
   */
  async resolve(text: string): Promise<{ text: string; unknown: string[]; sealed: string[] }> {
    const response = await this.send({ kind: "vault:resolve", text });
    if (!response.ok) throw new Error(`Vault could not resolve: ${response.error}`);
    if (response.kind !== "resolve") throw new Error("Vault returned the wrong reply to a resolve.");
    return { text: response.text, unknown: response.unknown, sealed: response.sealed };
  }

  async view(): Promise<{ entries: VaultEntryView[]; size: number; ageMs: number }> {
    const response = await this.send({ kind: "vault:view" });
    if (!response.ok || response.kind !== "view") return { entries: [], size: 0, ageMs: 0 };
    return { entries: response.entries, size: response.size, ageMs: response.ageMs };
  }

  /** Real values and their tokens, for aligning the user's request. */
  async knownValues(): Promise<{ value: string; token: string }[]> {
    const response = await this.send({ kind: "vault:values" });
    return response.ok && response.kind === "values" ? response.values : [];
  }

  async size(): Promise<number> {
    return (await this.view()).size;
  }

  /** Drops every mapping, and closes the document holding them. */
  async clear(): Promise<void> {
    await this.send({ kind: "vault:clear" });
  }

  /**
   * Ends the session: mappings are destroyed and the host is torn down.
   * After this, every token ever issued is unresolvable.
   */
  async destroy(): Promise<void> {
    await this.clear();
    if (!this.fallback && chrome.offscreen) {
      await chrome.offscreen.closeDocument().catch(() => undefined);
    }
    this.fallback = undefined;
    this.ready = undefined;
  }
}

/**
 * Adapts any vault - local or remote - into the synchronous minter the
 * tokenizer needs, by resolving every request up front.
 */
export interface MinterSource {
  prepare(requests: MintRequest[]): Promise<TokenMinter>;
}

export function remoteSource(vault: RemoteVault): MinterSource {
  return {
    async prepare(requests) {
      const { tokens } = await vault.mint(requests);
      const { ReplayMinter } = await import("./protocol");
      return new ReplayMinter(requests, tokens);
    },
  };
}

export function localSource(vault: Vault): MinterSource {
  return {
    async prepare(requests) {
      const tokens = requests.map((entry) =>
        entry.op === "seal" ? vault.seal(entry.kind) : vault.tokenize(entry.value, entry.kind),
      );
      const { ReplayMinter } = await import("./protocol");
      return new ReplayMinter(requests, tokens);
    },
  };
}

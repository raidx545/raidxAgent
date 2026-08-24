import type { PiiKind } from "../pii/types";
import type { VaultEntryView } from "./vault";

/**
 * The wire protocol between the service worker and the offscreen document that
 * owns the vault.
 *
 * The vault has to outlive the service worker. Chrome terminates an idle MV3
 * worker after about thirty seconds, which would take every token mapping with
 * it in the middle of a task. An offscreen document has no such timer - for
 * every reason except AUDIO_PLAYBACK it lives until it is explicitly closed -
 * so that is where the vault lives.
 *
 * This does not weaken the in-memory rule. An offscreen document is a page in
 * the same profile, not storage: nothing is written to disk, and closing the
 * document destroys the mappings exactly as dropping the object would.
 */

/** One thing the sanitizer needs a token for. */
export type MintRequest =
  | { op: "tokenize"; value: string; kind: PiiKind }
  | { op: "seal"; kind: PiiKind };

export type VaultRequest =
  /** Mint or look up a batch of tokens in one round trip. */
  | { kind: "vault:mint"; requests: MintRequest[] }
  /** Swap tokens back for real values. */
  | { kind: "vault:resolve"; text: string }
  /** Content-free listing, for the inspector. */
  | { kind: "vault:view" }
  /**
   * Real values and their tokens.
   *
   * Only the service worker asks for this, and only to align the user's own
   * request with the page - "forward the invoice from Sharma Traders" has to
   * become the same token the page carries, or the join key is useless. It
   * never leaves the extension.
   */
  | { kind: "vault:values" }
  /** Drop every mapping. */
  | { kind: "vault:clear" }
  /** Liveness check, also used to confirm the document is up. */
  | { kind: "vault:ping" };

export type VaultResponse =
  | { ok: true; kind: "mint"; tokens: string[]; size: number }
  | { ok: true; kind: "resolve"; text: string; unknown: string[]; sealed: string[] }
  | { ok: true; kind: "view"; entries: VaultEntryView[]; size: number; ageMs: number }
  | { ok: true; kind: "values"; values: { value: string; token: string }[] }
  | { ok: true; kind: "cleared" }
  | { ok: true; kind: "pong" }
  | { ok: false; error: string };

/**
 * A synchronous token source.
 *
 * The tokenizer walks the tree and needs a token the instant it finds a span,
 * but the vault is now behind an async message boundary. This interface is how
 * the two are reconciled: the walk runs twice, once against a collector that
 * records what it would need, and once against a replayer holding the answers.
 */
export interface TokenMinter {
  tokenize(value: string, kind: PiiKind): string;
  seal(kind: PiiKind): string;
}

/**
 * First pass: records requests and hands back placeholders that are never used.
 *
 * The placeholders deliberately do not look like tokens, so that if one ever
 * escaped into real output it would be obvious rather than silently plausible.
 */
export class CollectingMinter implements TokenMinter {
  readonly requests: MintRequest[] = [];
  /** Values already requested, so the batch matches the vault's own dedupe. */
  private readonly seen = new Map<string, string>();

  tokenize(value: string, kind: PiiKind): string {
    const key = kind + " " + value;
    const existing = this.seen.get(key);
    if (existing) return existing;
    this.requests.push({ op: "tokenize", value, kind });
    const placeholder = `((collect:${this.requests.length}))`;
    this.seen.set(key, placeholder);
    return placeholder;
  }

  seal(kind: PiiKind): string {
    this.requests.push({ op: "seal", kind });
    return `((collect:${this.requests.length}))`;
  }
}

/**
 * Second pass: hands out the tokens the vault returned, in the order the first
 * pass asked for them.
 *
 * The traversal is deterministic over the same input, so the sequence is
 * identical - but that is an assumption worth checking rather than trusting,
 * so a mismatch throws instead of quietly returning the wrong token.
 */
export class ReplayMinter implements TokenMinter {
  private index = 0;
  private readonly seen = new Map<string, string>();

  constructor(
    private readonly requests: MintRequest[],
    private readonly tokens: string[],
  ) {}

  tokenize(value: string, kind: PiiKind): string {
    const key = kind + " " + value;
    const existing = this.seen.get(key);
    if (existing) return existing;

    const token = this.take({ op: "tokenize", value, kind });
    this.seen.set(key, token);
    return token;
  }

  seal(kind: PiiKind): string {
    return this.take({ op: "seal", kind });
  }

  private take(expected: MintRequest): string {
    const request = this.requests[this.index];
    const token = this.tokens[this.index];
    this.index++;

    if (!request || token === undefined) {
      throw new Error(
        `Vault replay ran out of tokens at position ${this.index}. ` +
          `The collect and apply passes disagreed, so nothing was tokenized.`,
      );
    }
    if (request.op !== expected.op || request.kind !== expected.kind) {
      throw new Error(
        `Vault replay is out of step at position ${this.index}: ` +
          `expected ${expected.op}/${expected.kind}, ` +
          `the collect pass recorded ${request.op}/${request.kind}.`,
      );
    }
    return token;
  }
}

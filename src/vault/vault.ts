import type { PiiKind } from "../pii/types";

/**
 * The vault: the only place a real value and its token live together.
 *
 * Rules this class enforces, from the architecture:
 *   - In memory only. Never chrome.storage, never disk, never a network call.
 *     There is no serialise method on purpose - you cannot accidentally persist
 *     what has no way to be written out.
 *   - Scoped to one session. `clear()` is the whole lifecycle; when the holder
 *     is dropped, every mapping goes with it.
 *   - Stable within a session: the same value always gets the same token, so the
 *     planner can match "the sender" in one place to "the sender" in another.
 *     Without that, tokens are noise rather than join keys.
 */

/** Prefix used in the token for each kind of finding. */
const PREFIX: Record<PiiKind, string> = {
  aadhaar: "AADHAAR",
  pan: "PAN",
  gstin: "GSTIN",
  payment_card: "CARD",
  ifsc: "IFSC",
  bank_account: "ACCT",
  upi_id: "UPI",
  passport: "PASSPORT",
  voter_id: "VOTERID",
  vehicle_number: "VEHICLE",
  phone: "PHONE",
  email: "EMAIL",
  ip_address: "IP",
  pincode: "PIN",
  date_of_birth: "DOB",
  person_name: "NAME",
  org_name: "ORG",
  postal_address: "ADDR",
  credential_field: "SECRET",
  payment_field: "PAYMENT",
  identity_field: "USERID",
  face_or_photo: "PHOTO",
  signature: "SIGNATURE",
  scanned_document: "DOCUMENT",
  qr_code: "QRCODE",
  unverified_region: "FRAME",
};

/** Matches a token anywhere in a string. Kept in one place deliberately. */
export const TOKEN_PATTERN = /<([A-Z][A-Z0-9]*)_(\d+)>/g;

export interface VaultEntry {
  token: string;
  kind: PiiKind;
  /**
   * The real value. Undefined for a sealed token - one that stands in for
   * something we deliberately never captured, such as a password's contents.
   */
  value?: string;
  sealed: boolean;
  createdAt: number;
  /** How many times this token has been resolved back to its value. */
  uses: number;
}

/** A view safe to render or log: shape without content. */
export interface VaultEntryView {
  token: string;
  kind: PiiKind;
  sealed: boolean;
  /** Character length of the hidden value, or 0 when sealed. */
  length: number;
  preview: string;
  uses: number;
}

export class Vault {
  private readonly byToken = new Map<string, VaultEntry>();
  /** kind + value -> token, so the same value always re-uses its token. */
  private readonly byValue = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly openedAt = Date.now();

  /**
   * Returns the token standing in for `value`. Calling this twice with the
   * same value and kind returns the same token.
   */
  tokenize(value: string, kind: PiiKind): string {
    const key = kind + " " + value;
    const existing = this.byValue.get(key);
    if (existing) return existing;

    const token = this.mint(kind);
    this.byToken.set(token, {
      token,
      kind,
      value,
      sealed: false,
      createdAt: Date.now(),
      uses: 0,
    });
    this.byValue.set(key, token);
    return token;
  }

  /**
   * Mints a token with no value behind it, for data we chose not to capture.
   * The planner still sees that a field is populated - which is the point, an
   * empty field and a filled password field are different facts - but there is
   * nothing here to leak, and resolving it returns undefined forever.
   */
  seal(kind: PiiKind): string {
    const token = this.mint(kind);
    this.byToken.set(token, {
      token,
      kind,
      sealed: true,
      createdAt: Date.now(),
      uses: 0,
    });
    return token;
  }

  private mint(kind: PiiKind): string {
    const prefix = PREFIX[kind] ?? "PII";
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return "<" + prefix + "_" + next + ">";
  }

  /** The real value behind a token, or undefined if unknown or sealed. */
  resolve(token: string): string | undefined {
    const entry = this.byToken.get(token);
    if (!entry || entry.sealed) return undefined;
    entry.uses++;
    return entry.value;
  }

  /** True if this vault issued the token. */
  issued(token: string): boolean {
    return this.byToken.has(token);
  }

  /**
   * Replaces every token in `text` with its real value.
   *
   * This is the last step before an action touches the page, and it is
   * deliberately strict: a token this vault never issued is left untouched and
   * reported, because a token the client never minted can only have come from
   * the model or the page - never from us.
   */
  resolveAll(text: string): { text: string; unknown: string[]; sealed: string[] } {
    const unknown: string[] = [];
    const sealed: string[] = [];

    const out = text.replace(TOKEN_PATTERN, (match) => {
      const entry = this.byToken.get(match);
      if (!entry) {
        unknown.push(match);
        return match;
      }
      if (entry.sealed) {
        sealed.push(match);
        return match;
      }
      entry.uses++;
      return entry.value!;
    });

    return { text: out, unknown, sealed };
  }

  /** Content-free view of what the vault holds. Safe to render. */
  view(): VaultEntryView[] {
    return Array.from(this.byToken.values()).map((entry) => ({
      token: entry.token,
      kind: entry.kind,
      sealed: entry.sealed,
      length: entry.value?.length ?? 0,
      preview: entry.sealed ? "(never captured)" : previewOf(entry.value ?? ""),
      uses: entry.uses,
    }));
  }

  /**
   * Every real value and its token.
   *
   * Deliberately separate from `view()`, which is content-free and safe to
   * render. This one returns secrets and exists for exactly one caller: the
   * step that rewrites the user's request into the same tokens the page uses.
   */
  values(): { value: string; token: string }[] {
    const out: { value: string; token: string }[] = [];
    for (const entry of this.byToken.values()) {
      if (!entry.sealed && entry.value) out.push({ value: entry.value, token: entry.token });
    }
    return out;
  }

  get size(): number {
    return this.byToken.size;
  }

  get ageMs(): number {
    return Date.now() - this.openedAt;
  }

  /**
   * Makes the vault safe to stringify by accident.
   *
   * Today the private Maps happen to serialise as `{}`, but that is a property
   * of Map, not a guarantee about this class - one plain-object field added
   * later would silently start leaking every value through any console.log or
   * structured clone. Defining toJSON makes the safe behaviour explicit.
   */
  toJSON(): { vault: string; entries: number } {
    return { vault: "sealed", entries: this.byToken.size };
  }

  /** Drops every mapping. Irreversible - the tokens become unresolvable. */
  clear(): void {
    this.byToken.clear();
    this.byValue.clear();
    this.counters.clear();
  }
}

/** Shows the shape of a value without revealing it. */
function previewOf(value: string): string {
  const dot = "•";
  if (value.length <= 2) return dot.repeat(value.length);
  if (value.length <= 6) return value[0] + dot.repeat(value.length - 1);
  return value.slice(0, 2) + dot.repeat(Math.min(8, value.length - 4)) + value.slice(-2);
}

/**
 * Neutralises text that already looks like one of our tokens.
 *
 * A page can contain the literal string "<EMAIL_1>". If that reached the
 * planner unchanged, the resolver would later swap it for a real address the
 * page never had. Rewriting it on the way in makes token syntax something only
 * we can produce.
 */
export function escapeExistingTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, (match) => "‹" + match.slice(1, -1) + "›");
}

import type { Finding } from "../pii/types";

/**
 * A record of everything that has left this browser.
 *
 * Two reasons this exists rather than a console.log.
 *
 * First, it is the only honest way to answer "what did the model actually
 * see?". Every other view in this extension shows an intermediate: findings,
 * the vault, the sanitized tree. This shows the bytes.
 *
 * Second, it re-runs the detector over the outgoing payload at the moment of
 * sending. The tests assert that nothing leaks on fixtures; this asserts it on
 * whatever page the user is really on, every turn, and says so loudly when
 * something survives. A privacy claim that is only checked in CI is a claim
 * about CI.
 *
 * The log holds sanitized payloads by definition - they are what was sent - so
 * it is safe to display. Nothing here ever sees a raw capture.
 */

export interface WireRecord {
  id: string;
  turn: number;
  at: number;
  /** Which provider and model received this. */
  destination: string;
  /** Characters of system prompt. Constant, so only its size is interesting. */
  systemChars: number;
  /** Every message, rendered exactly as it was sent. */
  messages: { role: string; text: string }[];
  /** The redacted screenshot, if one was attached. */
  image?: { dataUrl: string; bytes: number };
  /** Tokens present in the outgoing text. */
  tokens: string[];
  /**
   * Findings from re-running detection over the outgoing payload.
   *
   * Anything here is PII that reached the wire. It should always be empty.
   */
  leaked: Finding[];
  /** Total characters sent, for cost intuition. */
  totalChars: number;
}

/**
 * Kept small on purpose. Screenshots dominate the size, and a log that grows
 * without limit in a service worker is a memory leak with a nice name.
 */
const MAX_RECORDS = 24;
const MAX_IMAGE_BYTES = 3_000_000;

let records: WireRecord[] = [];
let sequence = 0;

export function recordWire(entry: Omit<WireRecord, "id" | "at">): WireRecord {
  const record: WireRecord = {
    ...entry,
    id: `w${++sequence}`,
    at: Date.now(),
  };

  // Drop the pixels rather than the record if the image is very large; the
  // metadata is the part that matters for an audit.
  if (record.image && record.image.bytes > MAX_IMAGE_BYTES) {
    record.image = { dataUrl: "", bytes: record.image.bytes };
  }

  records.push(record);
  if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
  return record;
}

export function wireRecords(): WireRecord[] {
  return records;
}

export function clearWire(): void {
  records = [];
  sequence = 0;
}

/** Every token in a string, deduplicated and sorted. */
export function tokensIn(text: string): string[] {
  return [...new Set(text.match(/<[A-Z][A-Z0-9]*_\d+>/g) ?? [])].sort();
}

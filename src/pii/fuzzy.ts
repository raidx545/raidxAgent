/**
 * Finding a value the page already named, in text OCR read imperfectly.
 *
 * The tree gives exact strings; OCR gives what it saw. The same phone number
 * arrives as "98765 43210" in one and "9876543210" or "98765-43210" in the
 * other, and the same name as "Kavya Iyer" and "KAVYA lYER" - the capital I
 * read as a lower-case l. An exact, case-folded search found none of those, so
 * a value the page had already tokenized was left readable in the picture.
 *
 * Two things make the match tolerant without making it loose:
 *
 *  - Both sides are folded to a canonical form first: case dropped,
 *    separators dropped, and the characters OCR confuses by shape (O/0, I/l/1,
 *    S/5, B/8, Z/2) mapped together. Most misreadings vanish here.
 *  - What remains may differ by a small number of edits, scaled to the length
 *    of the value - one in eight characters, at most two. A short value gets
 *    no slack at all, because a four-letter word one edit away from another is
 *    usually a different word.
 */

const FOLD: Record<string, string> = { o: "0", i: "1", l: "1", "|": "1", s: "5", b: "8", z: "2" };

/** The canonical form, and where each canonical character came from. */
function canonical(text: string): { chars: string; from: number[] } {
  let chars = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const lower = text[i].toLowerCase();
    const folded = FOLD[lower] ?? lower;
    if (!/[\p{L}\p{N}]/u.test(folded)) continue;
    chars += folded;
    from.push(i);
  }
  return { chars, from };
}

/** Edits a value of this canonical length may differ by. */
export function slack(length: number): number {
  if (length < 8) return 0;
  return Math.min(2, Math.floor(length / 8));
}

/**
 * Every place in `text` where `value` appears, allowing for OCR's mistakes.
 * Returns character ranges in `text`, non-overlapping, left to right.
 */
export function findApprox(text: string, value: string): [number, number][] {
  const needle = canonical(value).chars;
  if (needle.length < 4) return [];
  const hay = canonical(text);
  const m = needle.length;
  const n = hay.chars.length;
  const k = slack(m);
  if (n < m - k) return [];

  const out: [number, number][] = [];
  const alnum = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
  const push = (start: number, end: number): boolean => {
    if (start < 0 || end > n || start >= end) return false;
    const a = hay.from[start];
    const b = hay.from[end - 1] + 1;
    // A match inside a longer word is a different word: "Rahu" is not in
    // "Rahul", and a surname is not in a longer surname.
    if (alnum(text[a - 1]) || alnum(text[b])) return false;
    if (out.length > 0 && a < out[out.length - 1][1]) return false;
    out.push([a, b]);
    return true;
  };

  if (k === 0) {
    let at = hay.chars.indexOf(needle);
    while (at !== -1) {
      push(at, at + m);
      at = hay.chars.indexOf(needle, at + m);
    }
    return out;
  }

  // Sellers' algorithm: edit distance of the needle against every substring
  // of the haystack ending at each position, with a free start. `start`
  // tracks where the best alignment ending here began.
  let prev = new Array<number>(m + 1);
  let prevStart = new Array<number>(m + 1);
  let cur = new Array<number>(m + 1);
  let curStart = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) { prev[i] = i; prevStart[i] = 0; }

  // Every good ending in a run is one occurrence seen k+1 ways. Settle each
  // run once: the cheapest alignment that lands on word boundaries, the
  // longer one on a tie - "98765 43219" against "98765 43210" also aligns,
  // at the same cost, one digit short, and that one ends mid-number.
  let run: { cost: number; start: number; end: number }[] = [];
  const settleRun = (): void => {
    run.sort((x, y) => x.cost - y.cost || (y.end - y.start) - (x.end - x.start));
    for (const candidate of run) if (push(candidate.start, candidate.end)) break;
    run = [];
  };
  for (let j = 1; j <= n; j++) {
    cur[0] = 0;
    curStart[0] = j;
    for (let i = 1; i <= m; i++) {
      const same = needle[i - 1] === hay.chars[j - 1] ? 0 : 1;
      let cost = prev[i - 1] + same;
      let start = prevStart[i - 1];
      if (prev[i] + 1 < cost) { cost = prev[i] + 1; start = prevStart[i]; }
      if (cur[i - 1] + 1 < cost) { cost = cur[i - 1] + 1; start = curStart[i - 1]; }
      cur[i] = cost;
      curStart[i] = start;
    }

    if (cur[m] <= k) run.push({ cost: cur[m], start: curStart[m], end: j });
    else if (run.length > 0) settleRun();
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }
  if (run.length > 0) settleRun();
  return out;
}

import type { TranscriptEntry } from "../shared/types";

/**
 * The transcript, as DOM.
 *
 * Split out of the panel so it can be driven by a test with a real document and
 * no extension around it - which is how the bug this file exists to fix was
 * finally pinned down.
 *
 * That bug: entry ids came from a counter in the service worker, and Chrome
 * terminates an idle MV3 worker whenever it likes. The counter restarted at
 * one; the panel, being a separate document, kept every node it had already
 * rendered. So a fresh assistant entry arrived under an id the panel had
 * already used for a *step*, found that node, and wrote its text into it -
 * destroying the step's two spans. `.entry.step` is a two-column grid whose
 * first column is 20px wide, and a bare text node becomes an anonymous grid
 * item in that column. The model's prose came out two characters per line,
 * high up the panel where the old step had been.
 *
 * The id is now unique per worker lifetime, and this view refuses to reuse a
 * node whose role does not match - either alone would have prevented it, and
 * the second is what makes the whole class of mismatch impossible.
 */

const GLYPHS: Record<string, string> = {
  click: "→",
  type: "⌨",
  select: "▾",
  scroll: "↕",
  key: "⏎",
  find_text: "⌕",
  wait: "◷",
  read_page: "◉",
  navigate: "⇢",
  go_back: "⇠",
  open_tab: "＋",
  switch_tab: "⇄",
  close_tab: "×",
  list_tabs: "☰",
  ask_user: "?",
};

/** Steps beyond this in one run are folded away until asked for. */
const STEPS_BEFORE_FOLDING = 5;

interface Row {
  el: HTMLElement;
  role: TranscriptEntry["role"];
  /** Steps keep their inner spans; replacing textContent would destroy them. */
  glyph?: HTMLElement;
  detail?: HTMLElement;
}

export interface PatchOptions {
  text?: string;
  pending?: boolean;
  /** Replace the text rather than appending a streamed delta. */
  replace?: boolean;
}

export class TranscriptView {
  private readonly rows = new Map<string, Row>();
  /** The run of consecutive steps currently being appended to, if any. */
  private group: HTMLElement | undefined;
  private groupCount = 0;

  constructor(private readonly container: HTMLElement) {}

  get size(): number {
    return this.rows.size;
  }

  /** Steps rendered so far, folded or not. */
  get steps(): number {
    let count = 0;
    for (const row of this.rows.values()) if (row.role === "step") count++;
    return count;
  }

  clear(): void {
    for (const row of this.rows.values()) row.el.remove();
    this.rows.clear();
    this.container.querySelectorAll(".steps").forEach((n) => n.remove());
    this.group = undefined;
    this.groupCount = 0;
  }

  /** Creates the row if it is new, updates it if it is not. */
  render(entry: TranscriptEntry): void {
    const existing = this.rows.get(entry.id);

    // A row whose role has changed is not the same row. Reusing it would write
    // an assistant's prose into a step's grid, or a step's glyph into a user
    // bubble - so the old one goes and a fresh one takes its place.
    if (existing && existing.role !== entry.role) {
      existing.el.remove();
      this.rows.delete(entry.id);
    }

    const row = this.rows.get(entry.id) ?? this.create(entry);
    this.fill(row, entry);
  }

  patch(id: string, options: PatchOptions): boolean {
    const row = this.rows.get(id);
    if (!row) return false;

    if (options.text !== undefined) {
      if (row.role === "step") {
        // Steps are replaced, never appended: a step reports one outcome.
        row.detail!.textContent = options.text;
      } else if (row.role === "assistant" && !options.replace) {
        row.el.textContent = (row.el.textContent ?? "") + options.text;
      } else {
        row.el.textContent = options.text;
      }
    }

    if (options.pending !== undefined) {
      row.el.classList.toggle("pending", options.pending);
    }

    return true;
  }

  // ------------------------------------------------------------------ internals

  private create(entry: TranscriptEntry): Row {
    const el = document.createElement("div");
    el.className = `entry ${entry.role}`;

    const row: Row = { el, role: entry.role };

    if (entry.role === "step") {
      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.setAttribute("aria-hidden", "true");
      const detail = document.createElement("span");
      detail.className = "detail";
      el.append(glyph, detail);
      row.glyph = glyph;
      row.detail = detail;
      this.appendStep(el);
    } else {
      // Anything that is not a step ends the current run of steps.
      this.closeGroup();
      this.container.appendChild(el);
    }

    this.rows.set(entry.id, row);
    return row;
  }

  private fill(row: Row, entry: TranscriptEntry): void {
    if (row.role === "step") {
      row.glyph!.textContent = GLYPHS[entry.action ?? ""] ?? "•";
      row.detail!.textContent = entry.text;
    } else {
      row.el.textContent = entry.text;
    }
    row.el.classList.toggle("pending", entry.pending === true);
  }

  /**
   * Steps go into a run rather than straight into the transcript.
   *
   * A single task can produce thirty of them - one real run scrolled fifteen
   * times - and thirty grey lines bury the answer they were working towards.
   * A run folds itself once it is long enough, keeping the most recent few
   * visible because those are the ones that still matter.
   */
  private appendStep(el: HTMLElement): void {
    if (!this.group) {
      const group = document.createElement("div");
      group.className = "steps";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "steps-toggle";
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        const folded = group.classList.toggle("unfolded");
        toggle.setAttribute("aria-expanded", String(folded));
        this.labelGroup(group);
      });

      const list = document.createElement("div");
      list.className = "steps-list";

      group.append(toggle, list);
      this.container.appendChild(group);
      this.group = group;
      this.groupCount = 0;
    }

    this.group.querySelector(".steps-list")!.appendChild(el);
    this.groupCount++;
    this.group.classList.toggle("folded", this.groupCount > STEPS_BEFORE_FOLDING);
    this.labelGroup(this.group);
  }

  private labelGroup(group: HTMLElement): void {
    const count = group.querySelectorAll(".entry.step").length;
    const toggle = group.querySelector<HTMLElement>(".steps-toggle")!;
    const hidden = count - (STEPS_BEFORE_FOLDING - 2);
    toggle.textContent = group.classList.contains("unfolded")
      ? `Hide ${count} actions`
      : `${hidden} earlier action${hidden === 1 ? "" : "s"}`;
    toggle.hidden = !group.classList.contains("folded");
  }

  private closeGroup(): void {
    this.group = undefined;
    this.groupCount = 0;
  }
}

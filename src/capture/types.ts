/**
 * The capture layer's output: a structured view of the page plus the pixels,
 * carrying enough geometry that a finding in the DOM can be located in the
 * screenshot and vice versa.
 */

/** Viewport-relative CSS pixels: [x, y, width, height]. */
export type BBox = [number, number, number, number];

export interface CapturedNode {
  /** Stable within one capture. */
  id: number;
  tag: string;
  /** ARIA role, explicit or derived. */
  role: string;
  /** Accessible name. */
  label: string;
  /** Text belonging to this node directly, not to its descendants. */
  text?: string;
  /** Current value of a form control. Never the contents of a password field. */
  value?: string;
  /** The subset of attributes that carry signal about what a field holds. */
  attrs: Record<string, string>;
  bbox: BBox;
  /** True when the node intersects the visible viewport. */
  visible: boolean;
  children: CapturedNode[];
}

export interface Viewport {
  width: number;
  height: number;
  /** Screenshot pixels per CSS pixel — captureVisibleTab renders at this scale. */
  dpr: number;
  /**
   * Window scroll. This is the screenshot coordinate frame - see the note on
   * ScreenshotMeta - so it must stay the *window's* offset even on pages where
   * the window never moves. What the user is looking at is below.
   */
  scrollX: number;
  scrollY: number;
  pageHeight: number;
  /**
   * Where the page's own scrolling region sits, which on an application shell
   * (Gmail, Slack, most SPAs) is an inner container rather than the window.
   * Absent when the document itself scrolls, in which case the fields above
   * already say it.
   */
  contentScrollY?: number;
  contentHeight?: number;
}

export interface DomCapture {
  url: string;
  /** Origin only. The path can itself carry identifiers. */
  origin: string;
  title: string;
  capturedAt: number;
  viewport: Viewport;
  root: CapturedNode;
  stats: {
    /** Elements examined before pruning. */
    examined: number;
    /** Nodes kept in the tree. */
    kept: number;
    /** Nodes dropped as structurally uninteresting. */
    pruned: number;
  };
}

/**
 * A screenshot plus the coordinate frame needed to locate anything in it.
 *
 * Element bboxes are viewport-relative, but a stitched full-page image is
 * document-relative. Rather than have callers remember which is which, the
 * image carries its own origin and scale, and everything converts through
 * document coordinates:
 *
 *   documentX = bbox.x + viewport.scrollX
 *   imageX    = (documentX - originX) * scale
 *
 * For a viewport capture the origin *is* the scroll offset, so the second line
 * collapses back to `bbox.x * scale` - the two modes share one code path.
 */
export interface ScreenshotMeta {
  /** PNG data URL. */
  dataUrl: string;
  /** Whether the image covers the viewport or the whole scrollable page. */
  kind: "viewport" | "page";
  /** Image pixels per CSS pixel. */
  scale: number;
  /** Document-coordinate CSS offset of the image's top-left corner. */
  originX: number;
  originY: number;
  /** CSS pixels the image covers. */
  cssWidth: number;
  cssHeight: number;
  /** How many viewport captures were stitched together. */
  tiles: number;
  /** Set when the page was taller than the cap, in document CSS pixels. */
  truncatedAtCssY?: number;
  /** Set when the image was scaled down after stitching, for token cost. */
  downscaledFrom?: { width: number; height: number };
}

export interface Capture {
  dom: DomCapture;
  screenshot?: ScreenshotMeta;
  screenshotError?: string;
}

/**
 * Key names, as a model writes them and as the DOM wants them.
 *
 * Shared because two places must agree on what a key press is: the page, which
 * performs it, and the safety gate, which decides whether it may happen. A
 * gate that parsed "cmd+Return" differently from the page would be judging a
 * different key from the one that gets pressed.
 */

export interface KeyCombo { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }

/** "ctrl+shift+Enter" -> its parts. The last segment is the key itself. */
export function parseKey(raw: string): KeyCombo {
  // A bare space is the Space key, not an empty string - trimming it away
  // turned every "press Space" into "No key given".
  if (raw.length > 0 && raw.trim() === "") raw = " ";
  const parts = raw === " " ? [" "] : raw.split("+").map((p) => p.trim()).filter(Boolean);
  // "ctrl+ " and "shift+Space" alike: a trailing "+ " means the Space key.
  if (raw !== " " && /\+\s+$/.test(raw)) parts.push(" ");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return {
    key: normaliseKey(key),
    ctrl: mods.has("ctrl") || mods.has("control"),
    shift: mods.has("shift"),
    alt: mods.has("alt") || mods.has("option"),
    meta: mods.has("meta") || mods.has("cmd") || mods.has("command"),
  };
}

/** Accepts the spellings a model reaches for and returns the DOM key name. */
export function normaliseKey(key: string): string {
  const named: Record<string, string> = {
    enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab",
    space: " ", spacebar: " ", backspace: "Backspace", delete: "Delete", del: "Delete",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
    home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  };
  return named[key.toLowerCase()] ?? key;
}

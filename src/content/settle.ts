/**
 * Waiting for the page instead of waiting for the clock.
 *
 * Every action used to end in a fixed sleep - 500ms after a click, 400ms after
 * typing, 300ms after a scroll. A fixed sleep is wrong in both directions at
 * once. On a static page it is dead time on every single step, and a task of
 * twenty steps spends ten seconds doing nothing. On a slow application it is
 * not nearly long enough: Gmail's compose window takes longer than 500ms to
 * mount on a cold tab, so the capture that followed the click described a page
 * where the click had not happened yet, and the planner drew the obvious
 * conclusion - nothing happened, click again.
 *
 * Watching the DOM instead is faster in the common case and more patient in the
 * rare one, which is the right way round.
 */

/**
 * How long to wait for the first sign of life before deciding there is none.
 *
 * This is the one number with a real trade-off in it. Too short and a slow
 * reaction is missed - the agent is told nothing happened, and the whole
 * clicking-Compose-forever failure comes straight back. Too long and every
 * action that genuinely does nothing costs that much dead time.
 *
 * So it is set per action rather than globally. A click may take most of a
 * second to open something on a heavy application, and a click that opens
 * nothing is rare - so clicks are patient. A scroll or a keystroke either
 * moves the page immediately or never, so those stay quick.
 */
const START_TIMEOUT = 250;

/** The grace a click gets, where a missed reaction is expensive. */
export const CLICK_START = 900;

/** How still the DOM must be before we call it settled. */
const QUIET = 120;

/** The longest we will ever wait, however busy the page is. */
const CEILING = 3000;

/**
 * Resolves once the page stops changing, or once the ceiling is reached.
 *
 * A page that never quiets down - a clock, a spinner, an animated advert - hits
 * the ceiling and proceeds. That is correct: something permanently in motion is
 * not a reason to refuse to act, and the ceiling is what stops a carousel from
 * hanging the agent.
 */
export function settle(options: { start?: number; quiet?: number; ceiling?: number } = {}): Promise<void> {
  const startTimeout = options.start ?? START_TIMEOUT;
  const quiet = options.quiet ?? QUIET;
  const ceiling = options.ceiling ?? CEILING;

  return new Promise<void>((resolve) => {
    let quietTimer = 0;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(ceilingTimer);
      observer.disconnect();
      // One frame, so anything the last mutation triggered has been laid out
      // before the caller measures the page.
      requestAnimationFrame(() => resolve());
    };

    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = self.setTimeout(finish, quiet);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    const ceilingTimer = self.setTimeout(finish, ceiling);

    // Nothing may ever happen - a click on an inert element, a scroll that hits
    // the end. Give the page a moment to react, then stop waiting for it.
    quietTimer = self.setTimeout(finish, startTimeout);
  });
}

/**
 * Waits for the page to settle, then for a condition to hold.
 *
 * Used where we know what we are waiting for and can say so - a navigation
 * committing, a dialog appearing. Polls on animation frames, so it costs
 * nothing while the tab is in the background.
 */
export async function settleUntil(
  condition: () => boolean,
  options: { ceiling?: number } = {},
): Promise<boolean> {
  const ceiling = options.ceiling ?? CEILING;
  const deadline = Date.now() + ceiling;

  if (condition()) {
    await settle({ ceiling: Math.max(0, deadline - Date.now()) });
    return true;
  }

  while (Date.now() < deadline) {
    await settle({ ceiling: Math.max(0, deadline - Date.now()) });
    if (condition()) return true;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  return condition();
}

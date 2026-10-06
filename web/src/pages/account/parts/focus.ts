/**
 * Keeping keyboard focus where it belongs when a control replaces itself: a form that turns into a waiting card, a
 * "Removed" button whose row folds away, a secret card that closes. Without help the focused element leaves the DOM,
 * focus falls to the page body, and inside a modal drawer Tab and Escape stop working.
 *
 *   handFocus(block, () => pendingCard);   // call right after the state change that swaps the content
 */

const lost = (active: Element | null) => !active || active === document.body || active === document.documentElement;

/** True when focus is inside `scope`, or was lost to the page body (the control that had it just left the DOM). */
export function focusIsWithin(scope: Element | null | undefined): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return lost(active) || !!(active && scope?.contains(active));
}

/**
 * Moves focus to `target()` once the DOM has updated, if the control that had focus is being replaced: focus was in
 * `scope` (or already lost) when this is called, and by the time the new content is in place it is either lost or
 * still where it was. Focus the visitor moved somewhere else on their own is never taken away.
 */
export function handFocus(scope: Element | null | undefined, target: () => HTMLElement | null | undefined, options: { preventScroll?: boolean } = {}): void {
  if (!focusIsWithin(scope)) return;
  const before = document.activeElement;
  // Two frames: the swap renders in the first, and height and presence animations have attached their nodes by the second.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!lost(active) && active !== before) return;
    const element = target();
    if (element?.isConnected) element.focus({ preventScroll: options.preventScroll ?? true });
  }));
}

/** The shell's main region: the scope of a page's own focus handoffs (drawers and dialogs render outside it). */
export function pageMain(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.getElementById("main");
}

const CONTROL = 'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]';

/**
 * After an item left a list (its row folded away, or it moved to another view), focus the first control of the first
 * item still there, else `fallback()`, so keyboard focus does not drop back to the top of the page.
 */
export function focusAfterRemoval(list: () => Element | null | undefined, fallback?: () => HTMLElement | null | undefined): void {
  handFocus(pageMain(), () => list()?.querySelector<HTMLElement>(`:scope > [role="listitem"]:not([data-leaving]) :is(${CONTROL})`) ?? fallback?.());
}

/** The pressed option of the page's segmented control (its view switch): a steady place to land. */
export function pressedViewOption(): HTMLElement | null {
  return pageMain()?.querySelector<HTMLElement>('[role="group"] button[aria-pressed="true"]') ?? null;
}

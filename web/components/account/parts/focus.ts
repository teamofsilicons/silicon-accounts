/**
 * Keeping keyboard focus where it belongs when a control replaces itself: a form that turns into a waiting card, a
 * "Removed" button whose row folds away, a secret card that closes. Without help the focused element leaves the DOM,
 * focus falls to the page body, and inside a modal drawer Tab and Escape stop working.
 *
 *   handFocus(block, () => pendingCard);   // call right after the state change that swaps the content
 */

/**
 * Focus counts as lost on the page body, and on a modal dialog's own container: Radix moves focus there when the focused
 * element leaves the DOM inside a dialog, so the trap holds, but nothing useful has focus.
 */
const lost = (active: Element | null) => !active || active === document.body || active === document.documentElement || active.getAttribute("role") === "dialog";

/** True when focus is inside `scope`, or was lost to the page body (the control that had it just left the DOM). */
export function focusIsWithin(scope: Element | null | undefined): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return lost(active) || !!(active && scope?.contains(active));
}

/** The nearest ancestor that scrolls its content (overflow auto or scroll), else null for the page itself. */
function scroller(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Scrolls `element` into view by moving only its own scroller (a drawer's body, or the page). `element.focus()` and
 * `scrollIntoView()` would also scroll every clipping ancestor, a drawer panel included, and push its header out of
 * sight. "start" puts the element near the top; "nearest" scrolls only as far as needed.
 */
export function bringIntoView(element: HTMLElement, align: "start" | "nearest" = "nearest"): void {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior: ScrollBehavior = smooth ? "smooth" : "auto";
  const parent = scroller(element);
  const rect = element.getBoundingClientRect();
  if (parent) {
    const box = parent.getBoundingClientRect();
    const above = rect.top - box.top - 16;
    const below = rect.bottom - box.bottom + 16;
    const delta = align === "start" ? above : above < 0 ? above : below > 0 ? Math.min(below, above) : 0;
    if (delta) parent.scrollTo({ top: Math.max(0, parent.scrollTop + delta), behavior });
    return;
  }
  // The page: keep clear of the top row and of the floating dock at the bottom.
  const top = 96;
  const bottom = window.innerHeight - 120;
  const delta = align === "start" ? rect.top - top : rect.top < top ? rect.top - top : rect.bottom > bottom ? Math.min(rect.bottom - bottom, rect.top - top) : 0;
  if (delta) window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior });
}

/**
 * Moves focus to `target()` once the DOM has updated, if the control that had focus is being replaced: focus was in
 * `scope` (or already lost) when this is called, and by the time the new content is in place it is either lost or
 * still where it was. Focus the visitor moved somewhere else on their own is never taken away.
 */
export function handFocus(scope: Element | null | undefined, target: () => HTMLElement | null | undefined, options: { preventScroll?: boolean } = {}): void {
  // (Focus never scrolls on its own here; the new control is brought into view through its own scroller.)
  if (!focusIsWithin(scope)) return;
  const before = document.activeElement;
  // Two frames: React commits the swap in the first, and height and presence animations have attached their nodes by
  // the second.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (!lost(active) && active !== before && active?.isConnected) return;
    const element = target();
    if (!element?.isConnected) return;
    element.focus({ preventScroll: true });
    if (!options.preventScroll) bringIntoView(element);
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

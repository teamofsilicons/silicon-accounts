/**
 * Focus that would fall to the start of the page. Some controls leave as a result of being used: Save and Discard
 * leave the save bar once nothing is unsaved, a conflict's two choices leave with the conflict. When the control that
 * had focus is gone, focus goes back to the last place the Carbon worked in on the page (outside such passing parts,
 * which carry `data-focus-transient`), else to the tab's panel, so keyboard and screen reader users keep their place.
 */
import { useEffect } from "react";

const TRANSIENT = "[data-focus-transient]";
let last: HTMLElement | null = null;
let users = 0;

function remember(event: FocusEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.closest(TRANSIENT) || !target.closest("main")) return;
  last = target;
}

/** Remembers where focus last was on the page (outside passing parts) while the calling component is mounted. */
export function useFocusMemory(): void {
  useEffect(() => {
    if (users++ === 0) document.addEventListener("focusin", remember);
    return () => {
      if (--users > 0) return;
      document.removeEventListener("focusin", remember);
      last = null;
    };
  }, []);
}

/** The tab's panel: the place to land when nothing better is left. */
export const activeTabPanel = () => document.querySelector<HTMLElement>("[role='tabpanel'][data-state='active']");

/**
 * After the update in progress has rendered: when focus fell to the page (its control left the DOM), or is still in
 * `leaving` (a part on its way out, still animating), puts it back on the last place the Carbon worked in, else on
 * `fallback()`, else on the tab's panel. Focus anywhere else is left alone.
 */
export function returnFocusIfLost(options: { leaving?: Element | null; fallback?: () => HTMLElement | null } = {}): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || !!options.leaving?.contains(active);
    if (!lost) return;
    const target = (last?.isConnected ? last : null) ?? options.fallback?.() ?? activeTabPanel();
    target?.focus({ preventScroll: true });
  });
}

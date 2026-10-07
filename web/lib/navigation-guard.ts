"use client";

/**
 * Asking before leaving unsaved work. The App Router cannot block a navigation, so the account site sends every
 * navigation it starts through one gate:
 *
 *   - the shell's own moves (the dock and its phone sheet, the brand, the command palette, the section number keys, the
 *     user menu's Settings, signing out) call `confirmNavigation(href, …)` before they go;
 *   - a plain click on any other same-origin link (a page's own <Link>) is caught on the window in the capture phase,
 *     before Next's Link sees it, while a guard protects its destination (`useGuardedLinks`, run by the shell). Links
 *     that already ask through `confirmNavigation` carry `data-guarded-navigation` and are left alone.
 *
 * A page with something to lose registers a guard while it has it:
 *
 *   useNavigationGuard(dirty ? {
 *     protects: href => !href.startsWith(base),          // default: every destination (and signing out)
 *     confirm: request => askMyOwnQuestion(request),      // resolves true to leave, false to stay
 *   } : null);
 *
 * Without `confirm`, the shell asks its own question (`question`: title, description, button labels) in a dialog
 * (<LeaveQuestionHost />, mounted by the shell). `request.returnFocus` is the link or control that started the
 * navigation: give focus back to it when the Carbon stays.
 *
 * What cannot be asked: Back/Forward and a typed address (keep the work for this browser tab where possible), and a
 * reload or closing the tab (set `beforeunload` while there is unsaved work; the browser asks its own question).
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

export type LeaveReason = "navigate" | "sign-out";

export interface LeaveRequest {
  /** Where the navigation goes: a same-origin path with its query and hash ("/" when signing out). */
  href: string;
  /** "sign-out": the Carbon is signing out, so nothing in this browser tab can be kept across it. */
  reason: LeaveReason;
  /** Where focus goes back when the Carbon stays: the link or control that started the navigation, if any. */
  returnFocus: HTMLElement | null;
}

export interface LeaveQuestion {
  title: string;
  description: string;
  /** Default "Leave". */
  leaveLabel?: string;
  /** Default "Stay". */
  stayLabel?: string;
}

export interface NavigationGuard {
  /** True when leaving to `href` (for `reason`) loses something. Default: every destination. */
  protects?: (href: string, reason: LeaveReason) => boolean;
  /** Asks the Carbon in the page's own words and dialog; resolves true to leave. */
  confirm?: (request: LeaveRequest) => Promise<boolean>;
  /** Or the shell's question (used when `confirm` is absent). */
  question?: LeaveQuestion;
}

/** Marks links (and controls) that ask through confirmNavigation themselves: the window capture leaves them alone. */
export const GUARDED_NAVIGATION = "data-guarded-navigation";

const DEFAULT_QUESTION: LeaveQuestion = {
  title: "Leave this page?",
  description: "What you changed here is not saved yet, and leaving loses it.",
};

/** Registered guards, oldest first. */
const guards = new Set<NavigationGuard>();

export function registerNavigationGuard(guard: NavigationGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

const protecting = (href: string, reason: LeaveReason) => [...guards].reverse().filter(guard => !guard.protects || guard.protects(href, reason));

/** True when some guard would ask before leaving to `href`. */
export function navigationIsGuarded(href: string, reason: LeaveReason = "navigate"): boolean {
  return protecting(href, reason).length > 0;
}

/**
 * Asks every guard that protects `href` (the most recently registered first); resolves true when nothing objects.
 * Call it before any navigation the site starts itself.
 */
export async function confirmNavigation(href: string, options: { reason?: LeaveReason; returnFocus?: HTMLElement | null } = {}): Promise<boolean> {
  const request: LeaveRequest = { href, reason: options.reason ?? "navigate", returnFocus: options.returnFocus ?? null };
  for (const guard of protecting(href, request.reason)) {
    const leave = guard.confirm ? await guard.confirm(request) : await askQuestion(guard.question ?? DEFAULT_QUESTION, request);
    if (!leave) return false;
  }
  return true;
}

/**
 * Registers `guard` while it is not null (re-registering only when it switches between null and a guard; the latest
 * callbacks are always used).
 */
export function useNavigationGuard(guard: NavigationGuard | null): void {
  const latest = useRef(guard);
  useEffect(() => {
    latest.current = guard;
  });
  const active = guard !== null;
  useEffect(() => {
    if (!active) return;
    return registerNavigationGuard({
      protects: (href, reason) => {
        const current = latest.current;
        return !!current && (!current.protects || current.protects(href, reason));
      },
      confirm: request => {
        const current = latest.current;
        if (!current) return Promise.resolve(true);
        return current.confirm ? current.confirm(request) : askQuestion(current.question ?? DEFAULT_QUESTION, request);
      },
    });
  }, [active]);
}

/**
 * Catches plain clicks on same-origin links while a guard protects their destination: the link does not navigate on
 * its own; the guards are asked, and `navigate(href)` runs when the Carbon leaves. The shell runs this once. A link in
 * an open layer (a sheet, a dialog) closes its layer first, so the question is never asked over it.
 */
export function useGuardedLinks(navigate: (href: string) => void): void {
  const go = useRef(navigate);
  useEffect(() => {
    go.current = navigate;
  });
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!guards.size || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.closest(`[${GUARDED_NAVIGATION}]`) || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const href = `${url.pathname}${url.search}${url.hash}`;
      // A link to this very page (or only its hash) leaves nothing behind.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      if (!navigationIsGuarded(href)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const layer = anchor.closest<HTMLElement>("[role='dialog']");
      const opener = layer?.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(layer.id)}"]`) : null;
      if (layer) layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      void confirmNavigation(href, { returnFocus: layer ? opener : anchor }).then(leave => {
        if (leave) go.current(href);
      });
    };
    // Capturing on window runs before React's listeners (on the root), so a Link never starts navigating.
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The shell's question (for guards without a dialog of their own)                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface PendingQuestion {
  question: LeaveQuestion;
  request: LeaveRequest;
}

let pending: (PendingQuestion & { resolve: (leave: boolean) => void }) | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function askQuestion(question: LeaveQuestion, request: LeaveRequest): Promise<boolean> {
  return new Promise(resolve => {
    // A newer question replaces an unanswered one (that navigation stays put).
    pending?.resolve(false);
    pending = { question, request, resolve };
    emit();
  });
}

/** Answers the shell's open question: true leaves, false stays. */
export function answerLeaveQuestion(leave: boolean): void {
  const current = pending;
  if (!current) return;
  pending = null;
  emit();
  current.resolve(leave);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The question the shell's dialog shows now, or null. */
export function usePendingLeaveQuestion(): PendingQuestion | null {
  return useSyncExternalStore(subscribe, () => pending, () => null);
}

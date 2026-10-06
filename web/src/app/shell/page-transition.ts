/**
 * Transitions between top-level sections. With View Transitions (Chromium, Safari 18+) the old page slides out and
 * the new one in, in the direction of travel along the dock, while the dock stays put; without them the new page
 * rises in with Motion. Reduced motion: an instant change.
 */
import { createRoot, createSignal } from "solid-js";
import { animate, motionTokens, prefersReducedMotion } from "../../arc/lib/motion";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void> | void) => { finished: Promise<void>; ready: Promise<void>; skipTransition?: () => void };
};

const waiting = createRoot(() => {
  const [target, setTarget] = createSignal<{ path: string; resolve: () => void } | null>(null);
  return { target, setTarget };
});

/** The shell calls this after each render of a new location, which lets a pending transition capture the new page. */
export function pageRendered(pathname: string): void {
  const pending = waiting.target();
  if (pending && (pending.path === pathname || pathname.startsWith(`${pending.path}/`) || pending.path === "*")) {
    waiting.setTarget(null);
    pending.resolve();
  }
}

let running = false;

/**
 * Runs `navigate()` inside a page transition. `direction` is +1 when moving right along the dock, -1 left, 0 for
 * no direction (a plain crossfade). `path` is where navigate() goes, so the transition knows when the page is ready.
 */
export function transitionTo(path: string, direction: number, navigate: () => void): void {
  const doc = document as ViewTransitionDocument;
  if (!doc.startViewTransition || prefersReducedMotion() || running || document.visibilityState !== "visible") {
    navigate();
    return;
  }
  const root = document.documentElement;
  root.style.setProperty("--page-dir", String(Math.sign(direction)));
  root.setAttribute("data-transition", "page");
  running = true;
  const transition = doc.startViewTransition(
    () => new Promise<void>(resolve => {
      const timeout = window.setTimeout(() => { waiting.setTarget(null); resolve(); }, 900);
      waiting.setTarget({ path, resolve: () => { window.clearTimeout(timeout); resolve(); } });
      navigate();
    }),
  );
  transition.finished.finally(() => {
    running = false;
    if (root.getAttribute("data-transition") === "page") root.removeAttribute("data-transition");
    root.style.removeProperty("--page-dir");
  });
}

/** The fallback entrance for browsers without View Transitions (and for back/forward navigation). */
export function animatePageIn(el: HTMLElement, direction: number): void {
  if (prefersReducedMotion() || running) return;
  animate(
    el,
    { opacity: [0, 1], x: [direction * 14, 0], filter: [`blur(${motionTokens.blur.subtle}px)`, "blur(0px)"] },
    { duration: motionTokens.duration.considered, ease: [...motionTokens.ease.enter] as [number, number, number, number] },
  );
}

/** True while a View Transition between pages runs (the fallback animation stays out of its way). */
export function pageTransitionRunning(): boolean {
  return running;
}

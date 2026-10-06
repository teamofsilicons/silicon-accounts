/**
 * The eclipse theme change (Arc theme-switch-eclipse): the next appearance crosses the page as a disc that travels
 * from the switch, like a moon passing. Runs inside a View Transition; browsers without view transitions, and anyone
 * who prefers reduced motion, get an instant change.
 */
import { prefersReducedMotion } from "../arc/lib/motion";
import { applyTheme, resolveTheme, setThemePreference, type ThemePreference } from "./theme";

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => { finished: Promise<void>; ready: Promise<void> };
};

let running = false;

export function changeTheme(next: ThemePreference, trigger?: HTMLElement | null) {
  const doc = document as ViewTransitionDocument;
  const resolved = resolveTheme(next);
  const current = document.documentElement.getAttribute("data-theme");
  if (!doc.startViewTransition || prefersReducedMotion() || running || resolved === current) {
    setThemePreference(next);
    return;
  }
  const root = document.documentElement;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const rect = trigger?.getBoundingClientRect();
  const cx = rect ? rect.left + rect.width / 2 : width;
  const cy = rect ? rect.top + rect.height / 2 : 0;
  // A disc as large as the viewport diagonal covers the page from any centre inside it. It starts just behind the
  // switch (its leading edge on the switch) and travels to the page centre.
  const radius = Math.hypot(width, height);
  const dx = width / 2 - cx;
  const dy = height / 2 - cy;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  root.style.setProperty("--eclipse-r", `${radius}px`);
  root.style.setProperty("--eclipse-x0", `${cx - ux * radius}px`);
  root.style.setProperty("--eclipse-y0", `${cy - uy * radius}px`);
  root.style.setProperty("--eclipse-x1", `${width / 2}px`);
  root.style.setProperty("--eclipse-y1", `${height / 2}px`);
  root.setAttribute("data-transition", "eclipse");
  running = true;
  const transition = doc.startViewTransition(() => {
    setThemePreference(next);
    applyTheme(resolved, next);
  });
  transition.finished.finally(() => {
    running = false;
    if (root.getAttribute("data-transition") === "eclipse") root.removeAttribute("data-transition");
    for (const name of ["--eclipse-r", "--eclipse-x0", "--eclipse-y0", "--eclipse-x1", "--eclipse-y1"]) root.style.removeProperty(name);
  });
}

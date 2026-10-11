/**
 * The developer site is light only, as Silicon Writings and the Silicon Apps store are. The inline boot script
 * (THEME_BOOT_SCRIPT, rendered with the CSP nonce in the root layout's <head>) pins <html data-theme="light"> before the
 * first paint and marks <html data-js>, so controls that only work with script stay hidden in a browser without it.
 * The embed surface keeps no theme of its own (its colour scheme comes only from its `theme` parameter, or the iframe
 * canvas turns opaque on the app's page).
 *
 * The functions below keep the shape the site's code reads (useTheme, the branding runtime's visitor theme): the theme
 * is always "light", and changing it does nothing. An app's branding previews can still show its dark look; that paints
 * a subtree (lib/branding/apply.ts), never the site.
 */
export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

/** The key the theme choice used to be stored under; the boot script clears it so nothing reads a stale choice. */
export const THEME_STORAGE_KEY = "silicon-developer.theme";

export const THEME_BOOT_SCRIPT = `(function(){var r=document.documentElement;r.setAttribute("data-js","");if(r.getAttribute("data-surface")==="embed")return;r.setAttribute("data-theme","light");r.setAttribute("data-theme-preference","light");r.style.colorScheme="light";try{localStorage.removeItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}})();`;

/** Writes the light theme onto <html> (not on the embed surface, which themes its own root). */
export function applyTheme(): void {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  if (root.getAttribute("data-surface") === "embed") return;
  root.setAttribute("data-theme", "light");
  root.setAttribute("data-theme-preference", "light");
  root.style.colorScheme = "light";
}

/** The theme in use: always light. */
export function currentTheme(): Theme {
  return "light";
}

/** The preference: always light. */
export function themePreference(): ThemePreference {
  return "light";
}

/** What a preference would show: always light on this site. */
export const resolveTheme: (value: ThemePreference) => Theme = () => "light";

/** Kept for callers; the site has one theme, so this only makes sure it is applied. */
export const setThemePreference: (value: ThemePreference) => void = () => applyTheme();

/** The theme never changes, so there is nothing to subscribe to. */
export const subscribeTheme: (listener: () => void) => () => void = () => () => {};

/** Kept for callers; the site has one theme. */
export const changeTheme: (next: ThemePreference, trigger?: HTMLElement | null) => void = () => applyTheme();

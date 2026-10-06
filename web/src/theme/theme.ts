/**
 * Theme manager: light, dark or system, persisted per browser. public/theme-boot.js applies the stored choice before
 * the first paint; this module takes over afterwards and keeps <html data-theme> in sync with the preference and the
 * system setting.
 */
import { createMemo, createRenderEffect, createRoot, createSignal, type Accessor } from "solid-js";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

export const THEME_STORAGE_KEY = "silicon-accounts.theme";

function readStored(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Blocked storage (private mode, disabled site data): fall back to the system theme.
  }
  return "system";
}

function writeStored(value: ThemePreference) {
  try {
    if (value === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    // Not persisted, but still applied for this page.
  }
}

const media = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : undefined;

const [preference, setPreferenceSignal] = createSignal<ThemePreference>(typeof window === "undefined" ? "system" : readStored());
const [systemDark, setSystemDark] = createSignal(media?.matches ?? false);
media?.addEventListener("change", event => setSystemDark(event.matches));

/** The resolved theme in use right now. */
export const theme: Accessor<Theme> = createRoot(() =>
  createMemo(() => {
    const value = preference();
    return value === "system" ? (systemDark() ? "dark" : "light") : value;
  }),
);

/** The stored preference (light, dark or system). */
export const themePreference: Accessor<ThemePreference> = preference;

/** Writes the resolved theme onto <html>. Exported for the theme transition, which applies inside a view transition. */
export function applyTheme(value: Theme, pref: ThemePreference = preference()) {
  const root = document.documentElement;
  root.setAttribute("data-theme", value);
  root.setAttribute("data-theme-preference", pref);
  root.style.colorScheme = value;
}

createRoot(() => {
  // Keep <html> in sync whenever the preference or the system setting changes.
  createRenderEffect(() => applyTheme(theme(), preference()));
});

/** Sets and persists the theme preference. */
export function setThemePreference(value: ThemePreference) {
  writeStored(value);
  setPreferenceSignal(value);
}

/** Resolve what `setThemePreference(value)` would show, without applying it. */
export function resolveTheme(value: ThemePreference): Theme {
  return value === "system" ? (systemDark() ? "dark" : "light") : value;
}

// Another tab changed the preference: follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (event.key === THEME_STORAGE_KEY) setPreferenceSignal(readStored());
  });
}

/**
 * Development only: compare typefaces across the site. The choice is a `data-font` attribute on <html>
 * (styles/tokens.css swaps --font-body for it) and is remembered in this browser. The ⌘K palette lists the faces under
 * "Developer"; providers.tsx re-applies the remembered one when the site loads.
 */
export const PREVIEW_FONTS = [
  { key: "system", label: "System font", description: "The site's face (default)" },
  { key: "hanken", label: "Hanken Grotesk", description: "Silicon UI's body face, for everything" },
  { key: "geist", label: "Geist", description: "Silicon UI's title face, for everything" },
] as const;

export type PreviewFont = (typeof PREVIEW_FONTS)[number]["key"];

const KEY = "accounts.dev.font";

/** Sets the face on <html> and remembers it; the system font clears the attribute. */
export function applyPreviewFont(font: PreviewFont) {
  if (font === "system") delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = font;
  try {
    if (font === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, font);
  } catch {
    // Storage blocked: the face applies for this page only.
  }
}

/** Re-applies the remembered face, if any. */
export function restorePreviewFont() {
  try {
    const stored = window.localStorage.getItem(KEY);
    const known = PREVIEW_FONTS.find(font => font.key === stored);
    if (known) document.documentElement.dataset.font = known.key;
  } catch {
    // Storage blocked: the system font.
  }
}

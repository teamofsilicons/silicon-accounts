/**
 * Branding fonts: CSS stacks for the allowlist and on-demand loading. Geist, Instrument Serif and JetBrains Mono ship
 * with the site through next/font (app/fonts.ts, CSS variables on <html>); the others are self-hosted
 * @fontsource-variable stylesheets fetched only when an app's branding picks them, so the CSP stays 'self' and a
 * page that never shows Fraunces never downloads it.
 */
import type { BrandFont, Branding } from "../api/types";

const SANS_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const SERIF_FALLBACK = 'ui-serif, Georgia, "Times New Roman", serif';

/** The CSS font-family stack for each allowlisted font. */
export const FONT_STACKS: Record<BrandFont, string> = {
  Geist: `var(--font-geist), ${SANS_FALLBACK}`,
  Inter: `"Inter Variable", ${SANS_FALLBACK}`,
  "IBM Plex Sans": `"IBM Plex Sans Variable", ${SANS_FALLBACK}`,
  "DM Sans": `"DM Sans Variable", ${SANS_FALLBACK}`,
  "Space Grotesk": `"Space Grotesk Variable", ${SANS_FALLBACK}`,
  "Source Serif 4": `"Source Serif 4 Variable", ${SERIF_FALLBACK}`,
  Fraunces: `"Fraunces Variable", ${SERIF_FALLBACK}`,
  "Instrument Serif": `var(--font-instrument-serif), ${SERIF_FALLBACK}`,
  "JetBrains Mono": `var(--font-jetbrains-mono), ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
  System: SANS_FALLBACK,
};

/** The family to wait for when it needs a download (the @fontsource family name). Next/font faces are always there. */
const FAMILY: Partial<Record<BrandFont, string>> = {
  Inter: "Inter Variable",
  "IBM Plex Sans": "IBM Plex Sans Variable",
  "DM Sans": "DM Sans Variable",
  "Space Grotesk": "Space Grotesk Variable",
  "Source Serif 4": "Source Serif 4 Variable",
  Fraunces: "Fraunces Variable",
};

/** Each loader registers the font's @font-face rules (a CSS chunk the bundler emits next to the page). */
const LOADERS: Partial<Record<BrandFont, () => Promise<unknown>>> = {
  Inter: () => import("./fonts/inter"),
  "IBM Plex Sans": () => import("./fonts/ibm-plex-sans"),
  "DM Sans": () => import("./fonts/dm-sans"),
  "Space Grotesk": () => import("./fonts/space-grotesk"),
  "Source Serif 4": () => import("./fonts/source-serif-4"),
  Fraunces: () => import("./fonts/fraunces"),
};

const pending = new Map<BrandFont, Promise<void>>();

/** Loads one font's stylesheet (once) and waits until the browser has the face ready, or 1.5 s at most. */
export function loadBrandFont(font: BrandFont): Promise<void> {
  const existing = pending.get(font);
  if (existing) return existing;
  const loader = LOADERS[font];
  const family = FAMILY[font];
  const promise = (async () => {
    if (!loader || !family) return;
    await loader();
    if (typeof document === "undefined" || !("fonts" in document)) return;
    // Faces load lazily on first use; asking for them here avoids a flash of the fallback inside the branded card.
    await Promise.race([
      Promise.all([document.fonts.load(`400 1em "${family}"`), document.fonts.load(`500 1em "${family}"`)]).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 1500)),
    ]);
  })().catch(() => {
    pending.delete(font);
  });
  pending.set(font, promise);
  return promise;
}

/** Loads every font a branding uses (body and headings). */
export function loadBrandingFonts(branding: Pick<Branding, "font_family" | "heading_font_family">): Promise<void> {
  const fonts = new Set<BrandFont>([branding.font_family, branding.heading_font_family ?? branding.font_family]);
  return Promise.all([...fonts].map(loadBrandFont)).then(() => undefined);
}

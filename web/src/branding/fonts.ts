/**
 * Branding fonts: CSS stacks for the allowlist and on-demand loading. Geist, Instrument Serif and JetBrains Mono ship
 * with the site; the others are fetched only when an app's branding picks them (self-hosted, so the CSP stays 'self').
 */
import type { BrandFont, Branding } from "../api/types";

const SANS_FALLBACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const SERIF_FALLBACK = 'ui-serif, Georgia, "Times New Roman", serif';

/** The CSS font-family stack for each allowlisted font. */
export const FONT_STACKS: Record<BrandFont, string> = {
  Geist: `"Geist Variable", ${SANS_FALLBACK}`,
  Inter: `"Inter Variable", ${SANS_FALLBACK}`,
  "IBM Plex Sans": `"IBM Plex Sans Variable", ${SANS_FALLBACK}`,
  "DM Sans": `"DM Sans Variable", ${SANS_FALLBACK}`,
  "Space Grotesk": `"Space Grotesk Variable", ${SANS_FALLBACK}`,
  "Source Serif 4": `"Source Serif 4 Variable", ${SERIF_FALLBACK}`,
  Fraunces: `"Fraunces Variable", ${SERIF_FALLBACK}`,
  "Instrument Serif": `"Instrument Serif", ${SERIF_FALLBACK}`,
  "JetBrains Mono": `"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
  System: SANS_FALLBACK,
};

/** Fonts that need a stylesheet. Each import resolves to a hashed CSS asset that registers the @font-face rules. */
const LOADERS: Partial<Record<BrandFont, () => Promise<unknown>>> = {
  Inter: () => import("@fontsource-variable/inter/index.css"),
  "IBM Plex Sans": () => import("@fontsource-variable/ibm-plex-sans/index.css"),
  "DM Sans": () => import("@fontsource-variable/dm-sans/index.css"),
  "Space Grotesk": () => import("@fontsource-variable/space-grotesk/index.css"),
  "Source Serif 4": () => import("@fontsource-variable/source-serif-4/index.css"),
  Fraunces: () => import("@fontsource-variable/fraunces/index.css"),
};

const pending = new Map<BrandFont, Promise<void>>();

/** Loads one font's stylesheet (once) and waits until the browser has the face ready, or 1.5 s at most. */
export function loadBrandFont(font: BrandFont): Promise<void> {
  const existing = pending.get(font);
  if (existing) return existing;
  const loader = LOADERS[font];
  const promise = (async () => {
    if (loader) await loader();
    if (typeof document === "undefined" || !("fonts" in document) || font === "System") return;
    const family = FONT_STACKS[font].split(",")[0] ?? "";
    // Faces load lazily on first use; asking for them here avoids a flash of the fallback inside the branded card.
    await Promise.race([
      Promise.all([document.fonts.load(`400 1em ${family}`), document.fonts.load(`500 1em ${family}`)]).catch(() => undefined),
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

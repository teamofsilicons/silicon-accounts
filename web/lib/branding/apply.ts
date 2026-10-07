/**
 * The branding runtime (framework-free). `brandingVariables(branding, theme)` maps an app's Branding onto the Arc
 * semantic tokens for one subtree: colours from the palette of `theme`, radii from `radius`, fonts, density; and
 * `brandingAttributes` gives the data attributes styles/branding.css and styles/squircle.css read (layout, background,
 * corner and button styles). The React <BrandingScope> (components/foundation/branding) renders both on its root, so
 * every Arc component inside it (buttons, inputs, OTP cells, cards) follows them without knowing about branding, and
 * nothing leaks into the account site.
 */
import type { AppPublic, Branding, FlowView, Palette, ThemeMode } from "../api/types";
import { legibleTint, mixHex, mixOklab } from "./contrast";
import { LIMITS, normalizeBranding } from "./defaults";
import { FONT_STACKS } from "./fonts";

export type PaintTheme = "light" | "dark";

/** The theme a branded page should paint: the branding's forced theme, else the visitor's theme. */
export function resolveBrandTheme(mode: ThemeMode | undefined, visitorTheme: PaintTheme): PaintTheme {
  return mode === "light" || mode === "dark" ? mode : visitorTheme;
}

const mix = (a: string, percent: number, b: string) => `color-mix(in oklab, ${a} ${percent}%, ${b})`;
const px = (value: number) => `${Math.round(value * 100) / 100}px`;

/** `url("…")` for https and data:image URLs only; anything else is ignored (the server allows https only). */
function cssUrl(value: string | null): string | null {
  if (!value) return null;
  if (!/^https:\/\//i.test(value) && !/^data:image\//i.test(value)) return null;
  return `url(${JSON.stringify(value)})`;
}

/** What a hovered outline button lays under its words: its fill (the primary at 8 % opacity) over the ground. */
const hoverTint = (ground: string, primary: string) => mixHex(ground, primary, 0.08);

/**
 * Accent-coloured text (links, and the words of soft and outline buttons) that reads at 4.5:1 on everything it is
 * painted on: the page, the card, and the tint a soft button (14 %, 20 % on hover) or a hovered outline button (8 %)
 * lays under it. The server only holds button text on the primary and text on the page to 4.5:1, so a primary close
 * to the page colour (pixel-studio's #E5007E on #FFF5FA is 4.25:1; a primary equal to the page is 1:1) would leave an
 * outline button's words faint or invisible. Null when the theme's own ink (light: the primary; dark: half-way to the
 * text colour) already reads, so every such palette keeps exactly its look; else that ink moved toward the text colour
 * just far enough (legibleTint).
 */
function accentInk(p: Palette, dark: boolean, buttonStyle: Branding["button_style"]): string | null {
  const grounds = [p.background, p.surface];
  if (buttonStyle === "soft") grounds.push(mixOklab(p.surface, p.primary, 0.14), mixOklab(p.surface, p.primary, 0.2));
  if (buttonStyle === "outline") grounds.push(hoverTint(p.background, p.primary), hoverTint(p.surface, p.primary));
  return legibleTint(p.primary, p.foreground, grounds, LIMITS.minContrast, dark ? 0.5 : 0);
}

/**
 * The edge of an outline button (WCAG 1.4.11: 3:1 for a control's boundary): the primary, or, when the primary is
 * under 3:1 on the page or the card, the primary moved toward the text colour until it is not. Null keeps the primary.
 */
function accentLine(p: Palette): string | null {
  return legibleTint(p.primary, p.foreground, [p.background, p.surface], 3);
}

/**
 * Accent-coloured text on the accent tint (an info badge's words on --accent-subtle, the active tab, a hovered link):
 * --accent-strong, at 4.5:1 on the tint over the card and over the page, on the tint a hovered badge lays (10 %), and
 * on the page and the card themselves. The theme's own ink is the primary 22 % of the way to the text colour; it reads
 * in light, but in dark it stays close to the primary (the default dark #1F5FB8 gives #5383C9, 2.9:1 on its tint
 * #313C4A; the site's own dark ink is #93B8F1), so it moves on toward the text colour until it reads, as --accent-ink
 * does (#85A7D9 there, 4.55:1). Null keeps that ink.
 */
export function accentStrong(p: Palette, dark: boolean): string | null {
  const tint = dark ? 0.18 : 0.11;
  const grounds = [p.background, p.surface, mixHex(p.surface, p.primary, tint), mixHex(p.background, p.primary, tint), mixOklab(p.surface, p.primary, 0.1)];
  return legibleTint(p.primary, p.foreground, grounds, LIMITS.minContrast, 0.22);
}

/** The custom properties a branding paints in one theme. */
export function brandingVariables(input: Branding | Partial<Branding> | null | undefined, theme: PaintTheme): Record<string, string> {
  const branding = normalizeBranding(input as Partial<Branding>);
  const p: Palette = branding[theme];
  const dark = theme === "dark";
  const radius = branding.radius;
  const compact = branding.density === "compact";
  const vars: Record<string, string> = {
    "--background": p.background,
    "--surface": p.surface,
    "--surface-raised": dark ? mix(p.surface, 94, p.foreground) : p.surface,
    "--surface-muted": mix(p.foreground, dark ? 9 : 5, p.surface),
    "--foreground": p.foreground,
    "--text-secondary": p.muted,
    "--text-muted": p.muted,
    "--border": p.border,
    "--border-subtle": mix(p.border, 55, p.surface),
    "--border-strong": mix(p.border, 74, p.foreground),
    "--accent": p.primary,
    // Text on the tint (info badges, the active tab): it must read there in both themes (accentStrong).
    "--accent-strong": accentStrong(p, dark) ?? mix(p.primary, 78, p.foreground),
    "--accent-subtle": mix(p.primary, dark ? 18 : 11, "transparent"),
    "--accent-foreground": p.primary_foreground,
    // Accent-coloured text on dark surfaces needs a lighter ink than a fill does; on any palette it must read (accentInk).
    "--accent-ink": accentInk(p, dark, branding.button_style) ?? (dark ? mix(p.primary, 50, p.foreground) : p.primary),
    // The edge of an outline button: the primary, unless it vanishes into the page (accentLine).
    "--accent-line": accentLine(p) ?? p.primary,
    "--primary": p.primary,
    "--primary-hover": mix(p.primary, 90, p.foreground),
    "--primary-pressed": mix(p.primary, 82, p.foreground),
    "--primary-foreground": p.primary_foreground,
    "--control-on": p.primary,
    "--control-glyph": p.primary_foreground,
    "--control-fill": p.primary,
    "--control-on-subtle": mix(p.primary, 12, "transparent"),
    "--control-track": mix(p.foreground, dark ? 22 : 13, p.surface),
    "--control-track-hover": mix(p.foreground, dark ? 28 : 19, p.surface),
    "--control-thumb": dark ? mix(p.foreground, 92, p.surface) : "#FFFFFF",
    "--control-thumb-on": p.primary_foreground,
    "--danger": p.danger,
    "--dot-color": mix(p.foreground, dark ? 14 : 12, "transparent"),
    "--overlay": mix(p.background, 55, "transparent"),
    "--radius-control": px(radius),
    "--radius-panel": px(radius * (26 / 18)),
    "--radius-surface": px(radius * (34 / 18)),
    "--font-body": FONT_STACKS[branding.font_family],
    "--font-display": FONT_STACKS[branding.heading_font_family ?? branding.font_family],
    "--brand-logo-height": px(branding.logo_height),
    "--brand-pad": compact ? "24px" : "32px",
    "--brand-gap": compact ? "12px" : "16px",
    "--brand-panel-width": compact ? "380px" : "420px",
    "--control-height-sm": compact ? "2rem" : "2.25rem",
    "--control-height-md": compact ? "2.5rem" : "2.75rem",
    "--control-height-lg": compact ? "2.75rem" : "3.125rem",
  };
  const image = branding.background_style === "image" ? cssUrl(branding.background_image_url) : null;
  if (image) vars["--brand-bg-image"] = image;
  return vars;
}

/** The data attributes styles/branding.css and styles/squircle.css read. */
export function brandingAttributes(input: Branding | Partial<Branding> | null | undefined, theme: PaintTheme): Record<string, string> {
  const branding = normalizeBranding(input as Partial<Branding>);
  return {
    "data-brand": "",
    "data-theme": theme,
    "data-corner": branding.corner_style,
    "data-layout": branding.layout,
    "data-bg": branding.background_style === "image" && !cssUrl(branding.background_image_url) ? "plain" : branding.background_style,
    "data-button-style": branding.button_style,
    "data-density": branding.density,
  };
}

const applied = new WeakMap<HTMLElement, { vars: string[]; attrs: string[] }>();

/**
 * Paints `branding` in `theme` onto `el` imperatively (for code without React) and returns a function that removes
 * it again. Calling it again on the same element replaces the previous branding, so it can follow a live draft.
 */
export function applyBranding(el: HTMLElement, branding: Branding | Partial<Branding> | null | undefined, theme: PaintTheme): () => void {
  const vars = brandingVariables(branding, theme);
  const attrs = brandingAttributes(branding, theme);
  const previous = applied.get(el);
  if (previous) {
    for (const name of previous.vars) if (!(name in vars)) el.style.removeProperty(name);
    for (const name of previous.attrs) if (!(name in attrs)) el.removeAttribute(name);
  }
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  el.style.colorScheme = theme;
  applied.set(el, { vars: Object.keys(vars), attrs: Object.keys(attrs) });
  return () => {
    const current = applied.get(el);
    if (!current) return;
    for (const name of current.vars) el.style.removeProperty(name);
    for (const name of current.attrs) el.removeAttribute(name);
    el.style.removeProperty("color-scheme");
    applied.delete(el);
  };
}

/** The logo for a theme: the branding's own logo, else the app's logo; null when neither exists. */
export function brandLogo(
  branding: Pick<Branding, "logo_url" | "logo_dark_url"> | null | undefined,
  app: Pick<AppPublic, "logo_url" | "logo_dark_url"> | FlowView["app"] | null | undefined,
  theme: PaintTheme,
): string | null {
  const own = theme === "dark" ? branding?.logo_dark_url ?? branding?.logo_url : branding?.logo_url;
  const fallback = theme === "dark" ? app?.logo_dark_url ?? app?.logo_url : app?.logo_url;
  return own ?? fallback ?? null;
}

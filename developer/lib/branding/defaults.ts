/**
 * Branding defaults (the Silicon Accounts look) and normalization. Mirrors crates/core models/signin_config.rs:
 * missing fields fall back to these values, and a palette fills its missing colours from the right theme. The look is
 * the Silicon family (cool #F7F8FA / #02040A, BDO Grotesk and SF Pro), and the service gives new apps these palettes
 * (`Palette::default_light`, `default_dark`). Apps that kept the older defaults still store those, unchanged;
 * normalizeBranding recognises them and paints the new look (LEGACY_LIGHT, LEGACY_DARK).
 */
import type { BackgroundStyle, BrandFont, BrandLayout, Branding, ButtonStyle, CornerStyle, Density, Palette, SigninCopy, ThemeMode } from "../api/types";

/**
 * The Silicon Accounts look of the hosted pages, light: the same colours as the account site and the developer site
 * (styles/tokens.css): #F7F8FA page, #292929 text, brand blue #1F5FB8 buttons under white text (6.2:1), muted #5C6370
 * (6.0:1 on the card, 5.6:1 on the page).
 */
export const DEFAULT_LIGHT: Palette = {
  primary: "#1F5FB8",
  primary_foreground: "#FFFFFF",
  background: "#F7F8FA",
  surface: "#FFFFFF",
  foreground: "#292929",
  muted: "#5C6370",
  border: "#E2E5EB",
  danger: "#B42318",
};

/**
 * The Silicon Accounts look, dark: #02040A page, #F7F8FA text, the brand blue #1F5FB8 for buttons under #F7F8FA text
 * (5.8:1); links take the lighter ink the runtime derives (accentInk). Muted #9BA4B4 (7.4:1 on the card), error text
 * #FF8A80 (8.6:1 on the card).
 */
export const DEFAULT_DARK: Palette = {
  primary: "#1F5FB8",
  primary_foreground: "#F7F8FA",
  background: "#02040A",
  surface: "#0B0F18",
  foreground: "#F7F8FA",
  muted: "#9BA4B4",
  border: "#1F2635",
  danger: "#FF8A80",
};

/**
 * The palettes the service gave apps before the new look (crates/core signin_config.rs `legacy_light`, `legacy_dark`:
 * warm paper #FFFDF9 and charcoal #353432). Apps made before the change store them as they were, so a palette equal to
 * one of them, all eight colours, is an app that kept the Silicon Accounts look: it gets the new look (DEFAULT_LIGHT,
 * DEFAULT_DARK). A palette with any colour of the app's own stays exactly as stored.
 */
export const LEGACY_LIGHT: Palette = {
  primary: "#1F5FB8",
  primary_foreground: "#FFFDF9",
  background: "#FFFDF9",
  surface: "#FFFFFF",
  foreground: "#353432",
  muted: "#6F6B66",
  border: "#E8E3DA",
  danger: "#B42318",
};

export const LEGACY_DARK: Palette = {
  primary: "#1F5FB8",
  primary_foreground: "#FFFDF9",
  background: "#2A2927",
  surface: "#353432",
  foreground: "#FFFDF9",
  muted: "#B5B0A8",
  border: "#4A4845",
  danger: "#FF8A80",
};

export const DEFAULT_BRANDING: Branding = {
  theme: "auto",
  logo_url: null,
  logo_dark_url: null,
  logo_height: 36,
  show_app_name: true,
  font_family: "Geist",
  heading_font_family: null,
  corner_style: "squircle",
  radius: 18,
  button_style: "solid",
  layout: "card",
  background_style: "plain",
  background_image_url: null,
  density: "comfortable",
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
};

export const DEFAULT_COPY: SigninCopy = { title: null, subtitle: null, terms_url: null, privacy_url: null, support_email: null, opening_title: null, signup_title: null, signup_subtitle: null };

/** The font allowlist, in the order the branding editor lists it. */
export const BRAND_FONTS: readonly BrandFont[] = ["Geist", "Inter", "IBM Plex Sans", "DM Sans", "Space Grotesk", "Source Serif 4", "Fraunces", "Instrument Serif", "JetBrains Mono", "System"];
export const THEME_MODES: readonly ThemeMode[] = ["auto", "light", "dark"];
export const CORNER_STYLES: readonly CornerStyle[] = ["squircle", "rounded", "sharp"];
export const BUTTON_STYLES: readonly ButtonStyle[] = ["solid", "soft", "outline"];
export const LAYOUTS: readonly BrandLayout[] = ["card", "split", "minimal"];
export const BACKGROUND_STYLES: readonly BackgroundStyle[] = ["plain", "dots", "grain", "gradient", "image"];
export const DENSITIES: readonly Density[] = ["comfortable", "compact"];
export const PALETTE_KEYS: readonly (keyof Palette)[] = ["primary", "primary_foreground", "background", "surface", "foreground", "muted", "border", "danger"];

/** Contract limits (the server validates them too). */
export const LIMITS = { radius: { min: 0, max: 40 }, logoHeight: { min: 16, max: 96 }, titleMax: 80, subtitleMax: 200, continueLabelMax: 30, minContrast: 4.5 } as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Every colour of two palettes the same (case-insensitive). */
export function samePalette(a: Palette, b: Palette): boolean {
  return PALETTE_KEYS.every(key => a[key].toUpperCase() === b[key].toUpperCase());
}

/** A stored palette: the new default when it is the service's old default, else exactly as stored. */
function current(palette: Palette, legacy: Palette, fresh: Palette): Palette {
  return samePalette(palette, legacy) ? { ...fresh } : palette;
}

/**
 * Whether a branding is the Silicon Accounts look (an app that kept every default colour and the default font): its
 * pages then take the site's own faces (BDO Grotesk headings over the SF Pro system text) instead of Geist. Any font
 * or colour of the app's own keeps the app's look exactly.
 */
export function isSiliconLook(branding: Pick<Branding, "font_family" | "heading_font_family" | "light" | "dark">): boolean {
  const heading = branding.heading_font_family ?? branding.font_family;
  return branding.font_family === "Geist" && heading === "Geist" && samePalette(branding.light, DEFAULT_LIGHT) && samePalette(branding.dark, DEFAULT_DARK);
}
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
const clampNumber = (value: unknown, min: number, max: number, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);
const urlOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

function normalizePalette(value: unknown, base: Palette): Palette {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof Palette, unknown>>;
  const out = { ...base };
  for (const key of PALETTE_KEYS) {
    const colour = raw[key];
    if (typeof colour === "string" && HEX.test(colour.trim())) out[key] = colour.trim().toUpperCase();
  }
  return out;
}

/** A complete Branding from anything (a partial draft, a stored document, null). Invalid values fall back to defaults. */
export function normalizeBranding(value: Partial<Branding> | null | undefined): Branding {
  const raw = (value ?? {}) as Partial<Record<keyof Branding, unknown>>;
  return {
    theme: pick(raw.theme, THEME_MODES, DEFAULT_BRANDING.theme),
    logo_url: urlOrNull(raw.logo_url),
    logo_dark_url: urlOrNull(raw.logo_dark_url),
    logo_height: clampNumber(raw.logo_height, LIMITS.logoHeight.min, LIMITS.logoHeight.max, DEFAULT_BRANDING.logo_height),
    show_app_name: typeof raw.show_app_name === "boolean" ? raw.show_app_name : DEFAULT_BRANDING.show_app_name,
    font_family: pick(raw.font_family, BRAND_FONTS, DEFAULT_BRANDING.font_family),
    heading_font_family: raw.heading_font_family == null ? null : pick(raw.heading_font_family, BRAND_FONTS, DEFAULT_BRANDING.font_family),
    corner_style: pick(raw.corner_style, CORNER_STYLES, DEFAULT_BRANDING.corner_style),
    radius: clampNumber(raw.radius, LIMITS.radius.min, LIMITS.radius.max, DEFAULT_BRANDING.radius),
    button_style: pick(raw.button_style, BUTTON_STYLES, DEFAULT_BRANDING.button_style),
    layout: pick(raw.layout, LAYOUTS, DEFAULT_BRANDING.layout),
    background_style: pick(raw.background_style, BACKGROUND_STYLES, DEFAULT_BRANDING.background_style),
    background_image_url: urlOrNull(raw.background_image_url),
    density: pick(raw.density, DENSITIES, DEFAULT_BRANDING.density),
    light: current(normalizePalette(raw.light, DEFAULT_LIGHT), LEGACY_LIGHT, DEFAULT_LIGHT),
    dark: current(normalizePalette(raw.dark, DEFAULT_DARK), LEGACY_DARK, DEFAULT_DARK),
  };
}

export function normalizeCopy(value: Partial<SigninCopy> | null | undefined): SigninCopy {
  const raw = value ?? {};
  const text = (entry: unknown) => (typeof entry === "string" && entry.trim() ? entry.trim() : null);
  return {
    title: text(raw.title),
    subtitle: text(raw.subtitle),
    terms_url: text(raw.terms_url),
    privacy_url: text(raw.privacy_url),
    support_email: text(raw.support_email),
    opening_title: text(raw.opening_title),
    signup_title: text(raw.signup_title),
    signup_subtitle: text(raw.signup_subtitle),
  };
}

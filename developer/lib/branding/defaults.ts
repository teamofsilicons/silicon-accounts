/**
 * Branding defaults (the Silicon Accounts look) and normalization. Mirrors crates/core models/signin_config.rs:
 * missing fields fall back to these values, and a palette fills its missing colours from the right theme.
 */
import type { BackgroundStyle, BrandFont, BrandLayout, Branding, ButtonStyle, CornerStyle, Density, Palette, SigninCopy, ThemeMode } from "../api/types";

export const DEFAULT_LIGHT: Palette = {
  primary: "#1F5FB8",
  primary_foreground: "#FFFDF9",
  background: "#FFFDF9",
  surface: "#FFFFFF",
  foreground: "#353432",
  muted: "#6F6B66",
  border: "#E8E3DA",
  danger: "#B42318",
};

/**
 * The Silicon Accounts dark palette (crates/core signin_config.rs `default_dark`): filled buttons keep the brand blue
 * #1F5FB8 under #FFFDF9 text (6.1:1); the lighter #5B8FE0 is only an ink for links on dark (it would put button text
 * at 3.2:1). Error text is #FF8A80 (5.45:1 on the #353432 card; the old #F97066 read at 4.46:1, migration 0004).
 */
export const DEFAULT_DARK: Palette = {
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

export const DEFAULT_COPY: SigninCopy = {
  title: null, subtitle: null, terms_url: null, privacy_url: null, support_email: null, opening_title: null, signup_title: null, signup_subtitle: null,
};

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
    light: normalizePalette(raw.light, DEFAULT_LIGHT),
    dark: normalizePalette(raw.dark, DEFAULT_DARK),
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

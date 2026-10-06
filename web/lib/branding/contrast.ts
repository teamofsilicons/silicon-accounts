/**
 * WCAG 2.x contrast for branding colours. The server refuses branding whose primary/primary_foreground or
 * foreground/background contrast is below 4.5:1 (WCAG AA for text; crates/core MIN_TEXT_CONTRAST) in either theme; the
 * editor shows the same check live.
 */
import type { Branding, Palette } from "../api/types";
import { LIMITS } from "./defaults";

export type Rgb = [number, number, number];

/** Parses `#RGB` or `#RRGGBB` into 0..255 channels; null for anything else. */
export function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? hex.split("").map(ch => ch + ch).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16)) as Rgb;
}

const linear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance (0 black .. 1 white). */
export function luminance(rgb: Rgb): number {
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** Contrast ratio between two colours (1..21), or null when either is not a hex colour. */
export function contrastRatio(a: string, b: string): number | null {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return null;
  const [light, dark] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** "4.53:1" (two decimals, never rounded up past the threshold). */
export function formatRatio(ratio: number | null): string {
  if (ratio === null) return "n/a";
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
}

/** WCAG level for normal text: AAA ≥ 7, AA ≥ 4.5, "AA large" ≥ 3. */
export function wcagLevel(ratio: number | null): "AAA" | "AA" | "AA large" | "fail" {
  if (ratio === null) return "fail";
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA large";
  return "fail";
}

export interface ContrastIssue {
  /** Path as the server reports it, for example "branding.light.primary_foreground". */
  path: string;
  theme: "light" | "dark";
  pair: [keyof Palette, keyof Palette];
  ratio: number | null;
  message: string;
}

const PAIRS: Array<{ pair: [keyof Palette, keyof Palette]; describe: string }> = [
  { pair: ["primary_foreground", "primary"], describe: "button text on the primary colour" },
  { pair: ["foreground", "background"], describe: "text on the page background" },
];

/** The checks the server enforces (≥ 4.5:1), with messages that say exactly which pair fails and by how much. */
export function brandingContrastIssues(branding: Pick<Branding, "light" | "dark">, minimum: number = LIMITS.minContrast): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const theme of ["light", "dark"] as const) {
    const palette = branding[theme];
    for (const { pair, describe } of PAIRS) {
      const ratio = contrastRatio(palette[pair[0]], palette[pair[1]]);
      if (ratio === null || ratio < minimum) {
        issues.push({
          path: `branding.${theme}.${pair[0]}`,
          theme,
          pair,
          ratio,
          message: ratio === null
            ? `${theme} ${pair[0]} and ${pair[1]} must both be #RRGGBB colours.`
            : `In the ${theme} theme, ${describe} is ${formatRatio(ratio)}; it needs at least ${minimum}:1 so the page stays readable.`,
        });
      }
    }
  }
  return issues;
}

/** Mixes two hex colours in sRGB (0 = a, 1 = b). Used for derived shades where CSS color-mix is not an option. */
export function mixHex(a: string, b: string, amount: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  const out = x.map((channel, index) => Math.round(channel + ((y[index] ?? 0) - channel) * amount));
  return `#${out.map(channel => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** Black or paper text, whichever reads better on `background`. */
export function readableOn(background: string, light = "#FFFDF9", dark = "#2A2927"): string {
  const onLight = contrastRatio(background, dark) ?? 0;
  const onDark = contrastRatio(background, light) ?? 0;
  return onDark >= onLight ? light : dark;
}

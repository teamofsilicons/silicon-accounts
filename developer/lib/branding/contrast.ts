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

const toChannel = (value: number) => {
  const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
};

/** sRGB channels to OKLab (Björn Ottosson's matrices, as CSS Color 4 uses them). */
function toOklab([r, g, b]: Rgb): [number, number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab back to sRGB channels, clipped into the sRGB gamut. */
function fromOklab([lightness, a, b]: [number, number, number]): Rgb {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toChannel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toChannel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toChannel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * `a` moved `amount` (0 = a, 1 = b) of the way to `b` in OKLab: what CSS `color-mix(in oklab, a (1 - amount), b)`
 * paints, so script can judge the colours the branding's styles mix.
 */
export function mixOklab(a: string, b: string, amount: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  const [p, q] = [toOklab(x), toOklab(y)];
  const out = fromOklab([0, 1, 2].map(index => p[index]! + (q[index]! - p[index]!) * amount) as [number, number, number]);
  return `#${out.map(channel => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * A colour derived from the primary that must read on every ground it is painted on: the first of `start`, then
 * `start` moved toward `toward` (the palette's text colour) in steps of 5 % of the way that is left, whose contrast
 * on each of `grounds` is at least `minimum`:1. `start` is how far toward `toward` the theme's own ink already is
 * (0 = the primary itself). Null when the start already reads, or when a colour is not #RRGGBB (nothing to judge).
 * At worst it is `toward` itself, which the server holds to 4.5:1 on the page.
 */
export function legibleTint(primary: string, toward: string, grounds: string[], minimum: number, start = 0): string | null {
  if (!parseHex(primary) || !parseHex(toward) || !grounds.every(ground => parseHex(ground))) return null;
  const reads = (colour: string) => grounds.every(ground => (contrastRatio(colour, ground) ?? 0) >= minimum);
  if (reads(mixOklab(primary, toward, start))) return null;
  for (let step = 1; step <= 20; step++) {
    const colour = mixOklab(primary, toward, start + ((1 - start) * step) / 20);
    if (reads(colour)) return colour;
  }
  return toward.toUpperCase();
}

/** Light or dark text (white, or the Silicon ink #292929), whichever reads better on `background`. */
export function readableOn(background: string, light = "#FFFFFF", dark = "#292929"): string {
  const onLight = contrastRatio(background, dark) ?? 0;
  const onDark = contrastRatio(background, light) ?? 0;
  return onDark >= onLight ? light : dark;
}

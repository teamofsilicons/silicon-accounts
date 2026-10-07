/**
 * Error text on the hosted pages must stay readable in every app's colours.
 *
 * The steps show errors (a wrong code, a refused address, a field the server rejected) as 12 px text in the branding's
 * `danger` colour, so that colour needs 4.5:1 (WCAG AA) on the card and on the page. The server checks button text
 * and page text but not `danger`. The default palettes pass (the dark default is #FF8A80, 5.45:1 on its #353432 card;
 * migration 0004 moved stored configs off the old #F97066, 4.46:1 there), but an app can pick any colour.
 * `legibleBranding` keeps every colour the app chose, except a `danger` below 4.5:1, which moves toward the palette's
 * text colour just far enough to pass.
 *
 * Framework-free (HostedFrame calls it once per branding).
 */
import type { Branding, Palette } from "@/lib/api/types";
import { contrastRatio, parseHex } from "@/lib/branding/contrast";

const MIN_TEXT = 4.5;

const hex = (channels: number[]) => `#${channels.map(value => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** `from` moved `percent` % of the way to `to`, in sRGB. */
function mixHex(from: string, to: string, percent: number): string | null {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return null;
  return hex(a.map((value, index) => value + ((b[index] ?? value) - value) * (percent / 100)));
}

/** The palette with a `danger` that reads at 4.5:1 on its surface and its background. */
export function legiblePalette(palette: Palette): Palette {
  const readable = (colour: string) => Math.min(contrastRatio(colour, palette.surface) ?? 0, contrastRatio(colour, palette.background) ?? 0) >= MIN_TEXT;
  if (readable(palette.danger)) return palette;
  for (let percent = 5; percent <= 100; percent += 5) {
    const mixed = mixHex(palette.danger, palette.foreground, percent);
    if (mixed && readable(mixed)) return { ...palette, danger: mixed };
  }
  return palette;
}

/** The branding as the hosted pages paint it: the app's own, with error text readable in both themes. */
export function legibleBranding(branding: Branding): Branding {
  const light = legiblePalette(branding.light);
  const dark = legiblePalette(branding.dark);
  return light === branding.light && dark === branding.dark ? branding : { ...branding, light, dark };
}

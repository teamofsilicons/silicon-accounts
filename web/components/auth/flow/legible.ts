/**
 * Error text on the hosted pages must stay readable in every app's colours.
 *
 * The steps show errors (a wrong code, a refused address, a field the server rejected) as 12 px text in the branding's
 * `danger` colour, so that colour needs 4.5:1 (WCAG AA) on the card and on the page. The server checks button text
 * and page text but not `danger`, and the default dark palette's #F97066 (crates/core `default_dark`, mirrored in
 * lib/branding/defaults.ts) is only 4.46:1 on the default dark card #353432. `legibleBranding` keeps every colour the
 * app chose, except a `danger` below 4.5:1: the default dark one becomes the account site's own dark danger #FF8A80
 * (5.4:1 there), any other moves toward the palette's text colour just far enough to pass.
 *
 * Framework-free (HostedFrame calls it once per branding).
 */
import type { Branding, Palette } from "@/lib/api/types";
import { contrastRatio, parseHex } from "@/lib/branding/contrast";
import { DEFAULT_DARK } from "@/lib/branding/defaults";

const MIN_TEXT = 4.5;
/** styles/tokens.css `--danger` in dark mode. */
const SITE_DARK_DANGER = "#FF8A80";

const hex = (channels: number[]) => `#${channels.map(value => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** `from` moved `percent` % of the way to `to`, in sRGB. */
function mixHex(from: string, to: string, percent: number): string | null {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return null;
  return hex(a.map((value, index) => value + ((b[index] ?? value) - value) * (percent / 100)));
}

/** The palette with a `danger` that reads at 4.5:1 on its surface and its background. */
export function legiblePalette(palette: Palette, theme: "light" | "dark"): Palette {
  const readable = (colour: string) => Math.min(contrastRatio(colour, palette.surface) ?? 0, contrastRatio(colour, palette.background) ?? 0) >= MIN_TEXT;
  if (readable(palette.danger)) return palette;
  if (theme === "dark" && palette.danger.toUpperCase() === DEFAULT_DARK.danger.toUpperCase() && readable(SITE_DARK_DANGER)) return { ...palette, danger: SITE_DARK_DANGER };
  for (let percent = 5; percent <= 100; percent += 5) {
    const mixed = mixHex(palette.danger, palette.foreground, percent);
    if (mixed && readable(mixed)) return { ...palette, danger: mixed };
  }
  return palette;
}

/** The branding as the hosted pages paint it: the app's own, with error text readable in both themes. */
export function legibleBranding(branding: Branding): Branding {
  const light = legiblePalette(branding.light, "light");
  const dark = legiblePalette(branding.dark, "dark");
  return light === branding.light && dark === branding.dark ? branding : { ...branding, light, dark };
}

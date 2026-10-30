/**
 * The main colours of a picture, for decoration drawn around it (Home's ring, components/account/home-identity.tsx).
 * The picture is drawn small into a canvas and its pixels are grouped by hue and lightness; near-greys, near-whites and near-blacks
 * (a pixel avatar's background, a photo's backdrop) are left out. Each colour is made vivid enough to read as a
 * ring.
 *
 * A photo from another site can only be read when that site allows it (CORS); when it does not, or the picture has
 * fewer than two colours worth showing, the result is null and the caller keeps its own colours.
 *
 * usePicturePalette gives the other kind: the picture's colours as they are (k-means, dark to light), for a gradient
 * that looks like the picture itself.
 */
import { useEffect, useMemo, useState } from "react";

/** How many colours a ring takes; fewer distinct colours are repeated to fill it. */
export const PICTURE_COLOURS = 4;
const SAMPLE = 32;
const HUE_BINS = 24;

interface Bin { weight: number; s: number; l: number; hx: number; hy: number }

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255, green = g / 255, blue = b / 255;
  const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === red ? (green - blue) / d + (green < blue ? 6 : 0) : max === green ? (blue - red) / d + 2 : (red - green) / d + 4;
  return [h * 60, s, l];
}

/** Lightness bands: a photo's deep shadows, its middle tones and its light ones are told apart, not only its hues. */
const BANDS = [
  { below: 0.38, min: 0.36, max: 0.46 },
  { below: 0.62, min: 0.48, max: 0.6 },
  { below: Infinity, min: 0.62, max: 0.74 },
] as const;
const MIN_HUE_APART = 24;
const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/**
 * Groups the pixels by hue and lightness and returns the strongest groups, ordered round the wheel and dark to light.
 * Two groups count as different colours when their hues are apart or their lightness bands differ, so a picture of one
 * hue (a warm photo) gives its own deep, middle and light shades, never hues it does not have.
 */
export function coloursOf(pixels: Uint8ClampedArray): string[] | null {
  const bins: Bin[] = Array.from({ length: HUE_BINS * BANDS.length }, () => ({ weight: 0, s: 0, l: 0, hx: 0, hy: 0 }));
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const [h, s, l] = toHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (s < 0.18 || l < 0.12 || l > 0.9) continue;
    // Stronger colours count for more than washed-out ones, so the ring follows what the eye notices.
    const weight = s;
    const band = BANDS.findIndex(entry => l < entry.below);
    const bin = bins[(Math.floor(h / (360 / HUE_BINS)) % HUE_BINS) * BANDS.length + band];
    bin.weight += weight;
    bin.hx += Math.cos((h * Math.PI) / 180) * weight;
    bin.hy += Math.sin((h * Math.PI) / 180) * weight;
    bin.s += s * weight;
    bin.l += l * weight;
  }
  const total = bins.reduce((sum, bin) => sum + bin.weight, 0);
  if (total === 0) return null;
  const picked: { h: number; s: number; l: number; band: number }[] = [];
  for (const bin of bins.filter(entry => entry.weight > total * 0.04).sort((a, b) => b.weight - a.weight)) {
    const h = ((Math.atan2(bin.hy, bin.hx) * 180) / Math.PI + 360) % 360;
    const l = bin.l / bin.weight;
    const band = BANDS.findIndex(entry => l < entry.below);
    if (picked.some(colour => colour.band === band && hueDistance(colour.h, h) < MIN_HUE_APART)) continue;
    picked.push({ h, s: Math.max(0.5, bin.s / bin.weight), l: Math.min(BANDS[band].max, Math.max(BANDS[band].min, l)), band });
    if (picked.length === PICTURE_COLOURS) break;
  }
  if (picked.length === 0) return null;
  // One colour alone shows in its three shades, so the ring still moves without borrowing other hues.
  if (picked.length === 1) {
    const [only] = picked;
    picked.splice(0, 1, ...BANDS.map((band, index) => ({ ...only, l: (band.min + band.max) / 2, band: index })));
  }
  // Round the wheel from just before the strongest colour, so neighbours sit side by side; shades of one hue run dark to
  // light.
  const start = picked[0].h - 180;
  const turn = (h: number) => (h - start + 720) % 360;
  const colours = picked
    .sort((a, b) => Math.round(turn(a.h) / MIN_HUE_APART) - Math.round(turn(b.h) / MIN_HUE_APART) || a.l - b.l)
    .map(({ h, s, l }) => `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`);
  return Array.from({ length: PICTURE_COLOURS }, (_, index) => colours[index % colours.length]);
}

/**
 * Where to read a picture from. Uploaded photos (`{public_url}/v1/photos/…`) carry no CORS headers, so a site on another
 * origin than the API's public URL (a local server on the live API) reads them through its own `/v1` proxy instead.
 */
function readable(src: string): string {
  try {
    const url = new URL(src, window.location.href);
    if (url.origin !== window.location.origin && url.pathname.startsWith("/v1/photos/")) return url.pathname + url.search;
  } catch {
    // Not a URL (a data: URL parses; anything else is used as given).
  }
  return src;
}

/** A picture's pixels, drawn small (SAMPLE square), or null while loading or when it cannot be read. */
function usePicturePixels(src: string | null | undefined): Uint8ClampedArray | null {
  const [found, setFound] = useState<{ src: string; pixels: Uint8ClampedArray | null } | null>(null);
  useEffect(() => {
    if (!src) return;
    let live = true;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      if (!live) return;
      let pixels: Uint8ClampedArray | null = null;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE;
        canvas.height = SAMPLE;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context) {
          context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
          pixels = context.getImageData(0, 0, SAMPLE, SAMPLE).data;
        }
      } catch {
        // The site serving the photo does not allow reading it: the caller keeps its own colours.
      }
      setFound({ src, pixels });
    };
    image.onerror = () => {
      if (live) setFound({ src, pixels: null });
    };
    image.src = readable(src);
    return () => {
      live = false;
    };
  }, [src]);
  return found && found.src === src ? found.pixels : null;
}

/** The picture's main colours (PICTURE_COLOURS of them), or null while loading, unreadable or nearly grey. */
export function usePictureColours(src: string | null | undefined): string[] | null {
  const pixels = usePicturePixels(src);
  return useMemo(() => (pixels ? coloursOf(pixels) : null), [pixels]);
}

/** One colour of a picture's palette, with its perceived lightness (0 dark to 255 light). */
export interface PaletteColour { css: string; lightness: number }

const lightnessOf = ([r, g, b]: number[]) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * A picture's palette as the colours it is made of, untouched: its opaque pixels grouped into `count` colours by
 * k-means (seeded across the lightness range, 12 rounds), ordered dark to light. For a gradient that looks like the
 * picture itself (Home's You card).
 */
export function paletteOf(pixels: Uint8ClampedArray, count: number): PaletteColour[] {
  const points: number[][] = [];
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 200) points.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  if (points.length < count) return [];
  const sorted = [...points].sort((a, b) => lightnessOf(a) - lightnessOf(b));
  let centres = Array.from({ length: count }, (_, index) => [...sorted[Math.floor(((index + 0.5) * sorted.length) / count)]]);
  for (let round = 0; round < 12; round++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const point of points) {
      let best = 0;
      let bestDistance = Infinity;
      centres.forEach((centre, index) => {
        const distance = (point[0] - centre[0]) ** 2 + (point[1] - centre[1]) ** 2 + (point[2] - centre[2]) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      sums[best][0] += point[0];
      sums[best][1] += point[1];
      sums[best][2] += point[2];
      sums[best][3] += 1;
    }
    centres = centres.map((centre, index) => (sums[index][3] ? sums[index].slice(0, 3).map(sum => sum / sums[index][3]) : centre));
  }
  return centres
    .sort((a, b) => lightnessOf(a) - lightnessOf(b))
    .map(centre => ({ css: `rgb(${centre.map(Math.round).join(" ")})`, lightness: lightnessOf(centre) }));
}

/** The picture's palette (`count` colours, dark to light, see paletteOf), or null while loading or unreadable. */
export function usePicturePalette(src: string | null | undefined, count = 4): PaletteColour[] | null {
  const pixels = usePicturePixels(src);
  return useMemo(() => {
    if (!pixels) return null;
    const palette = paletteOf(pixels, count);
    return palette.length ? palette : null;
  }, [pixels, count]);
}

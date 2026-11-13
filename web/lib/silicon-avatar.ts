/**
 * A Silicon's pixel avatar (Anil's "Pixel Avatar Generators, mosaic style", the Silicons tab, 2026-11-12): a creature
 * of mosaic pixels on a 16 by 16 grid: one of eight forms (Walker, Cloud, Spark, Ghost, Drop, Sprout, Crystal, Bot),
 * coloured along a gradient of one of fifteen palettes, white-touched at its edges, a few light halo pixels around it,
 * and two pixel eyes.
 *
 * - `siliconChoiceFromSeed(uuid)`: every Silicon's default look, the same for a uuid every time. (Its Carbon will be
 *   able to change it later; the API keeps no look yet, redesign/api-gaps.md.)
 * - `siliconAvatarCells(choice)`: every pixel with its colour and opacity.
 * - `siliconAvatarDataUrl(choice)`: a still SVG for an <img>, crisp at any size.
 * - `siliconPalette(choice)`: the palette's colours, for surfaces that blend with the avatar.
 *
 * The colours are part of the picture (data, like a photo's pixels), not the site's palette.
 */

type Hsl = [number, number, number];
type Rgb = [number, number, number];

const SIZE = 16;

const FORMS: Record<string, { name: string; mask: string[] }> = {
  walker: { name: "Walker", mask: ["#.#######..", "#########..", "#########..", "###########", "#EE#EE#####", "##########.", "#########..", ".########..", ".##.##.##..", ".##.##.##..", ".##.##.###.", ".##.##..##."] },
  cloud: { name: "Cloud", mask: ["..##.oooo...", ".#########..", "###########o", "#EE#EE#####o", "############", ".##########o", "..########o.", "...######...", "....###.....", ".....oo....."] },
  spark: { name: "Spark", mask: ["....o#o....", "....##o....", "..#######o.", ".########o.", "o#EE#EE###o", "o#########o", "o#########o", "o########o.", ".o######o..", "...o##o....", "....##.....", "....#o.....", "....o......"] },
  ghost: { name: "Ghost", mask: ["...####...", ".########.", "##########", "##EE##EE##", "##########", "##########", "##########", "##########", "##.####.##", "#...##...#"] },
  drop: { name: "Drop", mask: ["....##....", "....##....", "...####...", "..######..", ".########.", "##########", "##EE##EE##", "##########", "##########", ".########.", "..######.."] },
  sprout: { name: "Sprout", mask: ["....##.##...", ".....###....", "......#.....", "...######...", "..########..", ".##########.", ".##EE##EE##.", ".##########.", ".##########.", "..########..", "...######..."] },
  crystal: { name: "Crystal", mask: ["...######...", "..########..", ".##########.", "############", "###EE##EE###", ".##########.", "..########..", "...######...", "....####....", ".....##....."] },
  bot: { name: "Bot", mask: ["....oo....", ".....#....", ".....#....", ".########.", ".########.", ".#EE##EE#.", ".########.", "##########", ".########.", ".########.", "..##..##..", "..##..##.."] },
};

/** Stops are [h, s, l]; the angle is the gradient's direction (0 = left to right, 90 = top to bottom). */
const PALETTES: Record<string, { name: string; angle: number; stops: Hsl[]; accent?: Hsl[] }> = {
  bloom: { name: "Bloom", angle: 45, stops: [[80, 68, 50], [330, 80, 66], [205, 75, 62]] },
  reef: { name: "Reef", angle: 30, stops: [[205, 72, 56], [82, 65, 52], [355, 80, 62], [330, 80, 74]] },
  ember: { name: "Ember", angle: 30, stops: [[195, 65, 52], [78, 62, 50], [20, 85, 58], [355, 85, 60], [330, 80, 76]] },
  sunset: { name: "Sunset", angle: 315, stops: [[44, 92, 55], [26, 92, 55], [325, 75, 68], [158, 72, 50]] },
  aurora: { name: "Aurora", angle: 60, stops: [[168, 70, 48], [215, 75, 62], [278, 62, 66], [322, 75, 70]] },
  candy: { name: "Candy", angle: 90, stops: [[330, 85, 74], [18, 90, 72], [52, 90, 64], [150, 58, 62]] },
  orange: { name: "Orange", angle: 45, stops: [[42, 95, 58], [25, 92, 56], [12, 85, 58]], accent: [[330, 80, 72], [200, 70, 66]] },
  blue: { name: "Blue", angle: 45, stops: [[196, 80, 60], [214, 78, 58], [234, 68, 66]], accent: [[160, 65, 55], [290, 55, 70]] },
  green: { name: "Green", angle: 45, stops: [[86, 66, 50], [118, 48, 52], [150, 55, 46]], accent: [[50, 90, 60], [200, 70, 62]] },
  pink: { name: "Pink", angle: 45, stops: [[348, 82, 72], [326, 75, 66], [304, 58, 66]], accent: [[25, 90, 62], [260, 60, 70]] },
  violet: { name: "Violet", angle: 45, stops: [[252, 70, 72], [272, 60, 64], [292, 55, 64]], accent: [[200, 75, 62], [330, 80, 72]] },
  teal: { name: "Teal", angle: 45, stops: [[166, 64, 48], [180, 60, 44], [196, 68, 52]], accent: [[80, 65, 55], [350, 80, 70]] },
  yellow: { name: "Yellow", angle: 45, stops: [[56, 92, 60], [46, 96, 55], [36, 96, 55]], accent: [[200, 70, 62], [330, 75, 72]] },
  red: { name: "Red", angle: 45, stops: [[12, 82, 60], [356, 78, 57], [342, 72, 56]], accent: [[42, 95, 60], [280, 55, 66]] },
  mono: { name: "Graphite", angle: 45, stops: [[220, 8, 62], [220, 8, 46], [220, 10, 32]], accent: [[25, 90, 60], [200, 70, 60]] },
};

export const SILICON_FORMS = Object.keys(FORMS);
export const SILICON_PALETTES = Object.keys(PALETTES);
export const siliconFormName = (form: string) => FORMS[form]?.name ?? form;
export const siliconPaletteName = (palette: string) => PALETTES[palette]?.name ?? palette;

export type SiliconEyes = "right" | "left" | "inward";
export interface SiliconAvatarChoice { form: string; palette: string; eyes: SiliconEyes; mirror: boolean; seed: number }

/* The generator's look settings, as the file ships them. */
const BLEND = 0.12, GRAIN = 10, EDGE = 0.55, HALO = 0.35, SPRINKLE = 0;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
function hash(r: number, c: number, s: number) { const x = Math.sin(r * 12.9898 + c * 78.233 + s * 37.719) * 43758.5453; return x - Math.floor(x); }
function hslToRgb(h: number, s: number, l: number): Rgb {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const toHex = (rgb: Rgb) => `#${rgb.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const WHITE: Rgb = [255, 255, 255], INK: Rgb = [12, 12, 12];

function sampleStops(stops: Hsl[], t: number): Hsl {
  if (stops.length === 1) return [...stops[0]];
  const x = clamp(t, 0, 1) * (stops.length - 1), i = Math.min(Math.floor(x), stops.length - 2), f = x - i;
  const A = stops[i], B = stops[i + 1];
  const dh = ((B[0] - A[0] + 540) % 360) - 180;
  return [A[0] + dh * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
}

/** A small seeded random source (mulberry32) from a string, so a uuid always gives the same look. */
function randomFrom(seed: string) {
  let state = 0;
  for (const char of seed) state = (Math.imul(state, 31) + char.charCodeAt(0)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Silicon's default look from its uuid (the generator's Randomize, made repeatable). */
export function siliconChoiceFromSeed(seed: string): SiliconAvatarChoice {
  const rnd = randomFrom(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
  return { form: pick(SILICON_FORMS), palette: pick(SILICON_PALETTES), eyes: pick(["right", "left", "inward"] as const), mirror: rnd() < 0.3, seed: Math.round(rnd() * 999) + 1 };
}

export interface SiliconAvatarCell { r: number; c: number; color: string; kind: "body" | "halo" | "eye" }

/**
 * One moment of the avatar, for the animated picture at large sizes (components/account/parts/silicon-avatar.tsx):
 * `phase` drifts the mosaic's grain (a slow shimmer), `look` sends the eyes to one side, `blinking` closes them, and
 * `twinkle` picks which halo pixels around it are lit. The still picture is every one of them at rest.
 */
export interface SiliconAvatarFrame { phase?: number; look?: "left" | "right"; blinking?: boolean; twinkle?: number }

/** Every pixel of the avatar on the 16 by 16 grid. */
export function siliconAvatarCells(choice: SiliconAvatarChoice, frame: SiliconAvatarFrame = {}): SiliconAvatarCell[] {
  const form = FORMS[choice.form] ?? FORMS.spark;
  const palette = PALETTES[choice.palette] ?? PALETTES.sunset;
  const width = Math.max(...form.mask.map(row => row.length));
  let mask = form.mask.map(row => row.padEnd(width, "."));
  if (choice.mirror) mask = mask.map(row => [...row].reverse().join(""));
  const height = mask.length, r0 = Math.floor((SIZE - height) / 2), c0 = Math.floor((SIZE - width) / 2);
  const at = (r: number, c: number) => (r >= 0 && r < height && c >= 0 && c < width ? mask[r][c] : ".");
  const empty = (r: number, c: number) => at(r, c) === ".";
  const rad = (palette.angle * Math.PI) / 180, dx = Math.cos(rad), dy = Math.sin(rad);
  const filled: Array<[number, number, string]> = [];
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) if (!empty(r, c)) filled.push([r, c, at(r, c)]);
  const project = (r: number, c: number) => (c + 0.5 - width / 2) * dx + (r + 0.5 - height / 2) * dy;
  let low = Infinity, high = -Infinity;
  for (const [r, c] of filled) { const p = project(r, c); low = Math.min(low, p); high = Math.max(high, p); }
  const sd = choice.seed;
  const colourAt = (r: number, c: number): Rgb => {
    const t = (project(r, c) - low) / (high - low || 1) + (hash(r, c, sd + 1) - 0.5) * BLEND * 2;
    let [h, s, l] = sampleStops(palette.stops, t);
    if (palette.accent && hash(r, c, sd + 11) < SPRINKLE) [h, s, l] = palette.accent[Math.floor(hash(r, c, sd + 13) * palette.accent.length)];
    h += (hash(r, c, sd + 7) - 0.5) * 8;
    // At rest the grain is the generator's; with a phase each pixel's lightness swings gently around it (a shimmer).
    const grain = frame.phase ? Math.sin(frame.phase + hash(r, c, sd + 3) * Math.PI * 2) * 0.5 : hash(r, c, sd + 3) - 0.5;
    l += grain * GRAIN * 2;
    return hslToRgb(h, s, clamp(l, 18, 90));
  };
  const cells = new Map<string, SiliconAvatarCell>();
  const put = (r: number, c: number, rgb: Rgb, kind: SiliconAvatarCell["kind"]) => cells.set(`${r},${c}`, { r: r0 + r, c: c0 + c, color: toHex(rgb), kind });
  for (const [r, c, ch] of filled) {
    if (ch === "E") continue;
    const edge = empty(r - 1, c) || empty(r + 1, c) || empty(r, c - 1) || empty(r, c + 1);
    const white = ch === "o" ? 0.5 + 0.35 * hash(r, c, sd + 19) : edge ? EDGE * (0.1 + 0.6 * hash(r, c, sd + 17)) : 0;
    put(r, c, mix(colourAt(r, c), WHITE, white), "body");
  }
  for (let r = -1; r <= height; r++) for (let c = -1; c <= width; c++) {
    if (!empty(r, c)) continue;
    const touches = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([p, q]) => !empty(r + p, c + q) && at(r + p, c + q) !== "E");
    if (touches && hash(r, c, sd + 23 + (frame.twinkle ?? 0) * 0.37) < HALO * 0.55) put(r, c, mix(colourAt(r, c), WHITE, 0.72 + 0.2 * hash(r, c, sd + 29)), "halo");
  }
  const look = { right: [[0, 1], [0, 1]], left: [[1, 0], [1, 0]], inward: [[0, 1], [1, 0]] }[choice.eyes] ?? [[0, 1], [0, 1]];
  let eye = 0;
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    if (at(r, c) === "E" && at(r, c + 1) === "E") {
      // Blinking: the eye closes into a darker line of the body; looking: both pupils go to that side.
      if (frame.blinking) {
        const lid = toHex(mix(colourAt(r, c), [0, 0, 0], 0.45)) ;
        cells.set(`${r},${c}`, { r: r0 + r, c: c0 + c, color: lid, kind: "eye" });
        cells.set(`${r},${c + 1}`, { r: r0 + r, c: c0 + c + 1, color: lid, kind: "eye" });
      } else {
        const pattern = frame.look ? (frame.look === "right" ? [0, 1] : [1, 0]) : look[Math.min(eye, 1)];
        put(r, c, pattern[0] ? INK : WHITE, "eye");
        put(r, c + 1, pattern[1] ? INK : WHITE, "eye");
      }
      eye++; c++;
    }
  }
  return [...cells.values()];
}

/**
 * The square the avatar is drawn in, cropped to the creature and every place its halo can light (one cell around its
 * form), centred: the same in every frame, so nothing shifts while it moves. As a viewBox: "x y size size".
 */
export function siliconAvatarBox(choice: SiliconAvatarChoice): { x: number; y: number; size: number } {
  const form = FORMS[choice.form] ?? FORMS.spark;
  const width = Math.max(...form.mask.map(row => row.length)), height = form.mask.length;
  const r0 = Math.floor((SIZE - height) / 2), c0 = Math.floor((SIZE - width) / 2);
  const top = r0 - 1, left = c0 - 1, h = height + 2, w = width + 2, size = Math.max(h, w);
  return { x: left - (size - w) / 2, y: top - (size - h) / 2, size };
}

/**
 * A still SVG of the avatar, transparent around it unless `background` is given (a CSS colour). With `crop`, the
 * picture is the smallest square around the creature and its halo (centred), so it fills the space it is given.
 */
export function siliconAvatarDataUrl(choice: SiliconAvatarChoice, { background, crop = false }: { background?: string; crop?: boolean } = {}): string {
  const cells = siliconAvatarCells(choice);
  let box = { x: 0, y: 0, size: SIZE };
  if (crop && cells.length) {
    const rows = cells.map(cell => cell.r), columns = cells.map(cell => cell.c);
    const top = Math.min(...rows), bottom = Math.max(...rows) + 1, left = Math.min(...columns), right = Math.max(...columns) + 1;
    const size = Math.max(bottom - top, right - left);
    box = { x: left - (size - (right - left)) / 2, y: top - (size - (bottom - top)) / 2, size };
  }
  const rects = cells.map(cell => `<rect x="${cell.c}" y="${cell.r}" width="1" height="1" fill="${cell.color}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.size} ${box.size}" shape-rendering="crispEdges">${background ? `<rect x="${box.x}" y="${box.y}" width="${box.size}" height="${box.size}" fill="${background}"/>` : ""}${rects}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The palette's stops as CSS colours, light to the generator's order, for surfaces that blend with the avatar. */
export function siliconPalette(choice: SiliconAvatarChoice): string[] {
  const palette = PALETTES[choice.palette] ?? PALETTES.sunset;
  return palette.stops.map(([h, s, l]) => `hsl(${Math.round(h)} ${s}% ${l}%)`);
}

/**
 * A still PNG of the avatar on a light wash. Older saved avatars used this as their public photo.
 * `fill = 1` recreates the earlier tight crop in the card lab; the later still used 60% of the square.
 */
export async function siliconAvatarPng(choice: SiliconAvatarChoice, scale = 32, fill = 0.6): Promise<Blob> {
  const inner = siliconAvatarBox(choice);
  const pad = (inner.size / fill - inner.size) / 2;
  const box = { x: inner.x - pad, y: inner.y - pad, size: inner.size + pad * 2 };
  const size = Math.round(box.size * scale);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw the avatar.");
  const palette = PALETTES[choice.palette] ?? PALETTES.sunset;
  const [from, to] = [palette.stops[0], palette.stops[palette.stops.length - 1]].map(([h, s, l]) => toHex(mix(hslToRgb(h, s, l), WHITE, 0.78)));
  const ground = context.createLinearGradient(0, 0, size, size);
  ground.addColorStop(0, from);
  ground.addColorStop(1, to);
  context.fillStyle = ground;
  context.fillRect(0, 0, size, size);
  for (const cell of siliconAvatarCells(choice)) {
    context.fillStyle = cell.color;
    context.fillRect(Math.round((cell.c - box.x) * scale), Math.round((cell.r - box.y) * scale), Math.ceil(scale), Math.ceil(scale));
  }
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("This browser cannot save the avatar."))), "image/png"));
}

/** Each choice's options, for the avatar maker: forms and palettes by name, the eyes' three looks, the two facings. */
export const SILICON_EYES: SiliconEyes[] = ["right", "left", "inward"];

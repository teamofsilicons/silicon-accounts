/**
 * The Silicon avatar generator (Anil's avatar customizer v9): a Carbon's default picture, an 11 by 13 grid of mosaic
 * pixels (hair, face, clothing) that every Carbon can customise. This module draws it; components/foundation/avatar/
 * pixel-avatar.tsx animates it (hair shimmer, eyes looking side to side, blinks) at large sizes.
 *
 * - `choiceFromSeed(uuid)`: the default look, the same for a uuid every time.
 * - `avatarCells(choice, frame)`: every pixel with its colour and opacity, for one animation frame.
 * - `avatarDataUrl(choice)`: a still SVG, for an <img> (Silicon UI's Avatar and UserMenu take a src).
 * - `avatarPng(choice)`: a PNG, uploaded as the Carbon's photo when they save a customised avatar, so every app sees it.
 *
 * The colours are part of the picture (data, like a photo's pixels), not the site's palette.
 */

const MASK = [
  "00000111000",
  "00011111000",
  "00111111100",
  "00111111100",
  "01111111110",
  "00111111100",
  "00111111100",
  "00011111000",
  "00001110000",
  "00001110000",
  "01111111110",
  "11111111111",
  "11111111111",
];
export const AVATAR_COLUMNS = MASK[0].length;
export const AVATAR_ROWS = MASK.length;
const ROW_FADE = [0.3, 0.55, 0.8, 0.95, 1, 1, 1, 0.95, 0.75, 0.75, 1, 1, 1];
const EYE_ROW = 4;
const EYE_PAIRS: Array<[number, number]> = [[3, 4], [6, 7]];

type Cell = [number, number];
interface Mosaic { hue: number; spread: number; sat: number; light: number; lightSpread: number; seed: number }

interface Hair { label: string; rule: (r: number, c: number) => boolean; extra: Cell[]; accent?: Cell[]; accentColor?: string; cfg: Mosaic }
interface Face extends Mosaic { label: string; accessory: "earrings" | "glasses" | null; skinExtra?: Cell[] }
type Cloth =
  | { label: string; pattern: "mosaic"; cfg: Mosaic }
  | { label: string; pattern: "stripe-h" | "stripe-v" | "checker"; hue: number; sat: number; l1: number; l2: number }
  | { label: string; pattern: "collar"; hue: number; sat: number; lBody: number; lCollar: number };

const HAIR: Hair[] = [
  { label: "Short fade", rule: (r, c) => r <= 1 || (r === 2 && [4, 5, 6].includes(c)), extra: [], cfg: { hue: 20, spread: 16, sat: 16, light: 18, lightSpread: 12, seed: 1 } },
  { label: "Red cap", rule: r => r <= 2, extra: [[2, 0], [2, 10]], accent: [[1, 7], [1, 8]], accentColor: "#fdfdfb", cfg: { hue: 6, spread: 18, sat: 68, light: 50, lightSpread: 14, seed: 2 } },
  { label: "Curly hair", rule: (r, c) => r <= 2 || (r === 3 && [2, 3, 7, 8].includes(c)), extra: [[1, 1], [1, 9], [2, 1], [2, 9], [3, 1], [3, 9], [4, 1], [4, 9], [5, 1], [5, 9]], cfg: { hue: 20, spread: 8, sat: 12, light: 11, lightSpread: 6, seed: 3 } },
  { label: "Headphones", rule: (r, c) => r === 0 && [4, 5, 6].includes(c), extra: [], accent: [[0, 3], [0, 7], [1, 2], [1, 8], [5, 1], [5, 2], [6, 1], [6, 2], [5, 8], [5, 9], [6, 8], [6, 9]], accentColor: "#33343a", cfg: { hue: 22, spread: 14, sat: 20, light: 30, lightSpread: 10, seed: 6 } },
  { label: "Black afro", rule: r => r <= 3, extra: [[1, 0], [1, 10], [2, 0], [2, 10], [3, 0], [3, 10], [4, 0], [4, 10], [5, 0], [5, 10], [6, 0], [6, 10]], cfg: { hue: 20, spread: 10, sat: 12, light: 12, lightSpread: 6, seed: 7 } },
  { label: "Buzz cut", rule: (r, c) => r === 0 && [4, 5, 6].includes(c), extra: [], cfg: { hue: 22, spread: 14, sat: 20, light: 30, lightSpread: 10, seed: 6 } },
  { label: "Long straight", rule: r => r <= 2, extra: [[3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [3, 9], [4, 9], [5, 9], [6, 9], [7, 9], [8, 9], [9, 9]], cfg: { hue: 260, spread: 22, sat: 12, light: 15, lightSpread: 8, seed: 5 } },
  { label: "Long wavy", rule: r => r <= 2, extra: [[3, 1], [4, 0], [5, 1], [6, 0], [7, 1], [8, 0], [9, 1], [3, 9], [4, 10], [5, 9], [6, 10], [7, 9], [8, 10], [9, 9]], cfg: { hue: 18, spread: 20, sat: 42, light: 30, lightSpread: 14, seed: 8 } },
  { label: "Long with bangs", rule: (r, c) => r <= 3 && (r < 3 || [2, 3, 7, 8].includes(c)), extra: [[4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [4, 9], [5, 9], [6, 9], [7, 9], [8, 9], [9, 9]], cfg: { hue: 0, spread: 10, sat: 6, light: 10, lightSpread: 6, seed: 9 } },
  { label: "Long, full sides", rule: r => r <= 2, extra: [[3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [7, 2], [8, 1], [8, 2], [8, 3], [9, 1], [9, 2], [9, 3], [3, 9], [4, 9], [5, 9], [6, 9], [7, 9], [7, 8], [8, 9], [8, 8], [8, 7], [9, 9], [9, 8], [9, 7]], cfg: { hue: 0, spread: 8, sat: 5, light: 9, lightSpread: 5, seed: 22 } },
  { label: "No hair", rule: () => false, extra: [], cfg: { hue: 0, spread: 0, sat: 0, light: 0, lightSpread: 0, seed: 0 } },
  { label: "Beanie", rule: r => r <= 2, extra: [], cfg: { hue: 100, spread: 14, sat: 25, light: 35, lightSpread: 12, seed: 28 } },
  { label: "Bucket hat", rule: r => r <= 2, extra: [[2, 0], [2, 1], [2, 9], [2, 10]], cfg: { hue: 45, spread: 14, sat: 35, light: 55, lightSpread: 10, seed: 27 } },
  { label: "Bob cut", rule: r => r <= 2, extra: [[3, 1], [4, 1], [5, 1], [3, 9], [4, 9], [5, 9]], cfg: { hue: 20, spread: 16, sat: 40, light: 32, lightSpread: 12, seed: 23 } },
  { label: "Bun, pulled back", rule: (r, c) => r <= 1 && c >= 4 && c <= 6, extra: [], cfg: { hue: 15, spread: 14, sat: 35, light: 20, lightSpread: 10, seed: 24 } },
  { label: "Textured crop", rule: (r, c) => r <= 1 || (r === 2 && [4, 6].includes(c)), extra: [], cfg: { hue: 210, spread: 12, sat: 8, light: 25, lightSpread: 10, seed: 25 } },
  { label: "Middle part", rule: (r, c) => (r === 0 && [4, 6].includes(c)) || (r === 1 && c >= 3 && c <= 7) || (r === 2 && c >= 2 && c <= 8), extra: [], cfg: { hue: 25, spread: 16, sat: 40, light: 30, lightSpread: 12, seed: 26 } },
];

const FACE: Face[] = [
  { label: "Deep", hue: 22, spread: 16, sat: 50, light: 38, lightSpread: 12, seed: 15, accessory: null },
  { label: "Tan with earrings", hue: 28, spread: 18, sat: 58, light: 66, lightSpread: 14, seed: 18, accessory: "earrings" },
  { label: "Fair", hue: 20, spread: 14, sat: 42, light: 88, lightSpread: 10, seed: 11, accessory: null },
  { label: "Medium, round face", hue: 24, spread: 18, sat: 55, light: 55, lightSpread: 14, seed: 19, accessory: null, skinExtra: [[5, 1], [5, 9], [6, 1], [6, 9]] },
  { label: "Tan", hue: 28, spread: 18, sat: 58, light: 66, lightSpread: 14, seed: 13, accessory: null },
  { label: "Light with earrings", hue: 25, spread: 16, sat: 50, light: 78, lightSpread: 12, seed: 16, accessory: "earrings" },
  { label: "Medium", hue: 24, spread: 18, sat: 55, light: 55, lightSpread: 14, seed: 14, accessory: null },
  { label: "Deep, softer jaw", hue: 22, spread: 16, sat: 50, light: 38, lightSpread: 12, seed: 21, accessory: null, skinExtra: [[7, 2], [7, 8]] },
  { label: "Tan with glasses", hue: 28, spread: 18, sat: 58, light: 66, lightSpread: 14, seed: 17, accessory: "glasses" },
  { label: "Light", hue: 25, spread: 16, sat: 50, light: 78, lightSpread: 12, seed: 12, accessory: null },
];

const CLOTH: Cloth[] = [
  { label: "Navy mosaic", pattern: "mosaic", cfg: { hue: 222, sat: 42, light: 32, spread: 16, lightSpread: 16, seed: 31 } },
  { label: "Crimson stripes", pattern: "stripe-h", hue: 355, sat: 55, l1: 38, l2: 52 },
  { label: "Forest fleck", pattern: "mosaic", cfg: { hue: 142, sat: 38, light: 30, spread: 28, lightSpread: 24, seed: 33 } },
  { label: "Mustard collar", pattern: "collar", hue: 42, sat: 58, lBody: 46, lCollar: 26 },
  { label: "Plum checker", pattern: "checker", hue: 285, sat: 34, l1: 36, l2: 52 },
  { label: "Teal pinstripe", pattern: "stripe-v", hue: 182, sat: 44, l1: 34, l2: 48 },
];

export const AVATAR_PARTS = {
  hair: HAIR.map(item => item.label),
  face: FACE.map(item => item.label),
  clothing: CLOTH.map(item => item.label),
} as const;
export type AvatarPart = keyof typeof AVATAR_PARTS;

/** One look: an index into each part's options. */
export interface AvatarChoice { hair: number; face: number; clothing: number }

/** The picture's own background, behind the bust. */
const BACKGROUND = "hsl(0, 0%, 95%)";

function noise(r: number, c: number, seed: number): number {
  const x = Math.sin(r * 12.9898 + c * 78.233 + seed * 37.719) * 43758.5453;
  return x - Math.floor(x);
}
function mosaic(r: number, c: number, cfg: Mosaic, phase = 0): string {
  const n1 = noise(r, c, cfg.seed + phase);
  const n2 = noise(r, c, cfg.seed + 5.3 + phase);
  const hue = cfg.hue + (n1 - 0.5) * cfg.spread;
  const light = cfg.light + (n2 - 0.5) * cfg.lightSpread;
  return `hsl(${hue.toFixed(1)}, ${cfg.sat}%, ${Math.max(10, Math.min(92, light)).toFixed(0)}%)`;
}
const hsl = (h: number, s: number, l: number) => `hsl(${h}, ${s}%, ${l}%)`;
function skin(r: number, c: number, face: Face): string {
  return r >= 7 ? mosaic(r, c, { ...face, spread: face.spread * 0.3, lightSpread: face.lightSpread * 0.3 }) : mosaic(r, c, face);
}
function clothing(r: number, c: number, row: number, cloth: Cloth): string {
  switch (cloth.pattern) {
    case "stripe-h": return hsl(cloth.hue, cloth.sat, row % 2 === 0 ? cloth.l1 : cloth.l2);
    case "stripe-v": return hsl(cloth.hue, cloth.sat, c % 2 === 0 ? cloth.l1 : cloth.l2);
    case "checker": return hsl(cloth.hue, cloth.sat, (r + c) % 2 === 0 ? cloth.l1 : cloth.l2);
    case "collar": return hsl(cloth.hue, cloth.sat, row === 0 ? cloth.lCollar : cloth.lBody);
    default: return mosaic(r, c, cloth.cfg);
  }
}

function hash(seed: string): number {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
}

/** The default look for an account: the same uuid always gets the same one. */
export function choiceFromSeed(seed: string): AvatarChoice {
  const value = hash(seed);
  return { hair: value % HAIR.length, face: Math.floor(value / HAIR.length) % FACE.length, clothing: Math.floor(value / (HAIR.length * FACE.length)) % CLOTH.length };
}

/** A valid choice from stored or typed values (out-of-range parts wrap). */
export function normaliseChoice(choice: AvatarChoice): AvatarChoice {
  const wrap = (value: number, length: number) => ((Math.trunc(value) % length) + length) % length;
  return { hair: wrap(choice.hair, HAIR.length), face: wrap(choice.face, FACE.length), clothing: wrap(choice.clothing, CLOTH.length) };
}

/** One animation frame: the hair's shimmer phase, which way the eyes look, and whether they are closed. */
export interface AvatarFrame { phase?: number; lookRight?: boolean; blinking?: boolean }

export interface AvatarCell { r: number; c: number; color: string; opacity: number }

/** Every pixel of the picture, in paint order (later cells cover earlier ones). */
export function avatarCells(rawChoice: AvatarChoice, frame: AvatarFrame = {}): AvatarCell[] {
  const choice = normaliseChoice(rawChoice);
  const hair = HAIR[choice.hair];
  const face = FACE[choice.face];
  const cloth = CLOTH[choice.clothing];
  const phase = frame.phase ?? 0;
  const cells: AvatarCell[] = [];
  const push = (r: number, c: number, color: string, opacity = ROW_FADE[r]) => cells.push({ r, c, color, opacity });

  MASK.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== "1") continue;
      if (r >= 10) { push(r, c, clothing(r, c, r - 10, cloth)); continue; }
      const pair = r === EYE_ROW ? EYE_PAIRS.find(([a, b]) => c === a || c === b) : undefined;
      if (pair) {
        const pupil = frame.lookRight ? pair[1] : pair[0];
        push(r, c, frame.blinking ? skin(r, c, face) : c === pupil ? "hsl(0, 0%, 8%)" : "hsl(0, 0%, 100%)", 1);
        continue;
      }
      push(r, c, hair.rule(r, c) ? mosaic(r, c, hair.cfg, phase) : skin(r, c, face));
    }
  });
  hair.extra.forEach(([r, c]) => push(r, c, mosaic(r, c, hair.cfg, phase), ROW_FADE[r] * 0.85));
  (face.skinExtra ?? []).forEach(([r, c]) => push(r, c, skin(r, c, face)));
  (hair.accent ?? []).forEach(([r, c]) => push(r, c, hair.accentColor ?? "#000"));
  if (face.accessory === "earrings") ([[5, 2], [6, 2], [5, 8], [6, 8]] as Cell[]).forEach(([r, c]) => push(r, c, "hsl(43, 70%, 51%)"));
  if (face.accessory === "glasses") ([[3, 3], [3, 4], [3, 6], [3, 7], [4, 1], [4, 9]] as Cell[]).forEach(([r, c]) => push(r, c, "hsl(30, 4%, 14%)"));
  return cells;
}

/**
 * The square the picture is drawn in: 15 by 15 cells with the 11 by 13 figure centred across and set a cell and a half
 * down, so a round crop keeps the whole head and cuts only the shoulders, as a portrait does.
 */
const FRAME = 15;
const FRAME_LEFT = (FRAME - AVATAR_COLUMNS) / 2;
const FRAME_TOP = 1.5;
export const AVATAR_VIEWBOX = `${-FRAME_LEFT} ${-FRAME_TOP} ${FRAME} ${FRAME}`;
export const AVATAR_FRAME = { size: FRAME, left: -FRAME_LEFT, top: -FRAME_TOP };

/** A still SVG of the look, as a data URL for an <img>. */
export function avatarDataUrl(choice: AvatarChoice): string {
  const rects = avatarCells(choice).map(cell => `<rect x="${cell.c}" y="${cell.r}" width="1.02" height="1.02" fill="${cell.color}" fill-opacity="${cell.opacity}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${AVATAR_VIEWBOX}" shape-rendering="crispEdges"><rect x="${-FRAME_LEFT}" y="${-FRAME_TOP}" width="${FRAME}" height="${FRAME}" fill="${BACKGROUND}"/>${rects}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** A PNG of the look (square, `scale` pixels per cell), to upload as the account's photo. */
export async function avatarPng(choice: AvatarChoice, scale = 24): Promise<Blob> {
  const size = FRAME * scale;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw the avatar.");
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, size, size);
  for (const cell of avatarCells(choice)) {
    context.globalAlpha = cell.opacity;
    context.fillStyle = cell.color;
    context.fillRect((cell.c + 1) * scale, cell.r * scale, scale, scale);
  }
  context.globalAlpha = 1;
  return new Promise((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("The avatar could not be drawn."))), "image/png"));
}

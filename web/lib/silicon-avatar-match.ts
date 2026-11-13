/**
 * Recovering a Silicon avatar's look from a PNG the avatar maker uploaded before saves carried their look (Anil,
 * 2026-11-13: "why no Silicons in motion?"). Those PNGs are exact: siliconAvatarPng drew every cell as a solid square of
 * its colour at a whole number of pixels per cell, on a smooth wash. So the look can be found again, and the card can
 * draw the Silicon live instead of a still picture:
 *
 *   1. its form and facing, from which cells are filled (the silhouette), among the 8 forms each way round;
 *   2. its eyes, from which eye cell of each pair is dark;
 *   3. its palette and pixel seed, by drawing each of the 15 palettes with each of the 999 seeds until every body
 *      cell's colour matches the picture exactly.
 *
 * Both PNG shapes are tried: cropped tight to the creature (the first saves) and with the creature at 60% (later ones).
 * Anything that doesn't match exactly answers null, and the picture stays a picture.
 */
import { siliconAvatarBox, siliconAvatarCells, SILICON_FORMS, SILICON_PALETTES, type SiliconAvatarChoice, type SiliconEyes } from "./silicon-avatar";

type Rgb = [number, number, number];
const distance = (a: Rgb, b: Rgb) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

export function matchSiliconAvatar(data: Uint8ClampedArray, width: number, height: number): SiliconAvatarChoice | null {
  if (width !== height || width < 64) return null;
  const pixel = (x: number, y: number): Rgb => {
    const at = (Math.min(height - 1, Math.max(0, Math.round(y))) * width + Math.min(width - 1, Math.max(0, Math.round(x)))) * 4;
    return [data[at], data[at + 1], data[at + 2]];
  };
  // The wash is a smooth diagonal gradient from the top-left corner to the bottom-right one.
  const from = pixel(1, 1), to = pixel(width - 2, height - 2);
  const ground = (x: number, y: number): Rgb => {
    const t = Math.min(1, Math.max(0, (x + y) / (width + height)));
    return [0, 1, 2].map(i => Math.round(from[i] + (to[i] - from[i]) * t)) as Rgb;
  };

  // 1. Form, facing and the picture's own cell grid.
  let best: { form: string; mirror: boolean; box: { x: number; y: number; size: number }; scale: number; score: number } | null = null;
  for (const form of SILICON_FORMS) for (const mirror of [false, true]) {
    const probe: SiliconAvatarChoice = { form, palette: SILICON_PALETTES[0], eyes: "right", mirror, seed: 1 };
    const tight = siliconAvatarBox(probe);
    const pad = (tight.size / 0.6 - tight.size) / 2;
    for (const box of [tight, { x: tight.x - pad, y: tight.y - pad, size: tight.size + pad * 2 }]) {
      const scale = width / box.size;
      if (Math.abs(Math.round(box.size * 32) - width) > 1) continue;
      const filled = new Set(siliconAvatarCells(probe).filter(cell => cell.kind !== "halo").map(cell => `${cell.r},${cell.c}`));
      let score = 0, total = 0;
      for (let r = Math.ceil(box.y); r < box.y + box.size; r++) for (let c = Math.ceil(box.x); c < box.x + box.size; c++) {
        const x = (c - box.x + 0.5) * scale, y = (r - box.y + 0.5) * scale;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const solid = distance(pixel(x, y), ground(x, y)) > 40;
        const want = filled.has(`${r},${c}`);
        // Halo cells are light and may or may not be there: a filled-looking cell outside the form only counts against
        // the match when it isn't next to the form.
        if (want === solid) score++;
        total++;
      }
      const ratio = score / (total || 1);
      if (!best || ratio > best.score) best = { form, mirror, box, scale, score: ratio };
    }
  }
  if (!best || best.score < 0.9) return null;
  const { form, mirror, box, scale } = best;
  const at = (r: number, c: number) => pixel((c - box.x + 0.5) * scale, (r - box.y + 0.5) * scale);

  // 2. Eyes: in each pair, which cell is the dark pupil.
  const eyeCells = siliconAvatarCells({ form, palette: SILICON_PALETTES[0], eyes: "right", mirror, seed: 1 }).filter(cell => cell.kind === "eye").sort((a, b) => a.r - b.r || a.c - b.c);
  const dark = (rgb: Rgb) => rgb[0] + rgb[1] + rgb[2] < 180;
  const pairs: Array<[boolean, boolean]> = [];
  for (let i = 0; i + 1 < eyeCells.length; i += 2) pairs.push([dark(at(eyeCells[i].r, eyeCells[i].c)), dark(at(eyeCells[i + 1].r, eyeCells[i + 1].c))]);
  if (pairs.length < 2) return null;
  // Facing mirrors the mask, and with it which side each pair reads from; compare against what each look draws.
  const lookOf = (eyes: SiliconEyes) => siliconAvatarCells({ form, palette: SILICON_PALETTES[0], eyes, mirror, seed: 1 }).filter(cell => cell.kind === "eye").sort((a, b) => a.r - b.r || a.c - b.c).map(cell => cell.color === "#0c0c0c");
  const seen = pairs.flat();
  const eyes = (["right", "left", "inward"] as SiliconEyes[]).find(candidate => lookOf(candidate).every((value, index) => value === seen[index]));
  if (!eyes) return null;

  // 3. Palette and seed: every body cell's colour, within a few steps. Privacy browsers (Helium, Brave, ungoogled
  // Chromium) add tiny random noise to pixels read back from a canvas, so an exact match would fail there; the shape and
  // eyes above already have to match, so a small tolerance can't pick a different Silicon. The best seed wins.
  const body = siliconAvatarCells({ form, palette: SILICON_PALETTES[0], eyes, mirror, seed: 1 }).filter(cell => cell.kind === "body");
  const sampled = new Map(body.map(cell => [`${cell.r},${cell.c}`, at(cell.r, cell.c)]));
  const parse = (colour: string): Rgb => [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16)) as Rgb;
  const allowed = Math.max(1, Math.floor(body.length * 0.03));
  let found: { choice: SiliconAvatarChoice; misses: number } | null = null;
  for (const palette of SILICON_PALETTES) for (let seed = 1; seed <= 999; seed++) {
    const choice: SiliconAvatarChoice = { form, palette, eyes, mirror, seed };
    let misses = 0;
    for (const cell of siliconAvatarCells(choice)) {
      if (cell.kind !== "body") continue;
      const want = sampled.get(`${cell.r},${cell.c}`);
      if (want !== undefined && distance(want, parse(cell.color)) > 6 && ++misses > allowed) break;
    }
    if (misses <= allowed && (!found || misses < found.misses)) {
      found = { choice, misses };
      if (misses === 0) return choice;
    }
  }
  return found?.choice ?? null;
}

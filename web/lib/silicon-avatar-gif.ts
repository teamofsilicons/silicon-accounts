/**
 * A transparent, animated copy of a Silicon's pixel avatar for its public profile photo.
 * The account API stores one photo URL. Keeping the motion in that GIF means another browser can
 * show the same look without the local avatar settings that only the saving browser has.
 */
import { SILICON_FORMS, SILICON_PALETTES, siliconAvatarCells, type SiliconAvatarChoice, type SiliconAvatarFrame } from "./silicon-avatar";

const GRID = 16;
const CELL = 8;
const SIDE = GRID * CELL;
const MARKER = "silicon-avatar-v1";

function word(bytes: number[], value: number) { bytes.push(value & 255, (value >> 8) & 255); }

/** Literal LZW codes with a clear before each pixel. Small 128px frames stay well below the API's 2 MB limit. */
function imageData(indexes: Uint8Array): number[] {
  const packed: number[] = [];
  let bits = 0, count = 0;
  const code = (value: number) => {
    bits |= value << count;
    count += 9;
    while (count >= 8) { packed.push(bits & 255); bits >>>= 8; count -= 8; }
  };
  for (const index of indexes) { code(256); code(index); }
  code(257);
  if (count) packed.push(bits & 255);
  const blocks: number[] = [8];
  for (let start = 0; start < packed.length; start += 255) {
    const chunk = packed.slice(start, start + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return blocks;
}

function picture(choice: SiliconAvatarChoice, frame: SiliconAvatarFrame) {
  const indexes = new Uint8Array(SIDE * SIDE);
  const palette = new Uint8Array(256 * 3);
  const colors = new Map<string, number>();
  let next = 1; // 0 is transparent.
  for (const cell of siliconAvatarCells(choice, frame)) {
    let index = colors.get(cell.color);
    if (!index) {
      index = next++;
      if (index > 255) throw new Error("The avatar has too many colours for a GIF frame.");
      colors.set(cell.color, index);
      const rgb = cell.color.slice(1);
      palette[index * 3] = Number.parseInt(rgb.slice(0, 2), 16);
      palette[index * 3 + 1] = Number.parseInt(rgb.slice(2, 4), 16);
      palette[index * 3 + 2] = Number.parseInt(rgb.slice(4, 6), 16);
    }
    for (let y = cell.r * CELL; y < (cell.r + 1) * CELL; y++) {
      indexes.fill(index, y * SIDE + cell.c * CELL, y * SIDE + (cell.c + 1) * CELL);
    }
  }
  return { indexes, palette };
}

/** A looping GIF with a transparent background, moving eyes, a blink and shifting mosaic light. */
export function siliconAvatarGif(choice: SiliconAvatarChoice): Blob {
  const bytes: number[] = [...new TextEncoder().encode("GIF89a")];
  word(bytes, SIDE); word(bytes, SIDE);
  bytes.push(0x70, 0, 0); // No global palette; each frame uses its own exact colours.
  bytes.push(0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0);
  // Keep the editable look inside the file, not only in this browser's local storage.
  const comment = new TextEncoder().encode(`${MARKER}:${JSON.stringify(choice)}`);
  if (comment.length > 255) throw new Error("The avatar settings do not fit in a GIF comment.");
  bytes.push(0x21, 0xfe, comment.length, ...comment, 0);
  for (let index = 0; index < 16; index++) {
    const frame: SiliconAvatarFrame = {
      phase: index * 0.5 + 0.1,
      twinkle: Math.floor(index / 2),
      look: index >= 7 && index <= 10 ? "right" : undefined,
      blinking: index === 13,
    };
    const { indexes, palette } = picture(choice, frame);
    const delay = index === 13 ? 12 : 24; // Hundredths of a second.
    bytes.push(0x21, 0xf9, 4, 0x09);
    word(bytes, delay);
    bytes.push(0, 0); // Transparent palette index, end of graphic control extension.
    bytes.push(0x2c);
    word(bytes, 0); word(bytes, 0); word(bytes, SIDE); word(bytes, SIDE);
    bytes.push(0x87, ...palette, ...imageData(indexes)); // 256-colour local palette.
  }
  bytes.push(0x3b);
  return new Blob([new Uint8Array(bytes)], { type: "image/gif" });
}

/** Marker on our generated GIFs, so a saved avatar is not styled like a normal uploaded photo. */
export function isSiliconAvatarGif(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes.subarray(0, 100)).includes(MARKER);
}

/** The saved look, if this is one of our GIFs. Older marked GIFs may have no settings comment. */
export function siliconAvatarChoiceFromGif(bytes: Uint8Array): SiliconAvatarChoice | null {
  const prefix = `${MARKER}:`;
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, 300));
  const start = text.indexOf(prefix);
  if (start < 0) return null;
  const end = text.indexOf("\0", start);
  if (end < 0) return null;
  try {
    const choice = JSON.parse(text.slice(start + prefix.length, end)) as SiliconAvatarChoice;
    if (!SILICON_FORMS.includes(choice.form) || !SILICON_PALETTES.includes(choice.palette) ||
        !["left", "right", "inward"].includes(choice.eyes) || typeof choice.mirror !== "boolean" ||
        !Number.isInteger(choice.seed) || choice.seed < 1 || choice.seed > 1000) return null;
    return choice;
  } catch { return null; }
}

/**
 * Resolve an uploaded Silicon photo for a card. Older avatar-maker uploads are opaque PNGs: the
 * browser that saved them knows the avatar recipe, but another origin sees only that PNG. Recover
 * the crisp foreground from its smooth gradient rather than blurring or masking the creature.
 * New avatar-maker uploads are transparent GIFs marked by silicon-avatar-gif.ts.
 */
import { isSiliconAvatarGif, siliconAvatarChoiceFromGif } from "./silicon-avatar-gif";
import type { SiliconAvatarChoice } from "./silicon-avatar";
import { matchSiliconAvatar } from "./silicon-avatar-match";

export type SiliconPhotoAsset = { kind: "avatar"; src: string; poster: string; colours?: [string, string, string]; choice?: SiliconAvatarChoice } | { kind: "photo"; src: string };

/** Only the account service's own immutable uploads are inspected; other photo links render as given. */
function readableUrl(src: string): string | null {
  if (src.startsWith("data:image/")) return src; // The development card lab's legacy upload.
  try {
    const url = new URL(src);
    return /^\/v1\/photos\/[0-9a-f-]{36}$/.test(url.pathname) ? url.pathname : null;
  } catch { return null; }
}

/** Sample coloured cells from the saved creature itself, from its light side through its dark side. */
function avatarColours(data: Uint8ClampedArray, width: number, height: number): [string, string, string] | undefined {
  const cells: { order: number; colour: string }[] = [];
  const step = Math.max(4, Math.floor(Math.min(width, height) / 40));
  for (let y = Math.floor(step / 2); y < height; y += step) for (let x = Math.floor(step / 2); x < width; x += step) {
    const at = (y * width + x) * 4;
    if (data[at + 3] < 230) continue;
    const rgb = [data[at], data[at + 1], data[at + 2]];
    const lightness = (Math.max(...rgb) + Math.min(...rgb)) / 2;
    if (Math.max(...rgb) - Math.min(...rgb) < 24 || lightness < 45 || lightness > 235) continue;
    cells.push({ order: x / width + y / height, colour: `#${rgb.map(value => value.toString(16).padStart(2, "0")).join("")}` });
  }
  if (cells.length < 12) return undefined;
  cells.sort((a, b) => a.order - b.order);
  return [cells[Math.floor(cells.length * .15)].colour, cells[Math.floor(cells.length * .5)].colour, cells[Math.floor(cells.length * .85)].colour];
}

async function firstFrame(blob: Blob): Promise<{ poster: string; colours?: [string, string, string] }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context?.drawImage(bitmap, 0, 0);
    const colours = context ? avatarColours(context.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height) : undefined;
    return { poster: canvas.toDataURL("image/png"), colours };
  } finally { bitmap.close(); }
}

/** The avatar look an exact maker PNG was drawn from, or null for anything else. */
async function lookOfPng(blob: Blob): Promise<SiliconAvatarChoice | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return matchSiliconAvatar(context.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height);
  } catch {
    return null;
  } finally { bitmap.close(); }
}

const cache = new Map<string, Promise<SiliconPhotoAsset>>();

/** Keeps real photos intact; returns a transparent image (and a still frame for GIFs) for maker uploads. */
export function siliconPhotoAsset(src: string): Promise<SiliconPhotoAsset> {
  const previous = cache.get(src);
  if (previous) return previous;
  const request = (async (): Promise<SiliconPhotoAsset> => {
    const url = readableUrl(src);
    if (!url) return { kind: "photo", src };
    try {
      let blob: Blob;
      if (url.startsWith("data:")) {
        const match = /^data:(image\/(?:png|gif));base64,(.+)$/.exec(url);
        if (!match) return { kind: "photo", src };
        const raw = atob(match[2]);
        const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
        blob = new Blob([bytes], { type: match[1] });
      } else {
        const response = await fetch(url);
        if (!response.ok) return { kind: "photo", src };
        blob = await response.blob();
      }
      if (blob.type === "image/gif") {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (isSiliconAvatarGif(bytes)) return { kind: "avatar", src: url, ...await firstFrame(blob), choice: siliconAvatarChoiceFromGif(bytes) ?? undefined };
      }
      if (blob.type === "image/png") {
        // A maker PNG is exact: find its look again, so the card can draw it live (silicon-avatar-match.ts).
        const choice = await lookOfPng(blob);
        // Any other PNG is a photo, shown as it is: guessing an old avatar from flat colour areas cut real logos out.
        if (choice) return { kind: "avatar", src: url, poster: url, choice };
      }
    } catch { /* An unreadable photo still displays as a photo. */ }
    return { kind: "photo", src };
  })();
  cache.set(src, request);
  return request;
}

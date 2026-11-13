/**
 * What a Silicon's picture is (Anil, 2026-11-13): its pixel avatar (lib/silicon-avatar.ts), the look its Carbon made
 * or by default the one drawn from its uuid, or a photo it was given. As with a Carbon (lib/carbon-avatar.ts), a made
 * avatar is uploaded as a transparent animated GIF, so every app sees it. The GIF also carries the editable settings;
 * this browser remembers them beside the photo's address to draw the look live. Another browser reads the settings
 * from the GIF in the editor. The API keeps no separate look field (redesign/api-gaps.md).
 */
import { useSyncExternalStore } from "react";
import { siliconChoiceFromSeed, SILICON_FORMS, SILICON_PALETTES, type SiliconAvatarChoice } from "@/lib/silicon-avatar";

export type SiliconPicture =
  | { kind: "avatar"; choice: SiliconAvatarChoice; customised: boolean }
  | { kind: "photo"; src: string };

interface Stored { choice: SiliconAvatarChoice; photo: string }

/** Iris's default photo (none uploaded): `{iris}/pfp/silicon?id=…`. */
const isDefault = (url: string | null | undefined) => !url || /\/pfp\/(carbon|silicon)(\?|$)/.test(url);
const key = (uuid: string) => `accounts.silicon-avatar.${uuid}`;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key?.startsWith("accounts.silicon-avatar.")) listener(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
};

function readRaw(uuid: string): string | null {
  try { return window.localStorage.getItem(key(uuid)); } catch { return null; }
}

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Stored>;
    const choice = value.choice;
    if (!choice || typeof value.photo !== "string" || !SILICON_FORMS.includes(choice.form) || !SILICON_PALETTES.includes(choice.palette)) return null;
    return { choice, photo: value.photo };
  } catch {
    return null;
  }
}

/** Remembers the look just saved and the photo address it was uploaded as. */
export function rememberSiliconAvatar(uuid: string, choice: SiliconAvatarChoice, photo: string) {
  try { window.localStorage.setItem(key(uuid), JSON.stringify({ choice, photo })); } catch { /* storage blocked: the photo still shows */ }
  listeners.forEach(listener => listener());
}

/** A Silicon's picture: the look saved for its current photo, its default avatar, or its photo. */
export function siliconPictureOf(silicon: { uuid: string; pfp_url?: string | null }, stored: Stored | null): SiliconPicture {
  if (stored && silicon.pfp_url && silicon.pfp_url === stored.photo) return { kind: "avatar", choice: stored.choice, customised: true };
  if (isDefault(silicon.pfp_url)) return { kind: "avatar", choice: siliconChoiceFromSeed(silicon.uuid), customised: false };
  return { kind: "photo", src: silicon.pfp_url! };
}

/** The picture, kept up to date when a look is saved. Without `pfp_url` the Silicon counts as having the default. */
export function useSiliconPicture(silicon: { uuid: string; pfp_url?: string | null }): SiliconPicture {
  const raw = useSyncExternalStore(subscribe, () => readRaw(silicon.uuid), () => null);
  return siliconPictureOf(silicon, parse(raw));
}

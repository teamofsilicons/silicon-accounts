/**
 * What a Carbon's picture is: the photo they uploaded, or their pixel avatar (lib/pixel-avatar.ts), either the look
 * they customised or, by default, the one drawn from their uuid. Silicons keep their photo.
 *
 * A customised avatar is uploaded as the Carbon's photo (so every app sees it) and its look is remembered in this
 * browser beside the uploaded photo's address: while that photo is still theirs, the site draws it live (animated at
 * large sizes) and the editor opens on that look. The API keeps no look of its own (redesign/api-gaps.md).
 */
import { useSyncExternalStore } from "react";
import type { Me } from "@/lib/api/types";
import { avatarDataUrl, choiceFromSeed, normaliseChoice, type AvatarChoice } from "@/lib/pixel-avatar";

export type CarbonPicture =
  | { kind: "avatar"; choice: AvatarChoice; customised: boolean; src: string }
  | { kind: "photo"; src: string | null };

interface Stored { choice: AvatarChoice; photo: string }

/** Iris's default photo (no photo uploaded): `{iris}/pfp/carbon?id=…`. */
const isDefaultPhoto = (url: string | null | undefined) => !url || /\/pfp\/(carbon|silicon)(\?|$)/.test(url);

const key = (uuid: string) => `accounts.avatar.${uuid}`;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key?.startsWith("accounts.avatar.")) listener(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
};

function readRaw(uuid: string): string | null {
  try {
    return window.localStorage.getItem(key(uuid));
  } catch {
    return null;
  }
}

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Stored>;
    if (!value.choice || typeof value.photo !== "string") return null;
    return { choice: normaliseChoice(value.choice), photo: value.photo };
  } catch {
    return null;
  }
}

/** Remembers the look just saved and the photo address it was uploaded as. */
export function rememberAvatar(uuid: string, choice: AvatarChoice, photo: string) {
  try {
    window.localStorage.setItem(key(uuid), JSON.stringify({ choice, photo }));
  } catch {
    // Storage blocked: the uploaded picture still shows, as a photo.
  }
  listeners.forEach(listener => listener());
}

/** A Carbon's picture as the site should draw it (a Silicon's is always its photo). */
export function pictureOf(me: Pick<Me, "kind" | "uuid" | "pfp_url">, stored: Stored | null): CarbonPicture {
  if (me.kind !== "carbon") return { kind: "photo", src: me.pfp_url };
  if (stored && me.pfp_url === stored.photo) return { kind: "avatar", choice: stored.choice, customised: true, src: avatarDataUrl(stored.choice) };
  if (isDefaultPhoto(me.pfp_url)) {
    const choice = choiceFromSeed(me.uuid);
    return { kind: "avatar", choice, customised: false, src: avatarDataUrl(choice) };
  }
  return { kind: "photo", src: me.pfp_url };
}

/** The signed-in account's picture, kept up to date when a look is saved; null until the account is known. */
export function useCarbonPicture(me: Pick<Me, "kind" | "uuid" | "pfp_url"> | null | undefined): CarbonPicture | null {
  const uuid = me?.uuid;
  const raw = useSyncExternalStore(subscribe, () => (uuid ? readRaw(uuid) : null), () => null);
  return me ? pictureOf(me, parse(raw)) : null;
}

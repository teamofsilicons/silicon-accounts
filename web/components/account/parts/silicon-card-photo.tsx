"use client";

/** The card picture: a live generated avatar, a recovered older PNG, or an ordinary photo. */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { SiliconPhotoAsset } from "@/lib/silicon-photo-asset";
import { mediaMatches, subscribeMedia } from "@/lib/media-query";
import styles from "./silicon-card.module.css";

const MOTION = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (change: () => void) => subscribeMedia(MOTION, change);

/** `fallback`: drawn instead when the photo can't be loaded (a dead link, a blocked host, offline). */
export function SiliconCardPhoto({ src, asset, fallback }: { src: string; asset: SiliconPhotoAsset | null; fallback?: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  const reducedMotion = useSyncExternalStore(subscribeMotion, () => mediaMatches(MOTION), () => true);
  // A service upload is checked first (an avatar-maker save or a real photo?). Until that answer, and wherever it never
  // comes (JavaScript off or failed, the server's own render), show the saved picture itself at the avatar's size,
  // centred, never an empty card and never full-bleed (Anil, 2026-11-13: "we do save a picture, show that").
  if (!asset && (/\/v1\/photos\/[0-9a-f-]{36}$/.test(src) || src.startsWith("data:image/"))) {
    if (failed === src) return <>{fallback ?? null}</>;
    // eslint-disable-next-line @next/next/no-img-element -- the Silicon's saved picture, served as it is.
    return <img className={styles.avatarPhoto} src={src} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
  }
  const chosen = asset ?? { kind: "photo" as const, src };
  const avatar = chosen.kind === "avatar";
  const url = avatar && reducedMotion ? chosen.poster : chosen.src;
  if (failed === url) return <>{fallback ?? null}</>;
  // eslint-disable-next-line @next/next/no-img-element -- photos may come from any https address; avatar GIFs are served unchanged.
  return <img className={avatar ? styles.avatarPhoto : styles.photo} src={url} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(url)} />;
}

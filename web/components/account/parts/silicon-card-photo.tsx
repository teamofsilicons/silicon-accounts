"use client";

/** The card picture: a live generated avatar, a recovered older PNG, or an ordinary photo. */
import { useSyncExternalStore } from "react";
import type { SiliconPhotoAsset } from "@/lib/silicon-photo-asset";
import styles from "./silicon-card.module.css";

const MOTION = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (change: () => void) => {
  const media = window.matchMedia(MOTION);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
};

export function SiliconCardPhoto({ src, asset }: { src: string; asset: SiliconPhotoAsset | null }) {
  const reducedMotion = useSyncExternalStore(subscribeMotion, () => window.matchMedia(MOTION).matches, () => true);
  // Wait for a service upload to be classified, so an old opaque avatar does not flash full-bleed.
  if (!asset && (/\/v1\/photos\/[0-9a-f-]{36}$/.test(src) || src.startsWith("data:image/"))) return null;
  const chosen = asset ?? { kind: "photo" as const, src };
  const avatar = chosen.kind === "avatar";
  const url = avatar && reducedMotion ? chosen.poster : chosen.src;
  // eslint-disable-next-line @next/next/no-img-element -- photos may come from any https address; avatar GIFs are served unchanged.
  return <img className={avatar ? styles.avatarPhoto : styles.photo} src={url} alt="" decoding="async" referrerPolicy="no-referrer" />;
}

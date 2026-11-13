"use client";

/**
 * A Silicon's mark: its pixel avatar (lib/silicon-avatar.ts, Anil 2026-11-12: every Silicon gets one, drawn from its
 * uuid so it never changes) on a rounded square washed in the avatar's own palette. `pending` adds the dashed outline
 * of a Silicon still waiting for its custodian. Pass the Silicon's `photo` (its pfp_url) and the mark draws its picture
 * (lib/silicon-picture.ts): the look its Carbon made, else its default avatar, or the photo it was given.
 *
 * Until 2026-11-12 the mark was the prototype's: the Silicon's gradient (one of four pairs) with a white spark. It stays
 * as SiliconSparkMark, for the labs' record.
 */
import { useState, type CSSProperties } from "react";
import { Sparkle } from "lucide-react";
import { siliconAvatarDataUrl, siliconChoiceFromSeed, siliconPalette } from "@/lib/silicon-avatar";
import { useSiliconPicture } from "@/lib/silicon-picture";
import styles from "./parts.module.css";

const PAIRS = 4;

/** Which of the four Silicon colour pairs a Silicon wears (1 to 4), from its uuid, so it never changes. */
export function pairOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % PAIRS) + 1;
}

export function SiliconMark({ seed, photo, size = 32, pending, className }: { seed: string; photo?: string | null; size?: number; pending?: boolean; className?: string }) {
  const picture = useSiliconPicture({ uuid: seed, pfp_url: photo });
  // A photo that can't be loaded (a dead link, a blocked host) falls back to the Silicon's own avatar.
  const [failed, setFailed] = useState<string | null>(null);
  if (picture.kind === "photo" && failed !== picture.src) {
    return (
      <span className={[styles.siliconMark, styles.siliconPhoto, className].filter(Boolean).join(" ")} style={{ "--mark-size": `${size}px` } as CSSProperties} data-pending={pending ? "" : undefined} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element -- the Silicon's own photo, any https address. */}
        <img src={picture.src} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(picture.src)} />
      </span>
    );
  }
  const choice = picture.kind === "avatar" ? picture.choice : siliconChoiceFromSeed(seed);
  const colours = siliconPalette(choice);
  const style = { "--mark-size": `${size}px`, "--mark-from": colours[0], "--mark-to": colours[colours.length - 1] } as CSSProperties;
  return (
    <span className={[styles.siliconMark, styles.siliconAvatar, className].filter(Boolean).join(" ")} style={style} data-pending={pending ? "" : undefined} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- a generated SVG data URL, shown as is. */}
      <img src={siliconAvatarDataUrl(choice, { crop: true })} alt="" decoding="async" />
    </span>
  );
}

/** The prototype's mark (until 2026-11-12): the Silicon's gradient pair with a white spark. */
export function SiliconSparkMark({ seed, size = 32, pending, className }: { seed: string; size?: number; pending?: boolean; className?: string }) {
  const pair = pairOf(seed);
  const style = { "--mark-size": `${size}px`, "--mark-from": `var(--silicon-mark-${pair}-from)`, "--mark-to": `var(--silicon-mark-${pair}-to)` } as CSSProperties;
  return (
    <span className={[styles.siliconMark, className].filter(Boolean).join(" ")} style={style} data-pending={pending ? "" : undefined} aria-hidden="true">
      <Sparkle fill="currentColor" strokeWidth={1} />
    </span>
  );
}

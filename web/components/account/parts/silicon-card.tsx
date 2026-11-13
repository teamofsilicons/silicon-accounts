"use client";

/**
 * A Silicon's card (Anil, 2026-11-12; the bottom made short 2026-11-13): its pixel avatar (lib/silicon-avatar.ts) in a
 * 3:2 art area over a short strip with its name and si:id, the two blended into one card. Four ways to blend, compared in /__silicon-cards:
 *
 *   wash    The top is a soft wash of the avatar's own palette, fading into the card's white where the words begin.
 *   glow    The card is white; a light of the avatar's colours glows behind it and dies away before the words.
 *   pixels  The wash, plus faint pixels of the avatar's colours scattered around it, thinning out towards the words.
 *   tint    The whole card wears the palette's lightest tint; no seam at all between picture and words.
 */
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, type BadgeTone } from "@teamofsilicons/silicon-ui/badge";
import type { CSSProperties } from "react";
import { siliconChoiceFromSeed, siliconPalette, type SiliconAvatarChoice } from "@/lib/silicon-avatar";
import { siliconPhotoAsset, type SiliconPhotoAsset } from "@/lib/silicon-photo-asset";
import { useSiliconPicture } from "@/lib/silicon-picture";
import { SiliconAvatar, type SiliconMotion } from "./silicon-avatar";
import { SiliconCardPhoto } from "./silicon-card-photo";
import styles from "./silicon-card.module.css";

export type SiliconCardBlend = "wash" | "glow" | "pixels" | "tint";

/** Faint pixels in the avatar's colours, thinning out from the top, for the "pixels" blend. */
function scatter(choice: SiliconAvatarChoice, colours: string[]): string {
  const columns = 24, rows = 15;
  let state = choice.seed * 9301;
  const rnd = () => { state = (state * 9301 + 49297) % 233280; return state / 233280; };
  let rects = "";
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
    const chance = 0.2 * (1 - r / rows);
    if (rnd() < chance) rects += `<rect x="${c}" y="${r}" width="1" height="1" fill="${colours[Math.floor(rnd() * colours.length)]}" fill-opacity="${(0.12 + 0.18 * rnd() * (1 - r / rows)).toFixed(2)}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${columns} ${rows}" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges">${rects}</svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

/**
 * `animate` (on by default): the avatar is alive (silicon-avatar.tsx); off draws it still. `status`: a badge beside
 * the name for a state worth noticing (Handing over, Waiting for a custodian; Active, the normal case, shows none). `detail`: one more line under the
 * si:id ("Key made 4 days ago").
 */
export function SiliconCard({ uuid, name, id, href, blend = "wash", choice: given, photo, animate = true, motion = "alive", status, detail }: { uuid: string; name: string; id?: string | null; href: string; blend?: SiliconCardBlend; choice?: SiliconAvatarChoice; photo?: string | null; animate?: boolean; motion?: SiliconMotion | "hover"; status?: { tone: BadgeTone; text: string }; detail?: ReactNode }) {
  // "hover": still until the card is pointed at or focused, then alive (/__silicon-motion).
  const [hovered, setHovered] = useState(false);
  const moving = animate && (motion !== "hover" || hovered);
  // The Silicon's picture (lib/silicon-picture.ts): the look its Carbon made, its default avatar, or its own photo.
  const picture = useSiliconPicture({ uuid, pfp_url: photo });
  const photoSrc = picture.kind === "photo" && !given ? picture.src : null;
  const [resolvedPhoto, setResolvedPhoto] = useState<{ source: string; asset: SiliconPhotoAsset } | null>(null);
  useEffect(() => {
    if (!photoSrc) return;
    let active = true;
    void siliconPhotoAsset(photoSrc).then(asset => { if (active) setResolvedPhoto({ source: photoSrc, asset }); });
    return () => { active = false; };
  }, [photoSrc]);
  const photoAsset = resolvedPhoto?.source === photoSrc ? resolvedPhoto.asset : null;
  const choice = given ?? (picture.kind === "avatar" ? picture.choice : null) ?? siliconChoiceFromSeed(uuid);
  // An uploaded avatar's wash comes from its actual pixels, not a new look guessed from its uuid.
  const colours = photoSrc ? (photoAsset?.kind === "avatar" ? photoAsset.colours ?? (photoAsset.choice ? siliconPalette(photoAsset.choice) : siliconPalette(choice)) : ["var(--surface)"]) : siliconPalette(choice);
  const style = {
    "--avatar-1": colours[0],
    "--avatar-2": colours[Math.floor(colours.length / 2)],
    "--avatar-3": colours[colours.length - 1],
    ...(blend === "pixels" ? { "--avatar-scatter": scatter(choice, colours) } : {}),
  } as CSSProperties;
  return (
    <Link href={href} data-sq="clip" className={styles.card} data-blend={blend} style={style} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onFocus={() => setHovered(true)} onBlur={() => setHovered(false)}>
      <span className={styles.art} aria-hidden="true">
        {picture.kind === "photo" && !given && photoAsset?.kind === "avatar" && photoAsset.choice ? (
          // An avatar saved as a GIF carries its look: draw it live and moving, as in the browser that made it.
          <SiliconAvatar seed={uuid} choice={photoAsset.choice} animate={moving} motion={motion === "hover" ? "alive" : motion} className={styles.avatar} />
        ) : picture.kind === "photo" && !given ? (
          <SiliconCardPhoto src={picture.src} asset={photoAsset} fallback={<SiliconAvatar seed={uuid} choice={choice} animate={moving} motion={motion === "hover" ? "alive" : motion} className={styles.avatar} />} />
        ) : (
          <SiliconAvatar seed={uuid} choice={choice} animate={moving} motion={motion === "hover" ? "alive" : motion} className={styles.avatar} />
        )}
      </span>
      <span className={styles.words}>
        {/* A state worth noticing sits beside the name; "Active", the normal case, isn't shown (Anil, 2026-11-13). */}
        <span className={styles.nameRow}>
          <span className={styles.name}>{name}</span>
          {status && status.tone !== "success" ? <Badge size="sm" tone={status.tone}>{status.text}</Badge> : null}
        </span>
        {id ? <span className={styles.id}>{id}</span> : null}
        {detail ? <span className={styles.detail}>{detail}</span> : null}
      </span>
    </Link>
  );
}

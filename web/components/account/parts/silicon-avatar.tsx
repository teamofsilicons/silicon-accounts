"use client";

/**
 * A Silicon's pixel avatar (lib/silicon-avatar.ts) drawn in place, alive at large sizes (Anil, 2026-11-13: "add
 * motion"), as a Carbon's avatar is (foundation/avatar/pixel-avatar.tsx). With `animate`:
 *
 *   - the mosaic shimmers: each pixel's lightness swings gently around its own grain;
 *   - the eyes glance to one side and back every few seconds, and blink now and then;
 *   - the halo pixels around it twinkle, a few at a time.
 * No up-and-down motion (Anil, 2026-11-13).
 *
 * Reduced motion keeps it still; so does a page that isn't visible. Small marks use the still picture (SiliconMark).
 * The square is cropped to the creature and its halo (siliconAvatarBox), the same in every frame.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { siliconAvatarBox, siliconAvatarCells, siliconChoiceFromSeed, type SiliconAvatarChoice, type SiliconAvatarFrame } from "@/lib/silicon-avatar";
import styles from "./silicon-avatar.module.css";

const REDUCE = "(prefers-reduced-motion: reduce)";
const subscribeReduce = (change: () => void) => {
  const media = window.matchMedia(REDUCE);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
};

export function SiliconAvatar({ seed, choice: given, animate = false, label, className, style }: { seed: string; choice?: SiliconAvatarChoice; animate?: boolean; label?: string; className?: string; style?: CSSProperties }) {
  const choice = useMemo(() => given ?? siliconChoiceFromSeed(seed), [given, seed]);
  const box = useMemo(() => siliconAvatarBox(choice), [choice]);
  const reduce = useSyncExternalStore(subscribeReduce, () => window.matchMedia(REDUCE).matches, () => true);
  const moving = animate && !reduce;
  const [frame, setFrame] = useState<SiliconAvatarFrame>({});

  useEffect(() => {
    if (!moving) return;
    let phase = 0;
    let twinkle = 0;
    const shimmer = window.setInterval(() => {
      if (document.hidden) return;
      phase += 0.45;
      twinkle += 1;
      setFrame(current => ({ ...current, phase, twinkle: Math.floor(twinkle / 3) }));
    }, 420);
    // A glance to one side, held, then back to its own look.
    let glance: number | undefined;
    const scheduleGlance = () => {
      glance = window.setTimeout(() => {
        setFrame(current => ({ ...current, look: Math.random() < 0.5 ? "left" : "right" }));
        glance = window.setTimeout(() => { setFrame(current => ({ ...current, look: undefined })); scheduleGlance(); }, 1400);
      }, 2600 + Math.random() * 2600);
    };
    let blink: number | undefined;
    const scheduleBlink = () => {
      blink = window.setTimeout(() => {
        setFrame(current => ({ ...current, blinking: true }));
        blink = window.setTimeout(() => { setFrame(current => ({ ...current, blinking: false })); scheduleBlink(); }, 150);
      }, 2400 + Math.random() * 3600);
    };
    scheduleGlance();
    scheduleBlink();
    return () => { window.clearInterval(shimmer); window.clearTimeout(glance); window.clearTimeout(blink); setFrame({}); };
  }, [moving]);

  const cells = siliconAvatarCells(choice, moving ? frame : {});
  return (
    <span className={[styles.avatar, className].filter(Boolean).join(" ")} style={style} data-moving={moving || undefined} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
      <svg viewBox={`${box.x} ${box.y} ${box.size} ${box.size}`} shapeRendering="crispEdges" aria-hidden="true">
        <g>
          {cells.map(cell => <rect key={`${cell.r},${cell.c}`} x={cell.c} y={cell.r} width={1.02} height={1.02} fill={cell.color} className={cell.kind === "halo" ? styles.halo : undefined} />)}
        </g>
      </svg>
    </span>
  );
}

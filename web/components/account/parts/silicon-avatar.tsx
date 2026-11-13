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
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { siliconAvatarBox, siliconAvatarCells, siliconChoiceFromSeed, type SiliconAvatarChoice, type SiliconAvatarFrame } from "@/lib/silicon-avatar";
import { mediaMatches, subscribeMedia } from "@/lib/media-query";
import styles from "./silicon-avatar.module.css";

const REDUCE = "(prefers-reduced-motion: reduce)";
const subscribeReduce = (change: () => void) => subscribeMedia(REDUCE, change);

/**
 * How it moves (Anil, 2026-11-13: experiments, compared in /__silicon-motion; never up and down; the cards keep alive):
 *   alive    the shimmer, a glance now and then, blinks and a twinkling halo (the default);
 *   wave     the palette flows slowly through the body, and it blinks;
 *   sparkle  a few pixels glint white now and then, and it blinks;
 *   watch    its eyes follow the pointer across the page, and it blinks;
 *   glow     its halo swells to a full ring and settles, and it blinks slowly.
 */
export type SiliconMotion = "alive" | "wave" | "sparkle" | "watch" | "glow";

export function SiliconAvatar({ seed, choice: given, animate = false, motion = "alive", label, className, style }: { seed: string; choice?: SiliconAvatarChoice; animate?: boolean; motion?: SiliconMotion; label?: string; className?: string; style?: CSSProperties }) {
  const element = useRef<HTMLSpanElement>(null);
  const choice = useMemo(() => given ?? siliconChoiceFromSeed(seed), [given, seed]);
  const box = useMemo(() => siliconAvatarBox(choice), [choice]);
  const reduce = useSyncExternalStore(subscribeReduce, () => mediaMatches(REDUCE), () => true);
  // Only while it's on screen (and the page is visible): a long list of Silicons doesn't spend frames on the unseen.
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const node = element.current;
    if (!animate || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { rootMargin: "64px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [animate]);
  const moving = animate && !reduce && onScreen;
  const [frame, setFrame] = useState<SiliconAvatarFrame>({});

  useEffect(() => {
    if (!moving) return;
    const timers: number[] = [];
    const every = (ms: number, run: () => void) => timers.push(window.setInterval(() => { if (!document.hidden) run(); }, ms));
    // Blinks for every style (slower for glow).
    let blink: number | undefined;
    const scheduleBlink = (slow: boolean) => {
      blink = window.setTimeout(() => {
        setFrame(current => ({ ...current, blinking: true }));
        blink = window.setTimeout(() => { setFrame(current => ({ ...current, blinking: false })); scheduleBlink(slow); }, 150);
      }, (slow ? 4200 : 2400) + Math.random() * 3600);
    };
    scheduleBlink(motion === "glow");
    let glance: number | undefined;
    let stopPointer: (() => void) | undefined;

    if (motion === "alive") {
      let phase = 0, twinkle = 0;
      every(420, () => { phase += 0.45; twinkle += 1; setFrame(current => ({ ...current, phase, twinkle: Math.floor(twinkle / 3) })); });
      const scheduleGlance = () => {
        glance = window.setTimeout(() => {
          setFrame(current => ({ ...current, look: Math.random() < 0.5 ? "left" : "right" }));
          glance = window.setTimeout(() => { setFrame(current => ({ ...current, look: undefined })); scheduleGlance(); }, 1400);
        }, 2600 + Math.random() * 2600);
      };
      scheduleGlance();
    } else if (motion === "wave") {
      let shift = 0;
      every(140, () => { shift = (shift + 0.035) % 2; setFrame(current => ({ ...current, shift: shift || 0.0001 })); });
    } else if (motion === "sparkle") {
      let n = 0;
      every(650, () => { n += 1; setFrame(current => ({ ...current, sparkle: n % 3 === 0 ? undefined : n })); });
    } else if (motion === "glow") {
      let t = 0;
      every(160, () => { t += 0.12; setFrame(current => ({ ...current, glow: 0.3 + (Math.sin(t) + 1) * 0.85, twinkle: 0 })); });
    } else if (motion === "watch") {
      const onMove = (event: PointerEvent) => {
        const box = element.current?.getBoundingClientRect();
        if (!box) return;
        const dx = event.clientX - (box.left + box.width / 2);
        const look = Math.abs(dx) < box.width * 0.15 ? undefined : dx < 0 ? "left" : "right";
        setFrame(current => (current.look === look ? current : { ...current, look }));
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      stopPointer = () => window.removeEventListener("pointermove", onMove);
    }
    return () => { timers.forEach(timer => window.clearInterval(timer)); window.clearTimeout(blink); window.clearTimeout(glance); stopPointer?.(); setFrame({}); };
  }, [moving, motion]);

  const cells = siliconAvatarCells(choice, moving ? frame : {});
  return (
    <span ref={element} className={[styles.avatar, className].filter(Boolean).join(" ")} style={style} data-moving={moving || undefined} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
      <svg viewBox={`${box.x} ${box.y} ${box.size} ${box.size}`} shapeRendering="crispEdges" aria-hidden="true">
        <g>
          {cells.map(cell => <rect key={`${cell.r},${cell.c}`} x={cell.c} y={cell.r} width={1.02} height={1.02} fill={cell.color} className={cell.kind === "halo" ? styles.halo : undefined} />)}
        </g>
      </svg>
    </span>
  );
}

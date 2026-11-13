"use client";

/**
 * A Carbon's pixel avatar (lib/pixel-avatar.ts) drawn in place. With `animate` (large avatars only: the greeting, the
 * photo editor) the hair shimmers, the eyes look from side to side and blink now and then; reduced motion keeps it
 * still. Small avatars use the still picture through Silicon UI's Avatar (`avatarDataUrl`).
 */
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { AVATAR_FRAME, AVATAR_VIEWBOX, avatarCells, type AvatarChoice } from "@/lib/pixel-avatar";
import styles from "./pixel-avatar.module.css";

const REDUCE = "(prefers-reduced-motion: reduce)";
const subscribeReduce = (change: () => void) => {
  const media = window.matchMedia(REDUCE);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
};

export interface PixelAvatarProps {
  choice: AvatarChoice;
  /** Pixel size of the round picture. */
  size: number;
  /** Shimmer, look and blink (large avatars only). */
  animate?: boolean;
  /** The accessible name, such as the person's name; without it the picture is decorative. */
  label?: string;
  className?: string;
}

export function PixelAvatar({ choice, size, animate = false, label, className }: PixelAvatarProps) {
  const reduce = useSyncExternalStore(subscribeReduce, () => window.matchMedia(REDUCE).matches, () => true);
  const moving = animate && !reduce;
  const [phase, setPhase] = useState(0);
  const [lookRight, setLookRight] = useState(false);
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (!moving) return;
    const shimmer = window.setInterval(() => setPhase(value => value + 0.35), 550);
    const look = window.setInterval(() => setLookRight(value => !value), 3000);
    let blink: number | undefined;
    const scheduleBlink = () => {
      blink = window.setTimeout(() => {
        setBlinking(true);
        blink = window.setTimeout(() => { setBlinking(false); scheduleBlink(); }, 160);
      }, 2800 + Math.random() * 3200);
    };
    scheduleBlink();
    return () => { window.clearInterval(shimmer); window.clearInterval(look); window.clearTimeout(blink); };
  }, [moving]);

  const cells = avatarCells(choice, moving ? { phase, lookRight, blinking } : {});
  return (
    <span className={[styles.avatar, className].filter(Boolean).join(" ")} style={{ "--avatar-size": `${size}px` } as CSSProperties} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
      <svg viewBox={AVATAR_VIEWBOX} shapeRendering="crispEdges" aria-hidden="true">
        <rect x={AVATAR_FRAME.left} y={AVATAR_FRAME.top} width={AVATAR_FRAME.size} height={AVATAR_FRAME.size} fill="hsl(0, 0%, 95%)" />
        {cells.map((cell, index) => <rect key={index} x={cell.c} y={cell.r} width={1.02} height={1.02} fill={cell.color} fillOpacity={cell.opacity} />)}
      </svg>
    </span>
  );
}

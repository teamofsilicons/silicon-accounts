"use client";

/**
 * The sign-in card's morph (the Arc sign-in block's step motion, without its chrome: BrandPanel is the card here). A
 * new step slides in from the side it comes from and unblurs while the old one leaves the other way; the card's
 * height springs between them. Reduced motion crossfades in place.
 *
 * The leaving step keeps rendering what it showed (AnimatePresence holds its last element, props included) and is
 * inert while it leaves, so nothing on it can be pressed twice.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useReducedMotion, type AnimationPlaybackControls, type Variants } from "motion/react";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import styles from "./flow.module.css";

const { blur, duration, ease, spring } = motionTokens;

interface Custom {
  direction: number;
  reduce: boolean;
}

const stepMotion: Variants = {
  enter: ({ direction, reduce }: Custom) => (reduce ? { opacity: 0 } : { opacity: 0, x: direction * 28, filter: `blur(${blur.soft}px)` }),
  center: ({ reduce }: Custom) => ({
    opacity: 1,
    x: 0,
    filter: "blur(0px)",
    transitionEnd: { filter: "none" },
    transition: reduce
      ? { duration: duration.instant }
      : { x: spring.smooth, opacity: { duration: duration.standard, ease: [...ease.enter], delay: 0.05 }, filter: { duration: duration.standard, ease: [...ease.enter] } },
  }),
  exit: ({ direction, reduce }: Custom) =>
    reduce
      ? { opacity: 0, transition: { duration: 0 } }
      : { opacity: 0, x: direction * -20, filter: `blur(${blur.soft}px)`, transition: { x: spring.smooth, opacity: { duration: duration.exit, ease: [...ease.standard] }, filter: { duration: duration.exit } } },
};

/**
 * Follows its content's height. When `morphKey` changes, the frame is pinned at the height it had (before the new
 * step paints) and springs to the new one, then returns to auto, so later reflows (an alert opening, a font swap)
 * follow at once. It clips only while moving.
 *
 * Nothing is written to the page from inside the ResizeObserver callback: frames nest (the requirements step morphs
 * inside the card), and a write there would resize an outer frame in the same delivery, which browsers report as a
 * "ResizeObserver loop" error. The pin happens in a layout effect, and the spring writes on animation frames.
 */
export function HeightFrame({ morphKey, className, contentClassName, children }: { morphKey: string; className?: string; contentClassName?: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  /** The content's last measured height (the old step's, when the key changes). */
  const measured = useRef<number | undefined>(undefined);
  /** True from a key change until the spring settles. */
  const pinned = useRef(false);
  const changedAt = useRef(0);
  const firstKey = useRef(morphKey);
  const controls = useRef<AnimationPlaybackControls | undefined>(undefined);

  useLayoutEffect(() => {
    if (firstKey.current === morphKey) return;
    firstKey.current = morphKey;
    const node = frame.current;
    const from = measured.current;
    if (!node || reduce || from === undefined) return;
    // Pin the old height before this frame paints; the observer then springs it to the new one.
    controls.current?.stop();
    controls.current = undefined;
    pinned.current = true;
    changedAt.current = performance.now();
    height.jump(from);
    Object.assign(node.style, { overflow: "hidden", height: `${from}px` });
    // A new step exactly as tall as the old one never resizes the content, so nothing would release the pin.
    const release = window.setTimeout(() => {
      if (!pinned.current || controls.current) return;
      pinned.current = false;
      height.jump("auto");
      Object.assign(node.style, { overflow: "", height: "auto" });
    }, 300);
    return () => window.clearTimeout(release);
  }, [morphKey, reduce, height]);

  useEffect(() => {
    const node = content.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let frameRequest = 0;
    const settle = () => {
      pinned.current = false;
      controls.current = undefined;
      height.jump("auto");
      if (frame.current) Object.assign(frame.current.style, { overflow: "", height: "auto" });
    };
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight;
      measured.current = next;
      if (!pinned.current) return;
      const current = height.get();
      const from = typeof current === "number" ? current : next;
      controls.current?.stop();
      // Long after the change (or nothing to travel): let the frame follow on its own again.
      if (Math.abs(from - next) < 1 || performance.now() - changedAt.current > 600) {
        cancelAnimationFrame(frameRequest);
        frameRequest = requestAnimationFrame(settle);
        return;
      }
      controls.current = animate(height, [from, next], { ...spring.smooth, onComplete: settle });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameRequest);
      controls.current?.stop();
    };
  }, [height]);

  return (
    <motion.div ref={frame} className={className} style={{ height }}>
      <div ref={content} className={contentClassName}>{children}</div>
    </motion.div>
  );
}

/** One step; `ref` reaches the element so AnimatePresence can pop a leaving step out of the flow. */
function Step({ custom, children, ref }: { custom: Custom; children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  return (
    <motion.div ref={ref} className={styles.step} custom={custom} variants={stepMotion} initial="enter" animate="center" exit="exit" inert={!present || undefined} aria-hidden={!present || undefined} data-step-leaving={!present || undefined}>
      {children}
    </motion.div>
  );
}

export interface StepMorphProps {
  /** The view to show; a new key morphs the card. */
  view: string;
  /**
   * Keys in their usual order (a sub-view "step:detail" sorts just after its step, and numbered ones such as
   * "details:0", "details:1" in their number's order), to tell forward from back.
   */
  order: readonly string[];
  children: (view: string) => ReactNode;
  className?: string;
}

export function StepMorph({ view, order, children, className }: StepMorphProps) {
  const reduce = !!useReducedMotion();
  const rank = (key: string) => {
    const [base = key, sub] = key.split(":");
    const index = order.indexOf(base);
    if (index < 0) return order.length;
    if (sub === undefined) return index;
    const number = /^\d+$/.test(sub) ? Number(sub) : 0;
    return index + 0.5 + Math.min(number, 400) / 1000;
  };
  const [last, setLast] = useState({ view, direction: 1 });
  if (last.view !== view) setLast({ view, direction: Math.sign(rank(view) - rank(last.view)) || 1 });
  const custom: Custom = { direction: last.direction, reduce };
  return (
    <HeightFrame morphKey={view} className={[styles.morph, className].filter(Boolean).join(" ")} contentClassName={styles.track}>
      <AnimatePresence mode="popLayout" initial={false} custom={custom}>
        <Step key={view} custom={custom}>{children(view)}</Step>
      </AnimatePresence>
    </HeightFrame>
  );
}

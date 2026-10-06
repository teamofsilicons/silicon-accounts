"use client";

/**
 * Follows its content's height. After `morphKey` changes (a button that turns into a form, a form that turns into a
 * waiting card), the height springs from the old size to the new one while the new content rises in; then it returns
 * to auto, so passive reflows (a resize, a font swap, an error line) follow at once. It clips only while it moves, so
 * nothing is cut off at rest. Reduced motion: no height animation, a quick fade.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotion, type AnimationPlaybackControls } from "motion/react";
import { motionTokens } from "@/components/arc/lib/motion-tokens";

const enter = [...motionTokens.ease.enter] as [number, number, number, number];

export function HeightFrame({ morphKey, className, children }: { morphKey: string; className?: string; children: ReactNode }) {
  const reduce = useReducedMotion() ?? false;
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  const changedAt = useRef(0);
  // Content shown on mount appears as it is; content that replaces it rises in.
  const [seen, setSeen] = useState({ key: morphKey, changed: false });
  if (seen.key !== morphKey) setSeen({ key: morphKey, changed: true });
  useLayoutEffect(() => {
    if (seen.changed) changedAt.current = performance.now();
  }, [seen]);
  useEffect(() => {
    const node = content.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let last: number | undefined;
    let controls: AnimationPlaybackControls | undefined;
    const settle = () => {
      height.jump("auto");
      if (frame.current) Object.assign(frame.current.style, { overflow: "", height: "auto" });
    };
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight;
      const current = height.get();
      const from = typeof current === "number" ? current : last;
      last = next;
      controls?.stop();
      if (reduce || from === undefined || from === next || performance.now() - changedAt.current > 160) return settle();
      // Pin the old height before this frame paints, then spring to the new one.
      if (frame.current) Object.assign(frame.current.style, { overflow: "hidden", height: `${from}px` });
      controls = animate(height, [from, next], { ...motionTokens.spring.smooth, onComplete: settle });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      controls?.stop();
    };
  }, [height, reduce]);
  return (
    <motion.div ref={frame} className={className} style={{ height, minWidth: 0 }}>
      <div ref={content} style={{ minWidth: 0 }}>
        <motion.div
          key={morphKey}
          style={{ minWidth: 0 }}
          initial={seen.changed ? (reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.subtle}px)` }) : false}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }}
          transition={reduce ? { duration: motionTokens.duration.instant } : { duration: motionTokens.duration.standard, ease: enter }}
        >
          {children}
        </motion.div>
      </div>
    </motion.div>
  );
}

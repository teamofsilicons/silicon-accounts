"use client";

/**
 * Keyed lists whose items animate in and out, so a removed email, a revoked session or an app whose access was removed
 * closes its gap instead of snapping:
 *  - "list" (default): rows open and fold (height and opacity on the smooth spring);
 *  - "grid": cards fade and scale away, then the cards after them glide into place (layout animation).
 * Items present on the first render appear as they are. Reduced motion: items appear and disappear at once.
 * A leaving item is inert and marked `data-leaving`, so focus handoffs (parts/focus.ts) skip it.
 */
import type { ReactNode, Ref } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { motionTokens } from "@/components/arc/lib/motion-tokens";

export interface AnimatedRowsProps<T> {
  items: T[];
  keyOf: (item: T) => string;
  children: (item: T) => ReactNode;
  className?: string;
  /** "list" folds rows; "grid" fades cards and glides the rest into place. */
  layout?: "list" | "grid";
  label?: string;
}

const enterEase = [...motionTokens.ease.enter] as [number, number, number, number];
const exitEase = [...motionTokens.ease.exit] as [number, number, number, number];

function Row({ id, layout, reduced, children, ref }: { id: string; layout: "list" | "grid"; reduced: boolean; children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  // AnimatePresence's popLayout measures the leaving card through this ref.
  const common = { ref, role: "listitem", "data-key": id, "data-leaving": present ? undefined : "", inert: !present || undefined } as const;
  if (reduced) {
    return <motion.div {...common} initial={false} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0 } }}>{children}</motion.div>;
  }
  if (layout === "grid") {
    return (
      <motion.div
        {...common}
        layout="position"
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96, transition: { duration: motionTokens.duration.exit, ease: exitEase } }}
        transition={{ layout: motionTokens.spring.smooth, scale: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: enterEase } }}
      >
        {children}
      </motion.div>
    );
  }
  return (
    <motion.div
      {...common}
      style={{ overflow: "clip" }}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
      exit={{ height: 0, opacity: 0, overflow: "clip", transition: { height: { ...motionTokens.spring.smooth, visualDuration: 0.32 }, opacity: { duration: motionTokens.duration.fast } } }}
      transition={{ height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: enterEase } }}
    >
      {children}
    </motion.div>
  );
}

export function AnimatedRows<T>({ items, keyOf, children, className, layout = "list", label }: AnimatedRowsProps<T>) {
  const reduced = useReducedMotion() ?? false;
  return (
    <div className={className} role="list" aria-label={label}>
      <AnimatePresence initial={false} mode={layout === "grid" && !reduced ? "popLayout" : "sync"}>
        {items.map(item => {
          const id = keyOf(item);
          return <Row key={id} id={id} layout={layout} reduced={reduced}>{children(item)}</Row>;
        })}
      </AnimatePresence>
    </div>
  );
}

/**
 * FLIP for lists (Arc's layout="position"): capture where items sit, change the DOM, then glide each item from its
 * old place to the new one. Positions include any transform still in flight, so quick changes retarget smoothly.
 */
import { animate, prefersReducedMotion, spring, type AnimateOptions } from "./motion";

export interface Flip {
  /** Record current positions. Call right before the change. */
  capture(): void;
  /** Animate items from their captured positions. Call after the DOM has updated (it waits a microtask itself). */
  play(transition?: AnimateOptions): void;
}

function translation(el: HTMLElement): { x: number; y: number } {
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === "none") return { x: 0, y: 0 };
  const matrix = new DOMMatrixReadOnly(transform);
  return { x: matrix.m41, y: matrix.m42 };
}

export function createFlip(container: () => HTMLElement | undefined, selector: string, keyOf: (el: HTMLElement) => string | null): Flip {
  let snapshot = new Map<string, { x: number; y: number }>();
  return {
    capture() {
      snapshot = new Map();
      const root = container();
      if (!root) return;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
        const key = keyOf(el);
        if (key === null) continue;
        const moving = translation(el);
        snapshot.set(key, { x: el.offsetLeft + moving.x, y: el.offsetTop + moving.y });
      }
    },
    play(transition = spring.morph) {
      const before = snapshot;
      queueMicrotask(() => {
        const root = container();
        if (!root || prefersReducedMotion()) return;
        for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
          const key = keyOf(el);
          const old = key === null ? undefined : before.get(key);
          if (!old || el.style.position === "absolute") continue;
          const dx = old.x - el.offsetLeft;
          const dy = old.y - el.offsetTop;
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
          animate(el, { x: [dx, 0], y: [dy, 0] }, transition);
        }
      });
    },
  };
}

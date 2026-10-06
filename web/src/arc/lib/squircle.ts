/**
 * Squircles for Solid components: `ref={el => useSquircle(el)}` or `ref={squircle({ mode: "clip" })}`. The engine
 * (native corner-shape or the SVG-path fallback) and the styling contract live in squircle-core.ts.
 */
import { onCleanup } from "solid-js";
import { attachSquircle, type SquircleOptions } from "./squircle-core";

export * from "./squircle-core";

/** Solid helper: attaches a squircle for the lifetime of the current owner. Use as `ref={el => useSquircle(el)}`. */
export function useSquircle(el: HTMLElement, options?: SquircleOptions): void {
  const dispose = attachSquircle(el, options);
  onCleanup(dispose);
}

/** Ref factory: `<div ref={squircle()} />` or `<img ref={squircle({ mode: "clip" })} />`. */
export function squircle(options?: SquircleOptions): (el: HTMLElement) => void {
  return el => useSquircle(el, options);
}

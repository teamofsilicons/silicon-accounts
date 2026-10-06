import { createEffect, on, onCleanup, onMount, type JSX } from "solid-js";
import { animate, prefersReducedMotion, spring, type AnimationControls } from "./motion";

/**
 * Follows its content height. Shortly after `morphKey` changes, the height springs from the old size to the new one,
 * then returns to auto, so passive reflows (a resize, a font swap) follow instantly. It clips only while moving.
 */
export function HeightFrame(props: { morphKey: string; class?: string; contentClass?: string; children: JSX.Element; "aria-busy"?: boolean }) {
  let frame: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  let changedAt = 0;
  createEffect(on(() => props.morphKey, () => { changedAt = performance.now(); }, { defer: true }));
  onMount(() => {
    const node = content;
    if (!node || !frame || typeof ResizeObserver === "undefined") return;
    let last: number | undefined;
    let controls: AnimationControls | undefined;
    let current: number | undefined;
    const settle = () => {
      current = undefined;
      if (frame) Object.assign(frame.style, { overflow: "", height: "" });
    };
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight;
      const from = current ?? last;
      last = next;
      controls?.stop();
      if (prefersReducedMotion() || from === undefined || from === next || performance.now() - changedAt > 120) return settle();
      if (!frame) return;
      Object.assign(frame.style, { overflow: "hidden", height: `${from}px` });
      controls = animate(from, next, {
        ...spring.smooth,
        onUpdate: value => { current = value; if (frame) frame.style.height = `${value}px`; },
        onComplete: settle,
      });
    });
    observer.observe(node);
    onCleanup(() => { observer.disconnect(); controls?.stop(); });
  });
  return (
    <div ref={frame} class={props.class} aria-busy={props["aria-busy"]}>
      <div ref={content} class={props.contentClass} style={{ position: "relative", display: "flow-root" }}>{props.children}</div>
    </div>
  );
}

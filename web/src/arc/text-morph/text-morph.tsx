import { Dynamic } from "solid-js/web";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { MorphText } from "../lib/presence";
import { animate, prefersReducedMotion, spring, type AnimationControls } from "../lib/motion";
import styles from "./text-morph.module.css";

export interface TextMorphProps {
  /** The current label. Short status words that change a few letters at a time work best (Follow, Following). */
  children: string;
  as?: "span" | "div" | "p" | "strong" | "h1" | "h2" | "h3";
  class?: string;
  id?: string;
}

/**
 * Arc TextMorph: letters both strings share glide to their new positions, new letters sharpen in, removed letters blur
 * away, and the width follows on a spring so the surrounding layout glides instead of jumping. Assistive tech reads the
 * plain text. Use it for changing ids, statuses and labels.
 */
export function TextMorph(props: TextMorphProps) {
  let frame: HTMLSpanElement | undefined;
  let track: HTMLSpanElement | undefined;
  let width = 0;
  let sizing: AnimationControls | undefined;
  const measure = (el: HTMLElement) => parseFloat(getComputedStyle(el).width);

  // The frame holds an explicit width so a new label never snaps it; the spring follows the track.
  createEffect(on(() => props.children, () => {
    queueMicrotask(() => {
      if (!frame || !track) return;
      const next = measure(track);
      if (!Number.isFinite(next)) return;
      if (width && Math.abs(next - width) > 0.5 && !prefersReducedMotion()) {
        sizing?.stop();
        sizing = animate(frame, { width: `${next}px` }, spring.morph);
      } else {
        sizing?.stop();
        frame.style.width = `${next}px`;
      }
      width = next;
    });
  }));

  onMount(() => {
    if (!frame || !track || typeof ResizeObserver === "undefined") return;
    // Font loading or a responsive font size changes the width without a new label: follow it immediately.
    const observer = new ResizeObserver(() => {
      if (!frame || !track) return;
      const next = measure(track);
      if (!Number.isFinite(next) || Math.abs(next - width) < 0.5 || sizing?.state === "running") return;
      frame.style.width = `${next}px`;
      width = next;
    });
    observer.observe(track);
    onCleanup(() => observer.disconnect());
  });

  return (
    <Dynamic component={props.as ?? "span"} id={props.id} class={props.class}>
      <span class="sr-only">{props.children}</span>
      <span ref={frame} class={styles.frame} aria-hidden="true">
        <span ref={track} class={styles.track}>
          <MorphText text={props.children} keys="occurrence" variant="morph" />
        </span>
      </span>
    </Dynamic>
  );
}

export default TextMorph;

import { For, Show, type JSX } from "solid-js";
import { HeightFrame } from "../lib/HeightFrame";
import { Presence } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, tween } from "../lib/motion";
import styles from "./skeleton.module.css";

export interface SkeletonProps {
  label?: string;
  lines?: number;
  avatar?: boolean;
  class?: string;
  /** Content to reveal once loading finishes. With children, the placeholder crossfades into them. */
  children?: JSX.Element;
  /** Keeps the placeholder visible while true. Only used together with children. */
  loading?: boolean;
}

/** One block of placeholder shape, for building skeletons that match a final layout exactly. */
export function SkeletonBlock(props: { width?: string; height?: string; radius?: string; class?: string; index?: number }) {
  return <span class={[styles.block, props.class ?? ""].join(" ")} aria-hidden="true" style={{ width: props.width, height: props.height, "border-radius": props.radius, "--index": String(props.index ?? 0) }} />;
}

/**
 * Arc Skeleton: a calm, finite pulse in the final layout. With children it crossfades into the content and the height
 * springs from the placeholder's size to the content's.
 */
export function Skeleton(props: SkeletonProps) {
  const count = () => Math.min(Math.max(Math.floor(props.lines ?? 3), 1), 6);
  const placeholder = (extra?: string) => (
    <div class={[styles.root, extra ?? ""].join(" ")} role="status" aria-label={props.label ?? "Loading content"} aria-busy="true">
      <Show when={props.avatar}><span class={styles.avatar} aria-hidden="true" /></Show>
      <span class={styles.lines} aria-hidden="true">
        <For each={Array.from({ length: count() }, (_, index) => index)}>
          {index => <span class={styles.line} style={{ "--index": String(index + (props.avatar ? 1 : 0)) }} />}
        </For>
      </span>
    </div>
  );
  if (props.children === undefined) return placeholder(props.class);
  const fade = (el: HTMLElement) => animate(el, { opacity: [0, 1] }, tween(prefersReducedMotion() ? motionTokens.duration.instant : motionTokens.duration.fast));
  return (
    <HeightFrame class={props.class} morphKey={String(!!props.loading)} aria-busy={!!props.loading}>
      <Presence when={!!props.loading} enter={fade} exit={el => animate(el, { opacity: 0 }, tween(prefersReducedMotion() ? 0 : motionTokens.duration.fast))}>
        {ref => <div ref={ref}>{placeholder()}</div>}
      </Presence>
      <Presence
        when={!props.loading}
        initial
        enter={el => prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant)) : animate(el, { opacity: [0, 1], y: [4, 0] }, tween(motionTokens.duration.standard, motionTokens.ease.enter))}
      >
        {ref => <div ref={ref}>{props.children}</div>}
      </Presence>
    </HeightFrame>
  );
}

export default Skeleton;

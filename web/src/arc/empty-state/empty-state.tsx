import { Show, type JSX } from "solid-js";
import { Folder } from "lucide-solid";
import { HeightFrame } from "../lib/HeightFrame";
import { SwapText } from "../lib/presence";
import { createContentSwap } from "../lib/content-swap";
import { useSquircle } from "../lib/squircle";
import styles from "./empty-state.module.css";

export interface EmptyStateProps {
  title: string;
  /** Why it is empty, in one sentence. */
  description: string;
  /** One next step. */
  action?: JSX.Element;
  icon?: JSX.Element;
  class?: string;
  label?: string;
}

/** Arc EmptyState: says why a region is empty and offers one next step. Changes morph in place. */
export function EmptyState(props: EmptyStateProps) {
  let iconSlot: HTMLDivElement | undefined;
  let icon: HTMLSpanElement | undefined;
  createContentSwap(() => iconSlot, () => icon);
  return (
    <section class={[styles.root, props.class ?? ""].join(" ")} aria-label={props.label}>
      <div ref={el => { iconSlot = el; useSquircle(el); }} class={styles.icon} aria-hidden="true">
        <span ref={icon} class={styles.glyph}>{props.icon ?? <Folder width={24} height={24} stroke-width={1.5} />}</span>
      </div>
      <HeightFrame class={styles.frame} contentClass={styles.copy} morphKey={`${props.title}\n${props.description}`}>
        <h3><SwapText text={props.title} class={styles.line} /></h3>
        <p><SwapText text={props.description} class={styles.line} /></p>
      </HeightFrame>
      <Show when={props.action}><div class={styles.action}>{props.action}</div></Show>
    </section>
  );
}

export default EmptyState;

import { Show, createSignal, onCleanup, onMount, splitProps, type JSX } from "solid-js";
import { cx } from "../lib/cx";
import { animate, prefersReducedMotion, spring, type AnimationControls } from "../lib/motion";
import { createContentSwap } from "../lib/content-swap";
import { useSquircle } from "../lib/squircle";
import styles from "./badge.module.css";

export type BadgeTone = "neutral" | "success" | "info" | "warning" | "danger";
export type BadgeSize = "sm" | "md";

export interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  icon?: JSX.Element;
  /** Show a small status dot before the label (used for live statuses such as "Active"). */
  dot?: boolean;
}

/**
 * Arc Badge: a status mark that always pairs colour with a label. A new label or icon crossfades in place while the
 * pill's width springs to the new size. Status tones mean status; `info` marks emphasis.
 */
export function Badge(props: BadgeProps) {
  const [local, rest] = splitProps(props, ["tone", "size", "icon", "dot", "class", "children"]);
  let body: HTMLSpanElement | undefined;
  let content: HTMLSpanElement | undefined;
  let label: HTMLSpanElement | undefined;
  let labelInner: HTMLSpanElement | undefined;
  let iconSlot: HTMLSpanElement | undefined;
  let iconInner: HTMLSpanElement | undefined;
  const [changedAt, setChangedAt] = createSignal(0);
  createContentSwap(() => label, () => labelInner, { onSwap: () => setChangedAt(performance.now()) });
  createContentSwap(() => iconSlot, () => iconInner, { onSwap: () => setChangedAt(performance.now()) });

  // Width stays auto at rest. Only a new label or icon springs it from the old size to the new one.
  onMount(() => {
    const node = content;
    if (!node || !body || typeof ResizeObserver === "undefined") return;
    let last: number | undefined;
    let current: number | undefined;
    let controls: AnimationControls | undefined;
    const settle = () => { current = undefined; if (body) body.style.width = ""; };
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.borderBoxSize?.[0]?.inlineSize ?? node.offsetWidth;
      const from = current ?? last;
      last = next;
      controls?.stop();
      if (prefersReducedMotion() || from === undefined || from === next || performance.now() - changedAt() > 120) return settle();
      if (body) body.style.width = `${from}px`;
      controls = animate(from, next, { ...spring.morph, onUpdate: value => { current = value; if (body) body.style.width = `${value}px`; }, onComplete: settle });
    });
    observer.observe(node);
    onCleanup(() => { observer.disconnect(); controls?.stop(); });
  });

  return (
    <span {...rest} ref={el => useSquircle(el)} class={cx(styles.badge, styles[local.tone ?? "neutral"], styles[local.size ?? "md"], local.class)}>
      <span ref={body} class={styles.body}>
        <span ref={content} class={styles.content}>
          <Show when={local.dot}><span class={styles.dot} aria-hidden="true" /></Show>
          <Show when={local.icon}>
            <span ref={iconSlot} class={styles.icon} aria-hidden="true"><span ref={iconInner} class={styles.glyph}>{local.icon}</span></span>
          </Show>
          <span ref={label} class={styles.label}><span ref={labelInner} class={styles.text}>{local.children}</span></span>
        </span>
      </span>
    </span>
  );
}

export default Badge;

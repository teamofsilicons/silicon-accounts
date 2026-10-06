import { Show, createEffect, on, onCleanup, splitProps, type JSX } from "solid-js";
import { Check } from "lucide-solid";
import { SwapText, Presence } from "../lib/presence";
import { animate, presets, prefersReducedMotion, spring, type AnimationControls } from "../lib/motion";
import { cx } from "../lib/cx";
import styles from "./progress.module.css";

export interface ProgressProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "children"> {
  value?: number;
  max?: number;
  label?: string;
  showValue?: boolean;
  /** Use for work whose end is unknown (an import counting rows). Shows a calm moving band. */
  indeterminate?: boolean;
}

/**
 * Arc Progress. One spring drives the fill and the counted label, so the number always matches the bar. The fill
 * slides in from the left instead of scaling, so its rounded end keeps its shape. Completion lands with a check.
 */
export function Progress(props: ProgressProps) {
  const [local, rest] = splitProps(props, ["value", "max", "label", "showValue", "indeterminate", "class"]);
  let fill: HTMLSpanElement | undefined;
  let count: HTMLSpanElement | undefined;
  const safeMax = () => ((local.max ?? 100) > 0 ? local.max ?? 100 : 100);
  const safeValue = () => Math.min(Math.max(local.value ?? 0, 0), safeMax());
  const percentage = () => Math.round((safeValue() / safeMax()) * 100);
  const complete = () => !local.indeterminate && percentage() >= 100;
  let current = 0;
  let controls: AnimationControls | undefined;
  const paint = (latest: number) => {
    current = latest;
    const clamped = Math.min(Math.max(latest, 0), 100);
    if (fill) fill.style.transform = `translateX(${clamped - 100}%)`;
    if (count) count.textContent = `${Math.round(clamped)}%`;
  };
  createEffect(on(percentage, value => {
    controls?.stop();
    if (prefersReducedMotion() || !fill) {
      queueMicrotask(() => paint(value));
      return;
    }
    controls = animate(current, value, { ...spring.smooth, onUpdate: paint });
  }));
  onCleanup(() => controls?.stop());
  return (
    <div
      {...rest}
      class={cx(styles.progress, local.class)}
      data-complete={complete() ? "" : undefined}
      data-indeterminate={local.indeterminate ? "" : undefined}
      role="progressbar"
      aria-label={local.label ?? "Progress"}
      aria-valuemin={0}
      aria-valuemax={safeMax()}
      aria-valuenow={local.indeterminate ? undefined : safeValue()}
      aria-valuetext={local.indeterminate ? "In progress" : `${percentage()}%`}
    >
      <Show when={local.label || local.showValue}>
        <div class={styles.meta}>
          <span class={styles.label}><Show when={local.label}><SwapText text={local.label ?? ""} class={styles.line} /></Show></span>
          <Show when={local.showValue && !local.indeterminate}>
            <span class={styles.value}>
              <Presence when={complete()} enter={el => presets.iconIn(el)} exit={el => presets.iconOut(el)}>
                {ref => <span ref={ref} class={styles.done}><Check size={14} stroke-width={1.75} /></span>}
              </Presence>
              <span ref={count} class={styles.count}>0%</span>
            </span>
          </Show>
        </div>
      </Show>
      <div class={styles.track}><span ref={el => { fill = el; paint(current); }} class={styles.fill} /></div>
    </div>
  );
}

export default Progress;

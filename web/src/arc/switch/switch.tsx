import { Show, createEffect, createSignal, on, splitProps } from "solid-js";
import { Switch as K } from "@kobalte/core/switch";
import { animate, prefersReducedMotion, spring } from "../lib/motion";
import styles from "./switch.module.css";

export interface SwitchProps {
  /** Visible label. When the switch sits in a settings row with its own title, use aria-labelledby instead. */
  label?: string;
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  name?: string;
  value?: string;
  id?: string;
  class?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/** Track inner width (42 - 6 padding) minus the 18px thumb. */
const SIZE = 18;
const TRAVEL = 18;
/** How far the thumb widens toward the other side while pressed. */
const STRETCH = 5;
/** Critically damped: the thumb lands on its end without overshooting the state it reports. */
const glide = { type: "spring", visualDuration: 0.3, bounce: 0 } as const;

/**
 * Arc Switch on Kobalte: on or off that applies now. The thumb stretches like a held finger, keeps its far edge
 * anchored, then travels on a spring that never overshoots the state it reports.
 */
export function Switch(props: SwitchProps) {
  const [local, rest] = splitProps(props, ["label", "description", "class", "checked", "defaultChecked", "onChange", "aria-label", "aria-labelledby", "aria-describedby"]);
  const [internal, setInternal] = createSignal(!!local.defaultChecked);
  const [pressed, setPressed] = createSignal(false);
  const on_ = () => local.checked ?? internal();
  let thumb: HTMLSpanElement | undefined;
  let releasedAt = -Infinity;
  const place = (instant: boolean) => {
    if (!thumb) return;
    const extra = pressed() && !prefersReducedMotion() && !rest.disabled ? STRETCH : 0;
    const target = { x: on_() ? TRAVEL - extra : 0, width: `${SIZE + extra}px` };
    animate(thumb, target, instant || prefersReducedMotion() ? { duration: 0 } : { x: glide, width: spring.snappy });
  };
  createEffect(on(pressed, () => place(false), { defer: true }));
  createEffect(on(on_, () => {
    place(false);
    const fromPress = performance.now() - releasedAt < 250;
    if (thumb && !prefersReducedMotion() && !fromPress) animate(thumb, { scaleX: [1, 1.16, 1] }, { duration: 0.34, times: [0, 0.4, 1] });
  }, { defer: true }));
  const release = () => { if (pressed() && !rest.disabled) releasedAt = performance.now(); setPressed(false); };
  return (
    <K
      {...rest}
      class={[styles.switch, local.class ?? ""].join(" ")}
      checked={on_()}
      onChange={next => { if (local.checked === undefined) setInternal(next); local.onChange?.(next); }}
      onPointerDown={(event: PointerEvent) => { if (event.button === 0) setPressed(true); }}
      onPointerUp={release}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onKeyDown={(event: KeyboardEvent) => { if (event.key === " ") setPressed(true); }}
      onKeyUp={release}
      onFocusOut={() => setPressed(false)}
    >
      <K.Input class={styles.input} aria-label={local["aria-label"] ?? (local.label ? undefined : "Toggle")} aria-labelledby={local["aria-labelledby"]} aria-describedby={local["aria-describedby"]} />
      <K.Control class={styles.track}>
        <K.Thumb ref={el => { thumb = el; queueMicrotask(() => place(true)); }} class={styles.thumb} />
      </K.Control>
      <Show when={local.label || local.description}>
        <span class={styles.copy}>
          <Show when={local.label}><K.Label class={styles.label}>{local.label}</K.Label></Show>
          <Show when={local.description}><K.Description class={styles.description}>{local.description}</K.Description></Show>
        </span>
      </Show>
    </K>
  );
}

export default Switch;

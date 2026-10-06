import { Show, createEffect, createSignal, on, splitProps } from "solid-js";
import { Checkbox as K } from "@kobalte/core/checkbox";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./checkbox.module.css";

export interface CheckboxProps {
  label?: string;
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  id?: string;
  class?: string;
  "aria-label"?: string;
}

/** Both marks share three points, so the check morphs into the dash and back instead of swapping (Arc). */
const checkPath = "M4.25 9.25 L7.25 12.25 L13.75 5.75";
const dashPath = "M4.75 9 L9 9 L13.25 9";

/** Arc Checkbox on Kobalte: for choices inside a form that submits. The fill springs in and the mark draws itself. */
export function Checkbox(props: CheckboxProps) {
  const [local, rest] = splitProps(props, ["label", "description", "class", "checked", "defaultChecked", "onChange", "indeterminate"]);
  const [internal, setInternal] = createSignal(!!local.defaultChecked);
  const checked = () => local.checked ?? internal();
  const on_ = () => checked() || !!local.indeterminate;
  let fill: HTMLSpanElement | undefined;
  let path: SVGPathElement | undefined;
  const paint = (instant: boolean) => {
    if (!fill || !path) return;
    const show = on_();
    const reduce = instant || prefersReducedMotion();
    const fade = tween(show ? motionTokens.duration.instant : motionTokens.duration.fast);
    animate(fill, { opacity: show ? 1 : 0, scale: show ? 1 : 0.6 }, reduce ? { duration: 0 } : { scale: spring.snappy, opacity: fade });
    animate(path, { strokeDashoffset: show ? 0 : 1, opacity: show ? 1 : 0 }, reduce ? { duration: 0 } : { strokeDashoffset: spring.snappy, opacity: fade });
    const d = local.indeterminate ? dashPath : checkPath;
    if (path.getAttribute("d") !== d) {
      if (reduce) path.setAttribute("d", d);
      else animate(path, { d }, spring.morph);
    }
  };
  createEffect(on(() => [checked(), local.indeterminate], () => paint(false), { defer: true }));
  return (
    <K
      {...rest}
      class={[styles.field, local.class ?? ""].join(" ")}
      checked={checked()}
      indeterminate={local.indeterminate}
      onChange={next => { if (local.checked === undefined) setInternal(next); local.onChange?.(next); }}
    >
      <K.Input class={styles.input} aria-label={props["aria-label"] ?? (local.label ? undefined : "Checkbox")} />
      <K.Control class={styles.box}>
        <span ref={el => useSquircle(el)} class={styles.visual} aria-hidden="true">
          <span ref={el => { fill = el; queueMicrotask(() => paint(true)); }} class={styles.fill} style={{ opacity: on_() ? 1 : 0 }} />
          <svg class={styles.mark} viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path ref={el => { path = el; }} d={local.indeterminate ? dashPath : checkPath} pathLength="1" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style={{ "stroke-dasharray": "1", "stroke-dashoffset": on_() ? "0" : "1", opacity: on_() ? 1 : 0 }} />
          </svg>
        </span>
      </K.Control>
      <Show when={local.label || local.description}>
        <div class={styles.copy}>
          <Show when={local.label}><K.Label class={styles.label}>{local.label}</K.Label></Show>
          <Show when={local.description}><K.Description class={styles.description}>{local.description}</K.Description></Show>
        </div>
      </Show>
    </K>
  );
}

export default Checkbox;

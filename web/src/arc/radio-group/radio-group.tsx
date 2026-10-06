import { For, Show, createEffect, createUniqueId, on, onCleanup, onMount } from "solid-js";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./radio-group.module.css";

export interface RadioGroupOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioGroupProps {
  label: string;
  options: RadioGroupOption[];
  value: string;
  onValueChange: (value: string) => void;
  name?: string;
  class?: string;
}

/**
 * Arc RadioGroup: one highlight travels to the chosen row while the new dot springs in and the old one shrinks away,
 * so a change reads as a single physical move. Arrow keys take the same path (native radios).
 */
export function RadioGroup(props: RadioGroupProps) {
  const id = createUniqueId();
  let list: HTMLDivElement | undefined;
  let highlight: HTMLSpanElement | undefined;
  const rows: HTMLLabelElement[] = [];
  const dots: HTMLSpanElement[] = [];
  let at = "";
  let shown: number | null = null;
  const selected = () => props.options.findIndex(option => option.value === props.value);

  const place = (row: HTMLElement | undefined, glide: boolean) => {
    if (!highlight) return;
    const next = row ? `${row.offsetTop} ${row.offsetHeight}` : "";
    if (next === at) return;
    const visible = at !== "";
    at = next;
    if (!row) { animate(highlight, { opacity: 0 }, { duration: 0 }); return; }
    const target = { y: row.offsetTop, height: `${row.offsetHeight}px`, opacity: 1 };
    if (glide && visible) { animate(highlight, target, { ...spring.morph, opacity: { duration: 0 } }); return; }
    animate(highlight, target, { duration: 0 });
  };

  const paintDots = (instant: boolean) => {
    props.options.forEach((option, index) => {
      const dot = dots[index];
      if (!dot) return;
      const checked = option.value === props.value;
      animate(dot, checked ? { scale: 1, opacity: 1 } : { scale: 0.4, opacity: 0 }, instant || prefersReducedMotion() ? { duration: 0 } : { ...spring.snappy, opacity: tween(checked ? motionTokens.duration.fast : motionTokens.duration.instant) });
    });
  };

  createEffect(on(selected, index => {
    place(rows[index], shown !== null && shown !== index && !prefersReducedMotion());
    paintDots(shown === null);
    shown = index;
    list?.setAttribute("data-ready", "");
  }));
  onMount(() => {
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { at = ""; place(rows[shown ?? -1], false); });
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });

  return (
    <fieldset class={[styles.group, props.class ?? ""].join(" ")}>
      <legend>{props.label}</legend>
      <div ref={list} class={styles.options}>
        <span ref={el => { highlight = el; useSquircle(el); }} class={styles.highlight} aria-hidden="true" />
        <For each={props.options}>
          {(option, index) => (
            <label class={styles.option} ref={el => { rows[index()] = el; useSquircle(el); }} data-disabled={option.disabled ? "" : undefined}>
              <input type="radio" name={props.name ?? id} value={option.value} checked={props.value === option.value} disabled={option.disabled} onChange={() => props.onValueChange(option.value)} />
              <span class={styles.mark} aria-hidden="true"><span ref={el => (dots[index()] = el)} class={styles.dot} /></span>
              <span><strong>{option.label}</strong><Show when={option.description}><small>{option.description}</small></Show></span>
            </label>
          )}
        </For>
      </div>
    </fieldset>
  );
}

export default RadioGroup;

import { For, Show, createEffect, createSignal, createUniqueId, on, onCleanup, onMount, type JSX } from "solid-js";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./radio-cards.module.css";

export interface RadioCardOption {
  value: string;
  label: JSX.Element;
  /** One or two short lines under the label. */
  description?: JSX.Element;
  /** A value such as a count or an estimate. Sits at the end of a list row, or under the text in a grid card. */
  meta?: JSX.Element;
  /** Plain decorative icon beside the label. */
  icon?: JSX.Element;
  disabled?: boolean;
  /** Short reason shown in place of the description when the option is disabled. */
  disabledReason?: JSX.Element;
}

export interface RadioCardsProps {
  options: RadioCardOption[];
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string) => void;
  /** "grid" places cards in responsive columns; "list" stacks full width rows. */
  layout?: "grid" | "list";
  /** Narrowest a grid column may get before the grid drops a column, in px. */
  minColumnWidth?: number;
  /** Form field name. Renders a hidden input with the selected value. */
  name?: string;
  required?: boolean;
  disabled?: boolean;
  class?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

/** Arc's physical spring for the ring glide (visual duration .42, bounce .14). */
const root = (2 * Math.PI) / (0.42 * 1.2);
const GLIDE = { type: "spring", stiffness: root * root, damping: 2 * (1 - 0.14) * root, mass: 1 } as const;

/**
 * Arc RadioCards: selectable cards for choices that need more than a label. One selection ring glides from card to
 * card. Behaves as a native radio group: one tab stop, arrow keys move and select, a hidden input carries the value.
 */
export function RadioCards(props: RadioCardsProps) {
  const uid = createUniqueId();
  let rootEl: HTMLDivElement | undefined;
  let ring: HTMLSpanElement | undefined;
  const cards: HTMLDivElement[] = [];
  const dots: HTMLSpanElement[] = [];
  const [internal, setInternal] = createSignal<string | null>(props.defaultValue ?? null);
  const selected = () => (props.value !== undefined ? props.value : internal());
  const selectedIndex = () => props.options.findIndex(option => option.value === selected());
  const usable = (option: RadioCardOption | undefined) => !!option && !props.disabled && !option.disabled;
  const tabStop = () => (selectedIndex() >= 0 && usable(props.options[selectedIndex()]) ? selectedIndex() : props.options.findIndex(usable));
  const select = (next: string) => {
    if (next === selected()) return;
    if (props.value === undefined) setInternal(next);
    props.onValueChange?.(next);
  };

  let placed = false;
  const place = (glide: boolean) => {
    const node = cards[selectedIndex()];
    if (!ring) return;
    if (!node) { animate(ring, { opacity: 0 }, { duration: 0 }); placed = false; return; }
    const box = { x: node.offsetLeft, y: node.offsetTop, width: `${node.offsetWidth}px`, height: `${node.offsetHeight}px` };
    if (!glide || !placed || prefersReducedMotion()) {
      animate(ring, box, { duration: 0 });
      if (!placed && glide && !prefersReducedMotion()) animate(ring, { opacity: [0, 1] }, tween(motionTokens.duration.fast));
      else animate(ring, { opacity: 1 }, { duration: 0 });
      placed = true;
      return;
    }
    animate(ring, { ...box, opacity: 1 }, { ...GLIDE, opacity: { duration: 0 } });
  };
  const paintDots = (instant: boolean) => {
    props.options.forEach((_, index) => {
      const dot = dots[index];
      if (dot) animate(dot, { scale: index === selectedIndex() ? 1 : 0 }, instant || prefersReducedMotion() ? { duration: 0 } : spring.snappy);
    });
  };
  let first = true;
  createEffect(on(selectedIndex, () => {
    queueMicrotask(() => { place(!first); paintDots(first); first = false; });
  }));
  onMount(() => {
    if (!rootEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(rootEl);
    onCleanup(() => observer.disconnect());
  });

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      const option = props.options[index];
      if (option && usable(option)) select(option.value);
      return;
    }
    if (!step && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const count = props.options.length;
    let at = event.key === "Home" ? -1 : event.key === "End" ? count : index;
    const dir = event.key === "Home" ? 1 : event.key === "End" ? -1 : step;
    for (let tries = 0; tries < count; tries++) {
      at = (at + dir + count) % count;
      const option = props.options[at];
      if (option && usable(option)) { cards[at]?.focus(); select(option.value); return; }
    }
  };

  return (
    <div
      ref={rootEl}
      role="radiogroup"
      aria-label={props["aria-label"]}
      aria-labelledby={props["aria-labelledby"]}
      aria-disabled={props.disabled || undefined}
      aria-required={props.required || undefined}
      class={[styles.root, props.class ?? ""].join(" ")}
      data-layout={props.layout ?? "grid"}
      style={{ "--min-column": `${props.minColumnWidth ?? 180}px` }}
    >
      <span ref={el => { ring = el; useSquircle(el); }} class={styles.ring} aria-hidden="true" />
      <For each={props.options}>
        {(option, index) => {
          const checked = () => index() === selectedIndex();
          const off = () => !usable(option);
          const description = () => (off() && option.disabledReason ? option.disabledReason : option.description);
          return (
            <div
              ref={el => { cards[index()] = el; useSquircle(el); }}
              role="radio"
              class={styles.card}
              aria-checked={checked()}
              aria-disabled={off() || undefined}
              aria-labelledby={`${uid}-${index()}-label`}
              aria-describedby={description() ? `${uid}-${index()}-description` : undefined}
              tabIndex={index() === tabStop() ? 0 : -1}
              data-checked={checked() || undefined}
              onClick={() => { if (!off()) select(option.value); }}
              onKeyDown={event => onKeyDown(event, index())}
            >
              <span class={styles.indicator} aria-hidden="true"><span ref={el => (dots[index()] = el)} class={styles.indicatorDot} style={{ transform: "scale(0)" }} /></span>
              <span class={styles.body}>
                <span id={`${uid}-${index()}-label`} class={styles.label}>
                  <Show when={option.icon}><span class={styles.icon}>{option.icon}</span></Show>
                  <span class={styles.labelText}>{option.label}</span>
                </span>
                <Show when={description()}><span id={`${uid}-${index()}-description`} class={styles.description}>{description()}</span></Show>
              </span>
              <Show when={option.meta}><span class={styles.meta}>{option.meta}</span></Show>
            </div>
          );
        }}
      </For>
      <Show when={props.name}><input type="hidden" name={props.name} value={selected() ?? ""} required={props.required} /></Show>
    </div>
  );
}

export default RadioCards;

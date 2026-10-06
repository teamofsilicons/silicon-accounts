import { For, createEffect, createUniqueId, on, onCleanup, onMount, type JSX } from "solid-js";
import { animate, prefersReducedMotion, spring } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./segmented-control.module.css";

export interface Segment<V extends string = string> {
  value: V;
  label: string;
  /** Optional content after the label, such as a badge or icon. */
  accessory?: JSX.Element;
  /** Optional leading icon. */
  icon?: JSX.Element;
}

export interface SegmentedControlProps<V extends string = string> {
  options: Segment<V>[];
  value: V;
  onValueChange: (value: V) => void;
  label?: string;
  /** Called when the pointer or focus reaches an option, before it is chosen. */
  onOptionIntent?: (value: V) => void;
  class?: string;
  size?: "sm" | "md";
}

/**
 * Arc SegmentedControl: 2 to 5 views of the same data. One highlight glides to the chosen option on the morph spring;
 * arrow keys, Home and End move the selection, and only the selected option is a tab stop.
 */
export function SegmentedControl<V extends string = string>(props: SegmentedControlProps<V>) {
  const id = createUniqueId();
  let track: HTMLDivElement | undefined;
  let selection: HTMLSpanElement | undefined;
  let placed = false;
  const selectedIndex = () => Math.max(0, props.options.findIndex(option => option.value === props.value));

  const place = (glide: boolean) => {
    const button = track?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!button || !selection) return;
    const target = { x: button.offsetLeft, width: `${button.offsetWidth}px`, height: `${button.offsetHeight}px`, y: button.offsetTop, opacity: 1 };
    animate(selection, target, glide && placed && !prefersReducedMotion() ? spring.morph : { duration: 0 });
    placed = true;
  };

  createEffect(on(() => props.value, () => queueMicrotask(() => {
    place(true);
    // The selected option is always scrolled fully into view, with a little room so it clears the fade.
    const node = track;
    const button = node?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!node || !button || node.scrollWidth <= node.clientWidth) return;
    const room = 20;
    const start = button.offsetLeft - room;
    const end = button.offsetLeft + button.offsetWidth + room - node.clientWidth;
    const left = node.scrollLeft > start ? start : node.scrollLeft < end ? end : node.scrollLeft;
    if (left !== node.scrollLeft) node.scrollTo({ left: Math.max(0, left), behavior: prefersReducedMotion() ? "auto" : "smooth" });
  })));

  onMount(() => {
    const node = track;
    if (!node) return;
    const edges = () => {
      const rest = node.scrollWidth - node.clientWidth - node.scrollLeft;
      node.toggleAttribute("data-fade-start", node.scrollLeft > 1);
      node.toggleAttribute("data-fade-end", rest > 1);
    };
    edges();
    node.addEventListener("scroll", edges, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { edges(); place(false); });
    observer?.observe(node);
    onCleanup(() => { node.removeEventListener("scroll", edges); observer?.disconnect(); });
  });

  const onKeyDown = (event: KeyboardEvent) => {
    const last = props.options.length - 1;
    const index = selectedIndex();
    const target = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index === 0 ? last : index - 1)
        : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    const option = props.options[target];
    if (target < 0 || !option) return;
    event.preventDefault();
    props.onValueChange(option.value);
    track?.querySelector<HTMLElement>(`[data-value="${CSS.escape(option.value)}"]`)?.focus({ preventScroll: true });
  };

  return (
    <div ref={el => useSquircle(el)} class={[styles.root, props.size === "sm" ? styles.sm : "", props.class ?? ""].join(" ")} role="group" aria-label={props.label}>
      <div ref={track} class={styles.track}>
        <span ref={el => { selection = el; useSquircle(el); }} class={styles.selection} aria-hidden="true" />
        <For each={props.options}>
          {(option, index) => (
            <button
              id={`${id}-${option.value}`}
              class={styles.button}
              type="button"
              data-value={option.value}
              aria-pressed={props.value === option.value}
              tabIndex={index() === selectedIndex() ? 0 : -1}
              onClick={() => props.onValueChange(option.value)}
              onKeyDown={onKeyDown}
              onPointerEnter={() => props.onOptionIntent?.(option.value)}
              onFocus={() => props.onOptionIntent?.(option.value)}
            >
              <span class={styles.label}>{option.icon}{option.label}{option.accessory}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

export default SegmentedControl;

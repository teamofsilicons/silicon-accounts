import { createUniqueId, splitProps, type JSX } from "solid-js";
import { Search, X } from "lucide-solid";
import { cx } from "../lib/cx";
import { Presence } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./search-field.module.css";

export interface SearchFieldProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onInput"> {
  label: string;
  /** Hide the visible label (allowed in toolbars, where the context names it). */
  hideLabel?: boolean;
  value: string;
  onValueChange: (value: string) => void;
  ref?: (el: HTMLInputElement) => void;
}

/** Arc SearchField: the glass wakes with the field, and the clear button has a reserved slot so the field never resizes. */
export function SearchField(props: SearchFieldProps) {
  const [local, rest] = splitProps(props, ["label", "hideLabel", "value", "onValueChange", "id", "class", "ref"]);
  const generated = createUniqueId();
  const controlId = () => local.id ?? `search-${generated}`;
  let input: HTMLInputElement | undefined;
  return (
    <div class={styles.field}>
      <label class={local.hideLabel ? "sr-only" : styles.label} for={controlId()}>{local.label}</label>
      <div ref={el => useSquircle(el)} class={styles.shell} data-filled={local.value ? "true" : undefined}>
        <Search width={18} height={18} stroke-width={1.75} aria-hidden="true" />
        <input
          {...rest}
          ref={el => { input = el; local.ref?.(el); }}
          id={controlId()}
          type="search"
          value={local.value}
          onInput={event => local.onValueChange(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === "Escape" && local.value) { event.preventDefault(); local.onValueChange(""); } }}
          class={cx(styles.input, local.class)}
          autocomplete="off"
          spellcheck={false}
        />
        <span class={styles.clearSlot}>
          <Presence
            when={!!local.value}
            enter={el => prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant)) : animate(el, { opacity: [0, 1], scale: [0.8, 1], filter: ["blur(2px)", "blur(0px)"] }, { ...spring.snappy, opacity: tween(motionTokens.duration.fast), filter: tween(motionTokens.duration.fast) })}
            exit={el => prefersReducedMotion() ? animate(el, { opacity: 0 }, { duration: 0 }) : animate(el, { opacity: 0, scale: 0.8, filter: "blur(2px)" }, tween(motionTokens.duration.instant))}
          >
            {ref => (
              <button ref={ref} type="button" class={styles.clear} aria-label="Clear search" onClick={() => { local.onValueChange(""); input?.focus(); }}>
                <X width={16} height={16} stroke-width={1.75} aria-hidden="true" />
              </button>
            )}
          </Presence>
        </span>
      </div>
    </div>
  );
}

export default SearchField;

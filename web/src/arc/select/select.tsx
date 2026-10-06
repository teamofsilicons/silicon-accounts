import { Show, createEffect, createMemo, createSignal, createUniqueId, on } from "solid-js";
import { Select as K } from "@kobalte/core/select";
import { Check, ChevronDown } from "lucide-solid";
import { cx } from "../lib/cx";
import { Swap } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./select.module.css";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Optional secondary text shown in the menu only. */
  hint?: string;
}

export interface SelectProps {
  label: string;
  hideLabel?: boolean;
  description?: string;
  placeholder?: string;
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  class?: string;
}

/**
 * Arc Select on Kobalte: one of many options. The shown value rolls in the direction of the list (a later option rises
 * from below), and the menu grows from the trigger edge. The trigger anchors the menu, so a press answers with colour.
 */
export function Select(props: SelectProps) {
  const uid = createUniqueId();
  const [internal, setInternal] = createSignal(props.defaultValue ?? "");
  const current = () => props.value ?? internal();
  const selected = createMemo(() => props.options.find(option => option.value === current()) ?? null);
  const index = () => props.options.findIndex(option => option.value === current());
  const [direction, setDirection] = createSignal(1);
  createEffect(on(index, (next, previous) => { if (previous !== undefined) setDirection(next > previous ? 1 : -1); }));
  const shown = () => selected()?.label ?? props.placeholder ?? "Select an option";
  return (
    <K<SelectOption>
      class={cx(styles.field, props.class)}
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      optionDisabled="disabled"
      value={selected()}
      onChange={option => {
        if (!option) return;
        if (props.value === undefined) setInternal(option.value);
        props.onValueChange?.(option.value);
      }}
      disabled={props.disabled}
      required={props.required}
      name={props.name}
      id={props.id ?? `select-${uid}`}
      placement="bottom-start"
      gutter={4}
      sameWidth
      itemComponent={itemProps => (
        <K.Item item={itemProps.item} class={styles.item}>
          <K.ItemLabel class={styles.itemLabel}>{itemProps.item.rawValue.label}</K.ItemLabel>
          <Show when={itemProps.item.rawValue.hint}><span class={styles.itemHint}>{itemProps.item.rawValue.hint}</span></Show>
          <K.ItemIndicator class={styles.indicator}><Check size={16} stroke-width={1.75} aria-hidden="true" /></K.ItemIndicator>
        </K.Item>
      )}
    >
      <K.Label class={props.hideLabel ? "sr-only" : styles.label}>{props.label}</K.Label>
      <K.HiddenSelect />
      <K.Trigger ref={(el: HTMLButtonElement) => useSquircle(el)} class={styles.trigger}>
        <span class="sr-only"><K.Value<SelectOption>>{state => state.selectedOption()?.label}</K.Value></span>
        <span class={styles.valueText} aria-hidden="true">
          <Swap
            value={shown()}
            enter={el => prefersReducedMotion()
              ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant))
              : animate(el, { opacity: [0, 1], y: [`${direction() * 0.35}em`, "0em"], filter: ["blur(4px)", "blur(0px)"] }, tween(motionTokens.duration.standard, motionTokens.ease.enter))}
            exit={el => prefersReducedMotion()
              ? animate(el, { opacity: 0 }, tween(motionTokens.duration.instant))
              : animate(el, { opacity: 0, y: `${direction() * -0.3}em`, filter: "blur(2px)" }, tween(motionTokens.duration.fast))}
          >
            {text => <span data-placeholder={selected() ? undefined : ""}>{text}</span>}
          </Swap>
        </span>
        <K.Icon class={styles.chevron}><ChevronDown size={16} stroke-width={1.75} aria-hidden="true" /></K.Icon>
      </K.Trigger>
      <Show when={props.description}><K.Description class={styles.hint}>{props.description}</K.Description></Show>
      <K.Portal>
        <K.Content ref={(el: HTMLDivElement) => useSquircle(el)} class={styles.content}>
          <K.Listbox class={styles.viewport} />
        </K.Content>
      </K.Portal>
    </K>
  );
}

export default Select;

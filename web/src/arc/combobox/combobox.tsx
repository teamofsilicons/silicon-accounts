import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, type JSX } from "solid-js";
import { Check, ChevronDown, Search, X } from "lucide-solid";
import { cx } from "../lib/cx";
import { FieldMessage } from "../lib/FieldMessage";
import { Presence } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./combobox.module.css";

export interface ComboboxOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Extra search terms (for a timezone: its offset, abbreviations, major cities). */
  keywords?: string[];
  /** Secondary text shown at the end of the row (for a timezone: "UTC+05:30"). */
  meta?: string;
}

export interface ComboboxProps {
  label: string;
  hideLabel?: boolean;
  options: ComboboxOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  description?: string;
  error?: string | null;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  /** Most matches rendered at once; the rest appear as the search narrows. */
  limit?: number;
  id?: string;
  class?: string;
  name?: string;
  icon?: JSX.Element;
}

/**
 * Arc Combobox: type to filter a long option list (the timezone picker uses it). The menu height follows the results
 * on a critically damped spring, arrow keys move the active row, Enter chooses, Escape closes.
 */
export function Combobox(props: ComboboxProps) {
  const uid = createUniqueId();
  const controlId = () => props.id ?? `combo-${uid}`;
  const listboxId = () => `${controlId()}-listbox`;
  const hintId = () => (props.description ? `${controlId()}-description` : undefined);
  const errorId = () => (props.error ? `${controlId()}-error` : undefined);
  let rootEl: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let listbox: HTMLDivElement | undefined;
  let frame: HTMLDivElement | undefined;
  let inner: HTMLDivElement | undefined;
  const optionEls = new Map<string, HTMLDivElement>();
  const [internal, setInternal] = createSignal(props.defaultValue ?? "");
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal(-1);
  const selectedValue = () => props.value ?? internal();
  const selectedOption = createMemo(() => props.options.find(option => option.value === selectedValue()));

  // A chosen label settles into the field: it rises in from below with a soft blur.
  createEffect(on(selectedValue, value => {
    if (!input || prefersReducedMotion() || (value && open())) return;
    if (value) animate(input, { opacity: [0, 1], y: ["0.35em", "0em"], filter: ["blur(4px)", "blur(0px)"] }, tween(motionTokens.duration.standard, motionTokens.ease.enter));
    else animate(input, { opacity: [0, 1] }, tween(motionTokens.duration.fast, motionTokens.ease.enter));
  }, { defer: true }));

  const filtered = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase();
    const list = needle
      ? props.options.filter(option => [option.label, option.value, option.meta ?? "", ...(option.keywords ?? [])].some(term => term.toLocaleLowerCase().includes(needle)))
      : props.options;
    return list.slice(0, props.limit ?? 200);
  });
  const enabledIndices = () => filtered().reduce<number[]>((indices, option, index) => (option.disabled ? indices : [...indices, index]), []);

  createEffect(on([activeIndex, filtered, open], ([index, list, isOpen]) => {
    if (!isOpen) return;
    const option = index >= 0 ? list[index] : undefined;
    const node = option ? optionEls.get(option.value) : undefined;
    if (node && listbox) {
      const top = node.offsetTop;
      const bottom = top + node.offsetHeight;
      if (top < listbox.scrollTop) listbox.scrollTop = top;
      else if (bottom > listbox.scrollTop + listbox.clientHeight) listbox.scrollTop = bottom - listbox.clientHeight;
    }
  }));

  onMount(() => {
    const down = (event: PointerEvent) => {
      if (rootEl && !rootEl.contains(event.target as Node)) { setOpen(false); setQuery(""); }
    };
    document.addEventListener("pointerdown", down);
    onCleanup(() => document.removeEventListener("pointerdown", down));
  });

  const choose = (option: ComboboxOption) => {
    if (option.disabled) return;
    if (props.value === undefined) setInternal(option.value);
    props.onValueChange?.(option.value);
    setQuery("");
    setOpen(false);
    input?.focus();
  };
  const clear = (event: MouseEvent) => {
    event.preventDefault();
    if (props.value === undefined) setInternal("");
    props.onValueChange?.("");
    setQuery("");
    setOpen(true);
    input?.focus();
  };
  const openMenu = () => {
    if (props.disabled) return;
    if (!open()) {
      setOpen(true);
      setQuery("");
      const index = filtered().findIndex(option => option.value === selectedValue());
      setActiveIndex(index);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (props.disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open()) { openMenu(); return; }
      const indices = enabledIndices();
      if (!indices.length) return;
      const position = indices.indexOf(activeIndex());
      const next = event.key === "ArrowDown" ? (position + 1) % indices.length : (position - 1 + indices.length) % indices.length;
      setActiveIndex(indices[next] ?? -1);
      return;
    }
    if (event.key === "Enter" && open() && activeIndex() >= 0) {
      event.preventDefault();
      const option = filtered()[activeIndex()];
      if (option) choose(option);
      return;
    }
    if (event.key === "Escape" && open()) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery("");
    }
  };

  // The menu follows the listbox height with a critically damped spring, so filtering never snaps it.
  const follow = () => {
    if (!frame || !inner) return;
    const target = inner.offsetHeight;
    if (prefersReducedMotion() || !frame.style.height) frame.style.height = `${target}px`;
    else animate(frame, { height: `${target}px` }, spring.smooth);
  };

  const inputValue = () => (open() ? query() : selectedOption()?.label ?? "");
  const activeOption = () => (activeIndex() >= 0 ? filtered()[activeIndex()] : undefined);

  return (
    <div ref={rootEl} class={cx(styles.field, props.class)}>
      <label class={props.hideLabel ? "sr-only" : styles.label} for={controlId()}>{props.label}</label>
      <div class={styles.anchor}>
      <div ref={el => useSquircle(el)} class={styles.control} data-open={open() || undefined} data-disabled={props.disabled || undefined} data-invalid={props.error ? "" : undefined}>
        <span class={styles.searchIcon} aria-hidden="true">{props.icon ?? <Search size={16} stroke-width={1.75} />}</span>
        <input
          ref={input}
          id={controlId()}
          type="text"
          role="combobox"
          value={inputValue()}
          placeholder={selectedOption()?.label ?? props.placeholder ?? "Search or select"}
          disabled={props.disabled}
          autocomplete="off"
          spellcheck={false}
          aria-describedby={[hintId(), errorId()].filter(Boolean).join(" ") || undefined}
          aria-invalid={props.error ? true : undefined}
          aria-expanded={open()}
          aria-controls={open() ? listboxId() : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open() && activeOption() ? `${controlId()}-option-${activeOption()?.value}` : undefined}
          onFocus={openMenu}
          onClick={openMenu}
          onInput={event => { setQuery(event.currentTarget.value); setOpen(true); setActiveIndex(-1); }}
          onKeyDown={onKeyDown}
        />
        <Presence
          when={!!selectedOption() && !props.disabled}
          enter={el => prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(0.12)) : animate(el, { opacity: [0, 1], scale: [0.6, 1], filter: ["blur(2px)", "blur(0px)"] }, { ...spring.snappy, opacity: tween(motionTokens.duration.fast) })}
          exit={el => animate(el, prefersReducedMotion() ? { opacity: 0 } : { opacity: 0, scale: 0.6, filter: "blur(2px)" }, tween(motionTokens.duration.instant))}
        >
          {ref => (
            <button ref={ref} type="button" class={styles.clear} aria-label="Clear selection" onMouseDown={event => event.preventDefault()} onClick={clear}>
              <X size={16} stroke-width={1.75} aria-hidden="true" />
            </button>
          )}
        </Presence>
        <ChevronDown class={styles.chevron} size={16} stroke-width={1.75} aria-hidden="true" />
      </div>
      <Presence
        when={open()}
        enter={el => prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant)) : animate(el, { opacity: [0, 1], y: [-6, 0], scale: [0.97, 1] }, { ...spring.snappy, opacity: tween(motionTokens.duration.fast, motionTokens.ease.enter) })}
        exit={el => animate(el, prefersReducedMotion() ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }, tween(motionTokens.duration.instant))}
      >
        {ref => (
          <div ref={el => { ref(el); useSquircle(el); }} class={styles.popover} role="presentation">
            <div ref={frame} class={styles.autoHeight}>
              <div ref={el => {
                inner = el;
                const observer = new ResizeObserver(follow);
                observer.observe(el);
                onCleanup(() => observer.disconnect());
              }}>
                <div ref={listbox} id={listboxId()} class={styles.listbox} role="listbox" aria-label={`${props.label} options`}>
                  <Show when={filtered().length} fallback={<div class={styles.empty} role="status">{props.emptyMessage ?? "No matches found"}</div>}>
                    <For each={filtered()}>
                      {(option, index) => (
                        <div
                          ref={el => { optionEls.set(option.value, el); onCleanup(() => optionEls.delete(option.value)); }}
                          id={`${controlId()}-option-${option.value}`}
                          class={styles.option}
                          data-active={index() === activeIndex() ? "true" : undefined}
                          data-disabled={option.disabled ? "true" : undefined}
                          role="option"
                          aria-selected={option.value === selectedValue()}
                          aria-disabled={option.disabled || undefined}
                          onMouseDown={event => event.preventDefault()}
                          onMouseEnter={() => !option.disabled && setActiveIndex(index())}
                          onClick={() => choose(option)}
                        >
                          <span class={styles.optionLabel}>{option.label}</span>
                          <Show when={option.meta}><span class={styles.meta}>{option.meta}</span></Show>
                          <Show when={option.value === selectedValue()}><Check class={styles.check} size={16} stroke-width={1.75} aria-hidden="true" /></Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </div>
        )}
      </Presence>
      </div>
      <FieldMessage id={hintId()} text={props.description} />
      <FieldMessage id={errorId()} text={props.error} tone="error" alert />
      <Show when={props.name}><input type="hidden" name={props.name} value={selectedValue()} /></Show>
    </div>
  );
}

export default Combobox;

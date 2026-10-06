import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js";
import { CalendarDays, ChevronDown } from "lucide-solid";
import { Calendar, monthStart, type CalendarDateMatcher } from "../calendar/calendar";
import { FieldMessage } from "../lib/FieldMessage";
import { Presence, Swap, SwapText } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./date-picker.module.css";

export interface DatePickerProps {
  label: string;
  value?: Date;
  onChange?: (date: Date | undefined) => void;
  description?: string;
  error?: string | null;
  placeholder?: string;
  minDate?: Date;
  maxDate?: Date;
  disabledDates?: CalendarDateMatcher;
  locale?: string;
  format?: Intl.DateTimeFormatOptions;
  /** Adds a Today button to the calendar header. */
  showToday?: boolean;
  /** Lets the calendar title open a year grid (date of birth). */
  yearPicker?: boolean;
  /** Hide the Clear action when a value is required. */
  required?: boolean;
  disabled?: boolean;
  id?: string;
  class?: string;
}

/**
 * Arc DatePicker: a field that opens a calendar. Each part of the date rolls with time (a later date rises from below),
 * the popover grows from the field, and a picked day lets the disc glide onto it before the calendar returns focus.
 */
export function DatePicker(props: DatePickerProps) {
  const uid = createUniqueId();
  const controlId = () => props.id ?? `date-${uid}`;
  const hintId = () => (props.description ? `${controlId()}-description` : undefined);
  const errorId = () => (props.error ? `${controlId()}-error` : undefined);
  const [open, setOpen] = createSignal(false);
  const [month, setMonth] = createSignal(monthStart(props.value ?? new Date()));
  const [direction, setDirection] = createSignal(1);
  let rootEl: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  let closeTimer: number | undefined;
  const formatter = createMemo(() => new Intl.DateTimeFormat(props.locale ?? "en-US", props.format ?? { month: "short", day: "numeric", year: "numeric" }));
  const time = () => props.value?.getTime() ?? null;
  createEffect(on(time, (next, previous) => { if (previous !== undefined) setDirection(next === null || previous === null || next >= previous ? 1 : -1); }));
  const shown = () => (props.value ? formatter().format(props.value) : props.placeholder ?? "Select a date");
  const parts = () => (props.value ? formatter().formatToParts(props.value) : []);

  onMount(() => {
    const down = (event: PointerEvent) => { if (!rootEl?.contains(event.target as Node)) { window.clearTimeout(closeTimer); setOpen(false); } };
    document.addEventListener("pointerdown", down);
    onCleanup(() => { document.removeEventListener("pointerdown", down); window.clearTimeout(closeTimer); });
  });
  createEffect(on(open, isOpen => {
    if (isOpen) queueMicrotask(() => popover?.querySelector<HTMLButtonElement>('[data-present] [data-date][tabindex="0"]')?.focus({ preventScroll: true }));
  }, { defer: true }));

  const close = () => {
    window.clearTimeout(closeTimer);
    if (popover?.contains(document.activeElement)) trigger?.focus();
    setOpen(false);
  };
  const show = () => { window.clearTimeout(closeTimer); setMonth(monthStart(props.value ?? new Date())); setOpen(true); };
  const selectDate = (date: Date | undefined) => {
    props.onChange?.(date);
    window.clearTimeout(closeTimer);
    if (prefersReducedMotion() || !date) close();
    else closeTimer = window.setTimeout(close, 300);
  };
  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if ((event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") && !open()) { event.preventDefault(); show(); }
    if (event.key === "Escape") close();
  };
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (open() && next && !rootEl?.contains(next)) { window.clearTimeout(closeTimer); setOpen(false); }
  };
  const roll = {
    enter: (el: HTMLElement) => prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant)) : animate(el, { opacity: [0, 1], y: [`${direction() * 0.35}em`, "0em"], filter: ["blur(4px)", "blur(0px)"] }, tween(motionTokens.duration.standard, motionTokens.ease.enter)),
    exit: (el: HTMLElement) => prefersReducedMotion() ? animate(el, { opacity: 0 }, tween(motionTokens.duration.instant)) : animate(el, { opacity: 0, y: `${direction() * -0.3}em`, filter: "blur(2px)" }, tween(0.14)),
  };

  return (
    <div ref={rootEl} class={[styles.field, props.class ?? ""].join(" ")} onFocusOut={onFocusOut}>
      <label class={styles.label} for={controlId()}>{props.label}</label>
      <div class={styles.anchor}>
        <button
          ref={el => { trigger = el; useSquircle(el); }}
          id={controlId()}
          type="button"
          disabled={props.disabled}
          aria-haspopup="dialog"
          aria-expanded={open()}
          aria-describedby={[hintId(), errorId()].filter(Boolean).join(" ") || undefined}
          aria-invalid={props.error ? true : undefined}
          class={styles.trigger}
          onClick={() => (open() ? close() : show())}
          onKeyDown={onTriggerKeyDown}
        >
          <CalendarDays size={16} stroke-width={1.75} aria-hidden="true" />
          <span class="sr-only">{shown()}</span>
          <span class={styles.valueText} aria-hidden="true">
            <Show when={props.value} fallback={<span class={styles.placeholder}>{props.placeholder ?? "Select a date"}</span>}>
              <span class={styles.value}>
                <For each={parts()}>
                  {part => (
                    <span class={styles.part}>
                      {part.type === "literal"
                        ? <span class={styles.partValue}>{part.value}</span>
                        : <Swap value={part.value} class={styles.partValue} enter={roll.enter} exit={roll.exit}>{text => text}</Swap>}
                    </span>
                  )}
                </For>
              </span>
            </Show>
          </span>
          <ChevronDown class={styles.chevron} size={16} stroke-width={1.75} aria-hidden="true" />
        </button>
        <Presence
          when={open()}
          enter={el => prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant)) : animate(el, { opacity: [0, 1], y: [-8, 0], scale: [0.95, 1] }, { ...spring.snappy, opacity: tween(motionTokens.duration.fast, motionTokens.ease.enter) })}
          exit={el => animate(el, prefersReducedMotion() ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }, tween(0.14))}
        >
          {ref => (
            <div
              ref={el => { popover = el; ref(el); useSquircle(el); }}
              class={styles.popover}
              role="dialog"
              aria-label={`${props.label} calendar`}
              onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}
            >
              <Calendar value={props.value} onChange={selectDate} month={month()} onMonthChange={setMonth} minDate={props.minDate} maxDate={props.maxDate} disabledDates={props.disabledDates} locale={props.locale} showToday={props.showToday} yearPicker={props.yearPicker} />
              <div class={styles.footer}>
                <Show when={!props.required} fallback={<span />}>
                  <button type="button" onClick={() => selectDate(undefined)} disabled={!props.value}>Clear</button>
                </Show>
                <span class={styles.status}><SwapText text={props.value ? `Selected ${formatter().format(props.value)}` : "Choose a day"} /></span>
              </div>
            </div>
          )}
        </Presence>
      </div>
      <FieldMessage id={hintId()} text={props.description} />
      <FieldMessage id={errorId()} text={props.error} tone="error" alert />
    </div>
  );
}

export default DatePicker;

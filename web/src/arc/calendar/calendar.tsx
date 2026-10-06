import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack } from "solid-js";
import { ChevronLeft, ChevronRight } from "lucide-solid";
import { cx } from "../lib/cx";
import { Swap } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween, type AnimationControls } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./calendar.module.css";

export type CalendarDateMatcher = (date: Date) => boolean;

export interface CalendarProps {
  value?: Date;
  onChange?: (date: Date) => void;
  month?: Date;
  onMonthChange?: (month: Date) => void;
  minDate?: Date;
  maxDate?: Date;
  disabledDates?: CalendarDateMatcher;
  locale?: string;
  class?: string;
  /** Adds a Today button that slides back to the current month and selects today when it is available. */
  showToday?: boolean;
  /** Lets the title open a year grid, for dates far from today such as a date of birth. */
  yearPicker?: boolean;
}

export const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
export const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
export const sameDay = (a?: Date, b?: Date) => Boolean(a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate());
const sameMonth = (a?: Date, b?: Date) => Boolean(a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth());
export const addDays = (date: Date, amount: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
export const addMonths = (date: Date, amount: number) => new Date(date.getFullYear(), date.getMonth() + amount, 1);
/** Moves by whole months and keeps the day, clamped to the shorter month: January 31 plus one month is February 28. */
const shiftMonths = (date: Date, amount: number) => new Date(date.getFullYear(), date.getMonth() + amount, Math.min(date.getDate(), new Date(date.getFullYear(), date.getMonth() + amount + 1, 0).getDate()));
const isBefore = (a: Date, b?: Date) => Boolean(b && startOfDay(a).getTime() < startOfDay(b).getTime());
const isAfter = (a: Date, b?: Date) => Boolean(b && startOfDay(a).getTime() > startOfDay(b).getTime());
export const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
/** Parses "YYYY-MM-DD" (the API's date format) as a local calendar date. Returns undefined for anything else. */
export function fromDateKey(key: string | null | undefined): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? "");
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dateKey(date) === key ? date : undefined;
}
/** Every month shows six weeks, so the grid keeps one height and never jumps while months change. */
const makeWeeks = (month: Date) => {
  const start = addDays(month, -month.getDay());
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)));
};
const monthIndex = (date: Date) => date.getFullYear() * 12 + date.getMonth();
const fromIndex = (index: number) => new Date(Math.floor(index / 12), ((index % 12) + 12) % 12, 1);
/** Months sit side by side on one strip. Rapid clicks retarget the same spring, so the strip never queues panes. */
const stripSpring = { type: "spring", visualDuration: 0.36, bounce: 0, restDelta: 0.002 } as const;

/** The viewer's local date, following it across midnight and when the tab returns. */
export function createToday() {
  const [today, setToday] = createSignal(startOfDay(new Date()));
  const refresh = () => {
    const now = startOfDay(new Date());
    if (now.getTime() !== untrack(today).getTime()) setToday(now);
  };
  let timer = 0;
  const schedule = () => {
    const now = new Date();
    timer = window.setTimeout(() => { refresh(); schedule(); }, addDays(startOfDay(now), 1).getTime() - now.getTime() + 1000);
  };
  schedule();
  const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", refresh);
  onCleanup(() => {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", refresh);
  });
  return today;
}

/** The selected disc of one month, positioned by week and weekday so it glides on a straight line between days. */
function SelectionDisc(props: { cell: () => number }) {
  let el: HTMLSpanElement | undefined;
  let hidden = true;
  const state = { col: 0, row: 0, scale: 0.6, opacity: 0 };
  const paint = () => {
    if (!el) return;
    el.style.transform = `translate(calc(${state.col} * (100% + 4px)), calc(${state.row} * (100% + 4px))) scale(${state.scale})`;
    el.style.opacity = String(state.opacity);
  };
  const running: AnimationControls[] = [];
  const to = (key: keyof typeof state, value: number, transition: object) => {
    running.push(animate(state[key], value, { ...transition, onUpdate: (next: number) => { state[key] = next; paint(); } }));
  };
  createEffect(on(props.cell, cell => {
    running.splice(0).forEach(controls => controls.stop());
    const reduce = prefersReducedMotion();
    if (cell < 0) {
      hidden = true;
      const fade = reduce ? { duration: 0 } : tween(0.14);
      to("opacity", 0, fade);
      to("scale", 0.6, fade);
      return;
    }
    const col = cell % 7;
    const row = Math.floor(cell / 7);
    if (hidden || reduce) { state.col = col; state.row = row; paint(); }
    else { to("col", col, spring.morph); to("row", row, spring.morph); }
    hidden = false;
    to("opacity", 1, reduce ? { duration: 0 } : tween(motionTokens.duration.fast, motionTokens.ease.enter));
    to("scale", 1, reduce ? { duration: 0 } : spring.snappy);
  }));
  onMount(paint);
  return <span ref={el} class={styles.highlight} aria-hidden="true"><span ref={node => useSquircle(node, { mode: "clip" })} class={styles.highlightFill} /></span>;
}

/**
 * Arc Calendar: months slide on one strip, the selected disc glides between days, and keyboard navigation follows the
 * grid (arrows, Home, End, PageUp/PageDown, Shift for years). With `yearPicker`, the title opens a year grid.
 */
export function Calendar(props: CalendarProps) {
  const titleId = createUniqueId();
  const today = createToday();
  const locale = () => props.locale ?? "en-US";
  const [internalMonth, setInternalMonth] = createSignal(monthStart(untrack(() => props.value) ?? new Date()));
  const [focusedDate, setFocusedDate] = createSignal<Date | undefined>(untrack(() => props.value));
  const [years, setYears] = createSignal(false);
  const month = () => (props.month ? monthStart(props.month) : internalMonth());
  const [direction, setDirection] = createSignal(0);
  createEffect(on(() => month().getTime(), (time, previous) => { setDirection(previous === undefined ? 0 : time > previous ? 1 : -1); }));
  const target = () => monthIndex(month());

  /* The strip position is measured in months. The panes on either side of it render, plus the month being navigated to. */
  let position = untrack(target);
  const [span, setSpan] = createSignal<[number, number]>([position, position]);
  const paneEls = new Map<number, HTMLDivElement>();
  const paintPanes = () => {
    for (const [index, el] of paneEls) {
      const offset = index - position;
      el.style.transform = `translateX(calc(${offset * 100}% + ${offset * 16}px))`;
      el.style.opacity = String(1 - Math.min(1, Math.abs(offset)) * 0.6);
    }
  };
  const setPosition = (value: number) => {
    position = value;
    const next: [number, number] = [Math.floor(value + 1e-3), Math.ceil(value - 1e-3)];
    const current = untrack(span);
    if (current[0] !== next[0] || current[1] !== next[1]) setSpan(next);
    paintPanes();
  };
  let strip: AnimationControls | undefined;
  createEffect(on(target, goal => {
    if (position === goal) return;
    strip?.stop();
    if (prefersReducedMotion()) { setPosition(goal); return; }
    // Long jumps (Today, a year with Shift) start one month away, so the strip never scrolls through the months between.
    if (Math.abs(goal - position) > 2) setPosition(goal - Math.sign(goal - position));
    strip = animate(position, goal, { ...stripSpring, onUpdate: setPosition });
  }, { defer: true }));
  const paneIndexes = createMemo(() => Array.from(new Set([span()[0], span()[1], target()])).sort((a, b) => a - b));

  const formatter = createMemo(() => new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric" }));
  const weekdays = createMemo(() => {
    const format = new Intl.DateTimeFormat(locale(), { weekday: "short" });
    return Array.from({ length: 7 }, (_, index) => format.format(new Date(2024, 0, 7 + index)));
  });
  const monthLabel = () => formatter().format(month());
  const isDisabled = (date: Date) => isBefore(date, props.minDate) || isAfter(date, props.maxDate) || Boolean(props.disabledDates?.(date));
  const previousDisabled = () => Boolean(props.minDate && addMonths(month(), -1).getTime() < monthStart(props.minDate).getTime());
  const nextDisabled = () => Boolean(props.maxDate && addMonths(month(), 1).getTime() > monthStart(props.maxDate).getTime());
  const todaySelectable = () => !isDisabled(today()) && !!props.onChange;
  const todayIdle = () => sameMonth(month(), today()) && (!todaySelectable() || sameDay(props.value, today()));
  // Roving tab stop: the day last focused, else the selection, else today, else the first open day of the month.
  const tabbableKey = () => {
    const open = (date?: Date) => (date && sameMonth(date, month()) && !isDisabled(date) ? dateKey(date) : "");
    return open(focusedDate()) || open(props.value) || open(today()) || dateKey(makeWeeks(month()).flat().find(date => sameMonth(date, month()) && !isDisabled(date)) ?? new Date(0));
  };
  const changeMonth = (next: Date) => {
    const normalized = monthStart(next);
    if (!props.month) setInternalMonth(normalized);
    props.onMonthChange?.(normalized);
  };

  let viewport: HTMLDivElement | undefined;
  let focusRequest: string | null = null;
  const requestFocus = (key: string) => {
    focusRequest = key;
    queueMicrotask(() => {
      const button = viewport?.querySelector<HTMLButtonElement>(`[data-present] [data-date="${focusRequest}"]`);
      if (button) { focusRequest = null; button.focus({ preventScroll: true }); }
    });
  };
  const moveFocus = (from: Date, goal: Date, step: number) => {
    let next = isBefore(goal, props.minDate) && props.minDate ? startOfDay(props.minDate) : isAfter(goal, props.maxDate) && props.maxDate ? startOfDay(props.maxDate) : goal;
    for (let tries = 0; tries < 42 && isDisabled(next); tries += 1) next = addDays(next, step);
    if (isDisabled(next) || sameDay(next, from)) return;
    setFocusedDate(next);
    if (!sameMonth(next, month())) changeMonth(next);
    requestFocus(dateKey(next));
  };
  const onDayKeyDown = (event: KeyboardEvent, date: Date) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!isDisabled(date)) props.onChange?.(date);
      return;
    }
    const moves: Record<string, [Date, number]> = {
      ArrowLeft: [addDays(date, -1), -1],
      ArrowRight: [addDays(date, 1), 1],
      ArrowUp: [addDays(date, -7), -1],
      ArrowDown: [addDays(date, 7), 1],
      Home: [addDays(date, -date.getDay()), 1],
      End: [addDays(date, 6 - date.getDay()), -1],
      PageUp: [shiftMonths(date, event.shiftKey ? -12 : -1), -1],
      PageDown: [shiftMonths(date, event.shiftKey ? 12 : 1), 1],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    moveFocus(date, move[0], move[1]);
  };
  const goToToday = () => {
    if (todayIdle()) return;
    setFocusedDate(today());
    if (!sameMonth(today(), month())) changeMonth(today());
    if (todaySelectable() && !sameDay(props.value, today())) props.onChange?.(today());
  };
  const cellOf = (paneMonth: Date) => {
    if (!props.value) return -1;
    const first = addDays(paneMonth, -paneMonth.getDay());
    const index = Math.round((startOfDay(props.value).getTime() - first.getTime()) / 864e5);
    return index >= 0 && index < 42 ? index : -1;
  };

  /* Year grid (for dates far away, such as a date of birth). */
  const yearRange = createMemo(() => {
    const min = props.minDate?.getFullYear() ?? today().getFullYear() - 120;
    const max = props.maxDate?.getFullYear() ?? today().getFullYear() + 10;
    return Array.from({ length: max - min + 1 }, (_, index) => max - index);
  });
  let yearList: HTMLDivElement | undefined;
  createEffect(on(years, open => {
    if (!open) return;
    queueMicrotask(() => {
      const current = yearList?.querySelector<HTMLButtonElement>(`[data-year="${month().getFullYear()}"]`);
      if (current && yearList) {
        yearList.scrollTop = current.offsetTop - yearList.clientHeight / 2 + current.offsetHeight / 2;
        current.focus({ preventScroll: true });
      }
    });
  }));
  const pickYear = (year: number) => {
    const current = month();
    changeMonth(new Date(year, current.getMonth(), 1));
    setYears(false);
  };

  return (
    <section class={cx(styles.calendar, props.class)} aria-labelledby={`cal-${titleId}`}>
      <div class={styles.header}>
        <h2 id={`cal-${titleId}`} class={styles.heading}>
          <span class="sr-only">{monthLabel()}</span>
          <Show when={props.yearPicker} fallback={
            <span class={styles.title} aria-hidden="true">
              <Swap
                value={monthLabel()}
                class={styles.titleRow}
                enter={el => (prefersReducedMotion() || !direction() ? undefined : animate(el, { opacity: [0, 1], x: [direction() * 12, 0] }, tween(motionTokens.duration.standard, motionTokens.ease.enter)))}
                exit={el => (prefersReducedMotion() || !direction() ? animate(el, { opacity: 0 }, { duration: 0 }) : animate(el, { opacity: 0, x: direction() * -12 }, tween(0.14)))}
              >
                {text => text}
              </Swap>
            </span>
          }>
            <button type="button" class={styles.titleButton} aria-expanded={years()} aria-label={`${monthLabel()}, choose a year`} onClick={() => setYears(!years())}>
              <span class={styles.title} aria-hidden="true">
                <Swap
                  value={monthLabel()}
                  class={styles.titleRow}
                  enter={el => (prefersReducedMotion() || !direction() ? undefined : animate(el, { opacity: [0, 1], x: [direction() * 12, 0] }, tween(motionTokens.duration.standard, motionTokens.ease.enter)))}
                  exit={el => (prefersReducedMotion() || !direction() ? animate(el, { opacity: 0 }, { duration: 0 }) : animate(el, { opacity: 0, x: direction() * -12 }, tween(0.14)))}
                >
                  {text => text}
                </Swap>
              </span>
              <ChevronRight class={styles.titleChevron} size={14} stroke-width={1.75} aria-hidden="true" data-open={years() || undefined} />
            </button>
          </Show>
        </h2>
        <span class="sr-only" aria-live="polite">{direction() ? monthLabel() : ""}</span>
        <div class={styles.navigation}>
          <Show when={props.showToday}>
            <button type="button" class={styles.todayButton} aria-disabled={todayIdle() || undefined} aria-label={`Today, ${today().toLocaleDateString(locale(), { dateStyle: "full" })}`} onClick={goToToday}>Today</button>
          </Show>
          <button type="button" class={styles.navButton} aria-label="Previous month" aria-disabled={previousDisabled() || undefined} onClick={() => { if (!previousDisabled()) changeMonth(addMonths(month(), -1)); }}><ChevronLeft size={16} stroke-width={1.75} aria-hidden="true" /></button>
          <button type="button" class={styles.navButton} aria-label="Next month" aria-disabled={nextDisabled() || undefined} onClick={() => { if (!nextDisabled()) changeMonth(addMonths(month(), 1)); }}><ChevronRight size={16} stroke-width={1.75} aria-hidden="true" /></button>
        </div>
      </div>
      <div class={styles.body}>
        <div class={styles.weekdays} aria-hidden="true"><For each={weekdays()}>{day => <span>{day.slice(0, 2)}</span>}</For></div>
        <div class={styles.monthViewport} ref={viewport}>
          <For each={paneIndexes()}>
            {index => {
              const paneMonth = fromIndex(index);
              const present = () => index === target();
              return (
                <div
                  ref={el => { paneEls.set(index, el); paintPanes(); onCleanup(() => paneEls.delete(index)); }}
                  class={styles.monthBody}
                  data-present={present() || undefined}
                  aria-hidden={present() ? undefined : true}
                  inert={!present()}
                >
                  <SelectionDisc cell={() => cellOf(paneMonth)} />
                  <div class={styles.grid} role="grid" aria-label={formatter().format(paneMonth)}>
                    <For each={makeWeeks(paneMonth)}>
                      {week => (
                        <div class={styles.week} role="row">
                          <For each={week}>
                            {date => {
                              const key = dateKey(date);
                              const selected = () => sameDay(date, props.value);
                              const isToday = () => sameDay(date, today());
                              return (
                                <button
                                  type="button"
                                  role="gridcell"
                                  data-date={key}
                                  aria-label={date.toLocaleDateString(locale(), { dateStyle: "full" })}
                                  aria-selected={selected()}
                                  aria-current={isToday() ? "date" : undefined}
                                  tabIndex={present() && key === tabbableKey() ? 0 : -1}
                                  disabled={isDisabled(date)}
                                  class={cx(styles.day, !sameMonth(date, paneMonth) && styles.outside, selected() && styles.selected, isToday() && styles.today)}
                                  onFocus={() => setFocusedDate(date)}
                                  onKeyDown={event => onDayKeyDown(event, date)}
                                  onClick={() => props.onChange?.(date)}
                                >
                                  <span class={styles.dayNumber}>{date.getDate()}</span>
                                </button>
                              );
                            }}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={years()}>
          <div ref={yearList} class={styles.years} role="listbox" aria-label="Year" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setYears(false); } }}>
            <For each={yearRange()}>
              {year => (
                <button type="button" role="option" data-year={year} aria-selected={year === month().getFullYear()} class={styles.year} onClick={() => pickYear(year)}>{year}</button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </section>
  );
}

export default Calendar;

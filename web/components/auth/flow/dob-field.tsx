"use client";

/**
 * The date of birth field of the sign-up page: Arc's date picker look (its trigger, popover and calendar), with a
 * year grid behind the month title, because a date of birth is usually decades away from the prefilled one and
 * nobody should page back month by month. The month title opens the years; picking one returns to its days.
 *
 * Arc's DatePicker has no year view yet (a request to the foundation); this composes Arc's Calendar with the
 * DatePicker's own styles so it looks and moves the same.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import calendarStyles from "@/components/arc/calendar/calendar.module.css";
import { Calendar } from "@/components/arc/calendar/calendar";
import pickerStyles from "@/components/arc/date-picker/date-picker.module.css";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import { FieldNote } from "./parts";
import styles from "./dob-field.module.css";

const { duration, ease, spring } = motionTokens;

/** "YYYY-MM-DD" for a local date. */
export const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
/** The local date of a "YYYY-MM-DD" key, or undefined. */
export function fromDateKey(key: string | null | undefined): Date | undefined {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return undefined;
  const [year = 0, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}
const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
const monthIndex = (date: Date) => date.getFullYear() * 12 + date.getMonth();

export interface DobFieldProps {
  label: string;
  /** "YYYY-MM-DD" or null. */
  value: string | null;
  onChange: (value: string | null) => void;
  minDate: Date;
  maxDate: Date;
  description?: string;
  error?: string | null;
}

export function DobField({ label, value, onChange, minDate, maxDate, description, error }: DobFieldProps) {
  const id = useId();
  const reduce = !!useReducedMotion();
  const date = fromDateKey(value);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"days" | "years">("days");
  const [month, setMonth] = useState(() => monthStart(date ?? maxDate));
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const years = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const formatter = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric" });
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(month);
  const hintId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const firstYear = minDate.getFullYear();
  const lastYear = maxDate.getFullYear();
  const yearList = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => lastYear - index);
  const previousDisabled = monthIndex(month) <= monthIndex(minDate);
  const nextDisabled = monthIndex(month) >= monthIndex(maxDate);

  const close = (returnFocus: boolean) => {
    window.clearTimeout(closeTimer.current);
    if (returnFocus && popover.current?.contains(document.activeElement)) trigger.current?.focus();
    setOpen(false);
  };
  const show = () => {
    window.clearTimeout(closeTimer.current);
    setMonth(monthStart(date ?? maxDate));
    setView("days");
    setOpen(true);
  };
  /** A picked day lets the highlight glide onto it, then the calendar returns to the field. */
  const select = (next: Date | undefined) => {
    onChange(next ? dateKey(next) : null);
    window.clearTimeout(closeTimer.current);
    if (reduce || !next) close(true);
    else closeTimer.current = window.setTimeout(() => close(true), 300);
  };
  const pickYear = (year: number) => {
    const target = new Date(year, month.getMonth(), 1);
    const clamped = monthIndex(target) < monthIndex(minDate) ? monthStart(minDate) : monthIndex(target) > monthIndex(maxDate) ? monthStart(maxDate) : target;
    setMonth(clamped);
    setView("days");
  };

  // Outside presses close it; so does focus leaving the field.
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [open]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Opening moves focus into the view: the selected (or first open) day, or the selected year in the year grid.
  const shownMonth = useRef(month);
  useEffect(() => {
    shownMonth.current = month;
  });
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      // Near the bottom of the screen (a phone, a long form) the calendar would open below the fold.
      popover.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      if (view === "years") {
        const list = years.current;
        const selected = list?.querySelector<HTMLButtonElement>(`[data-year="${shownMonth.current.getFullYear()}"]`);
        if (list && selected) {
          list.scrollTop = selected.offsetTop - list.clientHeight / 2 + selected.offsetHeight / 2;
          selected.focus({ preventScroll: true });
        }
      } else {
        popover.current?.querySelector<HTMLButtonElement>('[data-present] [data-date][tabindex="0"]')?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, view, reduce]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") && !open) {
      event.preventDefault();
      show();
    }
    if (event.key === "Escape") close(true);
  };

  /** Arrow keys move through the year grid (four to a row). */
  const onYearKeyDown = (event: KeyboardEvent<HTMLButtonElement>, year: number) => {
    const moves: Record<string, number> = { ArrowLeft: 1, ArrowRight: -1, ArrowUp: 4, ArrowDown: -4 };
    const step = moves[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = Math.min(lastYear, Math.max(firstYear, year + step));
    years.current?.querySelector<HTMLButtonElement>(`[data-year="${next}"]`)?.focus();
  };

  return (
    <div
      ref={root}
      className={`${pickerStyles.field} ${styles.field}`}
      onBlur={event => {
        const next = event.relatedTarget as Node | null;
        if (open && next && !root.current?.contains(next)) close(false);
      }}
    >
      <label className={pickerStyles.label} htmlFor={id}>{label}</label>
      <div className={pickerStyles.anchor}>
        <button
          ref={trigger}
          id={id}
          type="button"
          className={pickerStyles.trigger}
          data-sq="surface"
          data-invalid={error ? "" : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
          onClick={() => (open ? close(true) : show())}
          onKeyDown={onTriggerKeyDown}
        >
          <CalendarDays size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles.value}>{date ? formatter.format(date) : "Pick your date of birth"}</span>
          <ChevronDown className={pickerStyles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <AnimatePresence>
          {open ? (
            <motion.div
              ref={popover}
              className={`${pickerStyles.popover} ${styles.popover}`}
              data-sq="surface"
              role="dialog"
              aria-label={`${label}: choose a day`}
              onKeyDown={event => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  if (view === "years") setView("days");
                  else close(true);
                }
              }}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: reduce ? { duration: duration.instant } : { ...spring.snappy, opacity: { duration: duration.fast, ease: [...ease.enter] } } }}
              exit={{ opacity: 0, ...(reduce ? {} : { y: -6, scale: 0.97 }), transition: { duration: 0.14, ease: [...ease.standard] } }}
            >
              <div className={styles.header}>
                <button type="button" className={styles.titleButton} aria-expanded={view === "years"} aria-label={`${monthLabel}, choose a year`} onClick={() => setView(view === "years" ? "days" : "years")}>
                  <span aria-live="polite">{monthLabel}</span>
                  <ChevronDown className={styles.titleChevron} data-open={view === "years" || undefined} size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
                {view === "days" ? (
                  <div className={calendarStyles.navigation}>
                    <button type="button" className={calendarStyles.navButton} aria-label="Previous month" aria-disabled={previousDisabled || undefined} onClick={() => { if (!previousDisabled) setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1)); }}>
                      <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                    <button type="button" className={calendarStyles.navButton} aria-label="Next month" aria-disabled={nextDisabled || undefined} onClick={() => { if (!nextDisabled) setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1)); }}>
                      <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
              {view === "days" ? (
                <div className={styles.days}>
                  <Calendar value={date} onChange={select} month={month} onMonthChange={next => setMonth(monthStart(next))} minDate={minDate} maxDate={maxDate} locale="en-US" />
                </div>
              ) : (
                <div ref={years} className={styles.years} role="listbox" aria-label="Year">
                  {yearList.map(year => (
                    <button
                      key={year}
                      type="button"
                      role="option"
                      data-year={year}
                      aria-selected={year === month.getFullYear()}
                      tabIndex={year === month.getFullYear() ? 0 : -1}
                      className={styles.year}
                      data-sq="surface"
                      onClick={() => pickYear(year)}
                      onKeyDown={event => onYearKeyDown(event, year)}
                    >
                      {year}
                    </button>
                  ))}
                </div>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      {description && !error ? <span id={hintId} className={pickerStyles.description}>{description}</span> : null}
      <FieldNote id={errorId} text={error} tone="error" alert />
    </div>
  );
}

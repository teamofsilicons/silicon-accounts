import { ChevronDown } from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { Presence, Swap } from "../lib/presence";
import { animate, instant, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { cx } from "../lib/cx";
import styles from "./timeline.module.css";

export interface TimelineEvent {
  id: string;
  /** When it happened, as an ISO string or epoch milliseconds. */
  at: string | number;
  /** Who did it, shown first in the foreground colour. */
  actor?: string;
  /** What happened, completing the actor: "signed in to Briefcase". */
  title: string;
  /** Short context under the title. */
  meta?: string;
  /** Revealed in place when the row is expanded. Rows without detail are not interactive. */
  detail?: () => JSX.Element;
  /** Portrait for an event by a person. */
  avatar?: string;
  /** Icon for a system event, used when there is no avatar. */
  icon?: () => JSX.Element;
  /** Status of a system event. Always say the outcome in the title too, so it never rests on colour. */
  tone?: "neutral" | "success" | "danger";
}

export interface TimelineProps {
  /** Updates in any order; the newest shows first. */
  events: TimelineEvent[];
  /** Reference time for relative labels and day groups, in epoch milliseconds. Pass a ticking clock to keep labels fresh. */
  now: number;
  /** Accessible name for the feed. */
  label: string;
  /** Time zone for day groups and clock times. Defaults to the browser's. */
  timeZone?: string;
  locale?: string;
  /** Height of the scrolling area. Without it the feed grows with the page and reveals on page scroll. */
  maxHeight?: number | string;
  /** Scroll back to the top when a new update arrives while the feed is scrolled down. */
  scrollToNew?: boolean;
  defaultExpanded?: string[];
  /** Heading level for the day labels. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  class?: string;
}

interface Row extends TimelineEvent { time: number; day: string }

const HOUR = 3_600_000;
/** Seconds between rows revealed together, so the line reads as drawing downward. */
const STEP = 0.09;

function dayKey(time: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(time));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function relative(time: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return { short: "Now", long: "just now" };
  if (minutes < 60) return { short: `${minutes}m`, long: `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago` };
  const hours = Math.floor(minutes / 60);
  return { short: `${hours}h`, long: `${hours} ${hours === 1 ? "hour" : "hours"} ago` };
}

/** Text that changes in place: the new value rises in from a soft blur while the old one lifts away. */
function RiseText(props: { text: string; direction?: number }) {
  const dir = () => props.direction ?? 1;
  return (
    <span class={styles.rise} aria-hidden="true">
      <Swap
        value={props.text}
        class={styles.riseLine}
        enter={el => prefersReducedMotion()
          ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant))
          : animate(el, { opacity: [0, 1], y: [`${0.3 * dir()}em`, "0em"], filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"] }, tween(motionTokens.duration.standard, motionTokens.ease.enter))}
        exit={el => prefersReducedMotion()
          ? animate(el, { opacity: 0 }, instant)
          : animate(el, { opacity: 0, y: `${-0.3 * dir()}em`, filter: `blur(${motionTokens.blur.subtle}px)` }, tween(motionTokens.duration.fast))}
      >
        {text => text}
      </Swap>
    </span>
  );
}

/** The day's update count rolls digit by digit in the direction it moved. */
function RollingCount(props: { value: number }) {
  const [direction, setDirection] = createSignal(1);
  createEffect(on(() => props.value, (next, previous) => { if (previous !== undefined) setDirection(next > previous ? 1 : -1); }));
  const chars = () => [...String(props.value)];
  return (
    <span class={styles.rolling} aria-hidden="true">
      <For each={chars().map((_, index, all) => all.length - index)}>
        {place => <span class={styles.place}><RiseText text={chars()[chars().length - place] ?? ""} direction={direction()} /></span>}
      </For>
    </span>
  );
}

/**
 * Arc Timeline: a vertical activity feed grouped by day. Day labels stay pinned while their updates scroll, the
 * connecting line draws itself as rows come into view, rows expand in place, and new updates slide in at the top
 * while the rest glide down. Arrow keys move between rows, Enter or Space expands one.
 */
export function Timeline(props: TimelineProps) {
  const id = createUniqueId();
  const timeZone = () => props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const locale = () => props.locale ?? "en-US";
  const [expanded, setExpanded] = createSignal(new Set(untrack(() => props.defaultExpanded ?? [])));
  const [announcement, setAnnouncement] = createSignal("");
  let scroller: HTMLDivElement | undefined;
  let track: HTMLDivElement | undefined;

  // Rows added after the first render are fresh: they slide in and the rest glide down. Their titles are announced.
  const known = new Set(untrack(() => props.events.map(event => event.id)));
  const fresh = new Set<string>();
  const initialDays = new Set(untrack(() => props.events.map(event => dayKey(new Date(event.at).getTime(), timeZone()))));
  createEffect(on(() => props.events, events => {
    const added = events.filter(event => !known.has(event.id));
    for (const event of added) { known.add(event.id); fresh.add(event.id); }
    if (added.length) setAnnouncement(`New update: ${added.map(event => [event.actor, event.title].filter(Boolean).join(" ")).join(". ")}`);
  }, { defer: true }));

  const rows = createMemo(() => props.events
    .map(event => ({ ...event, time: new Date(event.at).getTime(), day: "" }))
    .sort((a, b) => b.time - a.time)
    .map(row => ({ ...row, day: dayKey(row.time, timeZone()) }) as Row));
  const byId = createMemo(() => new Map(rows().map(row => [row.id, row])));
  const days = createMemo(() => [...new Set(rows().map(row => row.day))], undefined, { equals: (a, b) => a.length === b.length && a.every((value, index) => value === b[index]) });
  const rowsOf = (day: string) => rows().filter(row => row.day === day);
  const formats = createMemo(() => ({
    clock: new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit", timeZone: timeZone() }),
    full: new Intl.DateTimeFormat(locale(), { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timeZone() }),
    heading: new Intl.DateTimeFormat(locale(), { weekday: "long", month: "long", day: "numeric", timeZone: timeZone() }),
  }));
  const dayLabel = (day: string) => {
    const today = dayKey(props.now, timeZone());
    const yesterday = dayKey(props.now - 24 * HOUR, timeZone());
    if (day === today) return "Today";
    if (day === yesterday) return "Yesterday";
    const first = rowsOf(day)[0];
    return first ? formats().heading.format(new Date(first.time)) : day;
  };

  // Rows that come into view together are spaced a beat apart, so the line reads as drawing down the feed.
  let nextReveal = 0;
  const schedule = () => {
    if (prefersReducedMotion()) return 0;
    const current = performance.now() / 1000;
    const start = Math.min(Math.max(current, nextReveal), current + 0.45);
    nextReveal = start + STEP;
    return start - current;
  };

  const scrolls = () => props.maxHeight !== undefined;
  onMount(() => {
    if (!scrolls() || !scroller || !track || typeof ResizeObserver === "undefined") return;
    const node = scroller;
    const update = () => { if (node.scrollHeight - node.clientHeight - node.scrollTop > 2) node.dataset.more = ""; else delete node.dataset.more; };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observer.observe(track);
    onCleanup(() => { node.removeEventListener("scroll", update); observer.disconnect(); });
  });
  const newestId = () => rows()[0]?.id;
  createEffect(on(newestId, () => {
    if (props.scrollToNew === false || !scroller || scroller.scrollTop < 1) return;
    scroller.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, { defer: true }));

  const toggle = (rowId: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(rowId)) next.delete(rowId);
    else next.add(rowId);
    return next;
  });
  const onKeyDown = (event: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const triggers = [...(scroller?.querySelectorAll<HTMLElement>("[data-timeline-trigger]") ?? [])];
    const index = triggers.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? triggers.length - 1 : Math.min(Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0), triggers.length - 1);
    triggers[next]?.focus();
  };

  const maxHeight = () => (typeof props.maxHeight === "number" ? `${props.maxHeight}px` : props.maxHeight);

  return (
    <div class={cx(styles.root, props.class)} role="region" aria-label={props.label}>
      <div ref={scroller} class={styles.scroller} data-scrolls={scrolls() || undefined} style={scrolls() ? { "--timeline-height": maxHeight() } : undefined} onKeyDown={onKeyDown}>
        <div ref={track}>
          <For each={days()}>
            {day => {
              const headingId = `${id}-${day}`;
              const dayRows = createMemo(() => rowsOf(day).map(row => row.id), undefined, { equals: (a, b) => a.length === b.length && a.every((value, index) => value === b[index]) });
              const freshDay = !initialDays.has(day);
              return (
                <section
                  ref={el => {
                    if (!freshDay) return;
                    el.dataset.entering = "";
                    queueMicrotask(() => {
                      const done = () => { delete el.dataset.entering; el.style.height = ""; };
                      if (prefersReducedMotion()) return void animate(el, { opacity: [0, 1] }, { duration: 0.15 }).then(done);
                      animate(el, { height: ["0px", `${el.scrollHeight}px`], opacity: [0, 1] }, { height: spring.smooth, opacity: tween(motionTokens.duration.standard, motionTokens.ease.enter) }).then(done);
                    });
                  }}
                  class={styles.group}
                  aria-labelledby={headingId}
                >
                  <div class={styles.day} role="heading" aria-level={props.headingLevel ?? 3} id={headingId}>
                    <span>{dayLabel(day)}</span>
                    <span class={styles.count} aria-hidden="true"><RollingCount value={dayRows().length} /> {dayRows().length === 1 ? "update" : "updates"}</span>
                    <span class={styles.srOnly}>{`, ${dayRows().length} ${dayRows().length === 1 ? "update" : "updates"}`}</span>
                  </div>
                  <ol class={styles.list}>
                    <For each={dayRows()}>
                      {(rowId, index) => {
                        const row = () => byId().get(rowId);
                        return (
                          <Show when={row()}>
                            {current => (
                              <TimelineRow
                                row={current()}
                                last={index() === dayRows().length - 1}
                                expanded={expanded().has(rowId)}
                                onToggle={() => toggle(rowId)}
                                fresh={fresh.has(rowId)}
                                schedule={schedule}
                                now={props.now}
                                formats={formats()}
                              />
                            )}
                          </Show>
                        );
                      }}
                    </For>
                  </ol>
                </section>
              );
            }}
          </For>
        </div>
      </div>
      <span class={styles.srOnly} role="status">{announcement()}</span>
    </div>
  );
}

interface RowProps {
  row: Row;
  last: boolean;
  expanded: boolean;
  onToggle: () => void;
  fresh: boolean;
  schedule: () => number;
  now: number;
  formats: { clock: Intl.DateTimeFormat; full: Intl.DateTimeFormat };
}

function TimelineRow(props: RowProps) {
  const detailId = createUniqueId();
  let item: HTMLLIElement | undefined;
  let marker: HTMLSpanElement | undefined;
  let segment: HTMLSpanElement | undefined;
  let content: HTMLDivElement | undefined;
  let chevron: HTMLSpanElement | undefined;
  const fresh = untrack(() => props.fresh);
  const tone = () => (props.row.avatar ? undefined : props.row.tone ?? "neutral");
  const isToday = () => props.now - props.row.time < 12 * HOUR && new Date(props.now).toDateString() === new Date(props.row.time).toDateString();
  const time = () => (isToday() ? relative(props.row.time, props.now) : { short: props.formats.clock.format(new Date(props.row.time)), long: "" });
  const timeFull = () => (isToday() ? `${time().long}, ${props.formats.full.format(new Date(props.row.time))}` : props.formats.full.format(new Date(props.row.time)));

  onMount(() => {
    if (!item) return;
    const node = item;
    if (fresh) {
      node.dataset.entering = "";
      const done = () => { delete node.dataset.entering; node.style.height = ""; };
      if (prefersReducedMotion()) { done(); if (content) animate(content, { opacity: [0, 1] }, { duration: 0.15 }); }
      else {
        animate(node, { height: ["0px", `${node.scrollHeight}px`] }, spring.smooth).then(done);
        if (content) animate(content, { opacity: [0, 1], y: [-10, 0], filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"] }, { y: spring.smooth, opacity: { ...tween(motionTokens.duration.standard, motionTokens.ease.enter), delay: 0.05 }, filter: { ...tween(motionTokens.duration.standard, motionTokens.ease.enter), delay: 0.05 } });
      }
    }
    // The row reveals once, the first time it scrolls into view: its marker pops, then its line draws toward the next row.
    const reveal = () => {
      const delay = props.schedule() + (fresh ? 0.12 : 0);
      if (marker) animate(marker, { scale: [0.4, 1], opacity: [0, 1] }, prefersReducedMotion() ? { duration: 0, opacity: { duration: 0.15 } } : { ...spring.morph, visualDuration: 0.36, bounce: 0.32, delay, opacity: { ...tween(motionTokens.duration.fast, motionTokens.ease.enter), delay } });
      if (segment) animate(segment, { scaleY: [0, 1] }, prefersReducedMotion() ? instant : { ...spring.smooth, visualDuration: 0.34, delay: delay + 0.1 });
    };
    if (typeof IntersectionObserver === "undefined") { reveal(); return; }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      reveal();
    }, { threshold: 0.2 });
    observer.observe(node);
    onCleanup(() => observer.disconnect());
  });
  createEffect(on(() => props.expanded, (open, before) => {
    if (chevron) animate(chevron, { rotate: open ? 180 : 0 }, before === undefined || prefersReducedMotion() ? instant : spring.snappy);
  }));

  const inner = () => (
    <>
      <span class={styles.text}>
        <span class={styles.title}>
          <Show when={props.row.actor}><span class={styles.actor}>{props.row.actor}</span>{" "}</Show>
          {props.row.title}
        </span>
        <Show when={props.row.meta}><span class={styles.meta}>{props.row.meta}</span></Show>
      </span>
      <time class={styles.time} dateTime={new Date(props.row.time).toISOString()} title={timeFull()}>
        <RiseText text={time().short} />
        <span class={styles.srOnly}>{timeFull()}</span>
      </time>
      <Show when={props.row.detail}>
        <span ref={chevron} class={styles.chevron} aria-hidden="true"><ChevronDown size={16} stroke-width={1.75} /></span>
      </Show>
    </>
  );

  return (
    <li ref={item} class={styles.item}>
      <span ref={marker} class={styles.marker} data-tone={tone()} aria-hidden="true" style={{ opacity: 0, transform: "scale(0.4)" }}>
        <Show when={props.row.avatar} fallback={props.row.icon?.()}>
          {src => <img src={src()} alt="" width={28} height={28} decoding="async" />}
        </Show>
      </span>
      <Show when={!props.last}><span ref={segment} class={styles.segment} aria-hidden="true" style={{ transform: "scaleY(0)" }} /></Show>
      <div ref={content} class={styles.content}>
        <Show when={props.row.detail} fallback={<div class={styles.trigger}>{inner()}</div>}>
          <button type="button" class={styles.trigger} data-timeline-trigger="" aria-expanded={props.expanded} aria-controls={props.expanded ? detailId : undefined} onClick={() => props.onToggle()}>
            {inner()}
          </button>
        </Show>
        <Presence
          when={props.expanded && !!props.row.detail}
          enter={el => {
            if (prefersReducedMotion()) return;
            const controls = animate(el, { height: ["0px", `${el.scrollHeight}px`] }, spring.smooth);
            controls.then(() => { el.style.height = ""; });
            const first = el.firstElementChild;
            if (first) animate(first, { opacity: [0, 1], y: [-4, 0], filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"] }, { ...tween(motionTokens.duration.standard, motionTokens.ease.enter), delay: 0.06 });
            return controls;
          }}
          exit={el => {
            if (prefersReducedMotion()) return;
            const first = el.firstElementChild;
            if (first) animate(first, { opacity: 0 }, tween(motionTokens.duration.instant));
            return animate(el, { height: [`${el.offsetHeight}px`, "0px"] }, { ...spring.smooth, visualDuration: 0.28 });
          }}
        >
          {ref => <div ref={ref} id={detailId} class={styles.detail}><div class={styles.detailInner}>{props.row.detail?.()}</div></div>}
        </Presence>
      </div>
    </li>
  );
}

export default Timeline;

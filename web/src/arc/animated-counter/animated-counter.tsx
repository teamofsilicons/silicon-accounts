import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { animate, motionTokens, prefersReducedMotion, spring, type AnimationControls } from "../lib/motion";
import { SwapText } from "../lib/presence";
import styles from "./animated-counter.module.css";

export interface AnimatedCounterProps {
  value: number;
  label?: string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  /** Roll every digit up from zero the first time the counter scrolls into view. */
  animateOnView?: boolean;
  /** Formatting locale. Fixed by default so every visitor sees the same digits. */
  locale?: string;
  /** Size preset. "display" is Arc's 36px figure; "inline" inherits the surrounding font. */
  size?: "display" | "inline";
  class?: string;
}

type Part = { key: string; digit: number; order: number } | { key: string; text: string };

/** Split a formatted number into columns keyed by place value, so 999 → 1,000 keeps the ones column the ones column. */
function partsFor(value: number, decimals: number, locale: string): Part[] {
  const parts = new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, numberingSystem: "latn" }).formatToParts(value);
  let place = parts.reduce((count, part) => count + (part.type === "integer" ? part.value.length : 0), 0);
  let fraction = 0;
  let order = 0;
  return parts.flatMap((part, index): Part[] => {
    if (part.type === "integer") return [...part.value].map(char => ({ key: `i${--place}`, digit: Number(char), order: order++ }));
    if (part.type === "fraction") return [...part.value].map(char => ({ key: `f${fraction++}`, digit: Number(char), order: order++ }));
    return [{ key: part.type === "group" ? `g${place}` : part.type === "decimal" ? "d" : `${part.type}${index}`, text: part.value }];
  });
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

interface ColumnProps {
  digit: () => number;
  direction: () => number;
  armed: () => boolean;
  delay: number;
  leaving: () => boolean;
  onGone: () => void;
  entering: boolean;
}

/** A digit wheel. It always turns in the direction the whole number moved, wrapping 9 → 0 like an odometer. */
function Column(props: ColumnProps) {
  let column: HTMLSpanElement | undefined;
  const glyphs: HTMLSpanElement[] = [];
  const start = untrack(props.armed) ? 0 : untrack(props.digit);
  const wheel = { digit: start, target: start, revealed: !untrack(props.armed) };
  let controls: AnimationControls | undefined;
  const paint = (position: number) => {
    DIGITS.forEach((digit, i) => {
      const node = glyphs[i];
      if (!node) return;
      const offset = ((((digit - position) % 10) + 15) % 10) - 5;
      const distance = Math.abs(offset);
      node.style.transform = `translateY(${offset}em)`;
      node.style.opacity = String(Math.max(0, 1 - distance));
      node.style.visibility = distance >= 1 ? "hidden" : "visible";
      node.style.filter = distance < 0.02 || distance >= 1 ? "none" : `blur(${(distance * motionTokens.blur.subtle).toFixed(2)}px)`;
    });
  };
  let position = start;
  onMount(() => {
    paint(position);
    if (props.entering && column && !prefersReducedMotion()) {
      const width = column.offsetWidth;
      animate(column, { width: [0, width], opacity: [0, 1] }, spring.morph).then(() => { if (column) column.style.width = ""; });
    }
  });
  createEffect(on([props.digit, props.armed], ([digit, armed]) => {
    if (armed || wheel.digit === digit) {
      if (!armed) wheel.revealed = true;
      return;
    }
    wheel.target += props.direction() < 0 && wheel.revealed ? -((wheel.digit - digit + 10) % 10) : (digit - wheel.digit + 10) % 10;
    wheel.digit = digit;
    controls?.stop();
    if (prefersReducedMotion()) {
      position = wheel.target;
      paint(position);
    } else {
      const transition = wheel.revealed ? spring.smooth : { ...motionTokens.spring.smooth, visualDuration: motionTokens.duration.considered, delay: props.delay };
      controls = animate(position, wheel.target, { ...transition, onUpdate: value => { position = value; paint(value); } });
    }
    wheel.revealed = true;
  }, { defer: true }));
  createEffect(on(props.leaving, leaving => {
    if (!leaving) return;
    if (!column || prefersReducedMotion()) return props.onGone();
    animate(column, { width: 0, opacity: 0 }, spring.morph).then(props.onGone);
  }, { defer: true }));
  onCleanup(() => controls?.stop());
  return (
    <span ref={column} class={styles.column}>
      <span class={styles.sizer}>0</span>
      <For each={DIGITS}>{(digit, i) => <span ref={node => (glyphs[i()] = node)} class={styles.glyph}>{digit}</span>}</For>
    </span>
  );
}

interface Entry {
  key: string;
  digit?: () => number;
  setDigit?: (value: number) => void;
  text?: string;
  order: number;
  entering: boolean;
  leaving: () => boolean;
  setLeaving: (value: boolean) => void;
}

/**
 * Arc AnimatedCounter: each digit is a wheel keyed by place value that turns in the direction the number moved.
 * Tabular numerals keep the width stable; a gained or lost digit opens or closes its column on a spring.
 */
export function AnimatedCounter(props: AnimatedCounterProps) {
  let root: HTMLSpanElement | undefined;
  const [inView, setInView] = createSignal(!untrack(() => props.animateOnView));
  const [direction, setDirection] = createSignal(1);
  createEffect(on(() => props.value, (value, previous) => { if (previous !== undefined) setDirection(value > previous ? 1 : -1); }));
  const armed = () => !!props.animateOnView && !inView();
  onMount(() => {
    if (!props.animateOnView || !root || typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const observer = new IntersectionObserver(records => {
      if (records.some(record => record.isIntersecting)) { setInView(true); observer.disconnect(); }
    }, { threshold: 0.6 });
    observer.observe(root);
    onCleanup(() => observer.disconnect());
  });
  const parts = createMemo(() => partsFor(props.value, props.decimals ?? 0, props.locale ?? "en-US"));
  const text = () => `${props.prefix ?? ""}${parts().map(part => ("text" in part ? part.text : part.digit)).join("")}${props.suffix ?? ""}`;

  const make = (part: Part, entering: boolean): Entry => {
    const [leaving, setLeaving] = createSignal(false);
    if ("digit" in part) {
      const [digit, setDigit] = createSignal(part.digit);
      return { key: part.key, digit, setDigit, order: part.order, entering, leaving, setLeaving };
    }
    return { key: part.key, text: part.text, order: 0, entering, leaving, setLeaving };
  };
  const [entries, setEntries] = createSignal<Entry[]>(untrack(parts).map(part => make(part, false)));
  createEffect(on(parts, list => {
    const current = untrack(entries);
    const byKey = new Map(current.filter(entry => !entry.leaving()).map(entry => [entry.key, entry]));
    const next = list.map(part => {
      const existing = byKey.get(part.key);
      if (existing) {
        byKey.delete(part.key);
        if ("digit" in part) existing.setDigit?.(part.digit);
        return existing;
      }
      return make(part, true);
    });
    for (const entry of byKey.values()) entry.setLeaving(true);
    const leaving = current.filter(entry => entry.leaving());
    const merged = [...next];
    leaving.forEach(entry => merged.splice(Math.max(0, current.indexOf(entry)), 0, entry));
    setEntries(merged);
  }, { defer: true }));

  return (
    <span ref={root} class={[styles.counter, props.size === "inline" ? styles.inline : "", props.class ?? ""].join(" ")}>
      <Show when={props.label}>
        <span class={styles.label}><span class={styles.labelSwap}><SwapText text={props.label ?? ""} class={styles.labelText} /></span></span>
      </Show>
      <span class="sr-only">{text()}</span>
      <span class={styles.value} aria-hidden="true">
        <Show when={props.prefix}><span class={styles.symbol}>{props.prefix}</span></Show>
        <For each={entries()}>
          {entry => entry.digit
            ? <Column digit={entry.digit} direction={direction} armed={armed} delay={Math.min(entry.order * motionTokens.stagger.item, 0.25)} leaving={entry.leaving} entering={entry.entering} onGone={() => setEntries(list => list.filter(item => item !== entry))} />
            : <CounterSymbol text={entry.text ?? ""} entering={entry.entering} leaving={entry.leaving} onGone={() => setEntries(list => list.filter(item => item !== entry))} />}
        </For>
        <Show when={props.suffix}><span class={styles.symbol}>{props.suffix}</span></Show>
      </span>
    </span>
  );
}

function CounterSymbol(props: { text: string; entering: boolean; leaving: () => boolean; onGone: () => void }) {
  let el: HTMLSpanElement | undefined;
  onMount(() => {
    if (props.entering && el && !prefersReducedMotion()) {
      const width = el.offsetWidth;
      animate(el, { width: [0, width], opacity: [0, 1] }, spring.morph).then(() => { if (el) el.style.width = ""; });
    }
  });
  createEffect(on(props.leaving, leaving => {
    if (!leaving) return;
    if (!el || prefersReducedMotion()) return props.onGone();
    animate(el, { width: 0, opacity: 0 }, spring.morph).then(props.onGone);
  }, { defer: true }));
  return <span ref={el} class={styles.symbol}>{props.text}</span>;
}

export default AnimatedCounter;

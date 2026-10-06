import { For, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { animate, prefersReducedMotion, type AnimationControls } from "../lib/motion";
import { cx } from "../lib/cx";
import styles from "./slot-text.module.css";

export interface SlotTextProps {
  /** The value to show. Numbers pass through `format`; strings render as they are. */
  value: string | number;
  /** Formats a number value. Defaults to en-US grouping, so 12480 reads 12,480. */
  format?: (value: number) => string;
  /** Seconds the first reel spins. Later reels add stagger. */
  duration?: number;
  /** Seconds between reels stopping, left to right. */
  stagger?: number;
  /** Extra full turns a digit makes before it lands. */
  spins?: number;
  /** Which end reels are matched from when the length changes. Numbers default to end. */
  align?: "start" | "end";
  /** Announce new values politely to screen readers. */
  announce?: boolean;
  class?: string;
}

const DIGITS = "0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
/** Fast out, long soft landing, never past the target. */
const LANDING = [0.12, 0.8, 0.16, 1] as [number, number, number, number];
/** Cell pitch in em. Keep in sync with .cell in the stylesheet. */
const CELL = 1.6;

const classOf = (char: string) => (DIGITS.includes(char) ? DIGITS : LOWER.includes(char) ? LOWER : UPPER.includes(char) ? UPPER : null);

/** Deterministic shuffle so the same change always spins the same letters. */
function seeded(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** The reel's cells, from what is visible now to the target. */
function buildStrip(from: string, to: string, spins: number, rising: boolean, seed: number): string[] {
  if (from === to) return [to];
  const set = classOf(to);
  if (!set) return [from, to];
  if (set === DIGITS && classOf(from) === DIGITS) {
    const a = Number(from);
    const b = Number(to);
    const steps = spins * 10 + (rising ? (b - a + 10) % 10 : (a - b + 10) % 10);
    return Array.from({ length: steps + 1 }, (_, i) => String((a + (rising ? i : -i) + 100) % 10));
  }
  const random = seeded(seed);
  const fillers = Array.from({ length: Math.max(2, spins * 5 + 2) }, () => set[Math.floor(random() * set.length)] ?? to);
  return [from, ...fillers, to];
}

interface ReelProps {
  char: () => string;
  order: number;
  entering: boolean;
  rising: () => boolean;
  duration: number;
  stagger: number;
  spins: number;
  leaving: () => boolean;
  onGone: () => void;
}

function Reel(props: ReelProps) {
  let slot: HTMLSpanElement | undefined;
  let sizer: HTMLSpanElement | undefined;
  let stripEl: HTMLSpanElement | undefined;
  const reduce = untrack(prefersReducedMotion);
  const first = untrack(props.char);
  const [strip, setStrip] = createSignal<string[]>(props.entering && !reduce ? buildStrip("", first, props.spins, untrack(props.rising), first.charCodeAt(0) + props.order) : [first]);
  let pos = 0;
  let lastPos = 0;
  let lastTime = 0;
  let spin: AnimationControls | undefined;
  let size: AnimationControls | undefined;
  let measured = 0;
  const time = () => props.duration + props.order * props.stagger;

  const paint = (value: number) => {
    pos = value;
    if (!stripEl) return;
    const now = performance.now();
    const velocity = lastTime ? Math.abs(value - lastPos) / Math.max(1, now - lastTime) * 1000 : 0;
    lastPos = value;
    lastTime = now;
    const amount = Math.min(velocity * 0.05, 2.4);
    stripEl.style.transform = `translate3d(0, ${(-value * CELL).toFixed(4)}em, 0)`;
    stripEl.style.filter = amount < 0.15 ? "none" : `blur(${amount.toFixed(2)}px)`;
  };

  const run = (from: number, grow: boolean) => {
    const last = untrack(strip).length - 1;
    queueMicrotask(() => {
      const target = sizer?.getBoundingClientRect().width ?? 0;
      if (prefersReducedMotion()) {
        paint(last);
        if (slot) slot.style.width = `${target}px`;
        measured = target;
        return;
      }
      spin?.stop();
      paint(from);
      lastTime = 0;
      spin = animate(from, last, { duration: last === 0 ? 0.2 : time(), ease: LANDING, onUpdate: paint, onComplete: () => { if (stripEl) stripEl.style.filter = "none"; } });
      if (!slot) return;
      size?.stop();
      const start = grow ? 0 : measured || target;
      if (start === target && !grow) { slot.style.width = `${target}px`; measured = target; return; }
      size = animate(start, target, { type: "spring", visualDuration: Math.min(time(), 0.6), bounce: 0, onUpdate: value => { if (slot) slot.style.width = `${value}px`; } });
      measured = target;
    });
  };

  onMount(() => run(0, props.entering && !reduce));

  createEffect(on(props.char, (char, previous) => {
    if (char === previous) return;
    const current = pos;
    const list = untrack(strip);
    const index = Math.max(0, Math.min(list.length - 1, Math.round(current)));
    const visible = list[index] ?? "";
    if (prefersReducedMotion()) {
      setStrip([char]);
      run(0, false);
      return;
    }
    setStrip(buildStrip(visible, char, props.spins, untrack(props.rising), char.charCodeAt(0) * 31 + visible.charCodeAt(0) * 7 + props.order + list.length));
    run(current - index, false);
  }, { defer: true }));

  createEffect(on(props.leaving, leaving => {
    if (!leaving) return;
    spin?.stop();
    size?.stop();
    if (prefersReducedMotion() || !slot) return props.onGone();
    animate(slot.offsetWidth, 0, { type: "spring", visualDuration: 0.35, bounce: 0, onUpdate: value => { if (slot) slot.style.width = `${value}px`; }, onComplete: props.onGone });
  }, { defer: true }));

  onCleanup(() => { spin?.stop(); size?.stop(); });

  return (
    <span ref={slot} class={styles.slot} data-exiting={props.leaving() ? "" : undefined}>
      <span ref={sizer} class={styles.sizer}>{props.char() === " " ? " " : props.char()}</span>
      <span class={styles.window}>
        <span ref={stripEl} class={styles.strip}>
          <For each={strip()}>{cell => <span class={styles.cell}>{cell === " " ? " " : cell}</span>}</For>
        </span>
      </span>
    </span>
  );
}

interface ReelEntry {
  key: string;
  char: () => string;
  setChar: (value: string) => void;
  order: number;
  entering: boolean;
  leaving: () => boolean;
  setLeaving: (value: boolean) => void;
}

/**
 * Arc SlotText: every character is a reel. Digits count through the wheel in the direction the number moved, letters
 * shuffle, and reels stop one after another from left to right with a soft, overshoot-free landing.
 */
export function SlotText(props: SlotTextProps) {
  const text = createMemo(() => (typeof props.value === "number" ? (props.format ? props.format(props.value) : props.value.toLocaleString("en-US")) : props.value));
  const fromEnd = () => (props.align ?? (typeof props.value === "number" ? "end" : "start")) === "end";
  const [rising, setRising] = createSignal(true);
  createEffect(on(() => props.value, (value, previous) => {
    setRising(typeof value === "number" && typeof previous === "number" ? value >= previous : true);
  }, { defer: true }));

  const keysFor = (chars: string[]) => {
    const lead = fromEnd() ? chars.findIndex(char => /[\p{L}\p{N}]/u.test(char)) : 0;
    const prefix = lead < 0 ? chars.length : lead;
    return chars.map((_, i) => (i < prefix ? `p${i}` : fromEnd() ? `e${chars.length - 1 - i}` : `s${i}`));
  };

  const makeEntry = (key: string, char: string, order: number, entering: boolean): ReelEntry => {
    const [c, setC] = createSignal(char);
    const [leaving, setLeaving] = createSignal(false);
    return { key, char: c, setChar: setC, order, entering, leaving, setLeaving };
  };

  const initialChars = Array.from(untrack(text));
  const initialKeys = keysFor(initialChars);
  const [entries, setEntries] = createSignal<ReelEntry[]>(initialChars.map((char, i) => makeEntry(initialKeys[i] ?? `s${i}`, char, i, false)));

  createEffect(on(text, value => {
    const chars = Array.from(value);
    const keys = keysFor(chars);
    const current = untrack(entries);
    const byKey = new Map(current.filter(entry => !entry.leaving()).map(entry => [entry.key, entry]));
    const next: ReelEntry[] = chars.map((char, i) => {
      const key = keys[i] ?? `s${i}`;
      const existing = byKey.get(key);
      if (existing) {
        byKey.delete(key);
        existing.order = i;
        existing.setChar(char);
        return existing;
      }
      return makeEntry(key, char, i, true);
    });
    for (const entry of byKey.values()) entry.setLeaving(true);
    // Leaving reels stay in place (in their old order) until their width closes.
    const leaving = current.filter(entry => entry.leaving());
    const merged = [...next];
    for (const entry of leaving) merged.splice(Math.min(entry.order, merged.length), 0, entry);
    setEntries(merged);
  }, { defer: true }));

  return (
    <span class={cx(styles.root, props.class)}>
      <span class="sr-only" aria-live={props.announce ? "polite" : undefined}>{text()}</span>
      <span class={styles.reels} aria-hidden="true">
        <For each={entries()}>
          {entry => (
            <Reel
              char={entry.char}
              order={entry.order}
              entering={entry.entering}
              rising={rising}
              duration={props.duration ?? 0.9}
              stagger={props.stagger ?? 0.07}
              spins={props.spins ?? 1}
              leaving={entry.leaving}
              onGone={() => setEntries(list => list.filter(item => item !== entry))}
            />
          )}
        </For>
      </span>
    </span>
  );
}

export default SlotText;

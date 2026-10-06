"use client";

/**
 * Small hooks the hosted pages share: a ticking clock (one timer per interval, shared by every component that asks
 * for it), "has this page hydrated", and a timer-safe "later".
 */
import { useSyncExternalStore } from "react";

interface Clock {
  value: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  subscribe: (listener: () => void) => () => void;
  read: () => number;
}

const clocks = new Map<number, Clock>();

function clockOf(ms: number): Clock {
  const existing = clocks.get(ms);
  if (existing) return existing;
  const clock: Clock = {
    value: 0,
    listeners: new Set(),
    timer: null,
    subscribe(listener) {
      clock.listeners.add(listener);
      if (!clock.timer) {
        clock.value = Date.now();
        clock.timer = setInterval(() => {
          clock.value = Date.now();
          for (const notify of clock.listeners) notify();
        }, ms);
      }
      return () => {
        clock.listeners.delete(listener);
        if (!clock.listeners.size && clock.timer) {
          clearInterval(clock.timer);
          clock.timer = null;
        }
      };
    },
    read() {
      // An idle clock reads fresh once (the first component to ask), and is then steady until the next tick.
      if (!clock.timer && Date.now() - clock.value > ms) clock.value = Date.now();
      return clock.value;
    },
  };
  clocks.set(ms, clock);
  return clock;
}

const serverNow = () => 0;

/**
 * The current time in ms, ticking every `ms` while a component uses it. 0 on the server and during hydration (the
 * hosted pages render time-dependent text only after hydration).
 */
export function useNow(ms = 1000): number {
  const clock = clockOf(ms);
  return useSyncExternalStore(clock.subscribe, clock.read, serverNow);
}

const subscribeNothing = () => () => undefined;
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** False on the server and during hydration, true afterwards (and at once for pages reached by client navigation). */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNothing, clientSnapshot, serverSnapshot);
}

const subscribePointer = (notify: () => void) => {
  const media = window.matchMedia?.("(pointer: fine)");
  media?.addEventListener("change", notify);
  return () => media?.removeEventListener("change", notify);
};
const readPointer = () => !!window.matchMedia?.("(pointer: fine)").matches;

/** True on devices with a precise pointer, where focusing a field does not throw up a keyboard. */
export function useFinePointer(): boolean {
  return useSyncExternalStore(subscribePointer, readPointer, serverSnapshot);
}

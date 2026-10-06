/**
 * AnimatePresence for keyed lists: items that leave the source stay rendered (marked leaving) at their last place
 * until their exit animation calls `release`. New items are flagged `entering` so they can animate in.
 */
import { createEffect, createSignal, on, untrack, type Accessor, type Setter } from "solid-js";

export interface PresenceEntry<T> {
  key: string;
  item: Accessor<T>;
  setItem: Setter<T>;
  leaving: Accessor<boolean>;
  setLeaving: Setter<boolean>;
  /** True for items added after the first render. */
  entering: boolean;
}

export function createPresenceList<T>(source: Accessor<T[]>, keyOf: (item: T) => string) {
  const make = (item: T, entering: boolean): PresenceEntry<T> => {
    const [value, setItem] = createSignal(item);
    const [leaving, setLeaving] = createSignal(false);
    return { key: keyOf(item), item: value, setItem, leaving, setLeaving, entering };
  };
  const [entries, setEntries] = createSignal<PresenceEntry<T>[]>(untrack(source).map(item => make(item, false)));
  createEffect(on(source, next => {
    const current = untrack(entries);
    const live = new Map(current.filter(entry => !entry.leaving()).map(entry => [entry.key, entry]));
    const result: PresenceEntry<T>[] = [];
    const nextKeys = new Set(next.map(keyOf));
    for (const item of next) {
      const key = keyOf(item);
      const existing = live.get(key);
      if (existing) {
        existing.setItem(() => item);
        result.push(existing);
      } else result.push(make(item, true));
    }
    // Leaving entries keep their place relative to the entry before them.
    current.forEach((entry, index) => {
      if (entry.leaving() || nextKeys.has(entry.key)) {
        if (!entry.leaving()) return;
      } else entry.setLeaving(true);
      const before = current[index - 1];
      const at = before ? result.indexOf(before) + 1 : 0;
      result.splice(Math.max(0, at), 0, entry);
    });
    setEntries(result);
  }, { defer: true }));
  const release = (entry: PresenceEntry<T>) => setEntries(list => list.filter(item => item !== entry));
  return { entries, release };
}

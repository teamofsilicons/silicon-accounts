"use client";

/**
 * Secrets waiting to be stored (a new Silicon's STK, a rotated STK, a webhook signing secret). They live in memory for
 * as long as this tab does, so leaving the Silicons page and coming back still shows them until "I've stored it"; they
 * are never written to storage or to the query cache. While one is waiting, closing or reloading the tab asks first,
 * because the service cannot show it again.
 *
 * The values themselves are kept apart from what the pages render: lists of reveals carry labels and notes only, and
 * the reveal card reads its values here by id (`revealValue`). So no page or drawer holds a secret in its props or state
 * (React keeps the previous render's props until the next one), and "I've stored it" drops the only copy.
 */
import { useSyncExternalStore } from "react";

export interface RevealedSecret {
  /** "STK", "Webhook signing secret". */
  label: string;
  value: string;
  /** One line under the value: what it is for. */
  note?: string;
  /** A command that uses it, shown in mono with its own copy button. */
  command?: string;
}

/** What a page renders for one secret: everything but the value. */
export type SecretSlot = Omit<RevealedSecret, "value">;

/** A secret to store, tied to the Silicon it belongs to. */
export interface Reveal {
  id: string;
  silicon: string;
  title: string;
  description: string;
  secrets: SecretSlot[];
  /** What made it (a Silicon created, its STK rotated, its webhook set): where focus goes once it is stored. */
  origin?: "created" | "stk" | "webhook";
}

/** A reveal as it is handed over, values included. */
export type NewReveal = Omit<Reveal, "id" | "secrets"> & { secrets: RevealedSecret[] };

let seq = 0;
let reveals: Reveal[] = [];
/** Reveal id → its values, in the order of its slots. */
const values = new Map<string, string[]>();
const listeners = new Set<() => void>();

const guard = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  // Older browsers need a returnValue to show their prompt.
  event.returnValue = "";
};

function commit(next: Reveal[]) {
  reveals = next;
  if (typeof window !== "undefined") {
    window.removeEventListener("beforeunload", guard);
    if (next.length) window.addEventListener("beforeunload", guard);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: Reveal[] = [];

/** Every secret still waiting to be stored, oldest first (labels and notes; the values stay here). */
export function usePendingReveals(): Reveal[] {
  return useSyncExternalStore(subscribe, () => reveals, () => EMPTY);
}

export function addReveal(reveal: NewReveal): void {
  seq += 1;
  const id = `reveal-${seq}`;
  values.set(id, reveal.secrets.map(secret => secret.value));
  commit([...reveals, { ...reveal, id, secrets: reveal.secrets.map(({ label, note, command }) => ({ label, note, command })) }]);
}

/** The value of a reveal's `index`th secret, while it waits to be stored. */
export function revealValue(id: string, index: number): string | undefined {
  return values.get(id)?.[index];
}

/** "I've stored it": the secret is dropped from memory. */
export function dismissReveal(id: string): void {
  values.delete(id);
  commit(reveals.filter(item => item.id !== id));
}

/** Drops every secret of a Silicon (it was deleted). */
export function dismissRevealsOf(silicon: string): void {
  for (const item of reveals) if (item.silicon === silicon) values.delete(item.id);
  commit(reveals.filter(item => item.silicon !== silicon));
}

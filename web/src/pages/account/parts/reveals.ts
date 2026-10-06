/**
 * Secrets waiting to be stored (a new Silicon's STK, a rotated STK, a webhook signing secret). They live in memory for
 * as long as this tab does, so leaving the Silicons page and coming back still shows them until "I've stored it"; they
 * are never written to storage. While one is waiting, closing or reloading the tab asks first, because the service
 * cannot show it again.
 */
import { createRoot, createSignal } from "solid-js";
import type { RevealedSecret } from "./SecretReveal";

/** A secret to store, tied to the Silicon it belongs to. */
export interface Reveal {
  id: string;
  silicon: string;
  title: string;
  description: string;
  secrets: RevealedSecret[];
  /** What made it (a Silicon created, its STK rotated, its webhook set): where focus goes once it is stored. */
  origin?: "created" | "stk" | "webhook";
}

let seq = 0;

const store = createRoot(() => {
  const [reveals, setReveals] = createSignal<Reveal[]>([]);
  return { reveals, setReveals };
});

const guard = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  // Older browsers need a returnValue to show their prompt.
  event.returnValue = "";
};

function sync(list: Reveal[]) {
  if (typeof window === "undefined") return;
  window.removeEventListener("beforeunload", guard);
  if (list.length) window.addEventListener("beforeunload", guard);
}

/** Every secret still waiting to be stored, oldest first. */
export const pendingReveals = store.reveals;

export function addReveal(reveal: Omit<Reveal, "id">): void {
  store.setReveals(list => {
    const next = [...list, { ...reveal, id: `reveal-${++seq}` }];
    sync(next);
    return next;
  });
}

/** "I've stored it": the secret is dropped from memory. */
export function dismissReveal(id: string): void {
  store.setReveals(list => {
    const next = list.filter(item => item.id !== id);
    sync(next);
    return next;
  });
}

/** Drops every secret of a Silicon (it was deleted). */
export function dismissRevealsOf(silicon: string): void {
  store.setReveals(list => {
    const next = list.filter(item => item.silicon !== silicon);
    sync(next);
    return next;
  });
}

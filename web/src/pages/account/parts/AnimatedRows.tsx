/**
 * Keyed lists whose items animate in and out, so a removed email, a revoked session or an app whose access was removed
 * closes its gap instead of snapping:
 *  - "list" (default): rows open and fold (height and opacity on the smooth spring);
 *  - "grid": cards fade and scale away, then the cards after them glide into place (FLIP).
 * Reduced motion: items appear and disappear at once.
 */
import { For, createEffect, on, onMount, type Accessor, type JSX } from "solid-js";
import { createFlip } from "../../../arc/lib/flip";
import { animate, motionTokens, prefersReducedMotion, spring } from "../../../arc/lib/motion";
import { createPresenceList, type PresenceEntry } from "../../../arc/lib/presence-list";

export interface AnimatedRowsProps<T> {
  items: T[];
  keyOf: (item: T) => string;
  children: (item: Accessor<T>, leaving: Accessor<boolean>) => JSX.Element;
  class?: string;
  /** "list" folds rows; "grid" fades cards and glides the rest into place. */
  layout?: "list" | "grid";
  label?: string;
}

const enterEase = [...motionTokens.ease.enter] as [number, number, number, number];

interface RowProps<T> {
  entry: PresenceEntry<T>;
  layout: "list" | "grid";
  release: () => void;
  children: (item: Accessor<T>, leaving: Accessor<boolean>) => JSX.Element;
}

function Row<T>(props: RowProps<T>) {
  let el: HTMLDivElement | undefined;
  onMount(() => {
    if (!el || !props.entry.entering || prefersReducedMotion()) return;
    const node = el;
    if (props.layout === "grid") {
      animate(node, { opacity: [0, 1], scale: [0.96, 1] }, { scale: spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: enterEase } });
      return;
    }
    const height = node.scrollHeight;
    node.style.overflow = "hidden";
    animate(node, { height: ["0px", `${height}px`], opacity: [0, 1] }, { height: spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: enterEase } })
      .then(() => { node.style.height = ""; node.style.overflow = ""; });
  });
  createEffect(on(props.entry.leaving, leaving => {
    if (!leaving) return;
    if (!el || prefersReducedMotion()) return props.release();
    const node = el;
    node.setAttribute("inert", "");
    if (props.layout === "grid") {
      animate(node, { opacity: 0, scale: 0.96 }, { duration: motionTokens.duration.exit, ease: [...motionTokens.ease.exit] as [number, number, number, number] }).then(() => props.release());
      return;
    }
    node.style.overflow = "hidden";
    animate(node, { height: [`${node.offsetHeight}px`, "0px"], opacity: [1, 0] }, { height: { ...spring.smooth, visualDuration: 0.32 }, opacity: { duration: motionTokens.duration.fast } })
      .then(() => props.release());
  }, { defer: true }));
  return <div ref={el} role="listitem" data-key={props.entry.key} data-leaving={props.entry.leaving() || undefined}>{props.children(props.entry.item, props.entry.leaving)}</div>;
}

export function AnimatedRows<T>(props: AnimatedRowsProps<T>) {
  let container: HTMLDivElement | undefined;
  const list = createPresenceList(() => props.items, item => props.keyOf(item));
  const flip = createFlip(() => container, ":scope > [role='listitem']", el => el.dataset.key ?? null);
  const layout = () => props.layout ?? "list";
  const release = (entry: PresenceEntry<T>) => {
    if (layout() === "grid") flip.capture();
    list.release(entry);
    if (layout() === "grid") flip.play(spring.smooth);
  };
  return (
    <div ref={container} class={props.class} role="list" aria-label={props.label}>
      <For each={list.entries()}>
        {entry => <Row entry={entry} layout={layout()} release={() => release(entry)}>{props.children}</Row>}
      </For>
    </div>
  );
}

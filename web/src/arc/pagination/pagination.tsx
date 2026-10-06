import { ChevronLeft, ChevronRight } from "lucide-solid";
import { For, Show, createComputed, createEffect, createMemo, on, onCleanup, onMount, untrack } from "solid-js";
import { createPresenceList, type PresenceEntry } from "../lib/presence-list";
import { animate, motionTokens, prefersReducedMotion, pressable, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./pagination.module.css";

export interface PaginationProps {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  label?: string;
}

/** One button plus the gap (36px + 4px), as a percentage of the button width. */
const SLOT = 1000 / 9;

/**
 * Arc Pagination: a five page window. When the window shifts, numbers travel like a belt (each moves by the same
 * number of slots, new ones slide in, old ones slide out and fade) and one mark glides to the current page.
 */
export function Pagination(props: PaginationProps) {
  const pageCount = () => Math.max(0, Math.floor(props.pageCount));
  const current = () => (pageCount() > 0 ? Math.min(Math.max(1, Math.floor(props.page)), pageCount()) : 0);
  const start = () => (pageCount() > 0 ? Math.max(1, Math.min(pageCount() - 4, current() - 2)) : 1);
  const visible = createMemo(
    () => Array.from({ length: Math.min(pageCount(), 5) }, (_, index) => start() + index),
    undefined,
    { equals: (a, b) => a.length === b.length && a.every((value, index) => value === b[index]) },
  );
  const { entries, release } = createPresenceList(visible, page => String(page));
  const nodes = new Map<string, HTMLButtonElement>();
  let nav: HTMLElement | undefined;
  let mark: HTMLSpanElement | undefined;
  let markReady = false;
  let shift = 0;
  let previousStart = untrack(start);
  let before = new Map<string, { x: number; y: number }>();

  const capture = () => {
    const out = new Map<string, { x: number; y: number }>();
    for (const [key, node] of nodes) {
      if (!node.isConnected || node.dataset.leaving !== undefined) continue;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform === "none" ? undefined : getComputedStyle(node).transform);
      out.set(key, { x: node.offsetLeft + matrix.m41, y: node.offsetTop + matrix.m42 });
    }
    return out;
  };

  const placeMark = (instant: boolean) => {
    const target = nav?.querySelector<HTMLElement>("[aria-current='page']");
    if (!mark || !target) return;
    const to = { x: target.offsetLeft, y: target.offsetTop };
    animate(mark, to, instant || !markReady || prefersReducedMotion() ? { duration: 0 } : spring.morph);
    if (!markReady && nav) { markReady = true; nav.setAttribute("data-mark-ready", ""); }
  };

  // Positions are read before the window changes, so kept numbers can glide from where they were.
  createComputed(on(start, next => {
    shift = next - previousStart;
    previousStart = next;
    before = capture();
  }, { defer: true }));

  const settle = (list: PresenceEntry<number>[]) => {
    const reduce = prefersReducedMotion();
    const old = before;
    before = new Map();
    for (const entry of list) {
      const node = nodes.get(entry.key);
      if (!node || !entry.leaving() || node.dataset.leaving !== undefined) continue;
      node.dataset.leaving = "";
      const at = old.get(entry.key) ?? { x: node.offsetLeft, y: node.offsetTop };
      Object.assign(node.style, { position: "absolute", left: `${at.x}px`, top: `${at.y}px`, margin: "0", pointerEvents: "none" });
      node.setAttribute("aria-hidden", "true");
      node.tabIndex = -1;
      if (reduce) { release(entry); continue; }
      animate(node, { x: `${-SLOT * shift}%`, opacity: 0 }, { x: spring.smooth, opacity: tween(motionTokens.duration.instant) }).then(() => release(entry));
    }
    if (!reduce) for (const entry of list) {
      const node = nodes.get(entry.key);
      if (!node || entry.leaving()) continue;
      const from = old.get(entry.key);
      if (from) {
        const dx = from.x - node.offsetLeft;
        const dy = from.y - node.offsetTop;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) animate(node, { x: [dx, 0], y: [dy, 0] }, spring.smooth);
      } else if (old.size) {
        animate(node, { x: [`${SLOT * shift}%`, "0%"], opacity: [0, 1] }, { x: spring.smooth, opacity: tween(motionTokens.duration.standard, motionTokens.ease.enter) });
      }
    }
    placeMark(false);
  };

  createEffect(on(entries, list => queueMicrotask(() => settle(list)), { defer: true }));
  createEffect(on(current, () => queueMicrotask(() => placeMark(false)), { defer: true }));
  onMount(() => {
    placeMark(true);
    if (!nav || typeof ResizeObserver === "undefined") return;
    let size = `${nav.offsetWidth}x${nav.offsetHeight}`;
    const observer = new ResizeObserver(() => {
      const next = nav ? `${nav.offsetWidth}x${nav.offsetHeight}` : size;
      if (next !== size) { size = next; placeMark(true); }
    });
    observer.observe(nav);
    onCleanup(() => observer.disconnect());
  });

  return (
    <nav ref={nav} class={styles.nav} aria-label={props.label ?? "Pagination"}>
      <Show when={pageCount() > 0}>
        <button ref={el => { useSquircle(el); pressable(el); }} type="button" class={styles.step} onClick={() => props.onPageChange(current() - 1)} disabled={current() <= 1} aria-label="Previous page">
          <ChevronLeft width={16} height={16} aria-hidden="true" />
        </button>
        <span ref={el => { mark = el; useSquircle(el); }} class={styles.mark} aria-hidden="true" />
        <For each={entries()}>
          {entry => (
            <button
              ref={el => { nodes.set(entry.key, el); useSquircle(el); onCleanup(() => nodes.delete(entry.key)); }}
              type="button"
              class={styles.page}
              onClick={() => props.onPageChange(entry.item())}
              aria-label={`Page ${entry.item()}`}
              aria-current={!entry.leaving() && current() === entry.item() ? "page" : undefined}
            >
              {entry.item()}
            </button>
          )}
        </For>
        <button ref={el => { useSquircle(el); pressable(el); }} type="button" class={styles.step} onClick={() => props.onPageChange(current() + 1)} disabled={current() >= pageCount()} aria-label="Next page">
          <ChevronRight width={16} height={16} aria-hidden="true" />
        </button>
      </Show>
    </nav>
  );
}

export default Pagination;

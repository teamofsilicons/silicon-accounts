import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, type JSX } from "solid-js";
import { Command as CommandIcon, CornerDownLeft, Search, X } from "lucide-solid";
import { Presence } from "../lib/presence";
import { createFlip } from "../lib/flip";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { isApplePlatform } from "../lib/dom";
import { useSquircle } from "../lib/squircle";
import styles from "./command-palette.module.css";

export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  group?: string;
  keywords?: string[];
  icon?: JSX.Element;
  /** Shortcut hint, such as "1" or "⌘ ,". */
  shortcut?: string;
  /** Runs the command. */
  run?: () => void;
}

export interface CommandPaletteProps {
  items: CommandItem[];
  placeholder?: string;
  onSelect?: (item: CommandItem) => void;
  onClose?: () => void;
  label?: string;
  autoFocus?: boolean;
  /** Hide the ⌘K hint (the shell shows it already). */
  hideHotkey?: boolean;
}

const GLIDE_ROWS = 6;

/**
 * Arc CommandPalette block: one search field over grouped commands. Filtering lets the remaining rows glide into
 * place while the frame's height follows on a spring; one highlight follows the active result (a spring for the
 * pointer, a quick slide for arrow keys). Enter runs the highlighted result, or the top match after typing.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const inputId = `cmd-${createUniqueId()}`;
  const [query, setQuery] = createSignal("");
  const [activeIndex, setActiveIndex] = createSignal<number | null>(null);
  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;
  let frame: HTMLDivElement | undefined;
  let highlight: HTMLSpanElement | undefined;
  let pointer = false;
  let lastPointer = { x: -1, y: -1 };
  let highlightShown = false;
  const filtered = createMemo(() => {
    const normalized = query().trim().toLowerCase();
    if (!normalized) return props.items;
    return props.items.filter(item => [item.label, item.description, item.group, ...(item.keywords ?? [])].filter(Boolean).join(" ").toLowerCase().includes(normalized));
  });
  const grouped = createMemo(() => {
    const groups = new Map<string, Array<{ item: CommandItem; index: number }>>();
    filtered().forEach((item, index) => {
      const group = item.group ?? "Actions";
      const entries = groups.get(group) ?? [];
      entries.push({ item, index });
      groups.set(group, entries);
    });
    return [...groups.entries()];
  });
  const safeActiveIndex = () => {
    const index = activeIndex();
    return index === null ? -1 : Math.min(index, Math.max(filtered().length - 1, 0));
  };
  const activeId = () => filtered()[safeActiveIndex()]?.id;
  const flip = createFlip(() => list, "[data-command]", el => el.getAttribute("data-command"));
  let previousOrder = new Map<string, number>();
  createEffect(on(filtered, next => {
    const glide = next.every((item, index) => Math.abs((previousOrder.get(item.id) ?? index) - index) <= GLIDE_ROWS);
    previousOrder = new Map(next.map((item, index) => [item.id, index]));
    if (glide) flip.play(spring.smooth);
  }, { defer: true }));

  onMount(() => {
    if (props.autoFocus) queueMicrotask(() => input?.focus({ preventScroll: true }));
    if (!list || !frame) return;
    let first = true;
    const observer = new ResizeObserver(() => {
      if (!list || !frame) return;
      const height = Math.round(list.offsetHeight);
      if (first || prefersReducedMotion()) { frame.style.height = `${height}px`; first = false; return; }
      animate(frame, { height: `${height}px` }, spring.smooth);
    });
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });

  // One highlight follows the active result.
  createEffect(on(activeId, id => queueMicrotask(() => {
    if (!highlight) return;
    const node = id ? document.getElementById(`${inputId}-${id}`) : null;
    if (!node) {
      highlightShown = false;
      animate(highlight, { opacity: 0 }, { duration: prefersReducedMotion() ? 0 : 0.1 });
      return;
    }
    let top = 0;
    for (let element: HTMLElement | null = node; element && element !== list; element = element.offsetParent as HTMLElement | null) top += element.offsetTop + (element === node ? 0 : element.clientTop);
    const move = !highlightShown || prefersReducedMotion() ? { duration: 0 } : pointer ? spring.snappy : { duration: 0.07, ease: [...motionTokens.ease.enter] as [number, number, number, number] };
    animate(highlight, { y: top, height: `${node.offsetHeight}px` }, move);
    animate(highlight, { opacity: 1 }, { duration: prefersReducedMotion() ? 0 : 0.08 });
    highlightShown = true;
    node.scrollIntoView({ block: "nearest" });
  })));

  const choose = (item: CommandItem) => {
    props.onSelect?.(item);
    item.run?.();
    setQuery("");
    setActiveIndex(null);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    pointer = false;
    const count = filtered().length;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex(index => Math.min((index ?? -1) + 1, Math.max(count - 1, 0))); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex(index => Math.max((index ?? count) - 1, 0)); }
    if (event.key === "Home") { event.preventDefault(); setActiveIndex(0); }
    if (event.key === "End") { event.preventDefault(); setActiveIndex(Math.max(count - 1, 0)); }
    const target = filtered()[safeActiveIndex()] ?? (query() ? filtered()[0] : undefined);
    if (event.key === "Enter" && target) { event.preventDefault(); choose(target); }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (query()) { setQuery(""); setActiveIndex(null); }
      else props.onClose?.();
    }
  };
  const hotkey = isApplePlatform() ? "⌘ K" : "Ctrl K";

  return (
    <div ref={el => useSquircle(el)} class={styles.palette}>
      <div class={styles.searchRow}>
        <span class={styles.searchIcon}><Search width={18} height={18} stroke-width={1.75} aria-hidden="true" /></span>
        <label class="sr-only" for={inputId}>{props.label ?? "Command palette"}</label>
        <input
          ref={input}
          id={inputId}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={`${inputId}-results`}
          aria-activedescendant={activeId() ? `${inputId}-${activeId()}` : undefined}
          value={query()}
          onInput={event => { flip.capture(); setQuery(event.currentTarget.value); setActiveIndex(null); }}
          onKeyDown={onKeyDown}
          placeholder={props.placeholder ?? "Search commands"}
          autocomplete="off"
          spellcheck={false}
        />
        <Presence when={!!query()} enter={el => animate(el, { opacity: [0, 1], scale: [0.6, 1] }, prefersReducedMotion() ? { duration: 0 } : spring.snappy)} exit={el => animate(el, { opacity: 0, scale: 0.6 }, tween(motionTokens.duration.instant))}>
          {ref => <button ref={ref} class={styles.clearButton} type="button" aria-label="Clear search" onClick={() => { flip.capture(); setQuery(""); setActiveIndex(null); input?.focus(); }}><X width={15} height={15} aria-hidden="true" /></button>}
        </Presence>
        <Show when={props.onClose}><button class={styles.closeButton} type="button" aria-label="Close command palette" onClick={() => props.onClose?.()}>Esc</button></Show>
        <Show when={!props.hideHotkey}><kbd class={styles.commandKey}>{hotkey}</kbd></Show>
      </div>
      <div ref={frame} class={styles.resultsFrame}>
        <div ref={list} id={`${inputId}-results`} class={styles.results} role="listbox" aria-label="Command results">
          <span ref={highlight} class={styles.highlight} aria-hidden="true" />
          <Show when={filtered().length} fallback={
            <div class={styles.empty} role="status">
              <span><Search width={20} height={20} aria-hidden="true" /></span>
              <strong>No matching actions</strong>
              <small>Try a different word or clear the search.</small>
            </div>
          }>
            <For each={grouped()}>
              {([group, entries]) => (
                <div class={styles.group} role="group" aria-label={group} data-command={`group:${group}`}>
                  <span class={styles.groupHeading} aria-hidden="true">{group}</span>
                  <For each={entries}>
                    {entry => (
                      <button
                        id={`${inputId}-${entry.item.id}`}
                        data-command={entry.item.id}
                        class={styles.result}
                        classList={{ [styles.activeResult!]: entry.index === safeActiveIndex() }}
                        type="button"
                        role="option"
                        aria-selected={entry.index === safeActiveIndex()}
                        onClick={() => choose(entry.item)}
                        onPointerMove={event => {
                          if (event.clientX === lastPointer.x && event.clientY === lastPointer.y) return;
                          lastPointer = { x: event.clientX, y: event.clientY };
                          if (entry.index !== safeActiveIndex()) { pointer = true; setActiveIndex(entry.index); }
                        }}
                      >
                        <span class={styles.itemIcon} aria-hidden="true">{entry.item.icon ?? <CommandIcon width={16} height={16} />}</span>
                        <span class={styles.resultCopy}><strong>{entry.item.label}</strong><Show when={entry.item.description}><small>{entry.item.description}</small></Show></span>
                        <Show when={entry.item.shortcut} fallback={<span class={styles.enterHint} aria-hidden="true"><CornerDownLeft width={14} height={14} /></span>}><kbd class={styles.shortcut}>{entry.item.shortcut}</kbd></Show>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;

import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, type JSX } from "solid-js";
import { Check, ChevronDown, Search, X } from "lucide-solid";
import { Presence, Swap } from "../lib/presence";
import { animate, prefersReducedMotion, tween, type AnimationControls } from "../lib/motion";
import { freshJSX } from "../lib/clone";
import { useSquircle } from "../lib/squircle";
import styles from "./morph-select.module.css";

export interface MorphSelectOption {
  value: string;
  label: string;
  /**
   * A 20px mark shown before the label, in the list and in the trigger (an app icon, an avatar). It is shown in
   * several places at once, so pass a function (or a node, which is cloned for the trigger).
   */
  icon?: JSX.Element | (() => JSX.Element);
  /** Short trailing detail such as an offset or a count. Rendered with tabular numerals. */
  meta?: string;
  /** Extra words that match this option when searching. */
  keywords?: string;
  disabled?: boolean;
}

export interface MorphSelectGroup {
  label: string;
  options: MorphSelectOption[];
}

export type MorphSelectItem = MorphSelectOption | MorphSelectGroup;

export interface MorphSelectProps {
  label: string;
  hideLabel?: boolean;
  items: MorphSelectItem[];
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string, option: MorphSelectOption) => void;
  placeholder?: string;
  /** Shows a search field in place of the trigger when open. "auto" turns it on above eight options. */
  searchable?: boolean | "auto";
  searchPlaceholder?: string;
  /** Width of the open surface in px. It never gets narrower than the trigger. Defaults to 272. */
  panelWidth?: number;
  maxListHeight?: number;
  align?: "start" | "end";
  name?: string;
  disabled?: boolean;
  class?: string;
}

type Section = { key: string; label?: string; options: MorphSelectOption[] };

const physical = (visualDuration: number, bounce: number) => {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return { type: "spring" as const, stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
const GROW = physical(0.4, 0.12);
const SHRINK = physical(0.34, 0);
const GLIDE = physical(0.28, 0.08);
const WIDTH = physical(0.42, 0.16);
/** Width that narrows never overshoots: dipping under the closed width would ellipsize the label. */
const NARROW = physical(0.42, 0);
/** The lifted label travels a touch faster than the surface folds, so the closing edge never catches it. */
const FLY = physical(0.3, 0.06);
const OPEN_RADIUS = 22;
const TYPEAHEAD_RESET = 600;
const PAGE = 8;

const isGroup = (item: MorphSelectItem): item is MorphSelectGroup => "options" in item;
function normalize(items: MorphSelectItem[]): Section[] {
  const out: Section[] = [];
  items.forEach((item, index) => {
    if (isGroup(item)) { out.push({ key: `group-${index}`, label: item.label, options: item.options }); return; }
    const last = out[out.length - 1];
    if (last && !last.label) last.options.push(item);
    else out.push({ key: `loose-${index}`, options: [item] });
  });
  return out;
}
const matches = (option: MorphSelectOption, needle: string) => `${option.label} ${option.meta ?? ""} ${option.keywords ?? ""}`.toLowerCase().includes(needle);
const triggerWidth = (node: HTMLElement) => {
  const exact = node.getBoundingClientRect().width;
  const rounded = node.offsetWidth;
  return Math.abs(exact - rounded) <= 0.5 ? Math.ceil(exact - 0.01) : rounded + 1;
};

/**
 * Arc MorphSelect: a select whose trigger is the list. Opening grows the trigger into the options surface, a highlight
 * glides between options, and the chosen option's label lifts out of the list and settles into the trigger while the
 * trigger springs to its new width. Groups, type-ahead, search for long lists and the full listbox keyboard model.
 */
export function MorphSelect(props: MorphSelectProps) {
  const uid = createUniqueId();
  const labelId = `ms-${uid}-label`;
  const listId = `ms-${uid}-list`;
  const optionId = (index: number) => `ms-${uid}-option-${index}`;
  let rootEl: HTMLDivElement | undefined;
  let measure: HTMLSpanElement | undefined;
  let listFace: HTMLDivElement | undefined;
  let scroller: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let input: HTMLInputElement | undefined;
  let slot: HTMLSpanElement | undefined;
  let anchor: HTMLDivElement | undefined;
  let shape: HTMLDivElement | undefined;
  let highlight: HTMLSpanElement | undefined;
  const optionEls = new Map<string, HTMLElement>();

  const sections = createMemo(() => normalize(props.items));
  const all = createMemo(() => sections().flatMap(section => section.options));
  const indexOf = createMemo(() => new Map(all().map((option, index) => [option.value, index])));
  const canSearch = () => (props.searchable ?? "auto") === "auto" ? all().length > 8 : !!props.searchable;
  const [inner, setInner] = createSignal<string | null>(props.defaultValue ?? null);
  const selected = () => (props.value !== undefined ? props.value : inner());
  const selectedOption = () => {
    const value = selected();
    return value === null ? undefined : all().find(option => option.value === value);
  };
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal<string | null>(null);
  const [direction, setDirection] = createSignal(1);
  let fly: { x: number; y: number } | null = null;
  const needle = () => query().trim().toLowerCase();
  const visibleSections = createMemo(() => (needle()
    ? sections().map(section => ({ ...section, options: section.options.filter(option => matches(option, needle())) })).filter(section => section.options.length)
    : sections()));
  const enabled = createMemo(() => visibleSections().flatMap(section => section.options).filter(option => !option.disabled));
  const current = () => {
    const key = active();
    return key !== null && enabled().some(option => option.value === key) ? key : enabled()[0]?.value ?? null;
  };
  const resultCount = () => visibleSections().reduce((sum, section) => sum + section.options.length, 0);

  /* The shape: one surface whose width, height and corners spring between the trigger and the open list. */
  const sizes = { trigger: 0, lid: 0, listW: 0, listH: 0 };
  const shapeState = { anchor: 0, w: 0, h: 0, r: 22 };
  let measured = false;
  const running: AnimationControls[] = [];
  const apply = () => {
    if (anchor) anchor.style.width = `${shapeState.anchor}px`;
    if (shape) {
      shape.style.width = `${shapeState.w}px`;
      shape.style.height = `${shapeState.h}px`;
      shape.style.setProperty("--sq-r", `${shapeState.r}px`);
    }
  };
  const tweenTo = (key: keyof typeof shapeState, to: number, transition: object) => {
    running.push(animate(shapeState[key], to, { ...transition, onUpdate: (value: number) => { shapeState[key] = value; apply(); } }));
  };
  const place = (animated: boolean) => {
    const { trigger: triggerW, lid, listW, listH } = sizes;
    if (!triggerW || !lid) return;
    const isOpen = open();
    const next = isOpen ? { w: Math.max(triggerW, listW), h: lid + listH, r: OPEN_RADIUS } : { w: triggerW, h: lid, r: lid / 2 };
    running.splice(0).forEach(controls => controls.stop());
    if (!animated || prefersReducedMotion() || !measured) {
      Object.assign(shapeState, { anchor: triggerW, w: next.w, h: next.h, r: next.r });
      apply();
      measured = true;
      return;
    }
    const transition = next.w * next.h >= shapeState.w * shapeState.h ? GROW : SHRINK;
    tweenTo("anchor", triggerW, triggerW < shapeState.anchor ? NARROW : WIDTH);
    tweenTo("w", next.w, isOpen ? transition : next.w < shapeState.w ? NARROW : WIDTH);
    tweenTo("h", next.h, transition);
    tweenTo("r", next.r, transition);
  };
  const read = () => {
    if (!measure || !listFace || !rootEl) return false;
    rootEl.style.setProperty("--ms-trigger-w", `${triggerWidth(measure)}px`);
    const next = { trigger: triggerWidth(measure), lid: measure.offsetHeight, listW: listFace.offsetWidth, listH: listFace.offsetHeight };
    const changed = next.trigger !== sizes.trigger || next.lid !== sizes.lid || (open() && (next.listW !== sizes.listW || next.listH !== sizes.listH));
    Object.assign(sizes, next);
    return changed;
  };
  onMount(() => {
    if (read()) place(false);
    rootEl?.setAttribute("data-ready", "");
    if (!measure || !listFace || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (read()) place(measured); });
    observer.observe(measure);
    observer.observe(listFace);
    onCleanup(() => observer.disconnect());
  });
  let pendingFocus: "trigger" | "input" | null = null;
  createEffect(on(open, () => {
    queueMicrotask(() => {
      read();
      place(true);
      const target = pendingFocus;
      pendingFocus = null;
      if (target === "input") input?.focus({ preventScroll: true });
      if (target === "trigger") trigger?.focus({ preventScroll: true });
    });
  }, { defer: true }));

  /* The highlight glides between options on its own spring and fades when nothing is active. */
  let highlightShown = false;
  let scrollIntent = false;
  createEffect(on([current, open, visibleSections], ([key, isOpen]) => {
    queueMicrotask(() => {
      if (!highlight) return;
      const node = isOpen && key !== null ? optionEls.get(key) : undefined;
      if (!node) { animate(highlight, { opacity: 0 }, { duration: prefersReducedMotion() || !isOpen ? 0 : 0.12 }); highlightShown = false; return; }
      const top = node.offsetTop;
      const height = node.offsetHeight;
      if (!highlightShown || prefersReducedMotion()) animate(highlight, { y: top, height: `${height}px` }, { duration: 0 });
      else animate(highlight, { y: top, height: `${height}px` }, GLIDE);
      animate(highlight, { opacity: 1 }, { duration: prefersReducedMotion() ? 0 : 0.12 });
      highlightShown = true;
      if (scroller && scrollIntent) {
        scrollIntent = false;
        const pad = 6;
        if (top < scroller.scrollTop + pad) scroller.scrollTop = top - pad;
        else if (top + height > scroller.scrollTop + scroller.clientHeight - pad) scroller.scrollTop = top + height - scroller.clientHeight + pad;
      }
    });
  }));

  const typeahead = { buffer: "", at: 0 };
  let suppressClick = false;
  const [announcement, setAnnouncement] = createSignal("");
  const openList = (focus?: string | null, seed = "") => {
    if (props.disabled || open()) return;
    setQuery(seed);
    setActive(focus !== undefined ? focus : selected());
    scrollIntent = true;
    pendingFocus = canSearch() ? "input" : "trigger";
    setAnnouncement("");
    setOpen(true);
  };
  const close = (restoreFocus: boolean) => {
    typeahead.buffer = "";
    if (restoreFocus) pendingFocus = "trigger";
    setOpen(false);
  };
  const commit = (option: MorphSelectOption | undefined, source?: HTMLElement | null) => {
    if (!option || option.disabled) return;
    if (option.value !== selected()) {
      fly = null;
      const part = source?.querySelector<HTMLElement>("[data-part='value']");
      if (!prefersReducedMotion() && part && slot) {
        const from = part.getBoundingClientRect();
        const to = slot.getBoundingClientRect();
        fly = { x: from.left - to.left, y: from.top + from.height / 2 - (to.top + to.height / 2) };
      }
      const value = selected();
      const fromIndex = value === null ? -1 : indexOf().get(value) ?? -1;
      const toIndex = indexOf().get(option.value) ?? 0;
      setDirection(fromIndex < 0 ? 1 : Math.sign(toIndex - fromIndex) || 1);
      if (props.value === undefined) setInner(option.value);
      props.onValueChange?.(option.value, option);
    }
    close(true);
  };
  const typeTo = (char: string) => {
    const now = performance.now();
    typeahead.buffer = now - typeahead.at > TYPEAHEAD_RESET ? char : typeahead.buffer + char;
    typeahead.at = now;
    const buffer = typeahead.buffer.toLowerCase();
    const repeated = buffer.split("").every(letter => letter === buffer[0]);
    const search = repeated ? buffer[0] ?? "" : buffer;
    const pool = all().filter(option => !option.disabled);
    const from = open() ? current() : selected();
    const at = pool.findIndex(option => option.value === from);
    const offset = repeated || buffer.length === 1 ? 1 : 0;
    const ordered = [...pool.slice(at + offset), ...pool.slice(0, at + offset)];
    return ordered.find(option => option.label.toLowerCase().startsWith(search));
  };
  const move = (to: string | null | undefined) => {
    if (to === undefined || to === null) return;
    scrollIntent = true;
    setActive(to);
  };
  const onKey = (event: KeyboardEvent, fromInput: boolean) => {
    const key = event.key;
    if (key === " " && !fromInput) suppressClick = true;
    const printable = key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
    const typing = performance.now() - typeahead.at < TYPEAHEAD_RESET && typeahead.buffer.length > 0;
    if (!open()) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || (key === " " && !typing)) { event.preventDefault(); openList(); return; }
      if (key === "Home" || key === "End") { event.preventDefault(); const pool = all().filter(option => !option.disabled); openList((key === "Home" ? pool[0] : pool[pool.length - 1])?.value ?? null); return; }
      if (printable) {
        event.preventDefault();
        if (canSearch()) openList(undefined, key);
        else { const hit = typeTo(key); openList(hit?.value ?? selected()); }
      }
      return;
    }
    const list = enabled();
    const at = list.findIndex(option => option.value === current());
    const caretKeys = fromInput && query().length > 0;
    switch (key) {
      case "ArrowDown": event.preventDefault(); move(list[Math.min(list.length - 1, at + 1)]?.value); return;
      case "ArrowUp":
        event.preventDefault();
        if (event.altKey) { commit(list[at], optionEls.get(current() ?? "")); return; }
        move(list[Math.max(0, at - 1)]?.value); return;
      case "PageDown": event.preventDefault(); move(list[Math.min(list.length - 1, at + PAGE)]?.value); return;
      case "PageUp": event.preventDefault(); move(list[Math.max(0, at - PAGE)]?.value); return;
      case "Home": if (caretKeys) return; event.preventDefault(); move(list[0]?.value); return;
      case "End": if (caretKeys) return; event.preventDefault(); move(list[list.length - 1]?.value); return;
      case "Enter": event.preventDefault(); commit(list[at], optionEls.get(current() ?? "")); return;
      case "Escape": event.preventDefault(); event.stopPropagation(); close(true); return;
      case "Tab": close(false); return;
    }
    if (fromInput) return;
    if (key === " " && !typing) { event.preventDefault(); commit(list[at], optionEls.get(current() ?? "")); return; }
    if (printable) { event.preventDefault(); move(typeTo(key)?.value); }
  };
  createEffect(() => {
    if (!open()) return;
    const down = (event: PointerEvent) => { if (!rootEl?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", down);
    onCleanup(() => document.removeEventListener("pointerdown", down));
  });
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (open() && next && !rootEl?.contains(next)) close(false);
  };
  const onQuery = (next: string) => {
    setQuery(next);
    setActive(null);
    scrollIntent = true;
    if (scroller) scroller.scrollTop = 0;
    const text = next.trim().toLowerCase();
    const count = text ? all().filter(option => matches(option, text)).length : all().length;
    setAnnouncement(text ? (count ? `${count} ${count === 1 ? "option" : "options"}` : "No matches") : "");
  };
  const renderValue = (option: MorphSelectOption | undefined) => (option
    ? <>{option.icon ? <span class={styles.icon} aria-hidden="true">{freshJSX(option.icon)}</span> : null}<span class={styles.valueText}>{option.label}</span></>
    : <span class={styles.placeholder}>{props.placeholder ?? "Select"}</span>);
  const showSearch = () => open() && canSearch();

  return (
    <div
      ref={rootEl}
      class={[styles.root, props.class ?? ""].join(" ")}
      style={{ "--ms-panel-w": `${props.panelWidth ?? 272}px`, "--ms-list-max": `${props.maxListHeight ?? 296}px` }}
      data-open={open() || undefined}
      data-align={props.align ?? "start"}
      data-disabled={props.disabled || undefined}
      onFocusOut={onFocusOut}
    >
      <span id={labelId} class={props.hideLabel ? "sr-only" : styles.label}>{props.label}</span>
      <div ref={anchor} class={styles.anchor}>
        <span ref={measure} class={`${styles.trigger} ${styles.measure}`} aria-hidden="true">{renderValue(selectedOption())}</span>
        <div ref={el => { shape = el; useSquircle(el); }} class={styles.shape}>
          <div class={styles.lid}>
            <button
              ref={trigger}
              type="button"
              class={styles.trigger}
              role="combobox"
              aria-labelledby={labelId}
              aria-haspopup="listbox"
              aria-expanded={open()}
              aria-controls={listId}
              aria-activedescendant={open() && !canSearch() && current() !== null ? optionId(indexOf().get(current() ?? "") ?? 0) : undefined}
              disabled={props.disabled}
              inert={showSearch() || undefined}
              tabIndex={showSearch() ? -1 : 0}
              onClick={() => { if (suppressClick) { suppressClick = false; return; } if (open()) close(true); else openList(); }}
              onKeyDown={event => onKey(event, false)}
              onKeyUp={event => { if (event.key === " ") window.setTimeout(() => { suppressClick = false; }); }}
            >
              <span ref={slot} class={styles.slot} data-hidden={showSearch() || undefined}>
                <Swap
                  value={selected() ?? "__empty"}
                  class={styles.layer}
                  enter={el => {
                    if (prefersReducedMotion()) return animate(el, { opacity: [0, 1] }, tween(0.12));
                    const flight = fly;
                    fly = null;
                    if (flight) return animate(el, { x: [flight.x, 0], y: [flight.y, 0] }, { x: FLY, y: FLY });
                    return animate(el, { opacity: [0, 1], y: [`${direction() * 0.5}em`, "0em"], filter: ["blur(4px)", "blur(0px)"] }, { y: GLIDE, opacity: tween(0.2), filter: tween(0.22) });
                  }}
                  exit={el => (prefersReducedMotion() ? animate(el, { opacity: 0 }, tween(0.1)) : animate(el, { opacity: 0, y: `${direction() * -0.45}em`, filter: "blur(2px)" }, tween(0.12)))}
                >
                  {() => renderValue(selectedOption())}
                </Swap>
              </span>
            </button>
            <Show when={canSearch()}>
              <div class={styles.searchRow} inert={!showSearch() || undefined} data-open={showSearch() || undefined}>
                <Search class={styles.searchIcon} size={16} stroke-width={1.75} aria-hidden="true" />
                <input
                  ref={input}
                  class={styles.input}
                  type="text"
                  role="combobox"
                  aria-label={`Search ${props.label.toLowerCase()}`}
                  aria-expanded={open()}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={open() && current() !== null ? optionId(indexOf().get(current() ?? "") ?? 0) : undefined}
                  placeholder={props.searchPlaceholder ?? selectedOption()?.label ?? "Search"}
                  value={query()}
                  autocomplete="off"
                  spellcheck={false}
                  onInput={event => onQuery(event.currentTarget.value)}
                  onKeyDown={event => onKey(event, true)}
                />
                <Presence when={!!query()} enter={el => animate(el, { opacity: [0, 1], scale: [0.6, 1] }, prefersReducedMotion() ? { duration: 0 } : GLIDE)} exit={el => animate(el, { opacity: 0, scale: 0.6 }, tween(0.1))}>
                  {ref => <button ref={ref} type="button" class={styles.clear} aria-label="Clear search" onPointerDown={event => event.preventDefault()} onClick={() => { onQuery(""); input?.focus(); }}><X size={14} stroke-width={1.75} aria-hidden="true" /></button>}
                </Presence>
                <button type="button" class={styles.closeHit} aria-label={`Close ${props.label.toLowerCase()}`} onClick={() => close(true)} />
              </div>
            </Show>
            <span class={styles.chevron} aria-hidden="true" data-open={open() || undefined}><ChevronDown size={16} stroke-width={1.75} /></span>
          </div>
          <div ref={listFace} class={styles.listFace} inert={!open() || undefined} aria-hidden={!open() || undefined} data-open={open() || undefined}>
            <div ref={scroller} class={styles.scroll}>
              <div id={listId} class={styles.options} role="listbox" aria-labelledby={labelId}>
                <span ref={highlight} class={styles.highlight} aria-hidden="true" />
                <For each={visibleSections()}>
                  {section => (
                    <div role={section.label ? "group" : "presentation"} aria-labelledby={section.label ? `ms-${uid}-${section.key}` : undefined} class={styles.group}>
                      <Show when={section.label}><div id={`ms-${uid}-${section.key}`} class={styles.groupLabel} role="presentation">{section.label}</div></Show>
                      <For each={section.options}>
                        {option => (
                          <div
                            id={optionId(indexOf().get(option.value) ?? 0)}
                            role="option"
                            aria-selected={option.value === selected()}
                            aria-disabled={option.disabled || undefined}
                            class={styles.option}
                            data-active={option.value === current() || undefined}
                            ref={el => { optionEls.set(option.value, el); onCleanup(() => optionEls.delete(option.value)); }}
                            onPointerMove={event => { if (event.pointerType === "mouse" && !option.disabled && option.value !== current()) setActive(option.value); }}
                            onPointerDown={event => event.preventDefault()}
                            onClick={event => commit(option, event.currentTarget)}
                          >
                            <span class={styles.optionValue} data-part="value">
                              <Show when={option.icon}><span class={styles.icon} aria-hidden="true">{freshJSX(option.icon)}</span></Show>
                              <span class={styles.valueText}>{option.label}</span>
                            </span>
                            <Show when={option.meta}><span class={styles.meta}>{option.meta}</span></Show>
                            <span class={styles.check} data-on={option.value === selected() || undefined} aria-hidden="true"><Check size={16} stroke-width={1.75} /></span>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
                <Show when={resultCount() === 0}><p class={styles.empty}>No matches for “{query().trim()}”</p></Show>
              </div>
            </div>
          </div>
        </div>
      </div>
      <Show when={props.name}><input type="hidden" name={props.name} value={selected() ?? ""} /></Show>
      <span class="sr-only" role="status" aria-live="polite">{announcement()}</span>
    </div>
  );
}

export default MorphSelect;

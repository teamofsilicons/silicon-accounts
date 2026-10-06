import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { Check, ChevronLeft, ChevronRight, Plus, X } from "lucide-solid";
import { createPresenceList, type PresenceEntry } from "../lib/presence-list";
import { MorphText, Presence, SwapText } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween, type AnimationControls } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./filter-toolbar.module.css";

export interface FilterChip {
  /** The field id: a second pick for a field replaces the first. */
  id: string;
  label: string;
  value?: string;
}
/** One value a field can take. `hint` sits at the end of the row, for example a count. */
export interface FilterOption {
  value: string;
  label?: string;
  hint?: string | number;
  icon?: JSX.Element;
}
export interface FilterField {
  id: string;
  label: string;
  icon?: JSX.Element;
  options: (string | FilterOption)[];
}

export interface FilterMenuProps {
  fields: FilterField[];
  /** Receives a chip whose id is the field id, so a second pick for a field replaces the first. */
  onSelect: (filter: FilterChip, field: FilterField) => void;
  /** Applied filters: each field shows its current value and the value step marks it. */
  active?: FilterChip[];
  label?: string;
  /** The trigger edge the panel lines up with; it shifts when the viewport has no room. */
  align?: "start" | "end";
}

export interface FilterToolbarProps {
  filters: FilterChip[];
  onRemove: (id: string) => void;
  onClearAll?: () => void;
  /** Extra actions (a search field, a sort select) after the chips. */
  children?: JSX.Element;
  label?: string;
  /** Adds an Add filter trigger that morphs into a two step field and value menu. */
  addFilter?: { fields: FilterField[]; onAdd: (filter: FilterChip, field: FilterField) => void; label?: string; align?: "start" | "end" };
}

const toOption = (entry: string | FilterOption): FilterOption => (typeof entry === "string" ? { value: entry } : entry);
const optionText = (entry: FilterOption) => entry.label ?? entry.value;
const blur = (px: number) => `blur(${px}px)`;

function describeChange(before: FilterChip[], after: FilterChip[]) {
  const text = (filter: FilterChip) => (filter.value ? `${filter.label}: ${filter.value}` : filter.label);
  const removed = before.filter(old => !after.some(filter => filter.id === old.id));
  if (!after.length && removed.length > 1) return "All filters cleared";
  const added = after.filter(filter => !before.some(old => old.id === filter.id));
  const changed = after.filter(filter => before.some(old => old.id === filter.id && old.value !== filter.value));
  return [...added.map(filter => `Added ${text(filter)}`), ...changed.map(filter => `${filter.label} changed to ${filter.value ?? "any"}`), ...removed.map(filter => `Removed ${text(filter)}`)].join(". ");
}

type Row = { key: string; label: string; icon?: JSX.Element; meta?: JSX.Element; checked?: boolean; drill?: boolean };

/** A roving menu list with one highlight that glides under the pointer and jumps with the keyboard. */
function MenuList(props: { rows: Row[]; labelledBy: string; radio?: boolean; onChoose: (row: Row, keyboard: boolean) => void; onBack?: (keyboard: boolean) => void; focus?: "first" | "last" | "checked" | string | null }) {
  let list: HTMLDivElement | undefined;
  let highlight: HTMLSpanElement | undefined;
  let pointer = false;
  let shown = false;
  const typed = { text: "", at: 0 };
  const [current, setCurrent] = createSignal(Math.max(0, untrack(() => props.rows.findIndex(row => row.checked))));
  const items = () => Array.from(list?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
  const move = (item: HTMLElement | undefined) => {
    if (!item || !list) return;
    item.focus({ preventScroll: true });
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
  };
  onMount(() => {
    const request = props.focus;
    if (!request) return;
    queueMicrotask(() => {
      const all = items();
      const target = request === "first" ? all[0] : request === "last" ? all.at(-1) : request === "checked" ? all.find(item => item.getAttribute("aria-checked") === "true") ?? all[0] : all.find(item => item.dataset.row === request) ?? all[0];
      target?.focus({ preventScroll: true });
    });
  });
  const onKeyDown = (event: KeyboardEvent) => {
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLElement);
    const go = (next: number) => { event.preventDefault(); pointer = false; move(all[next]); };
    if (event.key === "ArrowDown") return go(index < 0 ? 0 : (index + 1) % all.length);
    if (event.key === "ArrowUp") return go(index < 0 ? all.length - 1 : (index - 1 + all.length) % all.length);
    if (event.key === "Home") return go(0);
    if (event.key === "End") return go(all.length - 1);
    const row = index >= 0 ? props.rows[index] : undefined;
    if (event.key === "ArrowRight" && row?.drill) { event.preventDefault(); props.onChoose(row, true); return; }
    if (event.key === "ArrowLeft" && props.onBack) { event.preventDefault(); props.onBack(true); return; }
    if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = performance.now();
      typed.text = now - typed.at < 700 ? typed.text + event.key.toLowerCase() : event.key.toLowerCase();
      typed.at = now;
      const offset = typed.text.length > 1 ? 0 : 1;
      const order = [...all.slice(index + offset), ...all.slice(0, index + offset)];
      const match = order.find(item => (item.dataset.text ?? "").toLowerCase().startsWith(typed.text));
      if (match) go(all.indexOf(match));
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (!item || !highlight) return;
    setCurrent(items().indexOf(item));
    const target = { y: item.offsetTop, height: `${item.offsetHeight}px`, opacity: 1 };
    if (shown && pointer && !prefersReducedMotion()) animate(highlight, target, { ...spring.snappy, opacity: { duration: 0.08 } });
    else animate(highlight, target, { duration: 0, opacity: { duration: prefersReducedMotion() ? 0 : 0.08 } });
    shown = true;
  };
  const onFocusOut = (event: FocusEvent) => {
    if (list?.contains(event.relatedTarget as Node | null) || !highlight) return;
    shown = false;
    animate(highlight, { opacity: 0 }, { duration: prefersReducedMotion() ? 0 : 0.08 });
  };
  return (
    <div ref={list} class={styles.list} role="menu" aria-labelledby={props.labelledBy} onKeyDown={onKeyDown} onFocusIn={onFocusIn} onFocusOut={onFocusOut}>
      <span ref={highlight} class={styles.highlight} aria-hidden="true" />
      <For each={props.rows}>
        {(row, index) => (
          <button
            type="button"
            class={styles.item}
            role={props.radio ? "menuitemradio" : "menuitem"}
            aria-checked={props.radio ? !!row.checked : undefined}
            tabIndex={index() === current() ? 0 : -1}
            data-row={row.key}
            data-text={row.label}
            onPointerMove={event => { pointer = true; if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }); }}
            onClick={event => props.onChoose(row, event.detail === 0)}
          >
            <Show when={row.icon}><span class={styles.itemIcon} aria-hidden="true">{row.icon}</span></Show>
            <span class={styles.itemLabel}>{row.label}</span>
            <Show when={row.meta}><span class={styles.itemMeta}>{row.meta}</span></Show>
          </button>
        )}
      </For>
    </div>
  );
}

/**
 * An Add filter button that grows into its own menu: pick a field, then a value. The surface springs between the
 * button and the panel; the panel renders in place, so keep its ancestors free of overflow clipping.
 */
export function FilterMenu(props: FilterMenuProps) {
  const uid = createUniqueId();
  const panelId = `fm-${uid}-panel`;
  const titleId = `fm-${uid}-title`;
  let root: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let surface: HTMLDivElement | undefined;
  let panel: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  const [phase, setPhase] = createSignal<"closed" | "open" | "closing">("closed");
  const [fieldId, setFieldId] = createSignal<string | null>(null);
  const [focusRequest, setFocusRequest] = createSignal<"first" | "last" | "checked" | string | null>(null);
  const [up, setUp] = createSignal(false);
  /** The surface's box relative to the trigger, and where it ends up (the panel content stays put at `final`). */
  const geometry = { left: 0, width: 0, height: 0, final: 0 };
  let running: AnimationControls[] = [];
  /** The panel height the surface is heading for; the list mounting during the open spring updates it. */
  let targetHeight = 0;
  let opening = false;
  const field = () => props.fields.find(entry => entry.id === fieldId()) ?? null;
  const current = (entry: FilterField) => props.active?.find(filter => filter.id === entry.id)?.value;

  const paint = (progress: number) => {
    if (!surface) return;
    surface.style.left = `${geometry.left}px`;
    surface.style.width = `${geometry.width}px`;
    surface.style.height = `${geometry.height}px`;
    if (panel) panel.style.transform = `translateX(${geometry.final - geometry.left}px)`;
    if (content) {
      const reveal = Math.min(1, Math.max(0, (progress - 0.4) / 0.5));
      content.style.opacity = String(reveal);
      content.style.transform = `translateY(${(1 - reveal) * (up() ? -6 : 6)}px) scale(${0.96 + reveal * 0.04})`;
      content.style.filter = reveal >= 1 ? "none" : blur((1 - reveal) * motionTokens.blur.soft);
    }
    if (trigger) {
      const face = Math.min(1, progress / 0.35);
      trigger.style.setProperty("--face-opacity", String(1 - face));
    }
  };
  const stop = () => { running.forEach(controls => controls.stop()); running = []; opening = false; };

  const openMenu = (focus: "first" | "last" | "panel") => {
    if (!trigger || !panel || !root) return;
    const rect = trigger.getBoundingClientRect();
    const panelWidth = panel.offsetWidth + 2;
    const panelHeight = panel.offsetHeight + 2;
    const gutter = 16;
    const viewport = document.documentElement.clientWidth;
    const min = gutter - rect.left;
    const max = viewport - gutter - rect.left - panelWidth;
    const end = rect.width - panelWidth;
    let x = (props.align ?? "end") === "end" ? (end >= min ? end : 0) : 0 <= max ? 0 : end;
    x = Math.round(Math.min(Math.max(x, min), Math.max(min, max)));
    setUp(window.innerHeight - rect.top < panelHeight + gutter && rect.bottom > window.innerHeight - rect.top);
    stop();
    const from = phase() === "closed" ? { left: 0, width: rect.width, height: rect.height } : { left: geometry.left, width: geometry.width, height: geometry.height };
    Object.assign(geometry, from, { final: x });
    setFieldId(null);
    setFocusRequest(focus === "panel" ? null : focus);
    setPhase("open");
    if (focus === "panel") queueMicrotask(() => panel?.focus({ preventScroll: true }));
    const target = { left: x, width: panelWidth };
    targetHeight = panelHeight;
    if (prefersReducedMotion()) {
      Object.assign(geometry, target, { height: panelHeight });
      paint(1);
      return;
    }
    const start = { left: geometry.left, width: geometry.width, height: geometry.height };
    opening = true;
    running.push(animate(0, 1, {
      ...spring.morph,
      onUpdate: p => {
        geometry.left = start.left + (target.left - start.left) * p;
        geometry.width = start.width + (target.width - start.width) * p;
        // The list renders once the menu opens, so the height target can grow while this runs.
        geometry.height = start.height + (targetHeight - start.height) * p;
        paint(Math.min(1, Math.max(0, p)));
      },
      onComplete: () => { opening = false; },
    }));
  };

  const closeMenu = (restore: false | "keyboard" | "pointer") => {
    if (phase() !== "open" || !trigger) return;
    setPhase("closing");
    if (restore) trigger.focus({ preventScroll: true });
    stop();
    const rect = trigger.getBoundingClientRect();
    const start = { left: geometry.left, width: geometry.width, height: geometry.height };
    const target = { left: 0, width: rect.width, height: rect.height };
    const done = () => {
      setPhase("closed");
      setFieldId(null);
      if (surface) Object.assign(surface.style, { left: "", width: "", height: "" });
      if (panel) panel.style.transform = "";
      trigger?.style.setProperty("--face-opacity", "1");
    };
    if (prefersReducedMotion()) { done(); return; }
    const controls = animate(0, 1, { ...spring.snappy, onUpdate: p => {
      geometry.left = start.left + (target.left - start.left) * p;
      geometry.width = start.width + (target.width - start.width) * p;
      geometry.height = start.height + (target.height - start.height) * p;
      paint(1 - p);
    }, onComplete: () => { if (phase() === "closing") done(); } });
    running.push(controls);
  };

  // A new step changes the panel height; the surface follows on the smooth spring instead of snapping.
  onMount(() => {
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (phase() !== "open" || !panel) return;
      const next = panel.offsetHeight + 2;
      targetHeight = next;
      if (opening || Math.abs(next - geometry.height) < 1) return;
      const start = geometry.height;
      if (prefersReducedMotion()) { geometry.height = next; paint(1); return; }
      running.push(animate(start, next, { ...spring.smooth, onUpdate: value => { geometry.height = value; paint(1); } }));
    });
    observer.observe(panel);
    onCleanup(() => { observer.disconnect(); stop(); });
  });

  createEffect(() => {
    if (phase() !== "open") return;
    const onPointerDown = (event: PointerEvent) => {
      if (root?.contains(event.target as Node)) return;
      closeMenu(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));
  });

  const chooseField = (row: Row, keyboard: boolean) => {
    setFocusRequest(keyboard ? "checked" : null);
    setFieldId(row.key);
    if (!keyboard) queueMicrotask(() => panel?.focus({ preventScroll: true }));
  };
  const goBack = (keyboard: boolean) => {
    const previous = fieldId();
    setFocusRequest(keyboard && previous ? previous : null);
    setFieldId(null);
    if (!keyboard) queueMicrotask(() => panel?.focus({ preventScroll: true }));
  };
  const chooseValue = (row: Row, keyboard: boolean) => {
    const entry = field();
    if (!entry) return;
    props.onSelect({ id: entry.id, label: entry.label, value: row.label }, entry);
    closeMenu(keyboard ? "keyboard" : "pointer");
  };

  const fieldRows = createMemo<Row[]>(() => props.fields.map(entry => ({
    key: entry.id,
    label: entry.label,
    icon: entry.icon,
    drill: true,
    meta: <>{current(entry) ? <span class={styles.metaValue}>{current(entry)}</span> : null}<ChevronRight size={15} stroke-width={1.8} aria-hidden="true" /></>,
  })));
  const valueRows = createMemo<Row[]>(() => {
    const entry = field();
    if (!entry) return [];
    return entry.options.map(toOption).map(option => {
      const text = optionText(option);
      const checked = current(entry) === text;
      return {
        key: option.value,
        label: text,
        icon: option.icon,
        checked,
        meta: option.hint != null || checked ? <>{option.hint != null ? <span class={styles.hint}>{option.hint}</span> : null}<span class={styles.check} data-on={checked || undefined}><Check size={15} stroke-width={2} aria-hidden="true" /></span></> : undefined,
      };
    });
  });
  const open = () => phase() === "open";

  return (
    <div
      ref={root}
      class={styles.menu}
      data-state={phase()}
      data-y={up() ? "up" : "down"}
      onKeyDown={event => { if (event.key === "Escape" && phase() === "open") { event.preventDefault(); event.stopPropagation(); closeMenu("keyboard"); } }}
      onFocusOut={event => { const next = event.relatedTarget as Node | null; if (phase() === "open" && next && !root?.contains(next)) closeMenu(false); }}
    >
      <button
        ref={trigger}
        type="button"
        class={styles.trigger}
        data-filter-trigger=""
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={panelId}
        tabIndex={open() ? -1 : undefined}
        onClick={event => { if (phase() !== "open") openMenu(event.detail === 0 ? "first" : "panel"); }}
        onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openMenu(event.key === "ArrowDown" ? "first" : "last"); } }}
      >
        <span class={styles.face}><Plus size={15} stroke-width={1.8} aria-hidden="true" />{props.label ?? "Add filter"}</span>
      </button>
      <div ref={el => { surface = el; useSquircle(el); }} class={styles.surface}>
        <div ref={panel} id={panelId} class={styles.panel} role="dialog" aria-labelledby={titleId} tabIndex={-1} inert={!open() || undefined} onKeyDown={event => {
          if (event.defaultPrevented) return;
          const rows = Array.from(panel?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); (event.key === "ArrowDown" ? rows[0] : rows.at(-1))?.focus({ preventScroll: true }); }
          if (event.key === "ArrowLeft" && field()) { event.preventDefault(); goBack(true); }
        }}>
          <div ref={content} class={styles.content}>
            <div class={styles.head}>
              <Show when={field()}>
                <button type="button" class={styles.back} aria-label="Back to fields" onClick={event => goBack(event.detail === 0)}><ChevronLeft size={16} stroke-width={1.8} aria-hidden="true" /></button>
              </Show>
              <span class={styles.title} id={titleId}><SwapText text={field()?.label ?? props.label ?? "Add filter"} /></span>
            </div>
            <div class={styles.stage}>
              <Show when={field()} fallback={<Show when={open()}><MenuList rows={fieldRows()} labelledBy={titleId} onChoose={chooseField} focus={focusRequest()} /></Show>}>
                <MenuList rows={valueRows()} labelledBy={titleId} radio onChoose={chooseValue} onBack={goBack} focus={focusRequest()} />
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chip(props: { entry: PresenceEntry<FilterChip>; onRemove: (id: string, viaKeyboard: boolean) => void; onGone: () => void }) {
  let slot: HTMLSpanElement | undefined;
  let chip: HTMLSpanElement | undefined;
  const filter = () => props.entry.item();
  onMount(() => {
    if (!slot || !chip || !props.entry.entering || prefersReducedMotion()) return;
    const width = slot.offsetWidth;
    slot.style.overflow = "clip";
    animate(slot, { width: [0, width], marginRight: [-8, 0] }, spring.smooth).then(() => { if (slot) Object.assign(slot.style, { width: "", overflow: "", marginRight: "" }); });
    animate(chip, { opacity: [0, 1], scale: [0.9, 1], filter: [blur(motionTokens.blur.soft), blur(0)] }, { ...tween(motionTokens.duration.standard, motionTokens.ease.enter), scale: spring.snappy });
  });
  createEffect(on(props.entry.leaving, leaving => {
    if (!leaving || !slot || !chip) return;
    if (prefersReducedMotion()) return props.onGone();
    slot.style.overflow = "clip";
    slot.style.pointerEvents = "none";
    animate(chip, { opacity: 0, scale: 0.9, filter: blur(motionTokens.blur.subtle) }, tween(motionTokens.duration.instant));
    animate(slot, { width: [slot.offsetWidth, 0], marginRight: [0, -8] }, spring.smooth).then(props.onGone);
  }, { defer: true }));
  return (
    <span ref={slot} class={styles.slot} aria-hidden={props.entry.leaving() || undefined}>
      <span ref={el => { chip = el; useSquircle(el); }} class={styles.chip}>
        <span class={styles.chipLabel}>
          {filter().label}
          <Show when={filter().value}>
            <span class={styles.value}><span class={styles.separator}> · </span><MorphText text={filter().value ?? ""} class={styles.morph} /><span class="sr-only">{filter().value}</span></span>
          </Show>
        </span>
        <button type="button" data-chip-remove={filter().id} tabIndex={props.entry.leaving() ? -1 : 0} aria-label={`Remove ${filter().label}${filter().value ? `: ${filter().value}` : ""}`} onClick={event => props.onRemove(filter().id, event.detail === 0)}>
          <X size={14} stroke-width={1.8} aria-hidden="true" />
        </button>
      </span>
    </span>
  );
}

/**
 * Arc FilterToolbar (ported to Solid): applied filters as removable chips that grow into place and collapse away,
 * a value change morphs in the chip, an "Add filter" menu, and "Clear all". Changes are announced politely.
 */
export function FilterToolbar(props: FilterToolbarProps) {
  let root: HTMLDivElement | undefined;
  let frame: HTMLDivElement | undefined;
  let list: HTMLDivElement | undefined;
  const [message, setMessage] = createSignal("");
  let seen = untrack(() => props.filters);
  createEffect(on(() => props.filters, filters => {
    const next = describeChange(seen, filters);
    seen = filters;
    if (next) setMessage(next);
  }, { defer: true }));
  const { entries, release } = createPresenceList(() => props.filters, filter => filter.id);
  let pendingFocus: number | null = null;

  // The frame follows the chip list height on a spring while filters change; other resizes follow at once.
  let armedUntil = 0;
  createEffect(on(() => props.filters.map(filter => `${filter.id}:${filter.value ?? ""}`).join("|"), () => { armedUntil = performance.now() + 900; }, { defer: true }));
  onMount(() => {
    if (!frame || !list || typeof ResizeObserver === "undefined") return;
    let known = false;
    const observer = new ResizeObserver(() => {
      if (!frame || !list) return;
      const next = list.offsetHeight;
      if (!known || prefersReducedMotion() || performance.now() > armedUntil) { known = true; frame.style.height = `${next}px`; return; }
      animate(frame, { height: `${next}px` }, spring.smooth);
    });
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });

  // A removed chip hands focus to its neighbour, or to the Add filter trigger once the list is empty.
  createEffect(on(() => props.filters, filters => {
    const index = pendingFocus;
    if (index === null || !root) return;
    pendingFocus = null;
    queueMicrotask(() => {
      const next = filters[Math.min(index, filters.length - 1)];
      const target = next ? root?.querySelector<HTMLElement>(`[data-chip-remove="${CSS.escape(next.id)}"]`) : root?.querySelector<HTMLElement>("[data-filter-trigger]");
      target?.focus({ preventScroll: true });
    });
  }, { defer: true }));

  return (
    <div ref={el => { root = el; useSquircle(el); }} class={styles.toolbar} role="group" aria-label={props.label ?? "Active filters"}>
      <div ref={frame} class={styles.frame}>
        <div ref={list} class={styles.chips}>
          <For each={entries()}>
            {entry => (
              <Chip
                entry={entry}
                onRemove={(id, keyboard) => {
                  if (keyboard || document.activeElement?.closest("[data-chip-remove]")) pendingFocus = props.filters.findIndex(filter => filter.id === id);
                  props.onRemove(id);
                }}
                onGone={() => release(entry)}
              />
            )}
          </For>
          <Presence
            when={props.filters.length === 0}
            enter={el => animate(el, { opacity: [0, 1], y: ["0.3em", "0em"], filter: [blur(motionTokens.blur.soft), blur(0)] }, prefersReducedMotion() ? { duration: 0 } : { ...tween(motionTokens.duration.standard, motionTokens.ease.enter), delay: motionTokens.duration.instant * 0.75 })}
            exit={el => animate(el, { opacity: 0 }, tween(prefersReducedMotion() ? 0 : motionTokens.duration.instant))}
          >
            {ref => <span ref={ref} class={styles.empty}>No filters applied</span>}
          </Presence>
        </div>
      </div>
      <div class={styles.actions}>
        <Show when={props.addFilter}>
          {add => <FilterMenu fields={add().fields} onSelect={add().onAdd} active={props.filters} label={add().label} align={add().align} />}
        </Show>
        {props.children}
        <Presence
          when={props.filters.length > 0 && !!props.onClearAll}
          enter={el => animate(el, { opacity: [0, 1] }, tween(prefersReducedMotion() ? 0 : motionTokens.duration.standard, motionTokens.ease.enter))}
          exit={el => animate(el, { opacity: 0 }, tween(prefersReducedMotion() ? 0 : motionTokens.duration.instant))}
        >
          {ref => <button ref={ref} class={styles.clear} type="button" onClick={() => { pendingFocus = -1; props.onClearAll?.(); }}>Clear all</button>}
        </Presence>
      </div>
      <span class="sr-only" role="status">{message()}</span>
    </div>
  );
}

export default FilterToolbar;

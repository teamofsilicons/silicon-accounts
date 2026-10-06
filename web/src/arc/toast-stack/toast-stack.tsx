import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type Accessor } from "solid-js";
import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-solid";
import { Presence, SwapText } from "../lib/presence";
import { createContentSwap } from "../lib/content-swap";
import { createPresenceList, type PresenceEntry } from "../lib/presence-list";
import { animate, motionTokens, prefersReducedMotion, spring, tween, type AnimationControls } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./toast-stack.module.css";

export type ToastType = "success" | "info" | "warning" | "error" | "loading";

export interface ToastAction {
  label: string;
  /** Runs the action. The toast closes afterwards unless the handler updates it (an Undo can morph it into its result). */
  onClick: (id: string) => void;
}

export interface ToastOptions {
  /** Reuse an id to update a toast in place instead of stacking a new one. */
  id?: string;
  type?: ToastType;
  title: string;
  description?: string;
  action?: ToastAction;
  /** Milliseconds before the toast closes itself. Defaults by type; loading toasts wait for an update. */
  duration?: number;
}

type ToastRecord = { id: string; type: ToastType; title: string; description?: string; action?: ToastAction; duration: number; seq: number; version: number };

const BASE = 5000;
const LIMIT = 12;
const PEEK = 14;
const GAP = 12;
const STEP = 0.05;
const BORDER = 2;
const SWIPE_FADE = 280;
const typeLabels: Record<ToastType, string> = { success: "Success", info: "Info", warning: "Warning", error: "Error", loading: "In progress" };
const durationFor = (type: ToastType, base: number) => (type === "loading" ? Infinity : type === "warning" || type === "error" ? base * 1.6 : base);
const project = (velocity: number) => ((velocity / 1000) * 0.99) / (1 - 0.99);
const rubberBand = (distance: number, dimension: number) => (1 - 1 / ((distance * 0.55) / dimension + 1)) * dimension;
const focusVisible = (element: Element) => { try { return element.matches(":focus-visible"); } catch { return true; } };

/* ------------------------------------------------------------------------------------------------------------------ */
/* Store (one per page; the account site renders one viewport in its shell)                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

const [records, setRecords] = createSignal<ToastRecord[]>([]);
let seq = 0;

/** Morphs a toast in place: icon, copy and height animate to the new content and its timer restarts. */
function update(id: string, patch: Partial<Omit<ToastOptions, "id">>) {
  const found = records().find(item => item.id === id);
  if (!found) return;
  const type = patch.type ?? found.type;
  const record: ToastRecord = { ...found, ...patch, type, duration: patch.duration ?? durationFor(type, BASE), version: found.version + 1 };
  setRecords(list => list.map(item => (item.id === id ? record : item)));
}
/** Shows a toast and returns its id. */
function show({ id, ...options }: ToastOptions): string {
  if (id && records().some(item => item.id === id)) { update(id, options); return id; }
  const type = options.type ?? "info";
  seq += 1;
  const record: ToastRecord = { ...options, id: id ?? `toast-${seq}`, type, duration: options.duration ?? durationFor(type, BASE), seq, version: 0 };
  setRecords(list => [record, ...list].slice(0, LIMIT));
  return record.id;
}
/** Dismisses one toast, or every toast when called without an id. */
function dismiss(id?: string) {
  if (id === undefined) { setRecords([]); return; }
  setRecords(list => list.filter(item => item.id !== id));
}
function runAction(id: string) {
  const found = records().find(item => item.id === id);
  if (!found?.action) return;
  found.action.onClick(id);
  if (records().find(item => item.id === id)?.version === found.version) dismiss(id);
}

/**
 * The toast API. Toasts are for the results of background work and short confirmations; a foreground action still
 * confirms in place (the button, the row). Errors from the API should also show inline next to their cause.
 */
export const toast = Object.assign(show, {
  update,
  dismiss,
  success: (title: string, description?: string, options: Partial<ToastOptions> = {}) => show({ ...options, type: "success", title, description }),
  info: (title: string, description?: string, options: Partial<ToastOptions> = {}) => show({ ...options, type: "info", title, description }),
  warning: (title: string, description?: string, options: Partial<ToastOptions> = {}) => show({ ...options, type: "warning", title, description }),
  error: (title: string, description?: string, options: Partial<ToastOptions> = {}) => show({ ...options, type: "error", title, description }),
  loading: (title: string, description?: string, options: Partial<ToastOptions> = {}) => show({ ...options, type: "loading", title, description }),
  /** Live count of queued toasts. */
  count: (): number => records().length,
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* Layout                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

type Target = { y: number; scale: number; height: number; opacity: number; content: number };

function layoutStack(toasts: ToastRecord[], heights: Record<string, number>, expanded: boolean, visibleToasts: number) {
  const front = toasts.length ? heights[toasts[0]?.id ?? ""] ?? 0 : 0;
  const tops = toasts.reduce<number[]>((sum, item, index) => [...sum, (sum[index] ?? 0) + (index < visibleToasts ? (heights[item.id] ?? 0) + GAP : 0)], [0]);
  const targets = new Map<string, Target>();
  toasts.forEach((item, index) => {
    const visible = index < visibleToasts;
    const depth = Math.min(index, visibleToasts);
    targets.set(item.id, expanded
      ? { y: -(tops[index] ?? 0), scale: 1, height: heights[item.id] ?? 0, opacity: visible ? 1 : 0, content: 1 }
      : { y: -PEEK * depth, scale: 1 - STEP * depth, height: index === 0 ? heights[item.id] ?? 0 : front, opacity: visible ? 1 : 0, content: index === 0 ? 1 : 0 });
  });
  const listHeight = !toasts.length ? 0 : expanded ? (tops[toasts.length] ?? 0) - GAP : front + PEEK * (Math.min(toasts.length, visibleToasts) - 1);
  return { targets, listHeight };
}

const icons = { success: CircleCheck, info: Info, warning: TriangleAlert, error: CircleX };

interface ItemProps {
  entry: PresenceEntry<ToastRecord>;
  target: Accessor<Target | undefined>;
  expanded: Accessor<boolean>;
  front: Accessor<boolean>;
  hidden: Accessor<boolean>;
  paused: Accessor<boolean>;
  onMeasure: (id: string, height: number) => void;
  onDragChange: (dragging: boolean) => void;
  onTap: () => void;
  onHandOff: (leaving: HTMLElement, keyboard: boolean) => void;
  onGone: () => void;
}

function ToastItem(props: ItemProps) {
  const record = () => props.entry.item();
  const id = untrack(record).id;
  let item: HTMLLIElement | undefined;
  let card: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  let iconSlot: HTMLSpanElement | undefined;
  let glyph: HTMLSpanElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  createContentSwap(() => iconSlot, () => glyph);
  // Stack geometry lives in plain numbers written straight to the DOM, so following the stack never re-renders.
  const g = { y: 0, scale: 1, height: 0, opacity: 0, content: 1, x: 0 };
  const paint = () => {
    if (!item) return;
    item.style.transform = `translateY(${g.y}px) scale(${g.scale})`;
    item.style.height = `${g.height}px`;
    item.style.opacity = String(g.opacity);
    if (content) content.style.opacity = String(g.content);
    if (card) {
      card.style.transform = g.x ? `translateX(${g.x}px)` : "";
      card.style.opacity = String(g.x > 0 ? 1 - Math.min(g.x / SWIPE_FADE, 1) * 0.75 : 1);
    }
  };
  const running: Partial<Record<keyof typeof g, AnimationControls>> = {};
  const to = (key: keyof typeof g, value: number, transition: object) => {
    running[key]?.stop();
    running[key] = animate(g[key], value, { ...transition, onUpdate: (next: number) => { g[key] = next; paint(); } });
    return running[key];
  };
  let applied: boolean | null = null;
  let swiped = false;
  let remaining = untrack(record).duration;

  onMount(() => {
    if (!content) return;
    props.onMeasure(id, content.offsetHeight + BORDER);
    const observer = new ResizeObserver(() => { if (content) props.onMeasure(id, content.offsetHeight + BORDER); });
    observer.observe(content);
    onCleanup(() => { observer.disconnect(); Object.values(running).forEach(controls => controls?.stop()); });
  });

  // Every stack change retargets the running springs from wherever they are.
  createEffect(on([props.target, props.expanded], ([target, expanded]) => {
    if (!target || props.entry.leaving() || target.height <= 0) return;
    const entering = applied === null;
    const morph = !entering && applied !== expanded;
    applied = expanded;
    if (prefersReducedMotion()) {
      Object.assign(g, { y: target.y, scale: target.scale, height: target.height });
      paint();
      to("opacity", target.opacity, tween(motionTokens.duration.fast));
      to("content", target.content, tween(motionTokens.duration.fast));
      return;
    }
    if (entering) { Object.assign(g, { y: target.y + target.height, scale: target.scale, height: target.height, content: target.content, opacity: 0 }); paint(); }
    const motionSpring = morph ? spring.morph : spring.smooth;
    to("y", target.y, motionSpring);
    to("scale", target.scale, motionSpring);
    if (!entering) to("height", target.height, motionSpring);
    to("opacity", target.opacity, entering ? tween(motionTokens.duration.standard, motionTokens.ease.enter) : tween(motionTokens.duration.fast));
    to("content", target.content, tween(motionTokens.duration.fast));
  }));

  // An update restarts the clock; pausing keeps whatever time is left.
  createEffect(on(() => record().version, () => { remaining = record().duration; }, { defer: true }));
  createEffect(() => {
    record().version;
    if (props.entry.leaving() || props.paused() || !Number.isFinite(remaining) || record().duration <= 0) return;
    const started = performance.now();
    const timer = window.setTimeout(() => dismiss(id), Math.max(remaining, 0));
    onCleanup(() => { window.clearTimeout(timer); remaining -= performance.now() - started; });
  });

  // Leaving: hand focus on before the toast turns inert, then fade out quickly.
  createEffect(on(props.entry.leaving, leaving => {
    if (!leaving || !item) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && item.contains(active)) props.onHandOff(item, focusVisible(active));
    item.setAttribute("inert", "");
    if (prefersReducedMotion()) { to("opacity", 0, tween(motionTokens.duration.fast))?.then(props.onGone); return; }
    if (!swiped) { to("y", g.y + 10, spring.smooth); to("scale", g.scale * 0.96, spring.smooth); }
    to("opacity", 0, { duration: swiped ? 0.22 : motionTokens.duration.exit, ease: [...motionTokens.ease.standard] as [number, number, number, number] })?.then(props.onGone);
  }, { defer: true }));

  /* Swipe right to dismiss. */
  let gesture: { pointerId: number; startX: number; startY: number; origin: number; active: boolean; samples: { t: number; x: number }[] } | null = null;
  let suppressClick = false;
  let pointerType = "mouse";
  const onPointerDown = (event: PointerEvent) => {
    pointerType = event.pointerType;
    suppressClick = false;
    if (event.button !== 0 || props.entry.leaving() || (event.target as Element).closest("button, a")) return;
    running.x?.stop();
    gesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: g.x, active: false, samples: [] };
  };
  const onPointerMove = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const current = gesture;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.active) {
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (Math.hypot(dx, dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) { gesture = null; return; }
      current.active = true;
      current.startX = event.clientX;
      suppressClick = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = "";
      window.getSelection()?.removeAllRanges();
      props.onDragChange(true);
    }
    const raw = current.origin + event.clientX - current.startX;
    g.x = raw >= 0 ? raw : -rubberBand(-raw, event.currentTarget.offsetWidth);
    paint();
    current.samples.push({ t: event.timeStamp, x: raw });
    while (current.samples.length > 2 && event.timeStamp - (current.samples[0]?.t ?? 0) > 100) current.samples.shift();
  };
  const onPointerEnd = (event: PointerEvent & { currentTarget: HTMLDivElement }, cancelled: boolean) => {
    const current = gesture;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture = null;
    if (!current.active) return;
    delete event.currentTarget.dataset.dragging;
    props.onDragChange(false);
    const first = current.samples[0];
    const last = current.samples[current.samples.length - 1];
    const velocity = cancelled || !first || !last || last.t === first.t || event.timeStamp - last.t > 60 ? 0 : ((last.x - first.x) / (last.t - first.t)) * 1000;
    const width = event.currentTarget.offsetWidth;
    if (!cancelled && g.x > 0 && velocity > -200 && g.x + project(velocity) > width * 0.4) {
      swiped = true;
      if (!prefersReducedMotion()) to("x", width + 40, { type: "spring", visualDuration: 0.32, bounce: 0, velocity: Math.max(velocity, 0) });
      dismiss(id);
      return;
    }
    if (prefersReducedMotion()) { g.x = 0; paint(); }
    else to("x", 0, { ...spring.snappy, velocity: g.x < 0 ? velocity * 0.3 : velocity });
  };

  const Icon = () => {
    const type = record().type;
    if (type === "loading") return <span class={styles.spinner} />;
    const Glyph = icons[type];
    return <Glyph width={18} height={18} stroke-width={1.75} />;
  };

  return (
    <li ref={item} class={styles.item} style={{ "z-index": String(record().seq), opacity: 0 }} data-front={props.front()} data-expanded={props.expanded()} inert={props.hidden() || undefined} onKeyDown={event => { if (event.key !== "Escape") return; event.stopPropagation(); dismiss(id); }}>
      <div
        ref={el => { card = el; useSquircle(el); }}
        class={styles.card}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={event => onPointerEnd(event, false)}
        onPointerCancel={event => onPointerEnd(event, true)}
        onClick={event => {
          if (suppressClick) { suppressClick = false; return; }
          if (pointerType !== "mouse" && !(event.target as Element).closest("button, a")) props.onTap();
        }}
      >
        <div ref={content} class={styles.content}>
          <span ref={iconSlot} class={styles.icon} data-type={record().type} aria-hidden="true"><span ref={glyph} class={styles.glyph} data-icon={record().type}>{Icon()}</span></span>
          <div class={styles.copy}>
            <span class="sr-only">{typeLabels[record().type]}: </span>
            <span class={styles.title}><SwapText text={record().title} class={styles.line} /></span>
            <Show when={record().description}><span class={styles.description}><SwapText text={record().description ?? ""} class={styles.line} /></span></Show>
          </div>
          <Presence when={!!record().action} enter={el => animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.fast))} exit={el => animate(el, { opacity: 0 }, tween(motionTokens.duration.fast))}>
            {ref => (
              <div ref={ref} class={styles.actionSlot}>
                <button type="button" ref={el => useSquircle(el)} class={styles.action} onClick={event => {
                  const keyboard = focusVisible(event.currentTarget);
                  runAction(id);
                  if (keyboard && !records().find(entry => entry.id === id)?.action) closeButton?.focus();
                }}>{record().action?.label}</button>
              </div>
            )}
          </Presence>
          <button ref={closeButton} type="button" class={styles.close} aria-label="Dismiss notification" onClick={() => dismiss(id)}>
            <X width={16} height={16} stroke-width={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  );
}

export interface ToastStackProps {
  label?: string;
  position?: "bottom-right" | "bottom-center" | "bottom-left";
  visibleToasts?: number;
  /** Alt+T moves focus into the stack. */
  hotkey?: boolean;
  class?: string;
}

/**
 * Arc ToastStack viewport: new toasts rise from the bottom edge, older ones tuck behind, and hovering or focusing the
 * stack fans it out into a list. Toasts pause while the stack is open or the tab is hidden, and swipe right to dismiss.
 * Render it once (the account shell does) and call `toast(...)` from anywhere.
 */
export function ToastStack(props: ToastStackProps) {
  const visibleToasts = () => props.visibleToasts ?? 3;
  const [hovered, setHovered] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const [tapped, setTapped] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [pageHidden, setPageHidden] = createSignal(typeof document !== "undefined" && document.visibilityState === "hidden");
  const [heights, setHeights] = createSignal<Record<string, number>>({});
  let region: HTMLElement | undefined;
  let list: HTMLOListElement | undefined;
  let returnFocus: HTMLElement | null = null;
  createEffect(() => { if (tapped() && records().length === 0) setTapped(false); });
  const expanded = () => records().length > 0 && (hovered() || focused() || tapped());
  const paused = () => expanded() || dragging() || pageHidden();
  const layout = createMemo(() => layoutStack(records(), heights(), expanded(), visibleToasts()));
  const { entries, release } = createPresenceList(records, item => item.id);
  const measure = (id: string, height: number) => setHeights(current => (current[id] === height ? current : { ...current, [id]: height }));

  onMount(() => {
    const visibility = () => setPageHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", visibility);
    onCleanup(() => document.removeEventListener("visibilitychange", visibility));
    if (props.hotkey === false) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.code !== "KeyT") return;
      const target = list?.querySelector<HTMLElement>(":scope > li:not([inert]) button");
      if (!target) return;
      event.preventDefault();
      target.focus({ focusVisible: true } as FocusOptions);
      setFocused(true);
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  createEffect(() => {
    if (!tapped()) return;
    const down = (event: PointerEvent) => { if (!region?.contains(event.target as Node)) setTapped(false); };
    document.addEventListener("pointerdown", down);
    onCleanup(() => document.removeEventListener("pointerdown", down));
  });
  const handOff = (leaving: HTMLElement, keyboard: boolean) => {
    const items = Array.from(list?.children ?? []) as HTMLElement[];
    const at = items.indexOf(leaving);
    const candidates = items.filter(item => item !== leaving && !item.hasAttribute("inert"));
    const next = candidates.find(item => items.indexOf(item) > at) ?? candidates[candidates.length - 1];
    const button = next?.querySelector<HTMLElement>("button");
    if (keyboard && button) button.focus();
    else if (keyboard && returnFocus?.isConnected) returnFocus.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <section
      ref={region}
      class={[styles.viewport, styles[props.position ?? "bottom-right"], props.class ?? ""].join(" ")}
      aria-label={props.hotkey === false ? props.label ?? "Notifications" : `${props.label ?? "Notifications"} (Alt+T)`}
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      onFocusIn={event => {
        const from = event.relatedTarget;
        if (!(from instanceof Node) || !event.currentTarget.contains(from)) returnFocus = from instanceof HTMLElement ? from : null;
        if (focusVisible(event.target as Element)) setFocused(true);
      }}
      onFocusOut={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    >
      <ol
        ref={list}
        class={styles.list}
        style={{ height: `${layout().listHeight}px` }}
        data-expanded={expanded()}
        onPointerEnter={event => { if (event.pointerType === "mouse") setHovered(true); }}
        onPointerMove={event => { if (event.pointerType === "mouse" && !hovered()) setHovered(true); }}
        onPointerLeave={event => { if (event.pointerType === "mouse") setHovered(false); }}
      >
        <For each={entries()}>
          {entry => {
            const index = () => records().findIndex(item => item.id === entry.key);
            return (
              <ToastItem
                entry={entry}
                target={() => layout().targets.get(entry.key)}
                expanded={expanded}
                front={() => index() === 0}
                hidden={() => index() >= visibleToasts()}
                paused={paused}
                onMeasure={measure}
                onDragChange={setDragging}
                onTap={() => setTapped(open => !open)}
                onHandOff={handOff}
                onGone={() => {
                  release(entry);
                  setHeights(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== entry.key)));
                }}
              />
            );
          }}
        </For>
      </ol>
    </section>
  );
}

export default ToastStack;

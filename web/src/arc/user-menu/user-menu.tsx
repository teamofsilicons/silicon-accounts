import { For, Show, createEffect, createSignal, createUniqueId, on, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { ChevronDown, LoaderCircle, LogOut, Monitor, Moon, Sun, SunMoon } from "lucide-solid";
import { Avatar } from "../avatar/avatar";
import { Presence, SwapText } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./user-menu.module.css";

export type ThemePreference = "light" | "dark" | "system";

export interface UserMenuAccount {
  displayName: string;
  /** The c:id or si:id. */
  id: string;
  pfpUrl?: string | null;
  kind?: "carbon" | "silicon";
}

export interface UserMenuItem {
  label: string;
  icon?: JSX.Element;
  keys?: string[];
  onSelect?: () => void;
}

export interface UserMenuProps {
  account: UserMenuAccount;
  theme?: ThemePreference;
  onThemeChange?: (theme: ThemePreference, trigger: HTMLElement) => void;
  showTheme?: boolean;
  /** Account destinations with optional shortcut hints. Keep it to three or four. */
  items?: UserMenuItem[];
  onSignOut?: () => void | Promise<unknown>;
  signOutKeys?: string[];
  align?: "start" | "center" | "end";
  /** Opens above the trigger (for a bottom dock). */
  side?: "top" | "bottom";
  /** Shows the name and a chevron beside the avatar from 640px up. */
  showName?: boolean;
  class?: string;
}

const themes: { value: ThemePreference; label: string; icon: () => JSX.Element }[] = [
  { value: "light", label: "Light", icon: () => <Sun size={16} stroke-width={1.75} aria-hidden="true" /> },
  { value: "dark", label: "Dark", icon: () => <Moon size={16} stroke-width={1.75} aria-hidden="true" /> },
  { value: "system", label: "Match the device", icon: () => <Monitor size={16} stroke-width={1.75} aria-hidden="true" /> },
];
const compactQuery = "(max-width: 639px)";
const getStops = (root: HTMLElement | undefined) => Array.from(root?.querySelectorAll<HTMLElement>("[data-stop]") ?? []);
function focusStop(stop: HTMLElement | undefined) {
  if (!stop) return;
  const target = stop.dataset.stop === "group" ? stop.querySelector<HTMLElement>('[aria-checked="true"]') ?? stop.querySelector<HTMLElement>("button") : stop;
  target?.focus({ preventScroll: true });
}

/**
 * Arc UserMenu, adapted for Silicon Accounts: the account menu behind the avatar. A compact identity header (name and
 * id), a few destinations, an inline theme switch and sign out. Below 640px it opens as a bottom sheet that can be
 * dragged away. Theme choices keep the menu open; everything else closes it and returns focus to the trigger.
 */
export function UserMenu(props: UserMenuProps) {
  const uid = createUniqueId();
  const menuId = `um-${uid}-menu`;
  const triggerId = `um-${uid}-trigger`;
  const media = typeof window !== "undefined" ? window.matchMedia(compactQuery) : undefined;
  const [compact, setCompact] = createSignal(media?.matches ?? false);
  onMount(() => {
    const change = (event: MediaQueryListEvent) => setCompact(event.matches);
    media?.addEventListener("change", change);
    onCleanup(() => media?.removeEventListener("change", change));
  });
  const [open, setOpenSignal] = createSignal(false);
  const [signingOut, setSigningOut] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  let surface: HTMLDivElement | undefined;
  let list: HTMLDivElement | undefined;
  let highlight: HTMLSpanElement | undefined;
  let highlightShown = false;
  let reason: "first" | "last" | "pointer" | null = null;
  const typed = { text: "", timer: 0 };
  let pending = false;
  const [highlightTone, setHighlightTone] = createSignal<string | undefined>();

  const setOpen = (next: boolean, why: typeof reason = null) => {
    reason = next ? why : null;
    if (next) setSigningOut(pending);
    highlightShown = false;
    setOpenSignal(next);
  };
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger?.focus({ preventScroll: true });
  };

  // Focus moves in only when a person opened the menu.
  createEffect(on(open, isOpen => {
    if (!isOpen) return;
    const why = reason;
    reason = null;
    requestAnimationFrame(() => {
      place();
      if (!why) return;
      const stops = getStops(list);
      if (why === "first") focusStop(stops[0]);
      else if (why === "last") focusStop(stops[stops.length - 1]);
      else surface?.focus({ preventScroll: true });
    });
  }, { defer: true }));

  // The panel is placed against the trigger and scales from the avatar's centre, flipping when there is no room.
  const place = () => {
    if (!open() || compact() || !surface || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = surface.offsetWidth;
    const height = surface.offsetHeight;
    const align = props.align ?? "end";
    const wanted = align === "start" ? rect.left : align === "center" ? rect.left + rect.width / 2 - width / 2 : rect.right - width;
    const left = Math.min(Math.max(12, wanted), window.innerWidth - width - 12);
    const below = rect.bottom + 8;
    const above = rect.top - 8 - height;
    const preferTop = props.side === "top";
    const top = preferTop ? (above > 12 ? above : below) : below + height > window.innerHeight - 12 && above > 12 ? above : below;
    surface.style.left = `${left}px`;
    surface.style.top = `${top}px`;
    const originX = rect.left + Math.min(rect.width, 40) / 2 - left;
    surface.style.setProperty("--origin-x", `${Math.min(Math.max(0, originX), width)}px`);
    surface.style.setProperty("--origin-y", top < rect.top ? `${height}px` : "0px");
  };
  createEffect(() => {
    if (!open() || compact()) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    onCleanup(() => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); });
  });
  // Outside presses close the panel. The sheet has its own scrim.
  createEffect(() => {
    if (!open() || compact()) return;
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (surface?.contains(target) || trigger?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", down, true);
    onCleanup(() => document.removeEventListener("pointerdown", down, true));
  });
  // The page behind the sheet stays put.
  createEffect(() => {
    if (!open() || !compact()) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    onCleanup(() => { root.style.overflow = previous; });
  });

  const signOut = () => {
    if (pending) return;
    const result = props.onSignOut?.();
    if (!result || typeof (result as Promise<unknown>).then !== "function") { close(true); return; }
    pending = true;
    setSigningOut(true);
    const done = () => { pending = false; close(false); };
    (result as Promise<unknown>).then(done, done);
  };

  const moveHighlight = (stop: HTMLElement | null) => {
    if (!highlight) return;
    if (!stop || stop.dataset.stop === "group") {
      animate(highlight, { opacity: 0 }, { duration: prefersReducedMotion() ? 0 : motionTokens.duration.instant });
      highlightShown = false;
      return;
    }
    setHighlightTone(stop.dataset.tone);
    const target = { y: stop.offsetTop, height: `${stop.offsetHeight}px` };
    if (highlightShown && !prefersReducedMotion()) animate(highlight, { ...target, opacity: 1 }, { ...spring.snappy, opacity: { duration: motionTokens.duration.instant } });
    else animate(highlight, { ...target, opacity: 1 }, { duration: 0, opacity: { duration: prefersReducedMotion() ? 0 : motionTokens.duration.instant } });
    highlightShown = true;
  };
  const onListFocus = (event: FocusEvent) => moveHighlight(event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-stop]") : null);
  const onItemPointerMove = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (event.pointerType === "touch") return;
    if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });
  };
  const onListPointerLeave = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    moveHighlight(null);
    surface?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const stops = getStops(list);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = active?.closest<HTMLElement>("[data-stop]") ?? null;
    const index = current ? stops.indexOf(current) : -1;
    const step = (to: HTMLElement | undefined) => { event.preventDefault(); focusStop(to); };
    switch (event.key) {
      case "ArrowDown": return step(stops[(index + 1) % stops.length]);
      case "ArrowUp": return step(stops[index <= 0 ? stops.length - 1 : index - 1]);
      case "Home": return step(stops[0]);
      case "End": return step(stops[stops.length - 1]);
      case "Escape": case "Tab": event.preventDefault(); return close(true);
      case "ArrowLeft": case "ArrowRight": {
        if (current?.dataset.stop !== "group") return;
        event.preventDefault();
        const segments = Array.from(current.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
        const at = Math.max(0, segments.findIndex(segment => segment.getAttribute("aria-checked") === "true"));
        const next = segments[(at + (event.key === "ArrowRight" ? 1 : -1) + segments.length) % segments.length];
        next?.focus({ preventScroll: true });
        next?.click();
        return;
      }
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || event.key === " ") return;
    window.clearTimeout(typed.timer);
    typed.text += event.key.toLowerCase();
    typed.timer = window.setTimeout(() => { typed.text = ""; }, 500);
    const ordered = [...stops.slice(index + 1), ...stops.slice(0, index + 1)];
    const match = ordered.find(stop => stop.dataset.label?.toLowerCase().startsWith(typed.text));
    if (match) step(match);
  };

  const themeIndex = () => Math.max(0, themes.findIndex(option => option.value === (props.theme ?? "system")));
  const content = () => (
    <>
      <div class={styles.header}>
        <Avatar name={props.account.displayName} src={props.account.pfpUrl} kind={props.account.kind} size="lg" />
        <div class={styles.identity}>
          <span class={styles.name}>{props.account.displayName}</span>
          <span class={styles.id} title={props.account.id}>{props.account.id}</span>
        </div>
      </div>
      <div ref={list} class={styles.list} onFocusIn={onListFocus} onPointerLeave={onListPointerLeave}>
        <span ref={highlight} class={styles.highlight} data-tone={highlightTone()} aria-hidden="true" />
        <Show when={(props.items ?? []).length > 0}>
          <div class={styles.separator} role="separator" />
          <For each={props.items ?? []}>
            {item => (
              <button type="button" role="menuitem" tabIndex={-1} class={styles.item} data-stop="item" data-label={item.label} onPointerMove={onItemPointerMove} onClick={() => { close(true); item.onSelect?.(); }}>
                <span class={styles.icon} aria-hidden="true">{item.icon}</span>
                <span class={styles.itemLabel}>{item.label}</span>
                <Show when={item.keys}><kbd class={styles.keys} aria-hidden="true">{item.keys?.join("")}</kbd></Show>
              </button>
            )}
          </For>
        </Show>
        <Show when={props.showTheme ?? true}>
          <div class={styles.separator} role="separator" />
          <div class={styles.row} data-stop="group" data-label="Theme">
            <span class={styles.icon} aria-hidden="true"><SunMoon size={16} stroke-width={1.75} /></span>
            <span class={styles.rowLabel} aria-hidden="true">Theme</span>
            <div class={styles.segments} role="group" aria-label="Theme" style={{ "--index": String(themeIndex()), "--count": String(themes.length) }}>
              <span class={styles.thumb} aria-hidden="true" />
              <For each={themes}>
                {option => (
                  <button type="button" role="menuitemradio" tabIndex={-1} aria-checked={option.value === (props.theme ?? "system")} aria-label={option.label} title={option.label} class={styles.segment} onClick={event => props.onThemeChange?.(option.value, event.currentTarget)}>
                    {option.icon()}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <div class={styles.separator} role="separator" />
        <button type="button" role="menuitem" tabIndex={-1} class={styles.item} data-stop="item" data-tone="danger" data-label="Sign out" aria-busy={signingOut() || undefined} onPointerMove={onItemPointerMove} onClick={signOut}>
          <span class={styles.icon} aria-hidden="true"><Show when={signingOut()} fallback={<LogOut size={16} stroke-width={1.75} />}><LoaderCircle class={styles.spinner} size={16} stroke-width={1.75} /></Show></span>
          <span class={styles.itemLabel}><SwapText text={signingOut() ? "Signing out" : "Sign out"} /></span>
          <Show when={props.signOutKeys}><kbd class={styles.keys} aria-hidden="true">{props.signOutKeys?.join("")}</kbd></Show>
        </button>
      </div>
    </>
  );

  // The sheet can be dragged away.
  let drag: { start: number; offset: number; last: number; lastT: number; v: number } | null = null;
  const sheetDown = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    if (prefersReducedMotion() || (event.target as Element).closest("button")) return;
    drag = { start: event.clientY, offset: 0, last: event.clientY, lastT: event.timeStamp, v: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const sheetMove = (event: PointerEvent) => {
    if (!drag || !surface) return;
    const delta = event.clientY - drag.start;
    drag.offset = delta < 0 ? delta * 0.04 : delta * 0.9;
    drag.v = ((event.clientY - drag.last) / Math.max(1, event.timeStamp - drag.lastT)) * 1000;
    drag.last = event.clientY;
    drag.lastT = event.timeStamp;
    surface.style.translate = `0 ${drag.offset}px`;
  };
  const sheetUp = () => {
    if (!drag || !surface) return;
    const state = drag;
    drag = null;
    if (state.offset > 80 || state.v > 500) { close(true); return; }
    const node = surface;
    animate(state.offset, 0, { ...spring.snappy, onUpdate: value => { node.style.translate = `0 ${value}px`; } });
  };

  const menuAttrs = () => ({ id: menuId, role: "menu" as const, "aria-labelledby": triggerId, tabIndex: -1, onKeyDown });

  return (
    <span class={[styles.root, props.class ?? ""].join(" ")}>
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        class={styles.trigger}
        data-state={open() ? "open" : "closed"}
        data-name={props.showName || undefined}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={open() ? menuId : undefined}
        aria-label={`Account menu, ${props.account.displayName}, ${props.account.id}`}
        onClick={event => (open() ? close(false) : setOpen(true, event.detail === 0 ? "first" : "pointer"))}
        onKeyDown={event => { if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return; event.preventDefault(); setOpen(true, event.key === "ArrowDown" ? "first" : "last"); }}
      >
        <Avatar name={props.account.displayName} src={props.account.pfpUrl} kind={props.account.kind} size="sm" />
        <Show when={props.showName}><span class={styles.triggerName}>{props.account.displayName}</span><ChevronDown class={styles.chevron} size={16} stroke-width={1.75} aria-hidden="true" /></Show>
      </button>
      <Portal>
        <Presence
          when={open() && !compact()}
          enter={el => prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant)) : animate(el, { opacity: [0, 1], scale: [0.94, 1] }, { type: "spring", visualDuration: 0.3, bounce: 0, opacity: tween(motionTokens.duration.fast, motionTokens.ease.enter) })}
          exit={el => animate(el, { opacity: 0, scale: prefersReducedMotion() ? 1 : 0.97 }, { duration: motionTokens.duration.instant, ease: [0.4, 0, 1, 1] })}
        >
          {ref => <div ref={el => { surface = el; ref(el); useSquircle(el); }} {...menuAttrs()} class={styles.panel}>{content()}</div>}
        </Presence>
        <Presence when={open() && compact()} enter={el => animate(el, { opacity: [0, 1] }, tween(prefersReducedMotion() ? 0.1 : 0.2))} exit={el => animate(el, { opacity: 0 }, tween(prefersReducedMotion() ? 0.1 : 0.2))}>
          {ref => <div ref={ref} class={styles.scrim} aria-hidden="true" onClick={() => close(true)} />}
        </Presence>
        <Presence
          when={open() && compact()}
          enter={el => prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant)) : animate(el, { y: ["100%", "0%"] }, { ...motionTokens.spring.smooth, visualDuration: 0.36 })}
          exit={el => (prefersReducedMotion() ? animate(el, { opacity: 0 }, tween(motionTokens.duration.instant)) : animate(el, { y: "100%" }, { duration: 0.22, ease: [0.4, 0, 1, 1] }))}
        >
          {ref => (
            <div ref={el => { surface = el; ref(el); useSquircle(el); }} {...menuAttrs()} aria-modal="true" class={`${styles.panel} ${styles.sheet}`} onPointerDown={sheetDown} onPointerMove={sheetMove} onPointerUp={sheetUp} onPointerCancel={sheetUp}>
              <span class={styles.handle} aria-hidden="true" />
              {content()}
            </div>
          )}
        </Presence>
      </Portal>
    </span>
  );
}

export default UserMenu;

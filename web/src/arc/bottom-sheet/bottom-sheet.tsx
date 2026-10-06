import { Show, createEffect, createSignal, on, onCleanup, onMount, splitProps, untrack, type JSX } from "solid-js";
import { Dialog as K, useDialogContext } from "@kobalte/core/dialog";
import { Button, type ButtonProps } from "../button/button";
import { X } from "lucide-solid";
import { animate, motionTokens, prefersReducedMotion, type AnimationControls } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./bottom-sheet.module.css";

/**
 * Arc BottomSheet: rises from the bottom edge and rests at one or more heights (detents). Drags follow the finger,
 * stretch like a rubber band past the top, and a release coasts on its velocity to the nearest detent (a flick moves at
 * least one; down from the smallest closes). The dim follows the sheet's position. Used for navigation on phones.
 */
export interface BottomSheetProps {
  /** The control that opens the sheet, as a `<BottomSheetTrigger as={Button}>`. Focus returns to it on close. */
  trigger?: JSX.Element;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  /** Hide the title visually (it stays the dialog's accessible name). */
  hideTitle?: boolean;
  description?: string;
  /** Resting heights as fractions of the viewport height. The sheet opens at `initialDetent`. */
  detents?: number[];
  initialDetent?: number;
  onDetentChange?: (index: number) => void;
  closeLabel?: string;
  class?: string;
  children: JSX.Element;
}

type Stop = number | "closed";
type Drag = { startY: number; origin: number; from: number; moved: boolean; samples: { t: number; y: number }[] };

const EXTENSION = 160;
const CLOSED_GAP = 40;
const PROJECTION = 0.2;
const FLICK = 320;
const STRETCH = 120;
const LOW_DIM = 0.78;
const settle = motionTokens.spring.smooth;
const leave = { ...motionTokens.spring.smooth, visualDuration: 0.3 };
const rubber = (distance: number) => (1 - 1 / ((distance * 0.55) / STRETCH + 1)) * STRETCH;
const unrubber = (stretch: number) => ((1 / (1 - Math.min(stretch, STRETCH - 1) / STRETCH) - 1) * STRETCH) / 0.55;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
function velocityOf(samples: Drag["samples"], now: number) {
  const recent = samples.filter(sample => now - sample.t <= 80);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last || last === first || now - last.t > 60) return 0;
  return (last.y - first.y) / ((last.t - first.t) / 1000);
}

export function BottomSheet(props: BottomSheetProps) {
  const [uncontrolled, setUncontrolled] = createSignal(!!props.defaultOpen);
  const open = () => props.open ?? uncontrolled();
  const setOpen = (next: boolean) => {
    if (props.open === undefined) setUncontrolled(next);
    props.onOpenChange?.(next);
  };
  const [mounted, setMounted] = createSignal(untrack(open));
  createEffect(on(open, isOpen => { if (isOpen) setMounted(true); }));
  return (
    <K open={open()} onOpenChange={setOpen} modal preventScroll forceMount>
      {props.trigger}
      <Show when={mounted()}>
        <K.Portal>
          <Sheet {...props} present={open()} onDismiss={() => setOpen(false)} onGone={() => { if (!open()) setMounted(false); }} />
        </K.Portal>
      </Show>
    </K>
  );
}

function Sheet(props: Omit<BottomSheetProps, "trigger" | "open" | "defaultOpen" | "onOpenChange"> & { present: boolean; onDismiss: () => void; onGone: () => void }) {
  const stops = () => (props.detents ?? [0.45, 0.92]).filter(stop => stop > 0).sort((a, b) => a - b);
  const top = () => stops().length - 1;
  const [detent, setDetent] = createSignal(clamp(Math.round(untrack(() => props.initialDetent ?? 0)), 0, untrack(top)));
  const [announcement, setAnnouncement] = createSignal("");
  let sheet: HTMLDivElement | undefined;
  let body: HTMLDivElement | undefined;
  let overlay: HTMLDivElement | undefined;
  let y = 4000;
  let height = 0;
  let presence = 1;
  let detentNow = untrack(detent);
  let aim: Stop = detentNow;
  let drag: Drag | null = null;
  let arrive: (() => void) | undefined;
  let suppressClick = false;
  let controls: AnimationControls | undefined;
  let moving = false;

  const offset = (stop: Stop) => (stop === "closed" ? height + CLOSED_GAP : height * (1 - (stops()[stop] ?? 1) / (stops()[top()] ?? 1)));
  const paint = () => {
    if (sheet) { sheet.style.transform = `translateY(${y}px)`; sheet.style.opacity = String(presence); }
    if (overlay) {
      if (!height) { overlay.style.opacity = "0"; return; }
      const low = height * (1 - (stops()[0] ?? 1) / (stops()[top()] ?? 1));
      const closed = height + CLOSED_GAP;
      const dim = y <= low ? 1 - (1 - LOW_DIM) * (low ? y / low : 0) : LOW_DIM * (1 - (y - low) / (closed - low));
      overlay.style.opacity = String(clamp(dim, 0, 1) * presence);
    }
  };
  const go = (stop: Stop, velocity?: number, onArrive?: () => void) => {
    aim = stop;
    arrive = onArrive;
    const target = offset(stop);
    const done = () => { moving = false; const callback = arrive; arrive = undefined; callback?.(); };
    controls?.stop();
    if (prefersReducedMotion()) { y = target; paint(); done(); return; }
    moving = true;
    controls = animate(y, target, { ...(stop === "closed" ? leave : settle), ...(velocity === undefined ? {} : { velocity }), onUpdate: value => { y = value; paint(); }, onComplete: done });
  };
  const rest = (stop: number, velocity?: number) => {
    if (stop !== detentNow) {
      detentNow = stop;
      setDetent(stop);
      props.onDetentChange?.(stop);
      setAnnouncement(stop === top() ? "Sheet expanded" : stop === 0 ? "Sheet collapsed" : `Sheet at ${Math.round((stops()[stop] ?? 0) * 100)} percent height`);
    }
    if (stop !== top() && body && body.scrollTop > 0) body.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    go(stop, velocity);
  };

  onMount(() => {
    if (!sheet) return;
    height = sheet.offsetHeight - EXTENSION;
    y = offset("closed");
    paint();
    if (prefersReducedMotion()) {
      y = offset(detentNow);
      presence = 0;
      paint();
      animate(0, 1, { duration: motionTokens.duration.fast, onUpdate: value => { presence = value; paint(); } });
    } else go(detentNow);
    queueMicrotask(() => sheet?.focus({ preventScroll: true }));
    const observer = new ResizeObserver(() => {
      if (!sheet) return;
      const next = sheet.offsetHeight - EXTENSION;
      if (next === height) return;
      height = next;
      if (drag || aim === "closed") return;
      if (moving) go(aim);
      else { y = offset(aim); paint(); }
    });
    observer.observe(sheet);
    onCleanup(() => { observer.disconnect(); controls?.stop(); });
  });

  // Leaving (Escape, outside press, close button) folds the sheet down; a reopen mid-exit catches it.
  createEffect(on(() => props.present, present => {
    if (present) { presence = 1; go(detentNow); return; }
    if (prefersReducedMotion()) {
      animate(presence, 0, { duration: motionTokens.duration.fast, onUpdate: value => { presence = value; paint(); } }).then(props.onGone);
      return;
    }
    if (aim === "closed" && moving) arrive = props.onGone;
    else go("closed", undefined, props.onGone);
  }, { defer: true }));

  const beginDrag = (clientY: number, time: number) => {
    controls?.stop();
    moving = false;
    drag = { startY: clientY, origin: y < 0 ? -unrubber(-y) : y, from: detentNow, moved: false, samples: [{ t: time, y: clientY }] };
  };
  const moveDrag = (clientY: number, time: number) => {
    if (!drag) return;
    const delta = clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(delta) < 3) return;
      drag.moved = true;
      sheet?.setAttribute("data-dragging", "");
    }
    const raw = drag.origin + delta;
    y = raw < 0 ? -rubber(-raw) : raw;
    paint();
    drag.samples.push({ t: time, y: clientY });
    if (drag.samples.length > 12) drag.samples.shift();
  };
  const endDrag = (time: number) => {
    const state = drag;
    drag = null;
    sheet?.removeAttribute("data-dragging");
    if (!state) return;
    if (!state.moved) { if (aim !== "closed") go(aim); return; }
    suppressClick = true;
    const velocity = y < 0 ? 0 : velocityOf(state.samples, time);
    const projected = y + velocity * PROJECTION;
    const candidates: Stop[] = [...stops().map((_, index) => index), "closed"];
    let target = candidates.reduce((best, stop) => (Math.abs(offset(stop) - projected) < Math.abs(offset(best) - projected) ? stop : best));
    if (Math.abs(velocity) > FLICK && target === state.from) target = velocity < 0 ? Math.min(state.from + 1, top()) : state.from === 0 ? "closed" : state.from - 1;
    if (target === "closed") { if (!prefersReducedMotion()) go("closed", velocity); props.onDismiss(); return; }
    rest(target, velocity);
  };

  // Touch drags on the content move the sheet until it is fully open; once open, the content scrolls and a pull down
  // from its top moves the sheet again.
  onMount(() => {
    if (!body) return;
    const node = body;
    let gesture: { x: number; y: number; mode: "pending" | "sheet" | "native" } | null = null;
    const start = (event: TouchEvent) => {
      const touch = event.touches[0];
      gesture = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, mode: "pending" } : null;
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!gesture || !touch || event.touches.length !== 1) return;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (gesture.mode === "pending") {
        if (detentNow === top()) {
          const scrollable = node.scrollHeight > node.clientHeight + 1;
          gesture.mode = Math.abs(dy) >= Math.abs(dx) && (!scrollable || (node.scrollTop <= 0 && dy > 0)) ? "sheet" : "native";
        } else {
          if (Math.hypot(dx, dy) < 4) return;
          gesture.mode = Math.abs(dy) >= Math.abs(dx) ? "sheet" : "native";
        }
        if (gesture.mode === "sheet") beginDrag(touch.clientY, event.timeStamp);
      }
      if (gesture.mode !== "sheet") return;
      if (event.cancelable) event.preventDefault();
      moveDrag(touch.clientY, event.timeStamp);
    };
    const end = (event: TouchEvent) => {
      if (gesture?.mode === "sheet") endDrag(event.timeStamp);
      gesture = null;
    };
    node.addEventListener("touchstart", start, { passive: true });
    node.addEventListener("touchmove", move, { passive: false });
    node.addEventListener("touchend", end);
    node.addEventListener("touchcancel", end);
    const scrolled = () => sheet?.toggleAttribute("data-scrolled", node.scrollTop > 1);
    node.addEventListener("scroll", scrolled, { passive: true });
    onCleanup(() => {
      node.removeEventListener("touchstart", start);
      node.removeEventListener("touchmove", move);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", end);
      node.removeEventListener("scroll", scrolled);
    });
  });

  const headerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.button !== 0 || !event.isPrimary) return;
    if (target?.closest("button, a, input, select, textarea, [role='button']") && !target.closest("[data-grabber]")) return;
    beginDrag(event.clientY, event.timeStamp);
  };
  const headerMove = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!drag) return;
    if (event.pointerType === "mouse" && event.buttons === 0) { endDrag(event.timeStamp); return; }
    moveDrag(event.clientY, event.timeStamp);
    if (drag?.moved && !event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
  };
  const headerUp = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    endDrag(event.timeStamp);
  };
  const grabberClick = () => {
    if (suppressClick) { suppressClick = false; return; }
    rest(detentNow === top() ? 0 : top());
  };
  const grabberKey = (event: KeyboardEvent) => {
    const next = event.key === "ArrowUp" ? Math.min(detentNow + 1, top()) : event.key === "ArrowDown" ? Math.max(detentNow - 1, 0) : event.key === "Home" ? top() : event.key === "End" ? 0 : null;
    if (next === null) return;
    event.preventDefault();
    rest(next);
  };
  const sheetKey = (event: KeyboardEvent) => {
    if (!body || (event.target !== event.currentTarget && event.target !== body)) return;
    const down = event.key === "ArrowDown" || event.key === "PageDown" || (event.key === " " && !event.shiftKey);
    const up = event.key === "ArrowUp" || event.key === "PageUp" || (event.key === " " && event.shiftKey);
    if (!down && !up) return;
    event.preventDefault();
    if (down && detentNow !== top()) { rest(top()); return; }
    const step = event.key.startsWith("Arrow") ? 48 : body.clientHeight * 0.85;
    body.scrollBy({ top: down ? step : -step, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };
  const expanded = () => detent() === top();

  return (
    <>
      <K.Overlay ref={(el: HTMLDivElement) => { overlay = el; }} class={styles.overlay} style={{ opacity: 0 }} data-leaving={!props.present || undefined} />
      <K.Content
        ref={(el: HTMLDivElement) => { sheet = el; useSquircle(el); }}
        class={[styles.sheet, props.class ?? ""].join(" ")}
        style={{ transform: "translateY(4000px)", "--sheet-max": String(stops()[top()] ?? 0.92), "--sheet-extension": `${EXTENSION}px` }}
        data-expanded-sheet={expanded() ? "" : undefined}
        data-leaving={!props.present || undefined}
        onKeyDown={sheetKey}
        onOpenAutoFocus={(event: Event) => event.preventDefault()}
        tabIndex={-1}
      >
        <div class={styles.header} onPointerDown={headerDown} onPointerMove={headerMove} onPointerUp={headerUp} onPointerCancel={headerUp}>
          <button type="button" class={styles.grabber} data-grabber="" aria-label={expanded() ? "Collapse sheet" : "Expand sheet"} aria-expanded={expanded()} onClick={grabberClick} onKeyDown={grabberKey}>
            <span class={styles.grabberBar} aria-hidden="true" />
          </button>
          <div class={styles.headRow}>
            <div class={styles.headText}>
              <K.Title class={props.hideTitle ? "sr-only" : styles.title}>{props.title}</K.Title>
              <Show when={props.description}><K.Description class={styles.description}>{props.description}</K.Description></Show>
            </div>
            <K.CloseButton class={styles.close} aria-label={props.closeLabel ?? "Close"}><X size={16} stroke-width={1.75} aria-hidden="true" /></K.CloseButton>
          </div>
        </div>
        <div ref={body} class={styles.body} onWheel={event => { if (detentNow !== top() && event.deltaY > 4 && !drag) rest(top()); }} onFocusIn={event => { if (detentNow !== top() && event.target instanceof Element && event.target.getBoundingClientRect().bottom > window.innerHeight - 8) rest(top()); }}>{props.children}</div>
        <span class="sr-only" role="status" aria-live="polite">{announcement()}</span>
      </K.Content>
    </>
  );
}

/** An Arc Button that closes the sheet; its visible label stays its accessible name. */
export function BottomSheetClose(props: ButtonProps) {
  const context = useDialogContext();
  const [local, rest] = splitProps(props, ["onClick", "variant"]);
  return (
    <Button
      {...rest}
      variant={local.variant ?? "ghost"}
      onClick={event => {
        const handler = local.onClick;
        if (typeof handler === "function") handler(event);
        context.close();
      }}
    />
  );
}
/** Opens the sheet: `<BottomSheetTrigger as={Button} variant="secondary">Menu</BottomSheetTrigger>` passed as `trigger`. */
export const BottomSheetTrigger = K.Trigger;
export default BottomSheet;

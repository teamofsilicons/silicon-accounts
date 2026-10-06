import { Show, createEffect, createSignal, createUniqueId, on, onCleanup, onMount, splitProps, type JSX } from "solid-js";
import { Trash2 } from "lucide-solid";
import { DrawnCheck } from "../lib/DrawnCheck";
import { SwapText } from "../lib/presence";
import { createContentSwap } from "../lib/content-swap";
import { animate, prefersReducedMotion, spring, type AnimationControls } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./hold-to-confirm.module.css";

export interface HoldToConfirmProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick"> {
  /** The instruction and the action, for example "Hold to delete Silicon". */
  label: string;
  /** Shown once the hold completes, for example "Deleted". */
  confirmedLabel?: string;
  /** Called once when the hold completes. */
  onConfirm: () => void;
  /** Hold length in milliseconds. */
  duration?: number;
  icon?: JSX.Element;
  /** `danger` (default here) for an irreversible action; `accent` fills with the brand; `neutral` with the foreground. */
  tone?: "accent" | "danger" | "neutral";
  /** Controls the done state. Set it back to false to reset the button. */
  confirmed?: boolean;
  onHoldChange?: (holding: boolean) => void;
}

function Face(props: { icon: JSX.Element; text: string; done: boolean; measureRef?: (el: HTMLSpanElement) => void; frameRef?: (el: HTMLSpanElement) => void }) {
  let iconSlot: HTMLSpanElement | undefined;
  let iconInner: HTMLSpanElement | undefined;
  createContentSwap(() => iconSlot, () => iconInner);
  return (
    <span class={styles.face}>
      <span ref={iconSlot} class={styles.iconSlot}><span ref={iconInner} class={styles.iconPhase}><Show when={props.done} fallback={props.icon}><DrawnCheck size={18} strokeWidth={2} /></Show></span></span>
      <span ref={props.frameRef} class={styles.labelFrame}>
        <Show when={props.measureRef}><span ref={props.measureRef} class={styles.measure}>{props.text}</span></Show>
        <SwapText text={props.text} class={styles.label} />
      </span>
    </span>
  );
}

/**
 * Arc HoldToConfirm: commits only after it is held, for actions where a stray tap must not count (delete account,
 * delete Silicon). A fill tracks the hold on a linear timeline; letting go early rewinds it on a spring; finishing
 * morphs the label and icon into a done state. Space and Enter can be held too.
 */
export function HoldToConfirm(props: HoldToConfirmProps) {
  const [local, rest] = splitProps(props, ["label", "confirmedLabel", "onConfirm", "duration", "icon", "tone", "confirmed", "onHoldChange", "class", "disabled"]);
  const hintId = `hold-${createUniqueId()}`;
  const [ownDone, setOwnDone] = createSignal(false);
  const done = () => local.confirmed ?? ownDone();
  const [holding, setHolding] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let fill: HTMLSpanElement | undefined;
  let measure: HTMLSpanElement | undefined;
  const frames: HTMLSpanElement[] = [];
  let progress = 0;
  let fillControls: AnimationControls | undefined;
  let pressControls: AnimationControls | undefined;
  let source: "pointer" | "key" | null = null;
  let pointerType = "mouse";
  const duration = () => local.duration ?? 1200;
  const text = () => (done() ? local.confirmedLabel ?? "Done" : local.label);
  const seconds = () => (duration() / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 });
  const paint = (value: number) => {
    progress = value;
    if (fill) fill.style.clipPath = `inset(0 ${((1 - Math.min(1, Math.max(0, value))) * 100).toFixed(3)}% 0 0)`;
  };
  // Both faces share one label width that springs to new text. One observer on the hidden measure drives both
  // frames, so no observer ever resizes an element another observer watches (no ResizeObserver loop).
  let armedUntil = 0;
  createEffect(on(text, () => { armedUntil = performance.now() + 700; }, { defer: true }));
  onMount(() => {
    const node = measure;
    if (!node || typeof ResizeObserver === "undefined") return;
    let width = 0;
    let controls: AnimationControls | undefined;
    const set = (value: number) => { for (const frame of frames) frame.style.width = value ? `${value}px` : ""; };
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? 0;
      controls?.stop();
      if (!width || !next || prefersReducedMotion() || performance.now() > armedUntil) {
        width = next;
        set(next);
        return;
      }
      const from = width;
      width = next;
      controls = animate(from, next, { ...spring.morph, onUpdate: set });
    });
    observer.observe(node);
    onCleanup(() => { observer.disconnect(); controls?.stop(); });
  });
  const pressTo = (pressed: boolean) => {
    pressControls?.stop();
    if (!button || prefersReducedMotion()) return;
    pressControls = animate(button, { scale: pressed ? (button.offsetWidth > 220 ? 0.985 : 0.97) : 1 }, spring.snappy);
  };
  const rewind = () => {
    fillControls?.stop();
    if (prefersReducedMotion()) { paint(0); return; }
    fillControls = animate(progress, 0, { ...spring.smooth, onUpdate: paint });
  };
  const stopHolding = () => { source = null; setHolding(false); local.onHoldChange?.(false); pressTo(false); };
  const complete = () => {
    if (!source) return;
    stopHolding();
    if (pointerType === "touch") navigator.vibrate?.(12);
    setOwnDone(true);
    local.onConfirm();
  };
  const begin = (from: "pointer" | "key") => {
    if (done() || local.disabled || source) return;
    source = from;
    setHolding(true);
    local.onHoldChange?.(true);
    pressTo(true);
    fillControls?.stop();
    fillControls = animate(progress, 1, { duration: ((1 - progress) * duration()) / 1000, ease: "linear", onUpdate: paint, onComplete: complete });
  };
  const release = () => { if (!source) return; stopHolding(); rewind(); };
  createEffect(on(done, isDone => {
    if (source) return;
    if (isDone && progress < 1) { fillControls?.stop(); if (prefersReducedMotion()) paint(1); else fillControls = animate(progress, 1, { ...spring.smooth, onUpdate: paint }); }
    if (!isDone && progress > 0) rewind();
  }, { defer: true }));
  onCleanup(() => { fillControls?.stop(); pressControls?.stop(); });

  return (
    <>
      <button
        {...rest}
        ref={el => { button = el; useSquircle(el); }}
        type="button"
        class={[styles.button, local.class ?? ""].join(" ")}
        data-tone={local.tone ?? "danger"}
        data-state={done() ? "done" : holding() ? "holding" : "idle"}
        disabled={local.disabled}
        aria-disabled={done() || undefined}
        aria-label={text()}
        aria-describedby={done() ? undefined : hintId}
        onPointerDown={event => { if (!event.isPrimary || event.button !== 0) return; pointerType = event.pointerType; event.currentTarget.setPointerCapture(event.pointerId); begin("pointer"); }}
        onPointerMove={event => {
          if (source !== "pointer") return;
          const box = event.currentTarget.getBoundingClientRect();
          const slack = 24;
          if (event.clientX < box.left - slack || event.clientX > box.right + slack || event.clientY < box.top - slack || event.clientY > box.bottom + slack) release();
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onKeyDown={event => { if (event.key !== " " && event.key !== "Enter") return; event.preventDefault(); if (!event.repeat) begin("key"); }}
        onKeyUp={event => { if (event.key !== " " && event.key !== "Enter") return; event.preventDefault(); if (source === "key") release(); }}
        onBlur={release}
        onContextMenu={event => event.preventDefault()}
      >
        <Face icon={local.icon ?? <Trash2 size={18} stroke-width={1.75} />} text={text()} done={done()} measureRef={el => (measure = el)} frameRef={el => frames.push(el)} />
        <span ref={fill} class={styles.fill} aria-hidden="true" style={{ "clip-path": "inset(0 100% 0 0)" }}>
          <Face icon={local.icon ?? <Trash2 size={18} stroke-width={1.75} />} text={text()} done={done()} frameRef={el => frames.push(el)} />
        </span>
      </button>
      <span id={hintId} class="sr-only">{`Press and hold for ${seconds()} seconds to confirm. With a keyboard, hold Space or Enter.`}</span>
      <span class="sr-only" role="status">{done() ? local.confirmedLabel ?? "Done" : ""}</span>
    </>
  );
}

export default HoldToConfirm;

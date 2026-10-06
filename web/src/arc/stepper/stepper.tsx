import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Presence, Swap } from "../lib/presence";
import { animate, instant, motionTokens, prefersReducedMotion, presets, spring, tween } from "../lib/motion";
import { cx } from "../lib/cx";
import styles from "./stepper.module.css";

export type StepperOrientation = "horizontal" | "vertical";
export type StepperStatus = "complete" | "current" | "upcoming" | "error";

export interface StepperStep {
  /** Stable key, so each step keeps its own motion when the list changes. */
  id: string;
  label: string;
  /** A short hint under the label. */
  description?: string;
  /** Marks the step as failed: the marker morphs into an alert and this message replaces the description. */
  error?: string;
}

export interface StepperProps {
  steps: StepperStep[];
  /** Index of the step in progress. `steps.length` marks the whole flow complete. */
  current: number;
  orientation?: StepperOrientation;
  /** Called with the index of a completed step when it is chosen. Without it the stepper is a read-only indicator. */
  onStepSelect?: (index: number) => void;
  /** "current" shows only the active step's description, for tight spaces. Errors always show. */
  details?: "all" | "current";
  /** Markers only; labels stay available to assistive tech. Horizontal steppers switch to this below 30rem. */
  compact?: boolean;
  /** Accessible name for the stepper. */
  label?: string;
  /** Announced, and shown in the compact caption, once every step is complete. */
  completeLabel?: string;
  class?: string;
}

type GlyphKind = "number" | "check" | "error";

/** Text that rises in with a small blur when it changes; its slot springs to the new height. */
function SlotText(props: { text?: string; class: string }) {
  let slot: HTMLSpanElement | undefined;
  let inner: HTMLSpanElement | undefined;
  let armedUntil = 0;
  createEffect(on(() => props.text, () => { armedUntil = performance.now() + 700; }, { defer: true }));
  onMount(() => {
    if (!slot || !inner || typeof ResizeObserver === "undefined") return;
    let measured = false;
    const observer = new ResizeObserver(() => {
      if (!slot || !inner) return;
      const next = inner.offsetHeight;
      if (!measured || prefersReducedMotion() || performance.now() > armedUntil) { measured = true; slot.style.height = `${next}px`; return; }
      animate(slot, { height: `${next}px` }, spring.smooth);
    });
    observer.observe(inner);
    onCleanup(() => observer.disconnect());
  });
  return (
    <span ref={slot} class={styles.slot}>
      <span ref={inner} class={styles.slotInner}>
        <Swap value={props.text ?? ""} enter={el => (el.textContent ? presets.textIn(el) : undefined)} exit={el => (el.textContent ? presets.textOut(el) : undefined)}>
          {text => <Show when={text}><span class={props.class}>{text}</span></Show>}
        </Swap>
      </span>
    </span>
  );
}

/** The number, check and alert share one spot: the outgoing glyph shrinks away while the next pops in and draws its stroke. */
function Glyph(props: { kind: GlyphKind; number: number; delay: () => number }) {
  return (
    <Swap
      value={props.kind}
      class={styles.glyphSlot}
      enter={el => {
        el.style.setProperty("--draw-delay", `${Math.round((props.delay() + 0.04) * 1000)}ms`);
        if (prefersReducedMotion()) return;
        const delay = props.delay();
        return animate(
          el,
          { opacity: [0, 1], scale: [0.5, 1], filter: [`blur(${motionTokens.blur.subtle}px)`, "blur(0px)"] },
          { scale: { ...spring.snappy, delay }, opacity: { ...tween(motionTokens.duration.fast), delay }, filter: { ...tween(motionTokens.duration.fast), delay } },
        );
      }}
      exit={el => animate(el, { opacity: 0, scale: 0.5, filter: `blur(${motionTokens.blur.subtle}px)` }, prefersReducedMotion() ? instant : tween(motionTokens.duration.fast))}
    >
      {kind => kind === "number"
        ? <span class={styles.glyph}>{props.number}</span>
        : (
          <svg class={cx(styles.glyph, styles.icon)} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            {kind === "check"
              ? <path class={styles.draw} d="M5.5 12.5l4.25 4.25L18.5 8" pathLength="1" />
              : <><path class={styles.draw} d="M12 6.75v6.5" pathLength="1" /><circle class={styles.dot} cx="12" cy="17.4" r="1.4" fill="currentColor" stroke="none" /></>}
          </svg>
        )}
    </Swap>
  );
}

const statusText: Record<StepperStatus, string> = { complete: "Completed", current: "", upcoming: "Not started", error: "Error" };

/**
 * Arc Stepper: a steps indicator for setup flows (the import wizard). Drive it with `current`; set it to
 * `steps.length` once every step is done. Pass `onStepSelect` to let people return to completed steps.
 * A jump across several steps fills or drains its connectors one after another.
 */
export function Stepper(props: StepperProps) {
  const count = () => props.steps.length;
  const active = createMemo(() => Math.min(Math.max(Math.round(props.current), 0), count()));
  const [from, setFrom] = createSignal(untrack(active));
  createEffect(on(active, (_next, previous) => { if (previous !== undefined) setFrom(previous); }, { defer: true }));
  const gap = motionTokens.stagger.line;
  const delayAt = (index: number) => {
    if (prefersReducedMotion()) return 0;
    const to = active();
    const start = from();
    if (to > start) return index >= start && index < to ? (index - start) * gap : 0;
    return index >= to && index < start ? (start - 1 - index) * gap : 0;
  };
  const ringDelay = () => (prefersReducedMotion() ? 0 : Math.max(0, Math.abs(active() - from()) - 1) * gap + 0.12);
  const interactive = () => !!props.onStepSelect;
  const vertical = () => props.orientation === "vertical";
  const now = () => (active() >= count() ? undefined : props.steps[active()]);
  const completeLabel = () => props.completeLabel ?? "All steps complete";

  // Arrow keys move between the steps you can reach; Home and End jump to the first and the current one.
  const onKeyDown = (event: KeyboardEvent) => {
    const list = event.currentTarget as HTMLOListElement;
    const rtl = !vertical() && getComputedStyle(list).direction === "rtl";
    const back = ["ArrowUp", rtl ? "ArrowRight" : "ArrowLeft"];
    const ahead = ["ArrowDown", rtl ? "ArrowLeft" : "ArrowRight"];
    if (![...back, ...ahead, "Home", "End"].includes(event.key)) return;
    const targets = Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-reachable]"));
    const at = targets.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? targets.length - 1 : back.includes(event.key) ? Math.max(0, at - 1) : Math.min(targets.length - 1, at + 1);
    targets[next]?.focus();
  };

  return (
    <Dynamic
      component={interactive() ? "nav" : "div"}
      class={cx(styles.root, vertical() ? styles.vertical : styles.horizontal, props.compact && styles.compact, props.class)}
      aria-label={props.label ?? "Progress"}
      role={interactive() ? undefined : "group"}
    >
      <ol class={styles.list} style={vertical() ? undefined : { "grid-template-columns": count() > 1 ? `repeat(${count() - 1}, minmax(0, 1fr)) auto` : "auto" }} onKeyDown={event => interactive() && onKeyDown(event)}>
        <For each={props.steps}>
          {(step, index) => {
            const isCurrent = () => index() === active();
            const status = (): StepperStatus => (step.error ? "error" : index() < active() ? "complete" : isCurrent() ? "current" : "upcoming");
            const clickable = () => interactive() && index() < active();
            const detail = () => step.error ?? (props.details !== "current" || isCurrent() ? step.description : undefined);
            const kind = (): GlyphKind => (step.error ? "error" : index() < active() ? "check" : "number");
            let fill: HTMLSpanElement | undefined;
            createEffect(on(() => index() < active(), (filled, before) => {
              if (!fill) return;
              const target = vertical() ? { scaleY: filled ? 1 : 0 } : { scaleX: filled ? 1 : 0 };
              animate(fill, target, before === undefined || prefersReducedMotion() ? instant : { ...spring.smooth, delay: delayAt(index()) });
            }));
            const content = () => (
              <>
                <span class={styles.marker} aria-hidden="true">
                  <Presence
                    when={isCurrent()}
                    enter={el => animate(el, { opacity: [0, 1], scale: [0.6, 1] }, prefersReducedMotion() ? instant : { scale: { ...spring.snappy, delay: ringDelay() }, opacity: { ...tween(motionTokens.duration.fast), delay: ringDelay() } })}
                    exit={el => animate(el, { opacity: 0, scale: 0.6 }, prefersReducedMotion() ? instant : tween(motionTokens.duration.fast))}
                  >
                    {ref => <span ref={ref} class={styles.ring} />}
                  </Presence>
                  <span class={styles.disc}><Glyph kind={kind()} number={index() + 1} delay={() => delayAt(index())} /></span>
                </span>
                <span class={styles.text}>
                  <span class={styles.label}>{step.label}</span>
                  <Show when={statusText[status()]}><span class={styles.srOnly}>, {statusText[status()]}</span></Show>
                  <SlotText text={detail()} class={step.error ? styles.error! : styles.description!} />
                </span>
              </>
            );
            return (
              <li class={styles.item} data-status={status()}>
                <Show when={index() < count() - 1}>
                  <span class={styles.connector} aria-hidden="true"><span ref={fill} class={styles.fill} /></span>
                </Show>
                <Show
                  when={interactive()}
                  fallback={<span class={styles.head} aria-current={isCurrent() ? "step" : undefined}>{content()}</span>}
                >
                  <button
                    type="button"
                    class={styles.head}
                    data-clickable={clickable() || undefined}
                    data-reachable={index() <= active() || undefined}
                    aria-current={isCurrent() ? "step" : undefined}
                    aria-disabled={clickable() ? undefined : true}
                    tabIndex={clickable() ? undefined : -1}
                    onClick={() => clickable() && props.onStepSelect?.(index())}
                  >
                    {content()}
                  </button>
                </Show>
              </li>
            );
          }}
        </For>
      </ol>
      <Show when={!vertical()}>
        <span class={styles.caption} aria-hidden="true">
          <SlotText text={now()?.label ?? completeLabel()} class={styles.captionLabel!} />
          <SlotText text={now()?.error ?? now()?.description} class={now()?.error ? styles.error! : styles.description!} />
        </span>
      </Show>
      <span class={styles.srOnly} aria-live="polite">{now() ? `Step ${active() + 1} of ${count()}: ${now()!.label}` : completeLabel()}</span>
    </Dynamic>
  );
}

export default Stepper;

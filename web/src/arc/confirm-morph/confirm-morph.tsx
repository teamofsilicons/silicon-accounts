import { Match, Show, Switch, createEffect, createSignal, createUniqueId, on, onCleanup, onMount, type JSX } from "solid-js";
import { CircleAlert, LoaderCircle } from "lucide-solid";
import { Swap } from "../lib/presence";
import { animate, prefersReducedMotion, tween, type AnimationControls } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./confirm-morph.module.css";

/** Where the control is in its life: resting, asking, working, finished, or failed. */
export type ConfirmMorphState = "idle" | "confirming" | "pending" | "done" | "error";

export interface ConfirmMorphProps {
  /** The resting label, such as "Remove access". */
  label: string;
  icon?: JSX.Element;
  /** The question shown while confirming, such as "Remove Briefcase's access?". Defaults to the label with a question mark. */
  prompt?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  pendingLabel?: string;
  doneLabel?: string;
  errorLabel?: string;
  retryLabel?: string;
  undoLabel?: string;
  undoingLabel?: string;
  tone?: "danger" | "neutral";
  /** Return a promise to show the pending face; reject it to show the error face with Retry. */
  onConfirm?: () => void | Promise<unknown>;
  /** Offering it adds Undo to the result. */
  onUndo?: () => void | Promise<unknown>;
  onCancel?: () => void;
  /** Called when the error face is shown, with the rejection (for an inline explanation nearby). */
  onError?: (error: unknown) => void;
  /** Milliseconds before an unanswered question returns to rest. 0 turns it off. */
  confirmTimeout?: number;
  /** Milliseconds a result stays before returning to rest. 0 turns it off. */
  resultTimeout?: number;
  cancelOnOutsidePress?: boolean;
  disabled?: boolean;
  class?: string;
}

const TRAVEL = 12;
const physical = (visualDuration: number, bounce: number) => {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return { type: "spring" as const, stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
const GROW = physical(0.44, 0.18);
const SHRINK = physical(0.34, 0);
const SLIDE = physical(0.36, 0.06);

/**
 * Arc ConfirmMorph: a button for destructive actions that asks in place. Pressing it morphs the same surface into an
 * inline question with Cancel and Confirm, then a spinner, then a result with optional Undo. The width springs to each
 * face. Escape, an outside press, or the timeout return it to rest. Used for remove access, revoke and delete.
 */
export function ConfirmMorph(props: ConfirmMorphProps) {
  const uid = createUniqueId();
  const promptId = `cm-${uid}-prompt`;
  let root: HTMLDivElement | undefined;
  let surface: HTMLDivElement | undefined;
  const [state, setState] = createSignal<ConfirmMorphState>("idle");
  const [direction, setDirection] = createSignal(1);
  const [working, setWorking] = createSignal<"confirm" | "undo">("confirm");
  const [announcement, setAnnouncement] = createSignal("");
  let pendingFocus = false;
  let run = 0;
  const go = (next: ConfirmMorphState) => {
    if (next === state()) return;
    pendingFocus = !!root && (root.contains(document.activeElement) || document.activeElement === document.body);
    setDirection(next === "idle" ? -1 : 1);
    setState(next);
  };
  const toIdle = () => { run++; go("idle"); };
  const perform = async (kind: "confirm" | "undo") => {
    const handler = kind === "confirm" ? props.onConfirm : props.onUndo;
    const token = ++run;
    setWorking(kind);
    let result: void | Promise<unknown> | undefined;
    try { result = handler?.(); } catch (error) { go("error"); setAnnouncement(props.errorLabel ?? "Couldn’t finish"); props.onError?.(error); return; }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      go("pending");
      setAnnouncement(kind === "confirm" ? props.pendingLabel ?? "Working" : props.undoingLabel ?? "Restoring");
      try { await result; } catch (error) {
        if (token !== run) return;
        go("error");
        setAnnouncement(props.errorLabel ?? "Couldn’t finish");
        props.onError?.(error);
        return;
      }
      if (token !== run) return;
    }
    if (kind === "undo") { go("idle"); setAnnouncement("Undone"); return; }
    go("done");
    setAnnouncement(props.onUndo ? `${props.doneLabel ?? "Done"}. ${props.undoLabel ?? "Undo"} is available.` : props.doneLabel ?? "Done");
  };
  const cancel = () => { props.onCancel?.(); toIdle(); setAnnouncement("Cancelled"); };

  /* The surface springs to whichever face is current. At rest it is auto. */
  let target = 0;
  let sizing: AnimationControls | undefined;
  const measureFace = () => {
    const face = surface?.querySelector<HTMLElement>(`[data-face="${state()}"]:not([aria-hidden])`);
    if (!face || !surface) return;
    const flex = face.style.flex;
    face.style.flex = "none";
    const width = face.offsetWidth;
    face.style.flex = flex;
    if (Math.abs(width - target) < 0.5) return;
    const from = target || surface.offsetWidth;
    target = width;
    if (!from || prefersReducedMotion()) { surface.style.width = ""; return; }
    sizing?.stop();
    sizing = animate(surface, { width: [`${from}px`, `${width}px`] }, width > from ? GROW : SHRINK);
    sizing.then(() => { if (surface && Math.abs(target - width) < 0.5) surface.style.width = ""; });
  };
  createEffect(on(state, () => queueMicrotask(measureFace), { defer: true }));
  onMount(() => { target = surface?.offsetWidth ?? 0; });

  /* The timeout runs as an invisible clock. A pointer resting on the control holds it, and so does a hidden tab. */
  let clock: AnimationControls | undefined;
  const holds = { hover: false, hidden: false };
  const sync = () => { if (!clock) return; if (holds.hover || holds.hidden) clock.pause(); else clock.play(); };
  createEffect(on(state, current => {
    clock?.stop();
    clock = undefined;
    const timeout = current === "confirming" ? props.confirmTimeout ?? 6000 : current === "done" || current === "error" ? props.resultTimeout ?? 5000 : 0;
    if (!timeout) return;
    const controls = animate(1, 0, { duration: timeout / 1000, ease: "linear" });
    clock = controls;
    controls.then(() => { if (clock === controls) { clock = undefined; if (state() === "confirming") cancel(); else toIdle(); } });
    sync();
  }));
  onMount(() => {
    const onVisibility = () => { holds.hidden = document.hidden; sync(); };
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => { document.removeEventListener("visibilitychange", onVisibility); clock?.stop(); });
  });
  createEffect(() => {
    if (state() !== "confirming" || props.cancelOnOutsidePress === false) return;
    const down = (event: PointerEvent) => { if (!root?.contains(event.target as Node)) cancel(); };
    document.addEventListener("pointerdown", down);
    onCleanup(() => document.removeEventListener("pointerdown", down));
  });
  // Focus lands on the safe choice: Cancel while asking, Undo or Retry on a result, the root while working.
  createEffect(on(state, current => queueMicrotask(() => {
    if (!pendingFocus || !root) return;
    pendingFocus = false;
    const face = root.querySelector<HTMLElement>(`[data-face="${current}"]:not([aria-hidden])`);
    const autofocus = face?.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)");
    (autofocus ?? root).focus({ preventScroll: true });
  }), { defer: true }));

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (state() === "confirming") { event.preventDefault(); event.stopPropagation(); cancel(); }
    else if (state() === "done" || state() === "error") { event.preventDefault(); event.stopPropagation(); toIdle(); }
  };
  const prompt = () => props.prompt ?? `${props.label}?`;

  const face = (current: ConfirmMorphState) => (
    <Switch>
      <Match when={current === "confirming"}>
        <span id={promptId} class={styles.prompt}>{prompt()}</span>
        <button type="button" class={styles.secondary} data-autofocus onClick={cancel}>{props.cancelLabel ?? "Cancel"}</button>
        <button type="button" class={styles.primary} data-tone={props.tone ?? "danger"} onClick={() => void perform("confirm")}>{props.confirmLabel ?? "Confirm"}</button>
      </Match>
      <Match when={current === "pending"}>
        <span class={styles.status}><LoaderCircle class={styles.spinner} size={16} stroke-width={1.75} aria-hidden="true" /><span>{working() === "undo" ? props.undoingLabel ?? "Restoring" : props.pendingLabel ?? "Working"}</span></span>
      </Match>
      <Match when={current === "done"}>
        <span class={styles.status} data-tone="success">
          <svg class={styles.check} viewBox="0 0 18 18" fill="none" aria-hidden="true"><circle class={styles.checkDisc} cx="9" cy="9" r="8" /><path class={styles.checkTick} d="M5.6 9.3 7.8 11.4 12.4 6.7" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" pathLength="1" /></svg>
          <span class={styles.statusText}>{props.doneLabel ?? "Done"}</span>
        </span>
        <Show when={props.onUndo}><button type="button" class={styles.secondary} data-autofocus onClick={() => void perform("undo")}>{props.undoLabel ?? "Undo"}</button></Show>
      </Match>
      <Match when={current === "error"}>
        <span class={styles.status} data-tone="danger"><CircleAlert size={16} stroke-width={1.75} aria-hidden="true" /><span class={styles.statusText}>{props.errorLabel ?? "Couldn’t finish"}</span></span>
        <button type="button" class={styles.secondary} data-autofocus onClick={() => void perform(working())}>{props.retryLabel ?? "Retry"}</button>
      </Match>
      <Match when={current === "idle"}>
        <button type="button" class={styles.trigger} data-autofocus disabled={props.disabled} onClick={() => { setAnnouncement(prompt()); go("confirming"); }}>
          <Show when={props.icon}><span class={styles.icon} aria-hidden="true">{props.icon}</span></Show>
          <span>{props.label}</span>
        </button>
      </Match>
    </Switch>
  );

  return (
    <div
      ref={root}
      class={[styles.root, props.class ?? ""].join(" ")}
      data-state={state()}
      data-tone={props.tone ?? "danger"}
      data-disabled={props.disabled || undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-busy={state() === "pending" || undefined}
      onPointerEnter={() => { holds.hover = true; sync(); }}
      onPointerLeave={() => { holds.hover = false; sync(); }}
    >
      <div ref={el => { surface = el; useSquircle(el); }} class={styles.surface}>
        <Swap
          value={state()}
          as="div"
          class={styles.face}
          enter={el => {
            if (prefersReducedMotion()) return animate(el, { opacity: [0, 1] }, tween(0.14));
            return animate(el, { opacity: [0, 1], x: [direction() * TRAVEL, 0], filter: ["blur(4px)", "blur(0px)"] }, { x: SLIDE, opacity: { duration: 0.2, delay: 0.04 }, filter: { duration: 0.22, delay: 0.04 } });
          }}
          exit={el => {
            el.setAttribute("inert", "");
            if (prefersReducedMotion()) return animate(el, { opacity: 0 }, tween(0.1));
            return animate(el, { opacity: 0, x: direction() * -TRAVEL * 0.6, filter: "blur(4px)" }, { x: SLIDE, opacity: tween(0.12), filter: tween(0.12) });
          }}
        >
          {current => <FaceFrame state={current} labelledBy={current === "confirming" ? promptId : undefined}>{face(current)}</FaceFrame>}
        </Swap>
      </div>
      <span class="sr-only" role="status" aria-live="polite">{announcement()}</span>
    </div>
  );
}

function FaceFrame(props: { state: ConfirmMorphState; labelledBy?: string; children: JSX.Element }) {
  return <div class={styles.faceInner} data-face={props.state} role={props.labelledBy ? "group" : undefined} aria-labelledby={props.labelledBy}>{props.children}</div>;
}

export default ConfirmMorph;

import { Match, Switch, createSignal, onCleanup, splitProps, type JSX } from "solid-js";
import { ArrowRight } from "lucide-solid";
import { cx } from "../lib/cx";
import { pressable } from "../lib/motion";
import { MorphText, createMorphWidth } from "../lib/presence";
import { DrawnCheck } from "../lib/DrawnCheck";
import { createContentSwap } from "../lib/content-swap";
import { useSquircle } from "../lib/squircle";
import styles from "./action-button.module.css";

export interface ActionButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  label: string;
  successLabel?: string;
  pendingLabel?: string;
  /** Return a promise: the button shows pending, then success, or returns to idle when it rejects. */
  onAction: () => void | Promise<void>;
  resetAfterMs?: number;
  onActionError?: (error: unknown) => void;
}

/**
 * Arc ActionButton: the label morphs letter by letter (Save, Saving, Saved) while the width follows on a spring and the
 * arrow hands over to a spinner, then a hand-drawn check. Pending stays focusable, so keyboard focus survives a save.
 */
export function ActionButton(props: ActionButtonProps) {
  const [local, rest] = splitProps(props, ["label", "successLabel", "pendingLabel", "onAction", "resetAfterMs", "onActionError", "class", "disabled", "type"]);
  const [state, setState] = createSignal<"idle" | "pending" | "success">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => timer && clearTimeout(timer));
  let slot: HTMLSpanElement | undefined;
  let row: HTMLSpanElement | undefined;
  let iconSlot: HTMLSpanElement | undefined;
  let icon: HTMLSpanElement | undefined;
  const text = () => (state() === "pending" ? local.pendingLabel ?? "Saving" : state() === "success" ? local.successLabel ?? "Saved" : local.label);
  createMorphWidth(() => slot, () => row, text);
  createContentSwap(() => iconSlot, () => icon);

  async function run() {
    if (state() === "pending") return;
    if (timer) clearTimeout(timer);
    setState("pending");
    try {
      await local.onAction();
      setState("success");
      const reset = local.resetAfterMs ?? 2400;
      if (reset > 0) timer = setTimeout(() => setState("idle"), reset);
    } catch (error) {
      setState("idle");
      local.onActionError?.(error);
    }
  }

  return (
    <button
      {...rest}
      ref={el => { useSquircle(el); pressable(el, { disabled: () => !!local.disabled || state() === "pending" }); }}
      type={local.type ?? "button"}
      class={cx(styles.button, local.class)}
      disabled={local.disabled}
      aria-disabled={state() === "pending" ? true : rest["aria-disabled"]}
      aria-busy={state() === "pending"}
      data-state={state()}
      data-variant="primary"
      onClick={() => void run()}
    >
      <span class={styles.content} aria-hidden="true">
        <span ref={slot} class={styles.morph}>
          <span ref={row} class={styles.glyphs}><MorphText text={text()} /></span>
        </span>
        <span ref={iconSlot} class={styles.iconSlot}>
          <span ref={icon} class={styles.phase}>
            <Switch>
              <Match when={state() === "pending"}><span class={styles.spinner} data-icon="spinner" /></Match>
              <Match when={state() === "success"}><DrawnCheck size={17} strokeWidth={2} /></Match>
              <Match when={state() === "idle"}><ArrowRight class={styles.arrow} size={17} stroke-width={1.75} /></Match>
            </Switch>
          </span>
        </span>
      </span>
      <span class="sr-only">{local.label}</span>
      <span class="sr-only" role="status">{state() === "pending" ? local.pendingLabel ?? "Saving" : state() === "success" ? local.successLabel ?? "Saved" : ""}</span>
    </button>
  );
}

export default ActionButton;

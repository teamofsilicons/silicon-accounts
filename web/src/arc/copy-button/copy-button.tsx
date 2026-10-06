import { Match, Switch, splitProps } from "solid-js";
import { CircleAlert, Copy } from "lucide-solid";
import { cx } from "../lib/cx";
import { createCopyFeedback } from "../lib/copy";
import { createContentSwap } from "../lib/content-swap";
import { MorphText } from "../lib/presence";
import { DrawnCheck } from "../lib/DrawnCheck";
import { animate, prefersReducedMotion, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./copy-button.module.css";

export interface CopyButtonProps {
  value: string;
  /** Visible label and accessible name, for example "Copy uuid". Defaults to "Copy". */
  label?: string;
  class?: string;
  iconOnly?: boolean;
  variant?: "outline" | "plain";
  size?: "sm" | "xs";
  disabled?: boolean;
  onCopied?: () => void;
}

/** Copy feedback is deliberately unhurried: a slow, almost critically damped spring and long, soft crossfades (Arc). */
const settle = { type: "spring", visualDuration: 0.5, bounce: 0.06 } as const;

/**
 * Arc CopyButton. The width never changes: the label cell reserves its widest state while the icon and letters crossfade
 * inside it. The result is announced politely.
 */
export function CopyButton(props: CopyButtonProps) {
  const [local] = splitProps(props, ["value", "label", "class", "iconOnly", "variant", "size", "disabled", "onCopied"]);
  const { state, copy } = createCopyFeedback();
  const label = () => local.label ?? "Copy";
  const text = () => (state() === "copied" ? "Copied" : state() === "error" ? "Failed" : label());
  let iconSlot: HTMLSpanElement | undefined;
  let icon: HTMLSpanElement | undefined;
  createContentSwap(() => iconSlot, () => icon, {
    enter: el => {
      if (prefersReducedMotion()) return animate(el, { opacity: [0, 1] }, tween(0.12));
      return animate(el, { opacity: [0, 1], scale: [0.6, 1], filter: ["blur(4px)", "blur(0px)"] }, { scale: settle, opacity: { duration: 0.36, delay: 0.03 }, filter: { duration: 0.36, delay: 0.03 } });
    },
    exit: el => {
      if (prefersReducedMotion()) return animate(el, { opacity: 0 }, tween(0));
      return animate(el, { opacity: 0, scale: 0.6, filter: "blur(4px)" }, tween(0.24));
    },
  });

  return (
    <>
      <button
        type="button"
        ref={el => useSquircle(el)}
        class={cx(styles.button, local.iconOnly && styles.iconOnly, local.variant === "plain" && styles.plain, local.size === "xs" && styles.xs, local.class)}
        onClick={async () => { if (await copy(local.value)) local.onCopied?.(); }}
        aria-label={label()}
        data-copy-state={state()}
        disabled={local.disabled}
      >
        <span ref={iconSlot} class={styles.icon} aria-hidden="true">
          <span ref={icon} class={styles.iconInner} data-state={state()}>
            <Switch>
              <Match when={state() === "copied"}><DrawnCheck slow /></Match>
              <Match when={state() === "error"}><CircleAlert size={16} stroke-width={1.75} /></Match>
              <Match when={state() === "idle"}><Copy size={16} stroke-width={1.75} /></Match>
            </Switch>
          </span>
        </span>
        {!local.iconOnly && (
          <span class={styles.label} aria-hidden="true">
            <span class={styles.measure}>{label()}</span>
            <span class={styles.measure}>Copied</span>
            <span class={styles.measure}>Failed</span>
            <span class={styles.glyphs}><MorphText text={text()} /></span>
          </span>
        )}
      </button>
      <span class="sr-only" role="status" aria-live="polite">
        {state() === "idle" ? "" : state() === "error" ? `${label()}: could not copy` : `${label()}: copied`}
      </span>
    </>
  );
}

export default CopyButton;

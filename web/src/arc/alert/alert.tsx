import { Show, createSignal, splitProps, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Check, CircleX, Info, TriangleAlert, X } from "lucide-solid";
import { cx } from "../lib/cx";
import { HeightFrame } from "../lib/HeightFrame";
import { Reveal, SwapText } from "../lib/presence";
import { createContentSwap } from "../lib/content-swap";
import { useSquircle } from "../lib/squircle";
import styles from "./alert.module.css";

export type AlertTone = "info" | "success" | "warning" | "danger";

export interface AlertProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: AlertTone;
  title: string;
  children?: JSX.Element;
  /** Controls presence. Hiding the alert collapses its height and fades it out. */
  open?: boolean;
  /** Shows a dismiss button. An uncontrolled alert collapses first, then calls this. */
  onDismiss?: () => void;
  /** Optional action row (for example a Retry button). */
  action?: JSX.Element;
}

const icons = { info: Info, success: Check, warning: TriangleAlert, danger: CircleX };

function AlertBox(props: AlertProps & { onDismissPress?: () => void }) {
  const [local, rest] = splitProps(props, ["tone", "title", "children", "open", "onDismiss", "onDismissPress", "action", "class"]);
  let iconSlot: HTMLSpanElement | undefined;
  let icon: HTMLSpanElement | undefined;
  createContentSwap(() => iconSlot, () => icon);
  const tone = () => local.tone ?? "info";
  const hasDetails = () => local.children !== undefined && local.children !== null && local.children !== false && local.children !== "";
  return (
    <div {...rest} ref={el => useSquircle(el)} class={cx(styles.alert, styles[tone()], local.class)} role={tone() === "danger" ? "alert" : "status"}>
      <span ref={iconSlot} class={styles.icon}>
        <span ref={icon} class={styles.glyph}><Dynamic component={icons[tone()]} width={18} height={18} stroke-width={1.75} aria-hidden="true" /></span>
      </span>
      <HeightFrame class={styles.copy} morphKey={`${local.title}\n${hasDetails()}`}>
        <strong class={styles.title}><SwapText text={local.title} class={styles.line} /></strong>
        <Show when={hasDetails()}>
          <div class={styles.description}>{local.children}</div>
        </Show>
        <Show when={local.action}><div class={styles.actions}>{local.action}</div></Show>
      </HeightFrame>
      <Show when={local.onDismissPress}>
        <button type="button" class={styles.dismiss} aria-label={`Dismiss: ${local.title}`} onClick={() => local.onDismissPress?.()}>
          <X width={16} height={16} stroke-width={1.75} aria-hidden="true" />
        </button>
      </Show>
    </div>
  );
}

/**
 * Arc Alert: a message that stays until resolved, next to its cause. Danger alerts are announced assertively. Changing
 * the tone morphs the icon; changing the copy springs the height. With `open` or `onDismiss` it collapses on close.
 */
export function Alert(props: AlertProps) {
  const [dismissed, setDismissed] = createSignal(false);
  const controlled = () => props.open !== undefined || !!props.onDismiss;
  const isOpen = () => props.open ?? !dismissed();
  const close = () => {
    if (props.open === undefined) {
      setDismissed(true);
      setTimeout(() => props.onDismiss?.(), 420);
    } else props.onDismiss?.();
  };
  return (
    <Show when={controlled()} fallback={<AlertBox {...props} />}>
      <Reveal when={isOpen()} class={styles.presence}>
        <AlertBox {...props} onDismissPress={props.onDismiss ? close : undefined} />
      </Reveal>
    </Show>
  );
}

export default Alert;

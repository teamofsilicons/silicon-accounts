import { Show, createSignal, splitProps, type JSX } from "solid-js";
import { cx } from "../lib/cx";
import { pressable } from "../lib/motion";
import { createContentSwap } from "../lib/content-swap";
import { createMorphWidth } from "../lib/presence";
import { useSquircle } from "../lib/squircle";
import styles from "./button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, keeps focus (aria-disabled instead of disabled) and swallows presses. */
  loading?: boolean;
  ref?: (el: HTMLButtonElement) => void;
}

/**
 * Arc Button. Defaults to primary, so set `variant` on every other button of a surface. A new label crossfades in place
 * (text rises out of a soft blur, icons pop) while the width springs to the new label, so the button never snaps.
 * Presses scale to about .97 on a snappy spring; a button that anchors a menu or popover answers with colour only.
 */
export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "size", "loading", "disabled", "class", "children", "onClick", "ref", "type"]);
  let slot: HTMLSpanElement | undefined;
  let content: HTMLSpanElement | undefined;
  const [labelKey, setLabelKey] = createSignal(0);
  createMorphWidth(() => slot, () => content, () => String(labelKey()));
  createContentSwap(() => slot, () => content, { onSwap: () => setLabelKey(key => key + 1) });

  const onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = event => {
    if (local.loading) {
      event.preventDefault();
      return;
    }
    const handler = local.onClick;
    if (typeof handler === "function") handler(event);
    else if (Array.isArray(handler)) (handler[0] as (data: unknown, e: MouseEvent) => void)(handler[1], event);
  };

  return (
    <button
      {...rest}
      ref={el => {
        useSquircle(el);
        pressable(el, { disabled: () => !!local.disabled || !!local.loading });
        local.ref?.(el);
      }}
      type={local.type ?? "button"}
      class={cx(styles.button, styles[local.variant ?? "primary"], styles[local.size ?? "md"], local.class)}
      data-variant={local.variant ?? "primary"}
      disabled={local.disabled}
      aria-busy={local.loading || undefined}
      aria-disabled={local.loading || rest["aria-disabled"] || undefined}
      onClick={onClick}
    >
      <Show when={local.loading}>
        <span class={styles.loader} aria-hidden="true"><span class={styles.spinner} /></span>
      </Show>
      <span ref={slot} class={cx(styles.labelSlot, local.loading && styles.loadingLabel)}>
        <span ref={content} class={styles.labelContent}>{local.children}</span>
      </span>
    </button>
  );
}

export interface LinkButtonProps extends JSX.AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** A link that looks like a Button (links go places, buttons do things). */
export function LinkButton(props: LinkButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "size", "class", "children"]);
  return (
    <a
      {...rest}
      ref={el => { useSquircle(el); pressable(el); }}
      class={cx(styles.button, styles.link, styles[local.variant ?? "primary"], styles[local.size ?? "md"], local.class)}
      data-variant={local.variant ?? "primary"}
    >
      <span class={styles.labelSlot}><span class={styles.labelContent}>{local.children}</span></span>
    </a>
  );
}

export default Button;

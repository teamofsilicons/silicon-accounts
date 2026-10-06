import { Show, createUniqueId, splitProps, type JSX } from "solid-js";
import { cx } from "../lib/cx";
import { FieldMessage } from "../lib/FieldMessage";
import { useSquircle } from "../lib/squircle";
import styles from "./input.module.css";

export interface InputProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label: string;
  /** Hide the visible label (it stays the accessible name). Use only where context makes it obvious. */
  hideLabel?: boolean;
  description?: string;
  error?: string | null;
  /** Content inside the field before the text (a "c:" prefix, an icon). */
  prefix?: JSX.Element;
  /** Content inside the field after the text (a status icon, a unit). */
  suffix?: JSX.Element;
  /** Use the mono face (ids, tokens, codes). */
  mono?: boolean;
  ref?: (el: HTMLInputElement) => void;
}

/**
 * Arc Input: a labelled text field. Focus answers with the border colour alone (no rings); the field never changes size.
 * Helper and error copy open beneath it on a spring and are wired to the input with aria-describedby.
 */
export function Input(props: InputProps) {
  const [local, rest] = splitProps(props, ["label", "hideLabel", "description", "error", "prefix", "suffix", "mono", "id", "class", "ref"]);
  const generated = createUniqueId();
  const controlId = () => local.id ?? `in-${generated}`;
  const hintId = () => (local.description ? `${controlId()}-description` : undefined);
  const errorId = () => (local.error ? `${controlId()}-error` : undefined);
  const describedBy = () => [rest["aria-describedby"], hintId(), errorId()].filter(Boolean).join(" ") || undefined;
  return (
    <div class={styles.field}>
      <label class={local.hideLabel ? "sr-only" : styles.label} for={controlId()}>{local.label}</label>
      <div ref={el => useSquircle(el)} class={cx(styles.shell, local.mono && styles.mono)} data-invalid={local.error ? "" : undefined} data-disabled={rest.disabled ? "" : undefined}>
        <Show when={local.prefix}><span class={styles.prefix}>{local.prefix}</span></Show>
        <input
          {...rest}
          ref={el => local.ref?.(el)}
          id={controlId()}
          class={cx(styles.input, local.class)}
          aria-invalid={local.error ? true : rest["aria-invalid"]}
          aria-describedby={describedBy()}
        />
        <Show when={local.suffix}><span class={styles.suffix}>{local.suffix}</span></Show>
      </div>
      <FieldMessage id={hintId()} text={local.description} />
      <FieldMessage id={errorId()} text={local.error} tone="error" alert />
    </div>
  );
}

export default Input;

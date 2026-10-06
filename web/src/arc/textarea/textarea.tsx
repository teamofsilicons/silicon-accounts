import { createUniqueId, splitProps, type JSX } from "solid-js";
import { cx } from "../lib/cx";
import { FieldMessage } from "../lib/FieldMessage";
import { useSquircle } from "../lib/squircle";
import styles from "./textarea.module.css";

export interface TextareaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hideLabel?: boolean;
  description?: string;
  error?: string | null;
  mono?: boolean;
  ref?: (el: HTMLTextAreaElement) => void;
}

/** Arc Textarea: the same focus language as Input, resizable vertically. */
export function Textarea(props: TextareaProps) {
  const [local, rest] = splitProps(props, ["label", "hideLabel", "description", "error", "mono", "id", "class", "ref"]);
  const generated = createUniqueId();
  const controlId = () => local.id ?? `ta-${generated}`;
  const hintId = () => (local.description ? `${controlId()}-description` : undefined);
  const errorId = () => (local.error ? `${controlId()}-error` : undefined);
  return (
    <div class={styles.field}>
      <label class={local.hideLabel ? "sr-only" : styles.label} for={controlId()}>{local.label}</label>
      <textarea
        {...rest}
        ref={el => { useSquircle(el); local.ref?.(el); }}
        id={controlId()}
        class={cx(styles.control, local.mono && styles.mono, local.class)}
        aria-invalid={local.error ? true : rest["aria-invalid"]}
        aria-describedby={[rest["aria-describedby"], hintId(), errorId()].filter(Boolean).join(" ") || undefined}
      />
      <FieldMessage id={hintId()} text={local.description} />
      <FieldMessage id={errorId()} text={local.error} tone="error" alert />
    </div>
  );
}

export default Textarea;

/** A value to copy somewhere else (a callback URL, an app id, a URL to paste into a provider console). */
import { Show, type JSX } from "solid-js";
import { CopyButton } from "../../../arc/copy-button/copy-button";
import { cx } from "../../../arc/lib/cx";
import { useSquircle } from "../../../arc/lib/squircle";
import styles from "./parts.module.css";

export function CopyField(props: { label: string; value: string; description?: JSX.Element; copyLabel?: string; class?: string }) {
  return (
    <div class={cx(styles.copyField, props.class)}>
      <span class={styles.copyLabel}>{props.label}</span>
      <div ref={el => useSquircle(el)} class={styles.copyShell}>
        <code class={styles.copyValue}>{props.value}</code>
        <CopyButton value={props.value} label={props.copyLabel ?? "Copy"} size="xs" />
      </div>
      <Show when={props.description}><span class={styles.copyDescription}>{props.description}</span></Show>
    </div>
  );
}

/**
 * A secret shown exactly once (a webhook signing secret, a proof token): masked until revealed, copyable, and gone once
 * the reader confirms they stored it. Silicon Accounts keeps only a hash or an encrypted copy and never shows it again.
 */
import { For, Show, createSignal, onMount, type JSX } from "solid-js";
import { Eye, EyeOff, KeyRound } from "lucide-solid";
import { Button } from "../../../arc/button/button";
import { CopyButton } from "../../../arc/copy-button/copy-button";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../../../arc/lib/motion";
import { useSquircle } from "../../../arc/lib/squircle";
import styles from "./parts.module.css";

export interface SecretItem {
  label: string;
  value: string;
  /** One line under the value (expiry, where it goes). */
  note?: JSX.Element;
}

export function SecretReveal(props: { title: string; description: JSX.Element; secrets: SecretItem[]; onDone: () => void; doneLabel?: string; children?: JSX.Element }) {
  const [shown, setShown] = createSignal<Record<number, boolean>>({});
  let card: HTMLDivElement | undefined;
  onMount(() => {
    if (!card || prefersReducedMotion()) return;
    animate(card, { opacity: [0, 1], y: [10, 0], scale: [0.985, 1] }, { y: spring.smooth, scale: spring.smooth, opacity: tween(motionTokens.duration.standard, motionTokens.ease.enter) });
  });
  const mask = (value: string) => {
    const prefix = /^[a-z_]+?_/.exec(value)?.[0] ?? "";
    return `${prefix}${"•".repeat(Math.min(28, Math.max(12, value.length - prefix.length)))}`;
  };
  return (
    <div ref={el => { card = el; useSquircle(el); }} class={styles.secretCard} role="group" aria-label={props.title}>
      <div class={styles.secretHead}>
        <span class={styles.secretIcon} aria-hidden="true"><KeyRound size={18} stroke-width={1.75} /></span>
        <div class={styles.secretText}>
          <strong>{props.title}</strong>
          <p>{props.description}</p>
        </div>
      </div>
      <For each={props.secrets}>
        {(secret, index) => (
          <div class={styles.secretRow}>
            <span class={styles.secretLabel}>{secret.label}</span>
            <div ref={el => useSquircle(el)} class={styles.secretShell}>
              <code class={styles.secretValue} data-shown={shown()[index()] || undefined}>{shown()[index()] ? secret.value : mask(secret.value)}</code>
              <button
                type="button"
                ref={el => useSquircle(el)}
                class={styles.secretToggle}
                aria-pressed={!!shown()[index()]}
                aria-label={shown()[index()] ? `Hide ${secret.label}` : `Show ${secret.label}`}
                onClick={() => setShown(current => ({ ...current, [index()]: !current[index()] }))}
              >
                <Show when={shown()[index()]} fallback={<Eye size={16} stroke-width={1.75} aria-hidden="true" />}><EyeOff size={16} stroke-width={1.75} aria-hidden="true" /></Show>
              </button>
              <CopyButton value={secret.value} label="Copy" size="xs" />
            </div>
            <Show when={secret.note}><span class={styles.secretNote}>{secret.note}</span></Show>
          </div>
        )}
      </For>
      {props.children}
      <div class={styles.secretFooter}>
        <span class={styles.secretWarning}>This is the only time {props.secrets.length === 1 ? "it is" : "they are"} shown.</span>
        <Button variant="secondary" size="sm" onClick={() => props.onDone()}>{props.doneLabel ?? "I've stored it"}</Button>
      </div>
    </div>
  );
}

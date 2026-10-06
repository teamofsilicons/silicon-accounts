/**
 * A secret shown exactly once (a Silicon's STK, a webhook signing secret). The characters decode into place, the value
 * can be copied or hidden while someone looks over your shoulder, and the card stays until "I've stored it".
 * Silicon Accounts keeps only a hash (STK) or an encrypted copy the page can never read again, so closing this card
 * is final.
 */
import { For, Show, createSignal, createUniqueId, onCleanup, onMount, type JSX } from "solid-js";
import { Eye, EyeOff, KeyRound } from "lucide-solid";
import { Button } from "../../../arc/button/button";
import { CopyButton } from "../../../arc/copy-button/copy-button";
import { SlotText } from "../../../arc/slot-text/slot-text";
import { animate, motionTokens, prefersReducedMotion } from "../../../arc/lib/motion";
import { useSquircle } from "../../../arc/lib/squircle";
import styles from "./parts.module.css";

export interface RevealedSecret {
  /** "STK", "Webhook signing secret". */
  label: string;
  value: string;
  /** One line under the value: what it is for. */
  note?: string;
  /** A command that uses it, shown in mono with its own copy button. */
  command?: string;
}

export interface SecretRevealProps {
  title: string;
  description: JSX.Element;
  secrets: RevealedSecret[];
  onDone: () => void;
  doneLabel?: string;
  /** Moves focus to the card when it appears, so it is announced and the keyboard lands on it. */
  focusOnMount?: boolean;
  class?: string;
}

const mask = (value: string) => value.replace(/[^-_]/g, "•");

function SecretValue(props: { secret: RevealedSecret }) {
  const [shown, setShown] = createSignal(prefersReducedMotion() ? props.secret.value : mask(props.secret.value));
  const [hidden, setHidden] = createSignal(false);
  // The reels decode the value once; then plain text takes over, so a long secret can wrap on a narrow screen.
  const [settled, setSettled] = createSignal(prefersReducedMotion());
  onMount(() => {
    if (prefersReducedMotion()) return;
    // Decode on the next frame so the reels have something to spin from.
    const frame = requestAnimationFrame(() => setShown(props.secret.value));
    const timer = window.setTimeout(() => setSettled(true), 1500);
    onCleanup(() => { cancelAnimationFrame(frame); window.clearTimeout(timer); });
  });
  const toggle = () => {
    const next = !hidden();
    setHidden(next);
    setShown(next ? mask(props.secret.value) : props.secret.value);
  };
  return (
    <div class={styles.secret}>
      <span class={styles.secretLabel}>{props.secret.label}</span>
      <div ref={el => useSquircle(el)} class={styles.secretWell}>
        <span class={styles.secretText}>
          <span class="sr-only">{hidden() ? `${props.secret.label} hidden` : props.secret.value}</span>
          <span aria-hidden="true">
            <Show when={settled()} fallback={<SlotText value={shown()} duration={0.55} stagger={0.016} spins={1} align="start" />}>
              <span class={styles.secretPlain}>{shown()}</span>
            </Show>
          </span>
        </span>
        <span class={styles.secretActions}>
          <button ref={el => useSquircle(el)} type="button" class={styles.iconButton} onClick={toggle} aria-label={hidden() ? `Show ${props.secret.label}` : `Hide ${props.secret.label}`} aria-pressed={hidden()}>
            <Show when={hidden()} fallback={<EyeOff size={16} stroke-width={1.75} aria-hidden="true" />}><Eye size={16} stroke-width={1.75} aria-hidden="true" /></Show>
          </button>
          <CopyButton value={props.secret.value} label={`Copy ${props.secret.label}`} iconOnly variant="plain" size="sm" />
        </span>
      </div>
      <Show when={props.secret.note}><span class={styles.secretNote}>{props.secret.note}</span></Show>
      <Show when={props.secret.command}>
        {command => (
          <span class={styles.command}>
            <code class={styles.commandText}>{command()}</code>
            <CopyButton value={command()} label="Copy the command" iconOnly variant="plain" size="xs" />
          </span>
        )}
      </Show>
    </div>
  );
}

export function SecretReveal(props: SecretRevealProps) {
  const titleId = `secret-${createUniqueId()}`;
  let card: HTMLElement | undefined;
  let heading: HTMLHeadingElement | undefined;
  onMount(() => {
    if (props.focusOnMount) heading?.focus({ preventScroll: false });
    if (card && !prefersReducedMotion()) {
      animate(card, { opacity: [0, 1], y: [10, 0], scale: [0.985, 1] }, { ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard } });
    }
  });
  return (
    <section ref={el => { card = el; useSquircle(el); }} class={[styles.reveal, props.class ?? ""].join(" ")} aria-labelledby={titleId} role="region">
      <div class={styles.revealHead}>
        <span class={styles.revealIcon} aria-hidden="true"><KeyRound size={20} stroke-width={1.75} /></span>
        <div class={styles.revealText}>
          <h2 ref={heading} id={titleId} class={styles.revealTitle} tabIndex={-1}>{props.title}</h2>
          <p class={styles.revealDescription}>{props.description}</p>
        </div>
      </div>
      <div class={styles.secrets}>
        <For each={props.secrets}>{secret => <SecretValue secret={secret} />}</For>
      </div>
      <div class={styles.revealFoot}>
        <span class={styles.revealWarning}>Shown only this once. Silicon Accounts cannot show it again.</span>
        <Button onClick={() => props.onDone()}>{props.doneLabel ?? "I've stored it"}</Button>
      </div>
    </section>
  );
}

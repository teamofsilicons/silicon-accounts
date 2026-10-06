import { For, createEffect, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js";
import { FieldMessage } from "../lib/FieldMessage";
import { Presence } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./otp-input.module.css";

export interface OtpInputProps {
  length?: number;
  value?: string;
  onChange?: (value: string) => void;
  /** Fires once every slot holds a character, with the full code (submit the verification here). */
  onComplete?: (value: string) => void;
  label: string;
  hideLabel?: boolean;
  description?: string;
  error?: string | null;
  autoFocus?: boolean;
  disabled?: boolean;
  inputMode?: "numeric" | "text";
  class?: string;
}

/**
 * Arc OtpInput: a 6 digit verification code. Each digit rises into its squircle slot and unblurs; a paste lands as a
 * short left to right wave; one ring glides to the focused slot; a new error nudges the row once.
 */
export function OtpInput(props: OtpInputProps) {
  const uid = createUniqueId();
  const length = () => props.length ?? 6;
  const [internal, setInternal] = createSignal("");
  const value = () => props.value ?? internal();
  const values = () => Array.from({ length: length() }, (_, index) => value()[index] ?? "");
  const hintId = () => (props.description ? `otp-${uid}-description` : undefined);
  const errorId = () => (props.error ? `otp-${uid}-error` : undefined);
  const describedBy = () => [hintId(), errorId()].filter(Boolean).join(" ") || undefined;
  const inputs: HTMLInputElement[] = [];
  let row: HTMLDivElement | undefined;
  let ring: HTMLSpanElement | undefined;
  let ringShown = false;
  const [wave, setWave] = createSignal(false);

  const focusAt = (index: number) => inputs[Math.max(0, Math.min(index, length() - 1))]?.focus();
  const sanitize = (next: string) => ((props.inputMode ?? "numeric") === "numeric" ? next.replace(/\D/g, "") : next.replace(/\s/g, ""));
  const emit = (next: string, changedSlots = 1) => {
    setWave(changedSlots > 1);
    if (props.value === undefined) setInternal(next);
    props.onChange?.(next);
    if (next.length === length()) props.onComplete?.(next);
  };
  const join = (list: string[]) => list.join("");

  onMount(() => {
    if (props.autoFocus) queueMicrotask(() => inputs[0]?.focus());
    if (!row || typeof ResizeObserver === "undefined") return;
    // Slots shrink at narrow widths; keep the ring on the focused slot when the row resizes.
    const observer = new ResizeObserver(() => {
      const slot = row?.contains(document.activeElement) ? document.activeElement?.parentElement as HTMLElement | null : null;
      if (slot && ring) animate(ring, { x: slot.offsetLeft, width: `${slot.offsetWidth}px` }, { duration: 0 });
    });
    observer.observe(row);
    onCleanup(() => observer.disconnect());
  });

  // A new error nudges the row side to side once, so a rejected code reads as a response to the attempt.
  createEffect(on(() => props.error, (error, previous) => {
    if (error && error !== previous && !prefersReducedMotion() && row) animate(row, { x: [0, -6, 5, -3, 2, 0] }, { duration: 0.36, ease: [...motionTokens.ease.standard] as [number, number, number, number] });
  }, { defer: true }));

  const updateAt = (index: number, raw: string) => {
    const next = values().slice();
    const clean = sanitize(raw).slice(-1);
    next[index] = clean;
    emit(join(next));
    if (clean && index < length() - 1) focusAt(index + 1);
  };
  const onInput = (index: number, event: InputEvent & { currentTarget: HTMLInputElement }) => {
    const raw = sanitize(event.currentTarget.value);
    if (raw.length <= 1) {
      updateAt(index, raw);
      event.currentTarget.value = values()[index] ?? "";
      return;
    }
    // Autofill from the platform ("one-time-code") or a fast typist delivers several characters at once.
    const next = values().slice();
    raw.slice(0, length() - index).split("").forEach((character, offset) => { next[index + offset] = character; });
    emit(join(next), raw.length);
    event.currentTarget.value = values()[index] ?? "";
    focusAt(Math.min(index + raw.length, length() - 1));
  };
  const onPaste = (index: number, event: ClipboardEvent) => {
    event.preventDefault();
    const pasted = sanitize(event.clipboardData?.getData("text") ?? "").slice(0, length() - index);
    if (!pasted) return;
    const next = values().slice();
    pasted.split("").forEach((character, offset) => { next[index + offset] = character; });
    emit(join(next), pasted.length);
    focusAt(Math.min(index + pasted.length, length() - 1));
  };
  const onKeyDown = (index: number, event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); focusAt(index - 1); }
    if (event.key === "ArrowRight") { event.preventDefault(); focusAt(index + 1); }
    if (event.key === "Backspace" && !values()[index] && index > 0) {
      event.preventDefault();
      const next = values().slice();
      next[index - 1] = "";
      emit(join(next));
      focusAt(index - 1);
    }
    if (event.key === "Delete" && values()[index]) {
      const next = values().slice();
      next[index] = "";
      emit(join(next));
    }
  };
  const onFocus = (event: FocusEvent & { currentTarget: HTMLInputElement }) => {
    const slot = event.currentTarget.parentElement as HTMLElement;
    event.currentTarget.select();
    if (!ring) return;
    const target = { x: slot.offsetLeft, width: `${slot.offsetWidth}px` };
    if (ringShown && !prefersReducedMotion()) animate(ring, { ...target, opacity: 1, scale: 1 }, { x: spring.snappy, width: { duration: 0 }, scale: spring.snappy, opacity: tween(motionTokens.duration.fast) });
    else {
      animate(ring, target, { duration: 0 });
      animate(ring, { opacity: 1, scale: [prefersReducedMotion() ? 1 : 0.94, 1] }, prefersReducedMotion() ? { duration: 0 } : { scale: spring.snappy, opacity: tween(motionTokens.duration.fast) });
    }
    ringShown = true;
  };
  const onBlur = (event: FocusEvent) => {
    if (row?.contains(event.relatedTarget as Node | null) || !ring) return;
    ringShown = false;
    animate(ring, { opacity: 0, scale: prefersReducedMotion() ? 1 : 0.94 }, prefersReducedMotion() ? { duration: 0 } : { opacity: tween(motionTokens.duration.fast), scale: spring.snappy });
  };

  return (
    <div class={[styles.field, props.class ?? ""].join(" ")}>
      <span class={props.hideLabel ? "sr-only" : styles.label} id={`otp-${uid}-label`}>{props.label}</span>
      <div ref={row} class={styles.inputs} role="group" aria-labelledby={`otp-${uid}-label`} data-invalid={props.error ? "true" : undefined}>
        <For each={values()}>
          {(character, index) => (
            <div class={styles.slot}>
              <input
                ref={el => { inputs[index()] = el; useSquircle(el); }}
                class={styles.input}
                aria-label={`${props.label}, digit ${index() + 1} of ${length()}`}
                aria-describedby={describedBy()}
                aria-invalid={props.error ? true : undefined}
                value={character}
                data-filled={character ? "true" : undefined}
                inputmode={props.inputMode ?? "numeric"}
                autocomplete={index() === 0 ? "one-time-code" : "off"}
                autocapitalize="off"
                spellcheck={false}
                disabled={props.disabled}
                onInput={event => onInput(index(), event)}
                onPaste={event => onPaste(index(), event)}
                onKeyDown={event => onKeyDown(index(), event)}
                onFocus={onFocus}
                onBlur={onBlur}
              />
              {/* The input text is transparent; this copy of the character rises into the slot and unblurs. */}
              <Presence
                when={!!character}
                enter={el => prefersReducedMotion()
                  ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant))
                  : animate(el, { opacity: [0, 1], y: ["0.35em", "0em"], scale: [0.85, 1], filter: ["blur(4px)", "blur(0px)"] }, { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] as [number, number, number, number], delay: wave() ? index() * motionTokens.stagger.item : 0, scale: { ...spring.snappy, delay: wave() ? index() * motionTokens.stagger.item : 0 } })}
                exit={el => animate(el, prefersReducedMotion() ? { opacity: 0 } : { opacity: 0, scale: 0.9, filter: "blur(2px)" }, tween(prefersReducedMotion() ? 0 : motionTokens.duration.instant))}
              >
                {ref => <span ref={ref} class={styles.glyph} aria-hidden="true">{character}</span>}
              </Presence>
            </div>
          )}
        </For>
        <span ref={el => { ring = el; useSquircle(el); }} class={styles.ring} aria-hidden="true" />
      </div>
      <FieldMessage id={hintId()} text={props.description} />
      <FieldMessage id={errorId()} text={props.error} tone="error" alert />
    </div>
  );
}

export default OtpInput;

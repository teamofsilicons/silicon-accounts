import { Match, Show, Switch, createEffect, createSignal, createUniqueId, on, onCleanup, onMount, untrack } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Check, CircleAlert, Pencil, X } from "lucide-solid";
import { DrawnCheck } from "../lib/DrawnCheck";
import { Swap, Reveal } from "../lib/presence";
import { createContentSwap } from "../lib/content-swap";
import { animate, motionTokens, prefersReducedMotion, spring, tween, type AnimationControls } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./inline-edit.module.css";

export interface InlineEditProps {
  /** The saved value. A new value from outside replaces the text while it is not being edited. */
  value: string;
  /** Persists the new value. Return a promise to show the saving state; reject it (ideally with an Error whose message says why) to roll back. */
  onSave: (next: string) => void | Promise<unknown>;
  /** Accessible name, for example "Display name". */
  label: string;
  /** Returns a message when the draft cannot be saved. */
  validate?: (next: string) => string | null | undefined;
  placeholder?: string;
  /** Wraps onto several lines. Enter still saves; Shift+Enter adds a line break. */
  multiline?: boolean;
  /** `title` for names and headings, `body` for descriptions, `display` for the serif identity name. */
  variant?: "title" | "body" | "display";
  as?: "span" | "p" | "h1" | "h2" | "h3";
  maxLength?: number;
  class?: string;
}

type Phase = "idle" | "saving" | "saved" | "failed";
/** Typing retargets many times a second, so the frame follows on a quicker spring without overshoot. */
const typingSpring = { ...motionTokens.spring.snappy, visualDuration: motionTokens.duration.fast, bounce: 0 };

/**
 * Arc InlineEdit: click-to-edit text for values read far more often than they change (the display name). The text
 * turns into a field in place with the same metrics, so nothing around it moves, and the frame grows with the text.
 * Enter saves optimistically and a check draws once the save lands; Escape rolls back; a failed save restores the last
 * saved value and says why, with a retry.
 */
export function InlineEdit(props: InlineEditProps) {
  const ids = createUniqueId();
  const displayHintId = `ie-${ids}-display`;
  const editHintId = `ie-${ids}-edit`;
  const messageId = `ie-${ids}-message`;
  const [committed, setCommitted] = createSignal(untrack(() => props.value));
  const [shown, setShown] = createSignal(untrack(() => props.value));
  const [direction, setDirection] = createSignal(1);
  const [layerKey, setLayerKey] = createSignal(0);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(untrack(() => props.value));
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal<{ value: string; reason: string } | null>(null);
  const [flash, setFlash] = createSignal<"on" | "off" | null>(null);
  const [announcement, setAnnouncement] = createSignal("");
  let root: HTMLDivElement | undefined;
  let display: HTMLButtonElement | undefined;
  let control: HTMLInputElement | HTMLTextAreaElement | undefined;
  let frame: HTMLSpanElement | undefined;
  let slot: HTMLSpanElement | undefined;
  let slotItem: HTMLSpanElement | undefined;
  let selection: number | "all" | null = null;
  let focusDisplay = false;
  let saveRun = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));
  onCleanup(() => timers.forEach(clearTimeout));
  createContentSwap(() => slot, () => slotItem);

  // A new value from outside replaces the text, unless the person is typing or a save is still in flight.
  createEffect(on(() => props.value, value => {
    if (value === committed()) return;
    setCommitted(value);
    if (!editing() && phase() !== "saving" && value !== shown()) {
      setShown(value);
      setDirection(1);
      setLayerKey(key => key + 1);
    }
  }, { defer: true }));

  const layerText = () => (editing() ? draft() : shown());
  const saving = () => phase() === "saving";

  /* The frame follows the display's natural width (single line) or height (multiline) on a spring. */
  let size = 0;
  let sizing: AnimationControls | undefined;
  let wasEditing = false;
  const naturalSize = () => (display ? parseFloat(getComputedStyle(display)[props.multiline ? "height" : "width"]) : 0);
  const snap = (next: number) => {
    sizing?.stop();
    if (props.multiline && control) { control.style.height = `${next}px`; control.scrollTop = 0; }
    if (frame && !props.multiline) frame.style.width = `${next}px`;
  };
  const onContentChange = () => {
    const next = naturalSize();
    const previous = size;
    const typing = editing() && wasEditing;
    size = next;
    wasEditing = editing();
    if (!next) return;
    if (props.multiline && control) { control.style.height = `${next}px`; control.scrollTop = 0; }
    if (props.multiline) return;
    if (!previous || prefersReducedMotion() || !frame?.style.width) { snap(next); return; }
    if (Math.abs(next - previous) < 0.1) return;
    sizing?.stop();
    if (frame) sizing = animate(frame, { width: `${next}px` }, typing ? typingSpring : spring.morph);
  };
  createEffect(on([layerText, editing], () => queueMicrotask(onContentChange)));
  onMount(() => {
    if (!display || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = naturalSize();
      if (!next || Math.abs(next - size) < 0.1) return;
      size = next;
      snap(next);
    });
    observer.observe(display, { box: "border-box" });
    onCleanup(() => observer.disconnect());
  });

  // Focus follows the mode: into the field with the caret where the text was clicked, back to the text after Enter or Escape.
  createEffect(on(editing, isEditing => queueMicrotask(() => {
    if (isEditing && control && selection !== null) {
      const at = selection;
      selection = null;
      control.focus({ preventScroll: true });
      if (at === "all") control.select();
      else control.setSelectionRange(at, at);
    }
    if (!isEditing && focusDisplay) { focusDisplay = false; display?.focus({ preventScroll: true }); }
  }), { defer: true }));

  function startEdit(at: number | "all", text = shown()) {
    if (editing() || saving()) return;
    setDraft(text);
    setEditing(true);
    setError(null);
    setFailed(null);
    setFlash(null);
    if (phase() !== "idle") setPhase("idle");
    selection = at;
  }

  /** The caret lands on the character that was clicked, the way it would in a text field. */
  function caretAt(x: number, y: number) {
    const node = display?.querySelector("[data-layer-text]")?.firstChild;
    const text = shown();
    if (!node || !text) return text.length;
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const position = doc.caretPositionFromPoint?.(x, y);
    if (position) return position.offsetNode === node ? Math.min(position.offset, text.length) : text.length;
    const range = doc.caretRangeFromPoint?.(x, y);
    return range && range.startContainer === node ? Math.min(range.startOffset, text.length) : text.length;
  }

  const clean = (text: string) => (props.multiline ? text.trim() : text.replace(/\s+/g, " ").trim());

  function submit(source: "key" | "button" | "blur") {
    const next = clean(draft());
    const problem = props.validate?.(next) || null;
    if (problem) {
      setError(problem);
      if (source !== "blur") control?.focus();
      return;
    }
    setEditing(false);
    setError(null);
    if (source !== "blur") focusDisplay = true;
    if (next !== draft()) { setDirection(1); setLayerKey(key => key + 1); }
    if (next === shown()) return;
    const previous = committed();
    const run = ++saveRun;
    setShown(next);
    setPhase("saving");
    setAnnouncement(`Saving ${props.label.toLowerCase()}`);
    Promise.resolve()
      .then(() => props.onSave(next))
      .then(() => {
        if (run !== saveRun) return;
        setCommitted(next);
        setPhase("saved");
        setAnnouncement(`${props.label} saved`);
        later(() => setPhase(current => (current === "saved" ? "idle" : current)), 1800);
      }, (reason: unknown) => {
        if (run !== saveRun) return;
        setShown(previous);
        setDirection(-1);
        setLayerKey(key => key + 1);
        setPhase("failed");
        const message = reason instanceof Error && reason.message ? reason.message : "";
        setFailed({ value: next, reason: message });
        setFlash("on");
        setAnnouncement("");
        later(() => setFlash(current => (current === "on" ? "off" : current)), 1400);
        later(() => setFlash(current => (current === "off" ? null : current)), 2000);
      });
  }

  function cancel() {
    setEditing(false);
    setError(null);
    focusDisplay = true;
    if (draft() !== shown()) { setDirection(-1); setLayerKey(key => key + 1); }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    if (event.key === "Enter" && !event.isComposing && !(props.multiline && event.shiftKey)) { event.preventDefault(); submit("key"); }
  };
  // Leaving the component saves, the way a rename does; switching windows does not.
  const onFocusOut = (event: FocusEvent) => {
    if (!editing()) return;
    const next = event.relatedTarget as Node | null;
    if (next && root?.contains(next)) return;
    if (!next && !document.hasFocus()) return;
    submit("blur");
  };

  const noun = () => props.label.toLowerCase();
  const slotState = () => (editing() ? "edit" : phase());
  const message = () => {
    const problem = error();
    if (problem) return { tone: "error" as const, text: problem };
    const failure = failed();
    if (failure && !editing()) return { tone: "failed" as const, text: `${failure.reason ? `${failure.reason} ` : ""}Couldn’t save “${failure.value}”, so the last saved ${noun()} is back.` };
    return null;
  };
  const describedBy = (hint: string) => [hint, message() ? messageId : null].filter(Boolean).join(" ");
  const fieldProps = () => ({
    class: styles.control,
    value: draft(),
    onInput: (event: InputEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
      setDraft(event.currentTarget.value);
      if (error()) setError(props.validate?.(clean(event.currentTarget.value)) || null);
    },
    onKeyDown,
    placeholder: props.placeholder ?? "",
    "aria-label": props.label,
    "aria-invalid": error() ? true : undefined,
    "aria-describedby": describedBy(editHintId),
    autocomplete: "off",
    spellcheck: props.variant === "body",
    maxLength: props.maxLength,
  });

  return (
    <div
      ref={root}
      class={[styles.root, props.class ?? ""].join(" ")}
      data-variant={props.variant ?? "title"}
      data-multiline={props.multiline || undefined}
      data-editing={editing() || undefined}
      data-phase={phase()}
      data-invalid={error() ? "" : undefined}
      data-flash={flash() ?? undefined}
      onFocusOut={onFocusOut}
    >
      <Dynamic component={props.as ?? "span"} class={styles.line}>
        <span class={styles.box}>
          {/* The text stays in flow while editing, hidden and mirroring the draft, so it sizes the box and can roll back. */}
          <button
            ref={display}
            type="button"
            class={styles.display}
            onClick={event => { if (!saving()) startEdit(event.detail === 0 ? "all" : caretAt(event.clientX, event.clientY)); }}
            tabIndex={editing() ? -1 : undefined}
            aria-label={`${props.label}: ${shown() || props.placeholder || "empty"}`}
            aria-describedby={describedBy(displayHintId)}
            aria-disabled={saving() || undefined}
          >
            <span class={styles.layer} data-empty={layerText() ? undefined : ""}>
              <Swap
                value={{ key: layerKey(), text: layerText() }}
                keyOf={value => value.key}
                class={styles.text}
                enter={el => prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.fast)) : animate(el, { opacity: [0, 1], y: [`${direction() * 0.3}em`, "0em"], filter: ["blur(4px)", "blur(0px)"] }, tween(motionTokens.duration.standard, motionTokens.ease.enter))}
                exit={el => prefersReducedMotion() ? animate(el, { opacity: 0 }, tween(motionTokens.duration.instant)) : animate(el, { opacity: 0, y: `${direction() * -0.3}em`, filter: "blur(2px)" }, tween(motionTokens.duration.fast))}
              >
                {value => <span data-layer-text>{(value.text || props.placeholder || "​") + (props.multiline && editing() ? "​" : "")}</span>}
              </Swap>
            </span>
          </button>
          <Show when={editing()}>
            {props.multiline
              ? <textarea ref={el => (control = el)} {...fieldProps()} rows={1} enterkeyhint="done" />
              : <input ref={el => (control = el)} {...fieldProps()} type="text" enterkeyhint="done" />}
          </Show>
          <span ref={el => { frame = el; useSquircle(el); }} class={styles.frame}>
            <span ref={slot} class={styles.slot}>
              <span ref={slotItem} class={styles.slotItem}>
                <Switch>
                  <Match when={slotState() === "edit"}>
                    <span class={styles.actions}>
                      <button type="button" class={styles.save} aria-label={`Save ${noun()}`} onPointerDown={event => event.preventDefault()} onClick={() => submit("button")}><Check size={15} stroke-width={2} aria-hidden="true" /></button>
                      <button type="button" class={styles.cancel} aria-label="Cancel editing" onPointerDown={event => event.preventDefault()} onClick={cancel}><X size={15} stroke-width={2} aria-hidden="true" /></button>
                    </span>
                  </Match>
                  <Match when={slotState() === "saving"}><span class={styles.spinner} aria-hidden="true" data-icon="spinner" /></Match>
                  <Match when={slotState() === "saved"}><span class={styles.saved} aria-hidden="true"><DrawnCheck size={16} strokeWidth={2.25} /></span></Match>
                  <Match when={slotState() === "failed"}><CircleAlert class={styles.failedIcon} size={16} stroke-width={1.75} aria-hidden="true" /></Match>
                  <Match when={slotState() === "idle"}><Pencil class={styles.pencil} size={14} stroke-width={1.75} aria-hidden="true" onClick={() => startEdit(shown().length)} /></Match>
                </Switch>
              </span>
            </span>
          </span>
        </span>
      </Dynamic>
      <Reveal when={!!message()} class={styles.reveal}>
        <span id={messageId} class={styles.message} data-tone={message()?.tone} aria-live="polite">
          <CircleAlert class={styles.messageIcon} size={14} stroke-width={2} aria-hidden="true" />
          <span>
            {message()?.text}
            <Show when={message()?.tone === "failed"}> <button type="button" class={styles.retry} onClick={() => { const failure = failed(); if (failure) startEdit(failure.value.length, failure.value); }}>Try again</button></Show>
          </span>
        </span>
      </Reveal>
      <span id={displayHintId} class="sr-only">Activate to edit.</span>
      <span id={editHintId} class="sr-only">{props.multiline ? "Enter saves, Shift+Enter adds a line break, Escape cancels." : "Enter saves, Escape cancels."}</span>
      <span class="sr-only" role="status">{announcement()}</span>
    </div>
  );
}

export default InlineEdit;

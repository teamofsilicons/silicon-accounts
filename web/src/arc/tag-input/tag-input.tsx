import { For, createEffect, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js";
import { X } from "lucide-solid";
import { FieldMessage } from "../lib/FieldMessage";
import { createFlip } from "../lib/flip";
import { createPresenceList, type PresenceEntry } from "../lib/presence-list";
import { Presence } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./tag-input.module.css";

export interface TagInputProps {
  label: string;
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  placeholder?: string;
  description?: string;
  /** Validates a new tag before it is added. Return an error message to refuse it (shown under the field). */
  validate?: (tag: string, tags: string[]) => string | null | undefined;
  /** Optional normaliser applied before validation (trim is always applied). */
  normalize?: (tag: string) => string;
  error?: string | null;
  /** Use the mono face (URLs, domains, origins). */
  mono?: boolean;
  maxTags?: number;
  id?: string;
}

function Tag(props: { entry: PresenceEntry<string>; picked: boolean; onPick: (tag: string) => void; onRemove: (tag: string) => void; onGone: () => void }) {
  let el: HTMLSpanElement | undefined;
  onMount(() => {
    if (!el || !props.entry.entering) return;
    if (prefersReducedMotion()) animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant));
    else animate(el, { opacity: [0, 1], scale: [0.9, 1], filter: ["blur(4px)", "blur(0px)"] }, { ...spring.morph, opacity: tween(motionTokens.duration.fast, motionTokens.ease.enter), filter: tween(motionTokens.duration.standard, motionTokens.ease.enter) }).then(() => { if (el) el.style.filter = "none"; });
  });
  createEffect(on(props.entry.leaving, leaving => {
    if (!leaving || !el) return;
    // Pop out of flow where it stood, so the rest glide in at once.
    Object.assign(el.style, { position: "absolute", left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, pointerEvents: "none" });
    if (prefersReducedMotion()) return props.onGone();
    animate(el, { opacity: 0, scale: 0.9, filter: "blur(2px)" }, tween(motionTokens.duration.instant)).then(props.onGone);
  }, { defer: true }));
  return (
    <span
      ref={node => { el = node; useSquircle(node); }}
      class={styles.tag}
      data-tag={props.entry.key}
      data-picked={props.picked || undefined}
      aria-hidden={props.entry.leaving() || undefined}
      onMouseDown={event => { if (!(event.target as HTMLElement).closest("button")) event.preventDefault(); }}
      onClick={event => { if (!(event.target as HTMLElement).closest("button")) props.onPick(props.entry.key); }}
    >
      <span class={styles.tagLabel}>{props.entry.item()}</span>
      <button type="button" onClick={() => props.onRemove(props.entry.key)} aria-label={`Remove ${props.entry.item()}`} tabIndex={props.entry.leaving() ? -1 : 0}>
        <X width={14} height={14} stroke-width={1.75} aria-hidden="true" />
      </button>
    </span>
  );
}

/**
 * Arc TagInput (redirect URIs, origins, email domains): a new tag blurs in where its text was typed while the caret
 * glides aside, a removed tag leaves its slot and the rest glide in, and the shell follows wrapped rows on a spring.
 * Backspace or the arrow keys pick a tag first; the next Backspace removes it. Enter, comma or blur adds the draft.
 */
export function TagInput(props: TagInputProps) {
  const uid = createUniqueId();
  const inputId = () => props.id ?? `tags-${uid}`;
  const hintId = () => (props.description ? `${inputId()}-description` : undefined);
  const errorId = () => `${inputId()}-error`;
  const [internal, setInternal] = createSignal(props.defaultValue ?? []);
  const [draft, setDraft] = createSignal("");
  const [picked, setPicked] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal("");
  const [refusal, setRefusal] = createSignal<string | null>(null);
  const tags = () => props.value ?? internal();
  const active = () => {
    const tag = picked();
    return tag !== null && tags().includes(tag) ? tag : null;
  };
  let shell: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let ring: HTMLSpanElement | undefined;
  let ringAt = "";
  const { entries, release } = createPresenceList(tags, tag => tag);
  const flip = createFlip(() => content, "[data-tag], input", el => el.getAttribute("data-tag") ?? (el.tagName === "INPUT" ? "input" : null));

  // The shell follows its wrapped rows on a spring instead of jumping when a tag starts or leaves a line.
  onMount(() => {
    if (!content || !shell || typeof ResizeObserver === "undefined") return;
    let first = true;
    const observer = new ResizeObserver(() => {
      if (!content || !shell) return;
      const next = content.offsetHeight;
      if (first || prefersReducedMotion()) { shell.style.height = `${next}px`; first = false; return; }
      animate(shell, { height: `${next}px` }, spring.smooth);
    });
    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });

  // The ring measures the picked tag's resting box, glides between picks, and fades in place when the pick clears.
  createEffect(on([active, entries], () => queueMicrotask(() => {
    const tag = active();
    const node = tag === null ? null : content?.querySelector<HTMLElement>(`[data-tag="${CSS.escape(tag)}"]`);
    if (!ring) return;
    if (!node) {
      if (ringAt) animate(ring, prefersReducedMotion() ? { opacity: 0 } : { opacity: 0, scale: 0.9 }, tween(prefersReducedMotion() ? 0 : motionTokens.duration.instant));
      ringAt = "";
      return;
    }
    const box = { x: node.offsetLeft, y: node.offsetTop, width: `${node.offsetWidth}px`, height: `${node.offsetHeight}px` };
    const at = Object.values(box).join(" ");
    if (at === ringAt) return;
    if (!prefersReducedMotion() && (ringAt || Number(getComputedStyle(ring).opacity) > 0.02)) animate(ring, { ...box, opacity: 1, scale: 1 }, { ...spring.morph, opacity: tween(motionTokens.duration.fast) });
    else {
      animate(ring, box, { duration: 0 });
      animate(ring, { opacity: [0, 1], scale: [prefersReducedMotion() ? 1 : 0.9, 1] }, prefersReducedMotion() ? { duration: 0 } : { opacity: tween(motionTokens.duration.fast), scale: spring.snappy });
    }
    ringAt = at;
  })));

  const say = (message: string) => setNotice(previous => (previous === message ? `${message} ` : message));
  const update = (next: string[]) => {
    flip.capture();
    if (props.value === undefined) setInternal(next);
    props.onValueChange?.(next);
    flip.play();
  };
  const pick = (tag: string | null) => {
    setPicked(tag);
    if (tag !== null) say(`${tag} selected. Press Backspace to remove it.`);
  };
  const add = () => {
    const raw = draft().trim();
    if (!raw) return true;
    const tag = props.normalize ? props.normalize(raw) : raw;
    const existing = tags().find(item => item.toLowerCase() === tag.toLowerCase());
    if (existing) {
      const node = content?.querySelector(`[data-tag="${CSS.escape(existing)}"]`);
      if (node && !prefersReducedMotion()) animate(node, { scale: [1, 1.06, 1] }, { duration: motionTokens.duration.standard + motionTokens.duration.instant, ease: [...motionTokens.ease.inOut] as [number, number, number, number] });
      say(`${existing} is already added`);
      setDraft("");
      return false;
    }
    if (props.maxTags !== undefined && tags().length >= props.maxTags) {
      setRefusal(`You can add up to ${props.maxTags}. Remove one first.`);
      return false;
    }
    const problem = props.validate?.(tag, tags());
    if (problem) { setRefusal(problem); return false; }
    setRefusal(null);
    update([...tags(), tag]);
    setDraft("");
    setPicked(null);
    say(`Added ${tag}`);
    return true;
  };
  const remove = (tag: string) => {
    update(tags().filter(item => item !== tag));
    setPicked(null);
    say(`Removed ${tag}`);
    input?.focus();
  };
  const onKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    const target = event.currentTarget;
    const atStart = target.selectionStart === 0 && target.selectionEnd === 0;
    const current = active();
    const list = tags();
    const index = current === null ? list.length : list.indexOf(current);
    let handled = true;
    if (event.key === "Enter" || event.key === ",") add();
    else if ((event.key === "Backspace" || event.key === "Delete") && current !== null) remove(current);
    else if (event.key === "Backspace" && atStart && list.length) pick(list[list.length - 1] ?? null);
    else if (event.key === "ArrowLeft" && (atStart || current !== null) && index > 0) pick(list[index - 1] ?? null);
    else if (event.key === "ArrowRight" && current !== null) pick(list[index + 1] ?? null);
    else if (event.key === "Escape" && current !== null) pick(null);
    else handled = false;
    if (handled) event.preventDefault();
  };
  const message = () => props.error ?? refusal();

  return (
    <div class={styles.field}>
      <label for={inputId()} class={styles.label}>{props.label}</label>
      <div ref={el => { shell = el; useSquircle(el); }} class={styles.control} data-invalid={message() ? "" : undefined}>
        <div ref={content} class={[styles.content, props.mono ? styles.mono : ""].join(" ")} onClick={event => { if (event.target === event.currentTarget) input?.focus(); }}>
          <span ref={el => { ring = el; useSquircle(el); }} class={styles.ring} aria-hidden="true" />
          <Presence when={!draft() && !tags().length} enter={el => animate(el, { opacity: [0, 1], y: ["0.3em", "0em"] }, tween(motionTokens.duration.standard, motionTokens.ease.enter))} exit={el => animate(el, { opacity: 0 }, { duration: 0 })}>
            {ref => <span ref={ref} class={styles.placeholder} aria-hidden="true">{props.placeholder ?? "Add and press Enter"}</span>}
          </Presence>
          <For each={entries()}>
            {entry => <Tag entry={entry} picked={entry.key === active()} onPick={tag => { pick(active() === tag ? null : tag); input?.focus(); }} onRemove={remove} onGone={() => release(entry)} />}
          </For>
          <input
            ref={input}
            id={inputId()}
            value={draft()}
            onInput={event => { setDraft(event.currentTarget.value); setPicked(null); if (refusal()) setRefusal(null); }}
            onKeyDown={onKeyDown}
            onBlur={() => { add(); setPicked(null); }}
            placeholder={tags().length ? "" : props.placeholder ?? "Add and press Enter"}
            aria-describedby={[hintId(), message() ? errorId() : undefined].filter(Boolean).join(" ") || undefined}
            aria-invalid={message() ? true : undefined}
            autocomplete="off"
            spellcheck={false}
          />
        </div>
      </div>
      <span class="sr-only" aria-live="polite">{notice()}</span>
      <FieldMessage id={hintId()} text={props.description} />
      <FieldMessage id={errorId()} text={message()} tone="error" alert />
    </div>
  );
}

export default TagInput;

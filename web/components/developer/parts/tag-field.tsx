"use client";

/**
 * Arc's TagInput with the rules a list of URLs, origins, domains, app ids or scopes needs (a wrapper: Arc's source
 * stays as installed). This field, not Arc, decides when typed text joins the list: Enter adds it, leaving the field
 * adds it, and a comma adds it only in lists whose values never hold one (`commaAdds`); elsewhere a comma is part of
 * the value, as in a redirect URI's query. The text is normalized (trimmed, lowercased…) and compared exactly with the
 * list (a redirect URI's path and a scope are case-sensitive, which Arc's own check ignores), then checked: a value
 * that does not pass is refused with a message saying exactly why, and its text stays in the field to be fixed instead
 * of retyped. Problems of values already in the list (the server's 422, or local checks) show under it.
 *
 * Text typed and not added yet can live outside the field (`typed` / `onTypedChange`): the sign-in setup editor counts
 * it as unsaved and gives it back when the tab returns. `commitTypedText()` asks every field on the page to add its
 * text now; the save bar calls it before saving, so ⌘S never saves without what is still being typed.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type FormEvent, type KeyboardEvent } from "react";
import { TagInput } from "@/components/arc/tag-input/tag-input";
import { plural } from "@/lib/format";
import styles from "./parts.module.css";

const COMMIT_EVENT = "developer:commit-typed-text";

/** Asks every list field on the page to add the text typed into it now (or to say why it can't). Synchronous. */
export function commitTypedText(): void {
  document.dispatchEvent(new Event(COMMIT_EVENT));
}

export interface TagFieldProps {
  label: string;
  value: string[];
  onValueChange: (next: string[]) => void;
  placeholder?: string;
  description?: string;
  /** Turns typed text into the stored form; trimming always happens. */
  normalize?: (tag: string) => string;
  /** A message refuses the value. */
  validate?: (tag: string, tags: string[]) => string | null;
  /** Most values the list may hold. */
  max?: number;
  /** Problems of values already in the list. */
  errors?: string[];
  /** URLs, origins, domains and ids read better in the mono face. */
  mono?: boolean;
  /** A comma also adds the typed text, for values that never hold one (domains, app ids). Enter always adds. */
  commaAdds?: boolean;
  /** Text typed and not added yet, kept outside the field (it comes back into the field when it changes there). */
  typed?: string;
  onTypedChange?: (text: string) => void;
  className?: string;
}

/** Puts text into a React-controlled input so React sees it as typed (Arc keeps the field's text in its own state). */
function retype(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.setSelectionRange(text.length, text.length);
}

export function TagField({ label, value, onValueChange, placeholder, description, normalize, validate, max, errors = [], mono, commaAdds = false, typed, onTypedChange, className }: TagFieldProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  /** True while this field changes the text itself (so a refusal stays on screen). */
  const restoring = useRef(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const inputOf = useCallback(() => wrapper.current?.querySelector<HTMLInputElement>("input") ?? null, []);

  /** Sets the field's text without counting as the Carbon's typing. */
  const setText = useCallback((text: string) => {
    const input = inputOf();
    if (!input || input.value === text) return;
    restoring.current = true;
    retype(input, text);
    restoring.current = false;
  }, [inputOf]);

  /** Adds typed text to the list, or refuses it with the reason. True when nothing is left to add. */
  const commit = (text: string): boolean => {
    const tag = (normalize ?? ((raw: string) => raw.trim()))(text.trim());
    if (!tag) {
      setText("");
      return true;
    }
    if (value.includes(tag)) {
      // Nothing is lost: the value is in the list already.
      setRefusal(`${tag} is already in the list.`);
      setText("");
      return true;
    }
    if (max !== undefined && value.length >= max) {
      setRefusal(`The list is full: it holds at most ${plural(max, "value")}. Remove one first.`);
      return false;
    }
    const problem = validate?.(tag, value) ?? null;
    if (problem) {
      setRefusal(problem);
      return false;
    }
    setRefusal(null);
    onValueChange([...value, tag]);
    setText("");
    setAnnouncement(current => (current === `Added ${tag}` ? `Added ${tag}\u00a0` : `Added ${tag}`));
    return true;
  };
  const commitRef = useRef(commit);
  useLayoutEffect(() => {
    commitRef.current = commit;
  });

  // A save asks first.
  useEffect(() => {
    const onCommit = () => {
      const input = inputOf();
      if (input?.value.trim()) commitRef.current(input.value);
    };
    document.addEventListener(COMMIT_EVENT, onCommit);
    return () => document.removeEventListener(COMMIT_EVENT, onCommit);
  }, [inputOf]);

  // Text kept outside comes back into the field (a tab shown again), and leaves it when the draft drops it (Discard).
  // Only changes made elsewhere: what the field itself reported last is already there.
  const reported = useRef("");
  useEffect(() => {
    if (typed === undefined) return;
    const own = reported.current.trim() ? reported.current : "";
    if (typed === own) return;
    reported.current = typed;
    setText(typed);
  }, [typed, setText]);

  // Arc ends a value at a comma, adds on Enter and on blur, and ignores case when it looks for duplicates. Those keys
  // and the blur are taken here first (capture phase), so the rules above apply.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const input = inputOf();
    if (!input || event.target !== input || event.nativeEvent.isComposing) return;
    const adds = event.key === "Enter" || (event.key === "," && commaAdds);
    if (adds && input.value.trim()) {
      event.preventDefault();
      event.stopPropagation();
      commit(input.value);
    } else if (event.key === "," && !commaAdds) {
      // Part of the value: typed as is.
      event.stopPropagation();
    }
  };
  const onBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const input = inputOf();
    if (!input || event.target !== input || !input.value.trim()) return;
    event.stopPropagation();
    commit(input.value);
  };
  const onInput = (event: FormEvent<HTMLDivElement>) => {
    const input = inputOf();
    if (!input || event.target !== input) return;
    reported.current = input.value;
    onTypedChange?.(input.value);
    if (!restoring.current && refusal) setRefusal(null);
  };

  // Removals come from Arc; an add that still reaches here (an input method's Enter) gets the same rules, and a
  // refused text goes back into the field once Arc has cleared it.
  const change = (next: string[]) => {
    const added = next.filter(tag => !value.includes(tag));
    if (!added.length) {
      setRefusal(null);
      onValueChange(next);
      return;
    }
    const text = added[added.length - 1] ?? "";
    if (!commit(text)) requestAnimationFrame(() => setText(text));
  };

  const messages = [...(refusal ? [refusal] : []), ...errors.filter(message => message !== refusal)];
  return (
    <div
      ref={wrapper}
      className={[styles.tagField, mono ? styles.monoTags : "", className].filter(Boolean).join(" ")}
      onKeyDownCapture={onKeyDownCapture}
      onBlurCapture={onBlurCapture}
      onInput={onInput}
    >
      <TagInput label={label} value={value} onValueChange={change} placeholder={placeholder} description={description} />
      {messages.length ? (
        <ul className={styles.tagMessages} role="list" aria-live="polite">
          {messages.map(message => <li key={message}>{message}</li>)}
        </ul>
      ) : null}
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </div>
  );
}

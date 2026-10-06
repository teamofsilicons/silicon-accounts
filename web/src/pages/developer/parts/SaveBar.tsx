/**
 * The floating "unsaved changes" bar of an editor tab: how many changes, what blocks saving (problems, or a version
 * conflict that waits for a choice), Discard and Save. It rises above the dock when the tab has changes, confirms
 * "Saved" in place, then leaves. ⌘S / Ctrl+S saves.
 */
import { Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { Check, TriangleAlert } from "lucide-solid";
import { Button } from "../../../arc/button/button";
import { Presence, SwapText } from "../../../arc/lib/presence";
import { animate, motionTokens, prefersReducedMotion, spring, tween } from "../../../arc/lib/motion";
import { useSquircle } from "../../../arc/lib/squircle";
import { isApplePlatform } from "../../../arc/lib/dom";
import type { SectionKey } from "../lib/config";
import type { ConfigEditor } from "../lib/editor";
import styles from "./parts.module.css";

export function SaveBar(props: { section: SectionKey; editor: ConfigEditor }) {
  const editor = props.editor;
  const [justSaved, setJustSaved] = createSignal(false);
  let timer = 0;
  const count = () => editor.changes(props.section).length;
  const problems = () => Object.keys(editor.problems(props.section)).length;
  const pending = () => editor.state[props.section].pending;
  const conflicted = () => !!editor.conflict(props.section);
  const visible = () => count() > 0 || pending() || justSaved();

  createEffect(on(() => editor.state[props.section].savedAt, savedAt => {
    if (!savedAt) return;
    setJustSaved(true);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => setJustSaved(false), 1600);
  }, { defer: true }));
  onCleanup(() => window.clearTimeout(timer));

  const save = () => void editor.save(props.section);
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || event.altKey || event.shiftKey) return;
      if (!count()) return;
      event.preventDefault();
      save();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  const status = () => {
    if (pending()) return "Saving changes";
    if (justSaved() && !count()) return `Saved as version ${editor.version()}`;
    if (conflicted()) return "Someone saved a newer version: choose above";
    if (problems()) return `${problems() === 1 ? "1 problem blocks" : `${problems()} problems block`} saving`;
    return `${count() === 1 ? "1 unsaved change" : `${count()} unsaved changes`}`;
  };

  return (
    <Presence
      when={visible()}
      initial
      enter={el => (prefersReducedMotion() ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant)) : animate(el, { opacity: [0, 1], y: [16, 0], scale: [0.98, 1] }, { y: spring.smooth, scale: spring.smooth, opacity: tween(motionTokens.duration.fast) }))}
      exit={el => animate(el, { opacity: 0, y: prefersReducedMotion() ? 0 : 12 }, tween(motionTokens.duration.exit))}
    >
      {ref => (
        <div ref={el => { ref(el); useSquircle(el); }} class={styles.saveBar} role="region" aria-label="Unsaved changes" data-problems={problems() > 0 || conflicted() || undefined}>
          <span class={styles.saveStatus} role="status">
            <Show when={(problems() > 0 || conflicted()) && !pending()} fallback={<Show when={justSaved() && !count()} fallback={<span class={styles.saveDot} aria-hidden="true" />}><Check size={16} stroke-width={2} class={styles.saveCheck} aria-hidden="true" /></Show>}>
              <TriangleAlert size={16} stroke-width={1.75} class={styles.saveWarn} aria-hidden="true" />
            </Show>
            <SwapText text={status()} class={styles.saveText} />
          </span>
          <Show when={count() > 0}>
            <span class={styles.saveActions}>
              <Button variant="ghost" size="sm" onClick={() => editor.discard(props.section)} disabled={pending()}>Discard</Button>
              <Button size="sm" loading={pending()} disabled={conflicted()} onClick={save} aria-keyshortcuts={isApplePlatform() ? "Meta+S" : "Control+S"}>Save changes</Button>
            </span>
          </Show>
        </div>
      )}
    </Presence>
  );
}

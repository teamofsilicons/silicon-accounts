"use client";

/**
 * The floating "unsaved changes" bar of an editor tab: how many changes, what blocks saving (problems, or a version
 * conflict that waits for a choice), Discard and Save. It rises above the dock when the tab has changes, confirms
 * "Saved as version N" in place, then leaves. ⌘S / Ctrl+S saves. Text still being typed into a list field counts as a
 * change, and a save adds it first. When Save or Discard leaves with the bar's buttons, focus goes back to where the
 * Carbon was working (parts/focus-return.ts).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, TriangleAlert } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import type { SectionKey } from "../lib/config";
import { useEditor, type ConfigEditor } from "../lib/editor";
import { alertId, revealAlert } from "./editor-alerts";
import { returnFocusIfLost, useFocusMemory } from "./focus-return";
import { commitTypedText } from "./tag-field";
import styles from "./parts.module.css";

const subscribeNothing = () => () => undefined;
const isApple = () => /mac|iphone|ipad|ipod/i.test(navigator.platform ?? "");

/** Status text that swaps with a short rise, so the bar never jumps between messages. */
function SwapText({ text }: { text: string }) {
  const reduced = useReducedMotion();
  return (
    <span className={styles.saveText}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: "0.35em", filter: `blur(${motionTokens.blur.soft}px)` }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.3em", filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast } }}
          transition={reduced ? { duration: motionTokens.duration.instant } : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * Saves; when the save stops at a choice (a conflict) or a failure, that alert comes into view and takes focus. A
 * save that worked takes the bar's buttons away, so focus that was on them goes back to where the Carbon worked.
 */
export async function saveAndReveal(editor: ConfigEditor, section: SectionKey, bar?: Element | null): Promise<void> {
  // Text still being typed into a list field joins the draft first (or is refused, with the reason next to it).
  commitTypedText();
  if (await editor.save(section)) {
    returnFocusIfLost({ leaving: bar });
    return;
  }
  const view = editor.getView();
  if (view.conflict[section]) revealAlert(alertId(section, "conflict"));
  else if (view.sections[section].error) revealAlert(alertId(section, "error"));
}

export function SaveBar({ section, editor }: { section: SectionKey; editor: ConfigEditor }) {
  const view = useEditor(editor);
  const reduced = useReducedMotion();
  const apple = useSyncExternalStore(subscribeNothing, isApple, () => false);
  useFocusMemory();
  const bar = useRef<HTMLDivElement>(null);
  const state = view.sections[section];
  const count = view.unsaved[section];
  const problems = Object.keys(view.problems[section]).length;
  const pending = state.pending;
  const conflicted = !!view.conflict[section];
  // "Saved" shows for a moment after a save made while this bar is mounted (not for an older one), then the bar leaves.
  const [seenSave, setSeenSave] = useState(state.savedAt);
  const justSaved = state.savedAt !== null && state.savedAt !== seenSave;
  useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setSeenSave(state.savedAt), 1600);
    return () => window.clearTimeout(timer);
  }, [justSaved, state.savedAt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || event.altKey || event.shiftKey) return;
      if (!editor.getView().dirty[section]) return;
      event.preventDefault();
      void saveAndReveal(editor, section, bar.current);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editor, section]);

  const visible = count > 0 || pending || justSaved;
  const status = pending
    ? "Saving changes"
    : justSaved && !count
      ? `Saved as version ${view.version}`
      : conflicted
        ? "Someone saved a newer version"
        : problems
          ? `${problems === 1 ? "1 problem blocks" : `${problems} problems block`} saving`
          : count === 1 ? "1 unsaved change" : `${count} unsaved changes`;
  const warn = (problems > 0 || conflicted) && !pending;

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          key="save-bar"
          ref={bar}
          data-sq="surface"
          data-focus-transient=""
          className={styles.saveBar}
          role="region"
          aria-label="Unsaved changes"
          data-problems={warn || undefined}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0, transition: { duration: motionTokens.duration.instant } } : { opacity: 0, y: 12, transition: { duration: motionTokens.duration.exit, ease: [...motionTokens.ease.standard] } }}
          transition={reduced ? { duration: motionTokens.duration.instant } : { y: motionTokens.spring.smooth, scale: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}
        >
          <span className={styles.saveStatus} role="status">
            {warn ? <TriangleAlert size={16} strokeWidth={1.75} className={styles.saveWarn} aria-hidden="true" />
              : justSaved && !count ? <Check size={16} strokeWidth={2} className={styles.saveCheck} aria-hidden="true" />
                : <span className={styles.saveDot} aria-hidden="true" />}
            <SwapText text={status} />
          </span>
          {count > 0 ? (
            <span className={styles.saveActions}>
              <Button variant="ghost" size="sm" onClick={() => { editor.discard(section); returnFocusIfLost({ leaving: bar.current }); }} disabled={pending}>Discard</Button>
              {conflicted && !pending ? (
                <Button size="sm" onClick={() => revealAlert(alertId(section, "conflict"))}>Review</Button>
              ) : (
                <Button size="sm" loading={pending} onClick={() => void saveAndReveal(editor, section, bar.current)} aria-keyshortcuts={apple ? "Meta+S" : "Control+S"}>Save changes</Button>
              )}
            </span>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

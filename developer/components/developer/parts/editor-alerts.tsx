"use client";

/**
 * What stands between an editor tab and a saved setup: a version conflict (someone saved in between and changed the
 * same settings: whose changes touch what, and the two ways out), a newer version that arrived without touching this
 * tab's changes (what changed underneath), settings that need fixing (each named), or any other failure.
 */
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Button } from "@/components/silicon-ui/button/button";
import { pathLabel, type SectionKey } from "../lib/config";
import { useEditor, type ConfigEditor } from "../lib/editor";
import { returnFocusIfLost } from "./focus-return";
import { commitTypedText } from "./tag-field";
import styles from "./parts.module.css";

/** Ids of the alerts the save bar brings into view. */
export const alertId = (section: SectionKey, kind: "conflict" | "error") => `${section}-${kind === "conflict" ? "conflict" : "save-error"}`;

/** Scrolls an alert of this tab into view and moves focus to it, so a keyboard or screen reader user lands on the choice. */
export function revealAlert(id: string): void {
  requestAnimationFrame(() => {
    const node = document.getElementById(id);
    if (!node) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    node.focus({ preventScroll: true });
  });
}

/**
 * A conflict's choice. The alert leaves at once, so focus goes back to where the Carbon was working; if saving on top
 * meets another conflict or a failure, that alert comes into view and takes focus instead.
 */
async function resolve(editor: ConfigEditor, section: SectionKey, choice: "mine" | "theirs"): Promise<void> {
  if (choice === "mine") commitTypedText();
  const done = editor.resolveConflict(section, choice);
  returnFocusIfLost();
  await done;
  const view = editor.getView();
  if (view.conflict[section]) revealAlert(alertId(section, "conflict"));
  else if (view.sections[section].error) revealAlert(alertId(section, "error"));
}

function Paths({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, 6);
  return (
    <span className={styles.pathList}>
      {shown.map((path, index) => (
        <span key={path}>{index > 0 ? ", " : ""}<span title={path}>{pathLabel(path)}</span></span>
      ))}
      {paths.length > 6 ? `, and ${paths.length - 6} more` : ""}
    </span>
  );
}

export function EditorAlerts({ section, editor }: { section: SectionKey; editor: ConfigEditor }) {
  const view = useEditor(editor);
  const state = view.sections[section];
  const conflict = view.conflict[section];
  const fieldEntries = Object.entries(view.fieldErrors[section]);
  const serverRefused = Object.keys(state.serverFields).length > 0;
  const error = !conflict ? state.error : undefined;

  return (
    <>
      {conflict ? (
        <Alert id={alertId(section, "conflict")} tabIndex={-1} data-focus-transient="" className={styles.alertTarget} tone="warning" title={`Someone saved version ${conflict.toVersion} while you edited version ${conflict.fromVersion}`}>
          <span className={styles.alertLine}>They changed <Paths paths={conflict.theirs} />.</span>
          <span className={styles.alertLine}>
            You both changed <Paths paths={conflict.overlap} />. Your values are still in the form; saving yours on top replaces theirs there and keeps
            the rest of theirs. Nothing is saved until you choose.
          </span>
          <span className={styles.alertActions}>
            <Button size="sm" loading={state.pending} onClick={() => void resolve(editor, section, "mine")}>Save mine on top</Button>
            <Button size="sm" variant="secondary" disabled={state.pending} onClick={() => void resolve(editor, section, "theirs")}>Discard mine, load theirs</Button>
          </span>
        </Alert>
      ) : null}
      {!conflict && state.notice ? (
        <Alert
          tone="info"
          data-focus-transient=""
          title={state.notice.saved ? `Saved on top of version ${state.notice.toVersion}` : `Version ${state.notice.toVersion} was saved while you edited`}
          onDismiss={() => editor.dismissNotice(section)}
        >
          <span className={styles.alertLine}>
            {state.notice.saved ? `Someone saved it while you edited version ${state.notice.fromVersion}. They changed ` : "It changed "}
            <Paths paths={state.notice.theirs} />
            {state.notice.saved ? ". None of that touched your changes, so both are kept." : ". None of that touches your changes, which stay on top of it."}
          </span>
        </Alert>
      ) : null}
      {error ? (
        <Alert id={alertId(section, "error")} tabIndex={-1} data-focus-transient="" className={styles.alertTarget} tone="danger" title={error.code === "validation_failed" ? "Some settings need fixing" : "The changes were not saved"}>
          {serverRefused && fieldEntries.length ? (
            <span className={styles.alertLine}>Silicon Accounts refused {fieldEntries.length === 1 ? "this setting" : `these ${fieldEntries.length} settings`}; nothing was saved.</span>
          ) : (
            <span className={styles.alertLine}>{error.message} {error.hint}</span>
          )}
          {(state.attempted || serverRefused) && fieldEntries.length ? (
            <span className={styles.problemList}>
              {fieldEntries.slice(0, 8).map(([path, message]) => (
                <span key={path}>
                  <span className={styles.problemPath} title={path}>{pathLabel(path)}</span> {message}
                </span>
              ))}
            </span>
          ) : null}
          {error.requestId ? <span className={styles.alertMeta}>Request {error.requestId}</span> : null}
        </Alert>
      ) : null}
    </>
  );
}

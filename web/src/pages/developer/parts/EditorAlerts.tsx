/**
 * What stands between an editor tab and a saved config: a version conflict (someone saved in between and changed the
 * same settings: whose changes touch what, and the two ways out), a newer version that arrived without touching this
 * tab's changes (what changed underneath), field problems (each with the setting it belongs to), or any other failure.
 */
import { For, Show } from "solid-js";
import { Alert } from "../../../arc/alert/alert";
import { Button } from "../../../arc/button/button";
import { pathLabel, type SectionKey } from "../lib/config";
import type { ConfigEditor } from "../lib/editor";
import styles from "./parts.module.css";

function Paths(props: { paths: string[] }) {
  const shown = () => props.paths.slice(0, 6);
  return (
    <span class={styles.pathList}>
      <For each={shown()}>{(path, index) => <>{index() > 0 ? ", " : ""}<span title={path}>{pathLabel(path)}</span></>}</For>
      {props.paths.length > 6 ? `, and ${props.paths.length - 6} more` : ""}
    </span>
  );
}

export function EditorAlerts(props: { section: SectionKey; editor: ConfigEditor }) {
  const state = () => props.editor.state[props.section];
  const conflict = () => props.editor.conflict(props.section);
  const fieldEntries = () => Object.entries(props.editor.fieldErrors(props.section));
  const showFields = () => state().attempted || Object.keys(state().serverFields).length > 0;
  return (
    <>
      <Show when={conflict()}>
        {open => (
          <Alert
            tone="warning"
            title={`Someone saved version ${open().toVersion} while you edited version ${open().fromVersion}`}
            action={
              <>
                <Button size="sm" loading={state().pending} onClick={() => void props.editor.resolveConflict(props.section, "mine")}>Save mine on top</Button>
                <Button size="sm" variant="secondary" disabled={state().pending} onClick={() => void props.editor.resolveConflict(props.section, "theirs")}>Discard mine, load theirs</Button>
              </>
            }
          >
            <p class={styles.alertLine}>They changed <Paths paths={open().theirs} />.</p>
            <p class={styles.alertLine}>You both changed <Paths paths={open().overlap} />. Your values are still in the form; saving yours on top replaces theirs there and keeps the rest of theirs. Nothing is saved until you choose.</p>
          </Alert>
        )}
      </Show>
      <Show when={!conflict() && state().notice}>
        {notice => (
          <Alert
            tone="info"
            title={notice().saved ? `Saved on top of version ${notice().toVersion}` : `Version ${notice().toVersion} was saved while you edited`}
            onDismiss={() => props.editor.dismissNotice(props.section)}
          >
            <p class={styles.alertLine}>
              {notice().saved ? `Someone saved it while you edited version ${notice().fromVersion}. They changed ` : "It changed "}
              <Paths paths={notice().theirs} />
              {notice().saved ? ". None of that touched your changes, so both are kept." : ". None of that touches your changes, which stay on top of it."}
            </p>
          </Alert>
        )}
      </Show>
      <Show when={!conflict() && state().error}>
        {error => (
          <Alert tone="danger" title={error().code === "validation_failed" ? "Some settings need fixing" : "The changes were not saved"}>
            <Show
              when={showFields() && fieldEntries().length && error().status !== 0}
              fallback={<p class={styles.alertLine}>{error().message} {error().hint}</p>}
            >
              <p class={styles.alertLine}>Silicon Accounts refused {fieldEntries().length === 1 ? "this setting" : `these ${fieldEntries().length} settings`}; nothing was saved.</p>
            </Show>
            <Show when={showFields() && fieldEntries().length}>
              <ul class={styles.problemList} role="list">
                <For each={fieldEntries().slice(0, 8)}>{([path, message]) => <li><span class={styles.problemPath} title={path}>{pathLabel(path)}</span> {message}</li>}</For>
              </ul>
            </Show>
            <Show when={error().requestId}><p class={styles.alertMeta}>Request {error().requestId}</p></Show>
          </Alert>
        )}
      </Show>
    </>
  );
}

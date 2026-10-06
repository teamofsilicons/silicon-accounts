/**
 * Every change to an app's sign-in setup, newest first (GET /v1/apps/{app_id}/signin-config/history): who changed what,
 * when, from what to what. Secrets show only that they changed. "Undo in draft" puts the earlier values of one version
 * back into the editor's draft for review; nothing is saved until Save changes.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { History, RotateCcw } from "lucide-solid";
import { api, createPagedList, type AccountSummary, type ConfigHistoryItem } from "../../../api";
import { Alert } from "../../../arc/alert/alert";
import { Badge } from "../../../arc/badge/badge";
import { Button } from "../../../arc/button/button";
import { Drawer, DrawerContent } from "../../../arc/drawer/drawer";
import { EmptyState } from "../../../arc/empty-state/empty-state";
import { SegmentedControl } from "../../../arc/segmented-control/segmented-control";
import { Skeleton } from "../../../arc/skeleton/skeleton";
import { useSquircle } from "../../../arc/lib/squircle";
import { notify } from "../../../app/notify";
import { formatDateTime, formatRelative } from "../../../lib/format";
import { SECTION_KEYS, pathLabel, type SectionKey } from "../lib/config";
import type { ConfigEditor } from "../lib/editor";
import { under } from "../lib/paths";
import styles from "./parts.module.css";

interface Change {
  path: string;
  before: unknown;
  after: unknown;
  secret?: boolean;
}

type Item = ConfigHistoryItem & { actor_account?: AccountSummary | null };

function changesOf(item: Item): Change[] {
  return Array.isArray(item.changes) ? (item.changes as Change[]).filter(change => change && typeof change.path === "string") : [];
}

function actorLabel(item: Item): string {
  if (item.actor_account?.id) return item.actor_account.id;
  if (typeof item.actor === "object" && item.actor) return item.actor.id ?? item.actor.uuid;
  if (item.actor === "app") return "The app, with its secret";
  if (item.actor === "silicon_apps" || item.actor === "sync") return "Silicon Apps";
  return item.actor ? String(item.actor) : "Unknown";
}

function Value(props: { value: unknown; secret?: boolean }) {
  return (
    <Switch fallback={<code class={styles.historyValue}>{JSON.stringify(props.value)}</code>}>
      <Match when={props.secret}><span class={styles.historyMuted}>{props.value === null ? "none" : "a secret"}</span></Match>
      <Match when={props.value === null || props.value === undefined}><span class={styles.historyMuted}>default</span></Match>
      <Match when={typeof props.value === "string" && /^#[0-9a-fA-F]{6}$/.test(props.value as string)}>
        <span class={styles.historyColour}><i ref={el => useSquircle(el)} style={{ "--sq-fill": props.value as string }} aria-hidden="true" /><code>{props.value as string}</code></span>
      </Match>
      <Match when={typeof props.value === "boolean"}><span>{props.value ? "On" : "Off"}</span></Match>
      <Match when={Array.isArray(props.value)}>
        <span class={styles.historyArray}>{(props.value as unknown[]).length ? (props.value as unknown[]).map(String).join(", ") : "none"}</span>
      </Match>
      <Match when={typeof props.value === "string" && (props.value as string).startsWith("data:")}><span class={styles.historyMuted}>an inline image</span></Match>
      <Match when={typeof props.value === "string" || typeof props.value === "number"}><code class={styles.historyValue}>{String(props.value)}</code></Match>
    </Switch>
  );
}

export function HistoryDrawer(props: { open: boolean; onOpenChange: (open: boolean) => void; appId: string; editor: ConfigEditor; section: SectionKey }) {
  const [scope, setScope] = createSignal<"section" | "all">("section");
  const list = createPagedList(query => api.apps.configHistory(props.appId, query), { limit: 30, immediate: false });
  // Read again every time the drawer opens, and when a newer version is stored while it is open: the list must always
  // reach the version the drawer says is stored. The previous list stays on screen until the new one arrives.
  createEffect(on([() => props.open, () => props.editor.version()], ([open]) => {
    if (open) void list.reset();
  }));
  const prefixes = () => SECTION_KEYS[props.section];
  const inScope = (change: Change) => scope() === "all" || prefixes().some(prefix => under(change.path, prefix));
  const entries = createMemo(() => (list.items() as Item[]).map(item => ({ item, changes: changesOf(item).filter(inScope) })).filter(entry => entry.changes.length > 0));

  const undo = (item: Item) => {
    const editable = changesOf(item).filter(change => !change.secret && prefixes().some(prefix => under(change.path, prefix)));
    if (!editable.length) return;
    const setDraft = props.editor.setDraft as unknown as (...args: unknown[]) => void;
    for (const change of editable) {
      const parts = change.path.split(".");
      setDraft(...parts, change.before === undefined ? null : JSON.parse(JSON.stringify(change.before)));
    }
    props.onOpenChange(false);
    notify.info(`Version ${item.version} undone in your draft`, `${editable.length === 1 ? "One value is" : `${editable.length} values are`} back to what they were before. Review them, then save.`);
  };

  return (
    <Drawer open={props.open} onOpenChange={props.onOpenChange}>
      <DrawerContent title="Version history" description={`Version ${props.editor.version()} is stored now. Every change is kept, with who made it.`} size="lg">
        <div class={styles.historyBody}>
          <SegmentedControl
            label="Show"
            size="sm"
            value={scope()}
            onValueChange={setScope}
            options={[{ value: "section", label: props.section === "branding" ? "Branding changes" : "Sign-in changes" }, { value: "all", label: "Every change" }]}
          />
          <Show when={list.error()}>
            {error => <Alert tone="danger" title="Could not load the history" action={<Button size="sm" variant="secondary" onClick={() => void list.reset()}>Try again</Button>}>{error().message} {error().hint}</Alert>}
          </Show>
          <Show when={!list.loading() || list.items().length} fallback={<Skeleton lines={5} label="Loading the version history" />}>
            <Show when={entries().length} fallback={<Show when={!list.error()}><EmptyState icon={<History size={24} stroke-width={1.5} />} title="No changes yet" description={scope() === "all" ? "Changes to this app's sign-in setup will be listed here." : "Nothing in this part of the setup has changed yet. Try Every change."} /></Show>}>
              <ol class={styles.historyList} role="list">
                <For each={entries()}>
                  {entry => (
                    <li class={styles.historyEntry}>
                      <div class={styles.historyHead}>
                        <Badge size="sm" tone={entry.item.version === props.editor.version() ? "info" : "neutral"}>Version {entry.item.version}</Badge>
                        <span class={styles.historyWho}><span class="mono">{actorLabel(entry.item)}</span> <span class={styles.historyMuted} title={formatDateTime(entry.item.at)}>{formatRelative(entry.item.at)}</span></span>
                        <Show when={entry.changes.some(change => !change.secret && prefixes().some(prefix => under(change.path, prefix)))}>
                          <Button size="sm" variant="ghost" onClick={() => undo(entry.item)} aria-label={`Undo version ${entry.item.version} in your draft`}><RotateCcw size={14} stroke-width={1.75} aria-hidden="true" />Undo in draft</Button>
                        </Show>
                      </div>
                      <ul class={styles.historyChanges} role="list">
                        <For each={entry.changes}>
                          {change => (
                            <li class={styles.historyChange}>
                              <span class={styles.historyPath} title={change.path}>{pathLabel(change.path)}</span>
                              <span class={styles.historyFromTo}><Value value={change.before} secret={change.secret} /><span class={styles.historyArrow} aria-label="changed to">→</span><Value value={change.after} secret={change.secret} /></span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </li>
                  )}
                </For>
              </ol>
              <Show when={list.hasMore()}>
                <Button variant="secondary" size="sm" loading={list.loadingMore()} onClick={() => void list.loadMore()}>Show older versions</Button>
              </Show>
            </Show>
          </Show>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

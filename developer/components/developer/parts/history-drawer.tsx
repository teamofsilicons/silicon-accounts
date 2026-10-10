"use client";

/**
 * Every change to an app's sign-in setup, newest first (GET /v1/apps/{app_id}/signin-config/history): who changed what,
 * when, from what to what. Secrets show only that they changed. "Undo in draft" puts the earlier values of one version
 * back into the editor's draft for review; nothing is saved until Save changes.
 */
import { useEffect, useMemo, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import { Drawer, DrawerContent } from "@/components/silicon-ui/drawer/drawer";
import { EmptyState } from "@/components/silicon-ui/empty-state/empty-state";
import SegmentedControl from "@/components/silicon-ui/segmented-control/segmented-control";
import { Skeleton } from "@/components/silicon-ui/skeleton/skeleton";
import type { ConfigHistoryItem } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { useConfigHistory } from "@/lib/query/developer";
import { SECTION_KEYS, SECTION_LABEL, pathLabel, type SectionKey } from "../lib/config";
import { useEditor, type ConfigEditor } from "../lib/editor";
import { under } from "../lib/json";
import styles from "./parts.module.css";

interface Change {
  path: string;
  before: unknown;
  after: unknown;
  secret?: boolean;
}

function changesOf(item: ConfigHistoryItem): Change[] {
  return Array.isArray(item.changes) ? (item.changes as Change[]).filter(change => change && typeof change.path === "string") : [];
}

/** How a setup began, as the server records it (crates/apps sync.rs), in words. */
function originOf(after: unknown): string {
  if (typeof after !== "string") return "The sign-in setup began here.";
  if (after.startsWith("app created by Silicon Apps")) return "Created in Silicon Apps, with the app's sign-in defaults.";
  if (after.startsWith("fake app seeded")) return "Seeded as a stand-in app, with its sign-in defaults.";
  return after;
}

/** Who saved a version: an account (its id, in the mono face) or a part of the system (in words). */
function Actor({ item }: { item: ConfigHistoryItem }) {
  if (item.actor_account) return <span className="mono">{item.actor_account.id ?? item.actor_account.uuid}</span>;
  const words = item.actor === "app" ? "The app, with its secret"
    : item.actor === "silicon_apps" || item.actor === "sync" ? "Silicon Apps"
      : item.actor === "system" || item.actor === "seed" ? "Silicon Accounts"
        : null;
  if (words) return <span>{words}</span>;
  return <span className="mono">{item.actor ?? "Unknown"}</span>;
}

function Value({ value, secret }: { value: unknown; secret?: boolean }) {
  if (secret) return <span className={styles.historyMuted}>{value === null ? "none" : "a secret"}</span>;
  if (value === null || value === undefined) return <span className={styles.historyMuted}>default</span>;
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) {
    return <span className={styles.historyColour}><i data-sq="surface" style={{ ["--sq-fill" as string]: value }} aria-hidden="true" /><code>{value}</code></span>;
  }
  if (typeof value === "boolean") return <span>{value ? "On" : "Off"}</span>;
  if (Array.isArray(value)) return value.length ? <code className={styles.historyValue}>{value.map(String).join(", ")}</code> : <span className={styles.historyMuted}>none</span>;
  if (typeof value === "string" && value.startsWith("data:")) return <span className={styles.historyMuted}>an inline image</span>;
  if (typeof value === "string" || typeof value === "number") return <code className={styles.historyValue}>{String(value)}</code>;
  return <code className={styles.historyValue}>{JSON.stringify(value)}</code>;
}

export interface HistoryDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: string;
  editor: ConfigEditor;
  section: SectionKey;
}

export function HistoryDrawer({ open, onOpenChange, appId, editor, section }: HistoryDrawerProps) {
  const view = useEditor(editor);
  const [scope, setScope] = useState<"section" | "all">("section");
  const history = useConfigHistory(appId, { enabled: false });
  const { refetch } = history;
  // Read again every time the drawer opens, and when a newer version is stored while it is open: the list always
  // reaches the version the drawer says is stored. The previous list stays on screen until the new one arrives.
  useEffect(() => {
    if (open) void refetch();
  }, [open, view.version, refetch]);

  const prefixes = SECTION_KEYS[section];
  const entries = useMemo(() => {
    const items = history.data?.pages.flatMap(page => page.items) ?? [];
    return items
      // A change at the root ("") is how the setup began (created by Silicon Apps, or seeded): it belongs to every part.
      .map(item => ({ item, changes: changesOf(item).filter(change => scope === "all" || change.path === "" || prefixes.some(prefix => under(change.path, prefix))) }))
      .filter(entry => entry.changes.length > 0);
  }, [history.data, scope, prefixes]);

  const undo = (item: ConfigHistoryItem) => {
    const editable = changesOf(item).filter(change => !change.secret && prefixes.some(prefix => under(change.path, prefix)));
    if (!editable.length) return;
    editor.restore(editable.map(change => ({ path: change.path, value: change.before })));
    onOpenChange(false);
    notify.info(`Version ${item.version} undone in your draft`, `${editable.length === 1 ? "One value is" : `${editable.length} values are`} back to what they were before. Review them, then save.`);
  };

  const loading = history.isFetching && !history.data;
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title="Version history" description={`Version ${view.version} is stored now. Every change is kept, with who made it.`} className={styles.wideDrawer}>
        <div className={styles.historyBody}>
          <SegmentedControl
            label="Show"
            value={scope}
            onValueChange={value => setScope(value as "section" | "all")}
            options={[{ value: "section", label: `${SECTION_LABEL[section]} changes` }, { value: "all", label: "Every change" }]}
          />
          {history.error ? (
            <Alert tone="danger" title="Could not load the history">
              {history.error.message} {history.error.hint}
              <span className={styles.alertActions}><Button size="sm" variant="secondary" onClick={() => void refetch()}>Try again</Button></span>
            </Alert>
          ) : null}
          {loading ? (
            <Skeleton lines={5} label="Loading the version history" />
          ) : entries.length ? (
            <>
              <ol className={styles.historyList} role="list">
                {entries.map(({ item, changes }) => (
                  <li key={item.version} className={styles.historyEntry}>
                    <div className={styles.historyHead}>
                      <Badge size="sm" tone={item.version === view.version ? "info" : "neutral"}>{`Version ${item.version}`}</Badge>
                      <span className={styles.historyWho}>
                        <Actor item={item} /> <span className={styles.historyMuted} title={formatDateTime(item.at)}>{formatRelative(item.at)}</span>
                      </span>
                      {changes.some(change => !change.secret && prefixes.some(prefix => under(change.path, prefix))) ? (
                        <Button size="sm" variant="ghost" onClick={() => undo(item)} aria-label={`Undo version ${item.version} in your draft`}>
                          <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />Undo in draft
                        </Button>
                      ) : null}
                    </div>
                    <ul className={styles.historyChanges} role="list">
                      {changes.map(change => change.path === "" ? (
                        <li key="(root)" className={styles.historyChange}>
                          <span className={styles.historyPath}>Created</span>
                          <span className={styles.historyFromTo}>{originOf(change.after)}</span>
                        </li>
                      ) : (
                        <li key={change.path} className={styles.historyChange}>
                          <span className={styles.historyPath} title={change.path}>{pathLabel(change.path)}</span>
                          <span className={styles.historyFromTo}>
                            <Value value={change.before} secret={change.secret} />
                            <span className={styles.historyArrow} aria-label="changed to">→</span>
                            <Value value={change.after} secret={change.secret} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
              {history.hasNextPage ? (
                <Button variant="secondary" size="sm" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Show older versions</Button>
              ) : null}
            </>
          ) : !history.error ? (
            <EmptyState
              icon={<History size={24} strokeWidth={1.5} />}
              title="No changes yet"
              description={scope === "all" ? "Changes to this app's sign-in setup will be listed here." : "Nothing in this part of the setup has changed yet. Try Every change."}
            />
          ) : null}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

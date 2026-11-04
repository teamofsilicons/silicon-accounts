"use client";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Button } from "@/components/silicon-ui/button/button";
import { ConfirmMorph } from "@/components/silicon-ui/confirm-morph/confirm-morph";
import { useInterfaceSessions, useRemoveInterfaceAccess } from "@/lib/query/interface-sessions";
import { describeError } from "../parts/common";
import styles from "./interface-access.module.css";

export function InterfaceAccess() {
  const sessions = useInterfaceSessions();
  const remove = useRemoveInterfaceAccess();
  const grouped = new Map<string, { name: string; count: number; apps: Set<string> }>();
  for (const session of sessions.data?.sessions ?? []) {
    const entry = grouped.get(session.interface_id) ?? { name: session.name, count: 0, apps: new Set<string>() };
    entry.count++;
    for (const app of session.apps) entry.apps.add(app);
    grouped.set(session.interface_id, entry);
  }
  if (sessions.error && !sessions.data) return <Alert tone="danger" title="Your Interfaces did not load">{describeError(sessions.error)} <Button size="sm" variant="secondary" onClick={() => void sessions.refetch()}>Try again</Button></Alert>;
  if (!sessions.data || grouped.size === 0) return null;
  return <section className={styles.section} aria-labelledby="interfaces-heading">
    <div><h2 id="interfaces-heading">Interfaces with access</h2><p>Removing an Interface signs it out of your apps. Your other app sign-ins stay active.</p></div>
    <ul className={styles.list}>
      {Array.from(grouped, ([id, entry]) => <li className={styles.row} key={id} data-sq="surface">
        <div><strong>{entry.name}</strong><p>{entry.count} {entry.count === 1 ? "session" : "sessions"}{entry.apps.size ? ` · ${Array.from(entry.apps).join(", ")}` : ""}</p></div>
        <ConfirmMorph label="Remove access" prompt={`Remove ${entry.name}'s access?`} confirmLabel="Remove" pendingLabel="Removing" doneLabel="Access removed" onConfirm={() => remove.mutateAsync(id)} />
      </li>)}
    </ul>
    {remove.error ? <p role="alert">{describeError(remove.error)}</p> : null}
  </section>;
}

"use client";

/**
 * Connected Apps' Interfaces: each Interface that signs you in to apps, with how many sessions it holds and for which
 * apps, and Remove, asked first in a dialog as an app's Remove is (app-page.tsx). Removing signs the Interface out of
 * those apps; your own sign-ins to them stay. Shown only when an Interface has access.
 */
import { useState } from "react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { useInterfaceSessions, useRemoveInterfaceAccess } from "@/lib/query/interface-sessions";
import { AppMark } from "../parts/app-mark";
import { describeError } from "../parts/common";
import { Row, Section } from "../parts/rows";
import styles from "./apps.module.css";

interface InterfaceEntry { id: string; name: string; logo_url: string | null; sessions: number; apps: string[] }

export function InterfaceAccess() {
  const sessions = useInterfaceSessions();
  const byInterface = new Map<string, InterfaceEntry>();
  for (const session of sessions.data?.sessions ?? []) {
    const entry = byInterface.get(session.interface_id) ?? { id: session.interface_id, name: session.name, logo_url: session.logo_url, sessions: 0, apps: [] };
    entry.sessions++;
    for (const app of session.apps) if (!entry.apps.includes(app)) entry.apps.push(app);
    byInterface.set(session.interface_id, entry);
  }
  if (sessions.error && !sessions.data) {
    return (
      <Alert tone="danger" title="Your Interfaces did not load">
        {describeError(sessions.error)}
        <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void sessions.refetch()}>Try Again</Button></span>
      </Alert>
    );
  }
  if (!byInterface.size) return null;
  return (
    <Section id="apps-interfaces" title="Interfaces" description="They sign you in to apps for you. Removing one signs it out of those apps; your own sign-ins stay.">
      {Array.from(byInterface.values(), entry => <InterfaceRow key={entry.id} entry={entry} />)}
    </Section>
  );
}

function InterfaceRow({ entry }: { entry: InterfaceEntry }) {
  const remove = useRemoveInterfaceAccess();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setError(null);
    try {
      await remove.mutateAsync(entry.id);
      setAsking(false);
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  const detail = `${entry.sessions} ${entry.sessions === 1 ? "session" : "sessions"}${entry.apps.length ? ` · ${entry.apps.join(", ")}` : ""}`;
  return (
    <Row lead={<AppMark app={{ app_id: entry.id, name: entry.name, logo_url: entry.logo_url }} size={32} className={styles.mark} decorative />} title={entry.name} detail={detail}>
      <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>Remove</Button>
      <Dialog open={asking} onOpenChange={open => { if (!open && !remove.isPending) setAsking(false); }}>
        <DialogContent title={`Remove ${entry.name}’s access?`} description={<><strong>{entry.name}</strong> is signed out of the apps it opened for you. Your own sign-ins to them stay.</>}>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setAsking(false)} disabled={remove.isPending}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => void confirm()}>Remove Access</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Row>
  );
}

"use client";

/**
 * "Where you are signed in": every browser, terminal and developer-platform session of this account, this browser
 * first, each with its last activity and a way to sign it out (this browser signs out at once; others ask in place).
 * Part of the Security pillar (/sign-in-methods), beside the ways in.
 */
import { useState } from "react";
import { Code, Monitor, Smartphone, SquareTerminal } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { ConfirmMorph } from "@teamofsilicons/silicon-ui/confirm-morph";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Section } from "@/components/foundation/layout/layout";
import { SESSION_ORIGINS } from "@/lib/api/labels";
import type { SessionInfo } from "@/lib/api/types";
import { formatDate, formatRelative } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { useSignOut } from "@/lib/query/session";
import { AnimatedRows } from "../parts/animated-rows";
import { describeError, useNow } from "../parts/common";
import { focusAfterRemoval, pageMain } from "../parts/focus";
import { useEverySession, useSignOutSession } from "../parts/queries";
import styles from "./sessions.module.css";

/** A readable name for a session: its label, or how it was made. */
export function sessionName(session: SessionInfo): string {
  if (session.kind === "developer") return "Silicon Developer";
  if (session.label) return session.label;
  if (session.kind === "cli") return session.origin === "silicon_login" ? "A Silicon sign-in" : "The silicon-accounts CLI";
  return "A browser";
}

function SessionIcon({ session }: { session: SessionInfo }) {
  const phone = /iphone|android|mobile/i.test(`${session.label ?? ""} ${session.user_agent ?? ""}`);
  const Icon = session.kind === "cli" ? SquareTerminal : session.kind === "developer" ? Code : phone ? Smartphone : Monitor;
  return (
    <span className={styles.icon} aria-hidden="true">
      <Icon size={20} strokeWidth={1.75} />
    </span>
  );
}

export function Sessions() {
  const now = useNow(60_000);
  const sessions = useEverySession();
  const { signOut, pending: signingOut } = useSignOut();
  const revoke = useSignOutSession();

  /**
   * Signs this browser out: the session ends on the server first, then the site starts afresh at the landing page with
   * a full load, so no account page lingers and nothing about the account stays in memory.
   */
  const signOutHere = async () => {
    try {
      await signOut();
    } catch (error) {
      notifyError(error, "Could not sign out");
    }
  };

  const revokeOne = async (session: SessionInfo) => {
    await revoke.mutateAsync(session.id);
    // "Signed out" shows in place, then the row folds away; focus goes to the first session left (this browser's).
    window.setTimeout(() => focusAfterRemoval(() => pageMain()?.querySelector('[role="list"][aria-label="Signed-in sessions"]')), 760);
  };

  const ordered = [...(sessions.data?.items ?? [])].sort((a, b) => Number(b.current) - Number(a.current));

  return (
    <Section
      title="Where you are signed in"
      description="Browsers, terminals and the developer platform signed in to Silicon Accounts. Signing one out ends that session at once; apps you signed into keep their own sessions."
    >
      {sessions.error && !sessions.data ? (
        <Alert tone="danger" title="Your sessions did not load">
          {describeError(sessions.error)}
          <span className={styles.alertAction}>
            <Button variant="secondary" size="sm" onClick={() => void sessions.refetch()}>Try again</Button>
          </span>
        </Alert>
      ) : !sessions.data ? (
        <SkeletonBlock width="100%" height="216px" radius="var(--radius-panel)" />
      ) : (
        <div data-sq="surface" className={styles.group}>
          <AnimatedRows items={ordered} keyOf={item => item.id} label="Signed-in sessions">
            {session => (
              <SessionRow
                session={session}
                now={now}
                signingOut={signingOut}
                onSignOutHere={() => void signOutHere()}
                onRevoke={() => revokeOne(session)}
              />
            )}
          </AnimatedRows>
        </div>
      )}
    </Section>
  );
}

function SessionRow({ session, now, signingOut, onSignOutHere, onRevoke }: { session: SessionInfo; now: number; signingOut: boolean; onSignOutHere: () => void; onRevoke: () => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const how = session.kind === "cli" ? SESSION_ORIGINS[session.origin] : session.kind === "developer" ? "developers.teamofsilicons.com" : null;
  const facts = [
    session.current ? "Active now" : session.last_seen_at ? `Active ${formatRelative(session.last_seen_at, now)}` : null,
    `signed in ${formatDate(session.created_at)}`,
    how && session.label ? how : null,
    session.ip ? `IP ${session.ip}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className={styles.row}>
      <div className={styles.main}>
        <SessionIcon session={session} />
        <div className={styles.text}>
          <span className={styles.title}>
            <span className={styles.name}>{sessionName(session)}</span>
            {session.current ? <Badge size="sm" tone="info">This browser</Badge> : null}
          </span>
          <span className={styles.meta}>{facts}</span>
          {error ? <span className={styles.error} role="alert">{error}</span> : null}
        </div>
      </div>
      <div className={styles.action}>
        {session.current ? (
          <Button variant="secondary" size="sm" onClick={onSignOutHere} loading={signingOut}>Sign out</Button>
        ) : (
          <ConfirmMorph
            label="Sign out"
            prompt="Sign it out?"
            confirmLabel="Sign out"
            pendingLabel="Signing out"
            doneLabel="Signed out"
            onConfirm={async () => {
              setError(null);
              try {
                await onRevoke();
              } catch (raw) {
                setError(describeError(raw));
                throw raw;
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

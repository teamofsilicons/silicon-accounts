"use client";

/**
 * /settings: how the site looks, whether this browser shares usage telemetry, every browser and terminal signed in to
 * this account (sign any of them out), signing out here, and deleting the account. A Carbon who is custodian of a
 * Silicon cannot delete their account until every Silicon has another custodian or is deleted, because a Silicon
 * always has exactly one.
 */
import { useState } from "react";
import { ArrowRight, Monitor, Smartphone, SquareTerminal, Trash2 } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { ConfirmMorph } from "@/components/arc/confirm-morph/confirm-morph";
import { HoldToConfirm } from "@/components/arc/hold-to-confirm/hold-to-confirm";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { Switch } from "@/components/arc/switch/switch";
import { ButtonLink } from "@/components/foundation/button-link";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader, Section, SettingsGroup, SettingsRow } from "@/components/foundation/layout/layout";
import { useTheme, type ThemePreference } from "@/components/foundation/theme/use-theme";
import { ApiError } from "@/lib/api/errors";
import { SESSION_ORIGINS } from "@/lib/api/labels";
import type { AccountSummary, SessionInfo } from "@/lib/api/types";
import { formatDate, formatRelative, plural } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { notifyError } from "@/lib/notify";
import { useDeleteAccount } from "@/lib/query/account";
import { useMe, useSignOut, useTelemetryEnabled } from "@/lib/query/session";
import { AnimatedRows } from "../parts/animated-rows";
import { asCarbon, asSilicon, describeError, useNow } from "../parts/common";
import { focusAfterRemoval, pageMain } from "../parts/focus";
import { useEverySession, useEverySilicon, useSetMeView, useSignOutSession } from "../parts/queries";
import styles from "./settings.module.css";

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Device" },
];

/** A readable name for a session: its label, or how it was made. */
function sessionName(session: SessionInfo): string {
  if (session.label) return session.label;
  if (session.kind === "cli") return session.origin === "silicon_login" ? "A Silicon sign-in" : "The accounts CLI";
  return "A browser";
}

function SessionIcon({ session }: { session: SessionInfo }) {
  const phone = /iphone|android|mobile/i.test(`${session.label ?? ""} ${session.user_agent ?? ""}`);
  return (
    <span className={styles.sessionIcon} aria-hidden="true">
      {session.kind === "cli" ? <SquareTerminal size={20} strokeWidth={1.75} /> : phone ? <Smartphone size={20} strokeWidth={1.75} /> : <Monitor size={20} strokeWidth={1.75} />}
    </span>
  );
}

export function Settings() {
  const now = useNow(60_000);
  const me = useMe();
  const sessions = useEverySession();
  const { preference, change } = useTheme();
  const [telemetryEnabled, setTelemetryEnabled] = useTelemetryEnabled();
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
  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);

  return (
    <Page width="narrow">
      <PageHeader title="Settings" description="How this site looks, what this browser shares, where you are signed in, and your account." />

      <Section title="Appearance">
        <SettingsGroup>
          <SettingsRow label="Theme" description="Light, dark, or whatever your device is set to.">
            <SegmentedControl label="Theme" options={THEMES} value={preference} onValueChange={value => change(value as ThemePreference, null)} />
          </SettingsRow>
        </SettingsGroup>
      </Section>

      <Section title="Privacy">
        <SettingsGroup>
          <SettingsRow
            label="Share usage telemetry"
            description={<>Usage events go to Space Station: a request&apos;s route, result and timing, or a step such as a Silicon being created. They never carry your id, email, phone number or tokens, and they show what is slow or broken. Turned off, nothing this browser asks for is recorded: every request it makes, photo loads and sign-in pages included, carries the choice. Work Silicon Accounts does later on its own, such as delivering webhooks, still reports, without personal details. The accounts CLI has its own switch: <code className={styles.code}>accounts config telemetry off</code>.</>}
          >
            {ids => (
              <Switch
                checked={telemetryEnabled}
                onCheckedChange={setTelemetryEnabled}
                aria-labelledby={ids.labelId}
                aria-describedby={ids.descriptionId}
              />
            )}
          </SettingsRow>
        </SettingsGroup>
      </Section>

      <Section title="Where you are signed in" description="Browsers and terminals signed in to Silicon Accounts. Signing one out ends that session at once; apps you signed into keep their own sessions.">
        {sessions.error && !sessions.data ? (
          <Alert tone="danger" title="Your sessions did not load">
            {describeError(sessions.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void sessions.refetch()}>Try again</Button></span>
          </Alert>
        ) : !sessions.data ? (
          <SkeletonBlock width="100%" height="216px" radius="var(--radius-panel)" />
        ) : (
          <div data-sq="surface" className={styles.group}>
            <AnimatedRows items={ordered} keyOf={item => item.id} label="Signed-in sessions">
              {session => <SessionRow session={session} now={now} signingOut={signingOut} onSignOutHere={() => void signOutHere()} onRevoke={() => revokeOne(session)} />}
            </AnimatedRows>
          </div>
        )}
      </Section>

      <Section title="Delete your account">
        {me.error && !me.data ? (
          <Alert tone="danger" title="Your account did not load">
            {describeError(me.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
          </Alert>
        ) : silicon ? (
          <div data-sq="surface" className={styles.danger}>
            <p className={styles.dangerText}>
              A Silicon&apos;s account is deleted by its custodian. Ask {silicon.custodian?.id ?? "your custodian"} to delete {silicon.id ?? "this Silicon"} on their Silicons page or with <code className={styles.code}>accounts silicon delete</code>.
            </p>
          </div>
        ) : carbon ? (
          <DeleteAccount id={carbon.id ?? carbon.uuid} custodianOf={carbon.custodian_of} onDeleted={() => void signOutHere()} />
        ) : (
          <SkeletonBlock width="100%" height="180px" radius="var(--radius-surface)" />
        )}
      </Section>
    </Page>
  );
}

function SessionRow({ session, now, signingOut, onSignOutHere, onRevoke }: { session: SessionInfo; now: number; signingOut: boolean; onSignOutHere: () => void; onRevoke: () => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const how = session.kind === "cli" ? SESSION_ORIGINS[session.origin] : null;
  const facts = [
    session.current ? "Active now" : session.last_seen_at ? `Active ${formatRelative(session.last_seen_at, now)}` : null,
    `signed in ${formatDate(session.created_at)}`,
    how && session.label ? how : null,
    session.ip ? `IP ${session.ip}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <SessionIcon session={session} />
        <div className={styles.rowText}>
          <span className={styles.rowTitle}>
            <span className={styles.name}>{sessionName(session)}</span>
            {session.current ? <Badge size="sm" tone="info">This browser</Badge> : null}
          </span>
          <span className={styles.rowMeta}>{facts}</span>
          {error ? <span className={styles.rowError} role="alert">{error}</span> : null}
        </div>
      </div>
      <div className={styles.rowAction}>
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

function DeleteAccount({ id, custodianOf, onDeleted }: { id: string; custodianOf: number; onDeleted: () => void }) {
  const [phase, setPhase] = useState<"idle" | "pending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<AccountSummary[] | null>(null);
  const silicons = useEverySilicon();
  const remove = useDeleteAccount();
  const view = useSetMeView();
  const listed: AccountSummary[] = (silicons.data?.items ?? []).map(item => ({ uuid: item.uuid, kind: "silicon", id: item.id, display_name: item.display_name, pfp_url: item.pfp_url, status: item.status }));
  const blocking = blockers ?? (custodianOf > 0 ? listed : []);
  const blocked = custodianOf > 0 || (blockers?.length ?? 0) > 0;

  const deleteAccount = async () => {
    setPhase("pending");
    setError(null);
    try {
      await remove.mutateAsync(id);
      setPhase("done");
      window.setTimeout(onDeleted, 900);
    } catch (raw) {
      setPhase("idle");
      const failure = ApiError.from(raw);
      if (failure.code === "custodian_of_silicons" && Array.isArray(failure.details.silicons)) {
        setBlockers(failure.details.silicons as AccountSummary[]);
        void view.refresh();
      }
      setError(describeError(failure));
    }
  };

  return (
    <div data-sq="surface" className={styles.danger}>
      {blocked ? (
        <div className={styles.blocked}>
          <p className={styles.dangerText}>
            You look after {plural(blocking.length || custodianOf, "Silicon")}. Every Silicon always has exactly one custodian, so hand each one to
            another Carbon, or delete it, before you delete your account.
          </p>
          {blocking.length ? (
            <ul className={styles.blockers} role="list">
              {blocking.map(item => (
                <li key={item.uuid} className={styles.blocker}>
                  <Avatar name={item.display_name} src={item.pfp_url} size="sm" />
                  <span className={styles.blockerName}>{item.display_name}</span>
                  <span className="mono">{item.id ?? item.uuid}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <ButtonLink href={paths.silicons} variant="secondary" size="sm" className={styles.blockedLink}>
            Hand over or delete your Silicons
            <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </ButtonLink>
        </div>
      ) : (
        <p className={styles.dangerText}>
          Your account ends for good. Every app you signed into is told and loses access, your sessions and proofs end, your
          emails and phone numbers are freed, and <span className="mono">{id}</span> stays reserved for 10 days before anyone
          can take it. This cannot be undone.
        </p>
      )}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.dangerAction}>
        <HoldToConfirm
          label="Hold to delete your account"
          confirmedLabel={phase === "pending" ? "Deleting" : "Deleted"}
          confirmed={phase !== "idle"}
          duration={2000}
          tone="danger"
          disabled={blocked}
          icon={<Trash2 size={18} strokeWidth={1.75} />}
          onConfirm={() => void deleteAccount()}
        />
        {blocked ? <span className={styles.disabledNote}>Unavailable while you are custodian of a Silicon.</span> : null}
      </div>
    </div>
  );
}

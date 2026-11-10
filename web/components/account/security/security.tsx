"use client";

/**
 * Security (/sign-in-methods), redesigned on Home's rules (Anil, 2026-11-10), in the prototype's order (v7, security):
 *
 *   Checkup       what needs you here: a recovery phone when there is none, a device not used lately (Keep or Sign
 *                 Out). Hidden when nothing does, like Home's Needs you, in the same boxed list.
 *   Silicon keys  each Silicon you look after: when its key was made, and Change (on the Silicon's page).
 *   Your sign-in  Google and Apple (connected with their email, or Connect), Email code and Text code (the emails and
 *                 phone numbers that get a code; Edit opens them in a dialog).
 *   Devices       where you are signed in: this device marked, the others with Sign Out; then "Sign out of all other
 *                 devices".
 *   Activity      the way to every sign-in and change.
 *
 * Every section is one white list with a clear border (no resting shadow), rows 8px high and 12px at the sides with
 * straight dividers, a 28px mark, the title in body over one line in --text-soft, title-case buttons. Sections are
 * 32px apart with their heading 16px above.
 */
import Image from "next/image";
import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { AtSign, ChevronRight, History, KeyRound, Laptop, Phone, SquareTerminal, Code } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { ConfirmMorph } from "@teamofsilicons/silicon-ui/confirm-morph";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { ButtonLink } from "@/components/foundation/button-link";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page } from "@/components/foundation/layout/layout";
import type { CarbonMe, IdentityView, Provider, SessionInfo } from "@/lib/api/types";
import { formatPhone, formatRelative } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useMe, useMeta } from "@/lib/query/session";
import { browserLogo, browserOf } from "../parts/browser";
import { keepSession, readKept, staleSession, subscribeKept } from "../parts/checkup";
import { asCarbon, asSilicon, describeError, spanText, stkRotatedAt, useNow } from "../parts/common";
import { useConnectProvider, useEverySession, useEverySilicon, useSignOutSession, useUnlinkProvider } from "../parts/queries";
import { PageBar } from "../parts/page-bar";
import { SiliconMark } from "../parts/silicon-mark";
import { siliconHref } from "../silicons/silicons";
import { ContactList, LinkResult, PROVIDER_NAMES, ProviderMark } from "../sign-in-methods/sign-in-methods";
import { sessionName } from "./sessions";
import styles from "./security.module.css";

export function Security() {
  const me = useMe();
  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);
  const [editing, setEditing] = useState<"email" | "phone" | null>(null);

  return (
    <div>
      <PageBar title="Security" />
      <Page>
      {me.error && !me.data ? (
        <Alert tone="danger" title="Your security settings did not load">
          {describeError(me.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try Again</Button></span>
        </Alert>
      ) : silicon ? (
        <EmptyState
          icon={<KeyRound width={24} height={24} strokeWidth={1.5} />}
          title="Silicons sign in with an STK"
          description={`${silicon.id ?? "This Silicon"} signs in with its si:id and STK, not with emails or phone numbers. Its custodian can rotate the STK.`}
        />
      ) : carbon ? (
        <>
          <LinkResult />
          <Checkup carbon={carbon} onAddPhone={() => setEditing("phone")} />
          <SiliconKeys />
          <YourSignIn carbon={carbon} onEdit={setEditing} />
          <Devices />
          <ActivityRow />
          <Dialog open={!!editing} onOpenChange={open => { if (!open) setEditing(null); }}>
            {editing ? (
              <DialogContent
                title={editing === "email" ? "Email code" : "Text code"}
                description={editing === "email"
                  ? "A code sent to any of these emails signs you in. Apps that can see your email get the primary one."
                  : "A code texted to any of these numbers signs you in. Apps that can see your phone number get the primary one."}
              >
                <ContactList channel={editing} carbon={carbon} />
              </DialogContent>
            ) : null}
          </Dialog>
        </>
      ) : (
        <div className={styles.skeleton} aria-busy="true" aria-label="Loading your security settings">
          {[0, 1, 2].map(index => <SkeletonBlock key={index} width="100%" height={index === 1 ? "176px" : "104px"} radius="var(--radius-container)" index={index} />)}
        </div>
      )}
      </Page>
    </div>
  );
}

/* Shared: a section and its boxed list ------------------------------------------------------------------------------ */

function Section({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.head}>
        <h2 id={id} className={styles.title}>{title}</h2>
        {count ? <Badge size="sm" tone="neutral">{count}</Badge> : null}
      </div>
      <ul data-sq="surface" className={styles.rows}>{children}</ul>
    </section>
  );
}

function Row({ lead, title, detail, error, wide, children }: { lead: ReactNode; title: ReactNode; detail?: ReactNode; error?: string | null; wide?: boolean; children?: ReactNode }) {
  return (
    <li className={styles.row} data-wide={wide ? "" : undefined}>
      {lead}
      <span className={styles.text}>
        <span className={styles.rowTitle}>{title}</span>
        {detail ? <span className={styles.rowDetail}>{detail}</span> : null}
        {error ? <span className={styles.rowError} role="alert">{error}</span> : null}
      </span>
      {children ? <span className={styles.actions}>{children}</span> : null}
    </li>
  );
}

const Tile = ({ children }: { children: ReactNode }) => <span data-sq="surface" className={styles.icon} aria-hidden="true">{children}</span>;

/* Checkup ------------------------------------------------------------------------------------------------------------ */

function Checkup({ carbon, onAddPhone }: { carbon: CarbonMe; onAddPhone: () => void }) {
  const sessions = useEverySession();
  const signOut = useSignOutSession();
  const now = useNow(30_000);
  const kept = useSyncExternalStore(subscribeKept, readKept, () => "");
  const stale = staleSession(sessions.data?.items, now, kept);
  const noPhone = carbon.phones.length === 0;
  const count = Number(noPhone) + Number(!!stale);
  if (!count) return null;
  return (
    <Section id="security-checkup" title="Checkup" count={count}>
      {noPhone ? (
        <Row lead={<Tile><Phone size={16} strokeWidth={2} /></Tile>} title="Add a recovery phone" detail="In case you lose your email">
          <Button variant="secondary" size="sm" onClick={onAddPhone}>Add</Button>
        </Row>
      ) : null}
      {stale ? (
        <Row lead={<DeviceIcon session={stale} />} title={`Still using ${sessionName(stale)}?`} detail={`Last active ${spanText(now - Date.parse(stale.last_seen_at ?? stale.created_at))} ago`} wide>
          <span className={styles.keep}><Button variant="soft" size="sm" onClick={() => keepSession(stale.id)}>Keep</Button></span>
          <Button variant="secondary" size="sm" loading={signOut.isPending} onClick={() => void signOut.mutateAsync(stale.id).catch(() => undefined)}>Sign Out</Button>
        </Row>
      ) : null}
    </Section>
  );
}

/* Silicon keys ------------------------------------------------------------------------------------------------------- */

function SiliconKeys() {
  const silicons = useEverySilicon();
  const now = useNow(60_000);
  const list = silicons.data?.items ?? [];
  if (!list.length) return null;
  return (
    <Section id="security-keys" title="Silicon keys">
      {list.map(silicon => {
        const made = stkRotatedAt(silicon) ?? silicon.created_at;
        return (
          <Row key={silicon.uuid} lead={<SiliconMark seed={silicon.uuid} size={28} />}
            title={silicon.display_name || silicon.id || "A Silicon"}
            detail={<>Made <span className={styles.strong}>{formatRelative(made, now)}</span></>}>
            <ButtonLink href={siliconHref(silicon)} variant="secondary" size="sm" aria-label={`Change ${silicon.display_name || silicon.id || "this Silicon"}'s key`}>Change</ButtonLink>
          </Row>
        );
      })}
    </Section>
  );
}

/* Your sign-in ------------------------------------------------------------------------------------------------------- */

function YourSignIn({ carbon, onEdit }: { carbon: CarbonMe; onEdit: (channel: "email" | "phone") => void }) {
  const meta = useMeta();
  const connect = useConnectProvider();
  const [connecting, setConnecting] = useState<Provider | null>(null);
  const [error, setError] = useState<{ provider: Provider; text: string } | null>(null);

  /** The provider's sign-in page comes next (a full navigation); it sends the browser back here with the outcome. */
  const start = async (provider: Provider) => {
    setError(null);
    setConnecting(provider);
    try {
      const connection = await connect.mutateAsync({ provider, returnTo: paths.signInMethods });
      window.location.assign(connection.authorize_url);
    } catch (raw) {
      setError({ provider, text: describeError(raw) });
      setConnecting(null);
    }
  };

  const emails = carbon.emails.map(item => item.email);
  const phones = carbon.phones.map(item => formatPhone(item.phone));

  return (
    <Section id="security-sign-in" title="Your sign-in">
      {(["google", "apple"] as const).map(provider => {
        const linked = carbon.identities.filter(item => item.provider === provider);
        if (linked.length) return linked.map(identity => <IdentityRow key={`${provider}:${identity.subject}`} identity={identity} />);
        const offered = !!meta.data?.providers[provider];
        return (
          <Row key={provider} lead={<span className={styles.provider}><ProviderMark provider={provider} /></span>} title={PROVIDER_NAMES[provider]}
            detail={meta.error && !meta.data ? "Can't be connected right now" : "Not connected"} error={error?.provider === provider ? error.text : null}>
            {offered ? (
              <Button variant="secondary" size="sm" onClick={() => void start(provider)} loading={connecting === provider} disabled={connecting !== null && connecting !== provider}>Connect</Button>
            ) : null}
          </Row>
        );
      })}
      <Row lead={<Tile><AtSign size={16} strokeWidth={2} /></Tile>} title="Email code" detail={emails.length ? emails.join(", ") : "Not set up"}>
        <Button variant="secondary" size="sm" onClick={() => onEdit("email")}>{emails.length ? "Edit" : "Add"}</Button>
      </Row>
      <Row lead={<Tile><Phone size={16} strokeWidth={2} /></Tile>} title="Text code" detail={phones.length ? phones.join(", ") : "Not set up"}>
        <Button variant="secondary" size="sm" onClick={() => onEdit("phone")}>{phones.length ? "Edit" : "Add"}</Button>
      </Row>
    </Section>
  );
}

function IdentityRow({ identity }: { identity: IdentityView }) {
  const unlink = useUnlinkProvider();
  const [error, setError] = useState<string | null>(null);
  const name = PROVIDER_NAMES[identity.provider];
  return (
    <Row lead={<span className={styles.provider}><ProviderMark provider={identity.provider} /></span>} title={name} detail={identity.email ?? "Connected"} error={error}>
      <ConfirmMorph
        label="Unlink"
        prompt={`Unlink ${name}?`}
        confirmLabel="Unlink"
        pendingLabel="Unlinking"
        doneLabel="Unlinked"
        onConfirm={async () => {
          setError(null);
          try {
            await unlink.mutateAsync({ provider: identity.provider, subject: identity.subject });
          } catch (raw) {
            setError(describeError(raw));
            throw raw;
          }
        }}
      />
    </Row>
  );
}

/* Devices ------------------------------------------------------------------------------------------------------------ */

function Devices() {
  const sessions = useEverySession();
  const revoke = useSignOutSession();
  const now = useNow(60_000);
  const [signingOutOthers, setSigningOutOthers] = useState(false);
  const [othersError, setOthersError] = useState<string | null>(null);

  if (sessions.error && !sessions.data) {
    return (
      <section className={styles.section} aria-labelledby="security-devices">
        <div className={styles.head}><h2 id="security-devices" className={styles.title}>Devices</h2></div>
        <Alert tone="danger" title="Your devices did not load">
          {describeError(sessions.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void sessions.refetch()}>Try Again</Button></span>
        </Alert>
      </section>
    );
  }
  if (!sessions.data) return <SkeletonBlock width="100%" height="160px" radius="var(--radius-container)" />;

  const ordered = [...sessions.data.items].sort((a, b) => Number(b.current) - Number(a.current));
  const others = ordered.filter(item => !item.current);

  const signOutOthers = async () => {
    setOthersError(null);
    setSigningOutOthers(true);
    try {
      // No one call signs out every other session; each one ends on its own.
      for (const session of others) await revoke.mutateAsync(session.id);
    } catch (raw) {
      setOthersError(describeError(raw));
    } finally {
      setSigningOutOthers(false);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="security-devices">
      <div className={styles.head}><h2 id="security-devices" className={styles.title}>Devices</h2></div>
      <ul data-sq="surface" className={styles.rows} aria-label="Signed-in sessions">
        {ordered.map(session => <DeviceRow key={session.id} session={session} now={now} />)}
        {others.length ? (
          <li className={styles.foot}>
            <Button variant="danger" size="sm" onClick={() => void signOutOthers()} loading={signingOutOthers}>Sign Out of All Other Devices</Button>
            {othersError ? <span className={styles.rowError} role="alert">{othersError}</span> : null}
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function DeviceRow({ session, now }: { session: SessionInfo; now: number }) {
  const revoke = useSignOutSession();
  const [error, setError] = useState<string | null>(null);
  const seen = session.current ? "Active now" : session.last_seen_at ? <>Active <span className={styles.strong}>{formatRelative(session.last_seen_at, now)}</span></> : "Not used yet";
  return (
    <Row lead={<DeviceIcon session={session} />} title={sessionName(session)} detail={<>{seen}{session.kind === "developer" ? " · developers.teamofsilicons.com" : session.ip ? ` · ${session.ip}` : ""}</>} error={error}>
      {session.current ? <Badge size="sm" tone="success">This Device</Badge> : (
        <Button variant="secondary" size="sm" loading={revoke.isPending} onClick={() => { setError(null); revoke.mutateAsync(session.id).catch(raw => setError(describeError(raw))); }}>Sign Out</Button>
      )}
    </Row>
  );
}

/** A device's mark: its browser's own logo, bare, when it is a known browser; else a terminal, code or laptop tile. */
function DeviceIcon({ session }: { session: SessionInfo }) {
  const browser = session.kind === "browser" ? browserOf(session) : null;
  if (browser) return <span className={styles.provider} aria-hidden="true"><Image className={styles.logo} src={browserLogo(browser)} alt="" width={24} height={24} unoptimized /></span>;
  const Icon = session.kind === "cli" ? SquareTerminal : session.kind === "developer" ? Code : Laptop;
  return <Tile><Icon size={16} strokeWidth={2} /></Tile>;
}

/* Activity ----------------------------------------------------------------------------------------------------------- */

function ActivityRow() {
  return (
    <section className={styles.section} aria-label="Activity">
      <Link href={paths.activity} data-sq="surface" className={styles.linkRow}>
        <Tile><History size={16} strokeWidth={2} /></Tile>
        <span className={styles.text}>
          <span className={styles.rowTitle}>Activity</span>
          <span className={styles.rowDetail}>Every sign-in and change, by day</span>
        </span>
        <ChevronRight className={styles.chevron} size={16} strokeWidth={2} aria-hidden="true" />
      </Link>
    </section>
  );
}

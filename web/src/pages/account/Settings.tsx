/**
 * /settings: how the site looks, whether this browser shares usage telemetry, every browser and terminal signed in to
 * this account (sign any of them out), and deleting the account. A Carbon who is custodian of a Silicon cannot delete
 * their account until every Silicon has another custodian or is deleted, because a Silicon always has exactly one.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { ArrowRight, Monitor, Smartphone, SquareTerminal, Trash2 } from "lucide-solid";
import { api, ApiError, collectPages, type AccountSummary, type ManagedSilicon, type SessionInfo } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { Avatar } from "../../arc/avatar/avatar";
import { Badge } from "../../arc/badge/badge";
import { Button, LinkButton } from "../../arc/button/button";
import { ConfirmMorph } from "../../arc/confirm-morph/confirm-morph";
import { HoldToConfirm } from "../../arc/hold-to-confirm/hold-to-confirm";
import { SegmentedControl } from "../../arc/segmented-control/segmented-control";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { Switch as Toggle } from "../../arc/switch/switch";
import { useSquircle } from "../../arc/lib/squircle";
import { Page, PageHeader, Section, SettingsGroup, SettingsRow } from "../../app/layout/layout";
import { paths } from "../../app/navigation";
import { notifyError } from "../../app/notify";
import { finishSignOut, refreshMe, signOut } from "../../app/session";
import { changeTheme } from "../../theme/theme-transition";
import { themePreference, type ThemePreference } from "../../theme/theme";
import { formatDate, formatRelative, plural } from "../../lib/format";
import { AnimatedRows } from "./parts/AnimatedRows";
import { asCarbon, asSilicon, createLoader, createNow, currentMe, describeError, meError, reportFailure } from "./parts/common";
import { focusAfterRemoval, pageMain } from "./parts/focus";
import { setTelemetryEnabled, telemetryEnabled } from "./parts/telemetry";
import styles from "./settings.module.css";

type Session = SessionInfo & { origin?: string | null; expires_at?: string | null };

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Device" },
];

/** A readable name for a session: its label, or what the user agent says. */
function sessionName(session: Session): string {
  if (session.label) return session.label;
  if (session.kind === "cli") return session.origin === "silicon_login" ? "A Silicon sign-in" : "The accounts CLI";
  return "A browser";
}

function SessionIcon(props: { session: Session }) {
  const phone = () => /iphone|android|mobile/i.test(`${props.session.label ?? ""} ${props.session.user_agent ?? ""}`);
  return (
    <span class={styles.sessionIcon} aria-hidden="true">
      <Switch fallback={<Monitor size={20} stroke-width={1.75} />}>
        <Match when={props.session.kind === "cli"}><SquareTerminal size={20} stroke-width={1.75} /></Match>
        <Match when={phone()}><Smartphone size={20} stroke-width={1.75} /></Match>
      </Switch>
    </span>
  );
}

export default function Settings() {
  const now = createNow(60_000);
  const sessions = createLoader(() => api.me.sessions.list() as Promise<Session[]>);
  const [signingOut, setSigningOut] = createSignal(false);

  /**
   * Signs this browser out, then starts the site afresh at the landing page. The session ends first and the page is
   * replaced afterwards (rather than navigating inside the app while the session changes), so no screen of the signed-in
   * site lingers and nothing about the account stays in memory.
   */
  const signOutHere = async () => {
    setSigningOut(true);
    try {
      await signOut();
      location.replace(paths.home);
    } catch (error) {
      finishSignOut();
      setSigningOut(false);
      notifyError(error, "Could not sign out");
    }
  };

  const revoke = async (session: Session) => {
    await api.me.sessions.revoke(session.id);
    window.setTimeout(() => {
      sessions.set(list => (list ?? []).filter(item => item.id !== session.id));
      // The row folds away with keyboard focus in it: the first session left (this browser's, at least) takes it.
      focusAfterRemoval(() => pageMain()?.querySelector('[role="list"][aria-label="Signed-in sessions"]'));
    }, 700);
  };

  const ordered = createMemo(() => [...(sessions.data() ?? [])].sort((a, b) => Number(b.current) - Number(a.current)));

  return (
    <Page width="narrow">
      <PageHeader title="Settings" description="How this site looks, what this browser shares, where you are signed in, and your account." />

      <Section title="Appearance">
        <SettingsGroup>
          <SettingsRow label="Theme" description="Light, dark, or whatever your device is set to.">
            <SegmentedControl label="Theme" options={THEMES} value={themePreference()} onValueChange={value => changeTheme(value, null)} size="sm" />
          </SettingsRow>
        </SettingsGroup>
      </Section>

      <Section title="Privacy">
        <SettingsGroup>
          <SettingsRow
            label="Share usage telemetry"
            description={<>Usage events go to Space Station: a request's route, result and timing, or a step such as a Silicon being created. They never carry your id, email, phone number or tokens, and they show what is slow or broken. Turned off, the requests your account pages make from this browser are no longer recorded; photo loads, the first requests as a page opens, the developer and sign-in pages, and events about changes to accounts still are, without personal details. The accounts CLI has its own switch: <code class={styles.code}>accounts config telemetry off</code>.</>}
          >
            {ids => <Toggle checked={telemetryEnabled()} onChange={setTelemetryEnabled} aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} />}
          </SettingsRow>
        </SettingsGroup>
      </Section>

      <Section title="Where you are signed in" description="Browsers and terminals signed in to Silicon Accounts. Signing one out ends that session at once; apps you signed into keep their own sessions.">
        <Switch>
          <Match when={sessions.error() && !sessions.data()}>
            <Alert tone="danger" title="Your sessions did not load" action={<Button variant="secondary" onClick={() => void sessions.reload()}>Try again</Button>}>{describeError(sessions.error())}</Alert>
          </Match>
          <Match when={sessions.loading()}>
            <SkeletonBlock width="100%" height="216px" radius="var(--radius-panel)" />
          </Match>
          <Match when={sessions.data()}>
            <div ref={el => useSquircle(el)} class={styles.group}>
              <AnimatedRows items={ordered()} keyOf={item => item.id} label="Signed-in sessions">
                {session => (
                  <SessionRow
                    session={session()}
                    now={now()}
                    signingOut={signingOut()}
                    onSignOutHere={() => void signOutHere()}
                    onRevoke={() => revoke(session())}
                  />
                )}
              </AnimatedRows>
            </div>
          </Match>
        </Switch>
      </Section>

      <Section title="Delete your account">
        <Switch fallback={<SkeletonBlock width="100%" height="180px" radius="var(--radius-surface)" />}>
          <Match when={meError()}>
            {error => <Alert tone="danger" title="Your account did not load" action={<Button variant="secondary" onClick={() => refreshMe()}>Try again</Button>}>{describeError(error())}</Alert>}
          </Match>
          <Match when={asSilicon(currentMe())}>
            {silicon => (
              <div ref={el => useSquircle(el)} class={styles.danger}>
                <p class={styles.dangerText}>
                  A Silicon's account is deleted by its custodian. Ask {silicon().custodian?.id ?? "your custodian"} to delete {silicon().id ?? "this Silicon"} on their Silicons page or with accounts silicon delete.
                </p>
              </div>
            )}
          </Match>
          <Match when={asCarbon(currentMe())}>
            {carbon => <DeleteAccount id={carbon().id ?? carbon().uuid} custodianOf={carbon().custodian_of} onDeleted={() => void signOutHere()} />}
          </Match>
        </Switch>
      </Section>
    </Page>
  );
}

function SessionRow(props: { session: Session; now: number; signingOut: boolean; onSignOutHere: () => void; onRevoke: () => Promise<unknown> }) {
  const [error, setError] = createSignal<string | null>(null);
  const facts = () => [
    props.session.current ? "Active now" : props.session.last_seen_at ? `Active ${formatRelative(props.session.last_seen_at, props.now)}` : null,
    `signed in ${formatDate(props.session.created_at)}`,
    props.session.ip ? `IP ${props.session.ip}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div class={styles.row}>
      <div class={styles.rowMain}>
        <SessionIcon session={props.session} />
        <div class={styles.rowText}>
          <span class={styles.rowTitle}>
            <span class={styles.name}>{sessionName(props.session)}</span>
            <Show when={props.session.current}><Badge size="sm" tone="info">This browser</Badge></Show>
          </span>
          <span class={styles.rowMeta}>{facts()}</span>
          <Show when={error()}><span class={styles.rowError} role="alert">{error()}</span></Show>
        </div>
      </div>
      <div class={styles.rowAction}>
        <Show
          when={props.session.current}
          fallback={<ConfirmMorph label="Sign out" prompt="Sign it out?" confirmLabel="Sign out" pendingLabel="Signing out" doneLabel="Signed out" onConfirm={() => { setError(null); return props.onRevoke(); }} onError={raw => setError(reportFailure(raw, "That session is still signed in"))} />}
        >
          <Button variant="secondary" size="sm" onClick={() => props.onSignOutHere()} loading={props.signingOut}>Sign out</Button>
        </Show>
      </div>
    </div>
  );
}

function DeleteAccount(props: { id: string; custodianOf: number; onDeleted: () => void }) {
  const [phase, setPhase] = createSignal<"idle" | "pending" | "done">("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [blockers, setBlockers] = createSignal<AccountSummary[] | null>(null);
  const silicons = createLoader(() => collectPages<ManagedSilicon>(query => api.me.silicons.list(query), 5), { immediate: false });
  createEffect(on(() => props.custodianOf, count => { if (count > 0) void silicons.reload(); }));
  const blocking = createMemo<AccountSummary[]>(() => blockers() ?? (silicons.data() ?? []).map(item => ({ uuid: item.uuid, kind: "silicon", id: item.id, display_name: item.display_name, pfp_url: item.pfp_url, status: item.status })));
  const blocked = () => props.custodianOf > 0 || (blockers()?.length ?? 0) > 0;

  const remove = async () => {
    setPhase("pending");
    setError(null);
    try {
      await api.me.deleteAccount(props.id);
      setPhase("done");
      window.setTimeout(() => props.onDeleted(), 900);
    } catch (raw) {
      setPhase("idle");
      const failure = ApiError.from(raw);
      if (failure.code === "custodian_of_silicons" && Array.isArray(failure.details.silicons)) {
        setBlockers(failure.details.silicons as AccountSummary[]);
        refreshMe();
      }
      setError(reportFailure(failure, "Your account was not deleted"));
    }
  };

  return (
    <div ref={el => useSquircle(el)} class={styles.danger}>
      <Show
        when={blocked()}
        fallback={
          <p class={styles.dangerText}>
            Your account ends for good. Every app you signed into is told and loses access, your sessions and proofs end, your
            emails and phone numbers are freed, and <span class="mono">{props.id}</span> stays reserved for 10 days before
            anyone can take it. This cannot be undone.
          </p>
        }
      >
        <div class={styles.blocked}>
          <p class={styles.dangerText}>
            You look after {plural(blocking().length || props.custodianOf, "Silicon")}. Every Silicon always has exactly one custodian, so
            hand each one to another Carbon, or delete it, before you delete your account.
          </p>
          <Show when={blocking().length}>
            <ul class={styles.blockers} role="list">
              <For each={blocking()}>
                {silicon => (
                  <li class={styles.blocker}>
                    <Avatar name={silicon.display_name} src={silicon.pfp_url} size="sm" kind="silicon" />
                    <span class={styles.blockerName}>{silicon.display_name}</span>
                    <span class="mono">{silicon.id ?? silicon.uuid}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <LinkButton href={paths.silicons} variant="secondary" size="sm">Hand over or delete your Silicons<ArrowRight size={16} stroke-width={1.75} aria-hidden="true" /></LinkButton>
        </div>
      </Show>
      <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
      <div class={styles.dangerAction}>
        <HoldToConfirm
          label="Hold to delete your account"
          confirmedLabel={phase() === "pending" ? "Deleting" : "Deleted"}
          confirmed={phase() !== "idle"}
          duration={2000}
          disabled={blocked()}
          icon={<Trash2 size={18} stroke-width={1.75} />}
          onConfirm={() => void remove()}
        />
        <Show when={blocked()}>
          <span class={styles.disabledNote}>Unavailable while you are custodian of a Silicon.</span>
        </Show>
      </div>
    </div>
  );
}

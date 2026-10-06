/**
 * /apps: every app this account has signed into, what each one can see (with the values it gets), and when it last
 * saw you. Removing an app's access signs you out of it everywhere, revokes the proofs it holds about you and tells
 * the app; you can sign in to it again later. Apps that imported you before you ever signed in are listed too, since
 * they hold data about you.
 */
import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js";
import { useLocation } from "@solidjs/router";
import { ArrowUpRight, LayoutGrid } from "lucide-solid";
import { api, collectPages, type Me, type MyApp, type Scope } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { Badge } from "../../arc/badge/badge";
import { Button } from "../../arc/button/button";
import { ConfirmMorph } from "../../arc/confirm-morph/confirm-morph";
import { CopyButton } from "../../arc/copy-button/copy-button";
import { EmptyState } from "../../arc/empty-state/empty-state";
import { SegmentedControl } from "../../arc/segmented-control/segmented-control";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { animate, prefersReducedMotion } from "../../arc/lib/motion";
import { useSquircle } from "../../arc/lib/squircle";
import { Page, PageHeader } from "../../app/layout/layout";
import { paths } from "../../app/navigation";
import { formatDate, formatPhone, formatRelative, plural } from "../../lib/format";
import { timezoneLabel } from "../../lib/timezones";
import { AppMark } from "./parts/AppMark";
import { AnimatedRows } from "./parts/AnimatedRows";
import { asCarbon, createLoader, createNow, currentMe, describeError, reportFailure } from "./parts/common";
import { focusAfterRemoval, pageMain, pressedViewOption } from "./parts/focus";
import styles from "./apps.module.css";
import "./parts/telemetry";

type View = "access" | "removed";
type Membership = MyApp & { access_removed_at?: string | null; source?: string };

/** What a scope shows about this account: a label and, where it is a value, the value the app gets. */
function shared(scope: Scope, me: Me | undefined): { label: string; value: string | null } | null {
  const carbon = asCarbon(me);
  switch (scope) {
    case "profile":
      return { label: "Name, id and photo", value: me ? `${me.display_name} · ${me.id ?? me.uuid}` : null };
    case "email":
      return { label: "Email", value: carbon?.emails.find(item => item.is_primary)?.email ?? null };
    case "phone":
      return { label: "Phone", value: carbon?.phones.find(item => item.is_primary) ? formatPhone(carbon.phones.find(item => item.is_primary)!.phone) : null };
    case "dob":
      return { label: "Date of birth", value: me ? formatDate(me.dob) : null };
    case "timezone":
      return { label: "Timezone", value: me ? timezoneLabel(me.timezone) : null };
    default:
      return null;
  }
}

const host = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

export default function Apps() {
  const location = useLocation();
  const apps = createLoader(() => collectPages<Membership>(query => api.me.apps.list(query) as Promise<{ items: Membership[]; next_cursor: string | null }>, 10));
  const meta = createLoader(() => api.meta.get());
  const [view, setView] = createSignal<View>("access");
  const now = createNow(30_000);
  const withAccess = createMemo(() => (apps.data() ?? []).filter(item => item.status !== "access_removed"));
  const removed = createMemo(() => (apps.data() ?? []).filter(item => item.status === "access_removed"));
  const shown = () => (view() === "access" ? withAccess() : removed());

  const removeAccess = async (appId: string) => {
    await api.me.apps.removeAccess(appId);
    // "Access removed" shows in place first, then the card moves to the removed list.
    window.setTimeout(() => {
      apps.set(list => (list ?? []).map(item => (item.app.app_id === appId ? { ...item, status: "access_removed", active_sessions: 0, access_removed_at: new Date().toISOString() } : item)));
      // The card left this view with keyboard focus in it: the next app's card takes it, else the view switch.
      focusAfterRemoval(() => pageMain()?.querySelector('[role="list"][aria-label="Apps with access"]'), pressedViewOption);
    }, 900);
  };

  // A stamp on the identity card links here as /apps#app-<id>: bring that card into view and mark it briefly.
  onMount(() => {
    const target = location.hash.replace(/^#/, "");
    if (!target) return;
    const tryFocus = (attempt: number) => {
      const card = document.getElementById(target);
      if (!card) {
        if (attempt < 20) window.setTimeout(() => tryFocus(attempt + 1), 100);
        return;
      }
      card.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      card.setAttribute("data-highlight", "");
      if (!prefersReducedMotion()) animate(card, { scale: [1, 1.012, 1] }, { duration: 0.6, delay: 0.25 });
      window.setTimeout(() => card.removeAttribute("data-highlight"), 2200);
    };
    tryFocus(0);
  });

  return (
    <Page width="default">
      <PageHeader
        title="Apps you have signed into"
        description="What each app can see about you and when it last saw you. Removing an app's access signs you out of it everywhere and ends the proofs it holds about you."
      />
      <Switch>
        <Match when={apps.error() && !apps.data()}>
          <Alert tone="danger" title="Your apps did not load" action={<Button variant="secondary" onClick={() => void apps.reload()}>Try again</Button>}>{describeError(apps.error())}</Alert>
        </Match>
        <Match when={apps.loading()}>
          <AppsSkeleton />
        </Match>
        <Match when={apps.data()}>
          <div class={styles.toolbar}>
            <SegmentedControl
              label="Which apps"
              value={view()}
              onValueChange={setView}
              options={[
                { value: "access", label: `With access (${withAccess().length})` },
                { value: "removed", label: `Access removed (${removed().length})` },
              ]}
            />
          </div>
          <Show
            when={shown().length}
            fallback={
              <div ref={el => useSquircle(el)} class={styles.empty}>
                <EmptyState
                  icon={<LayoutGrid width={24} height={24} stroke-width={1.5} />}
                  title={view() === "access" ? "No apps yet" : "No removed apps"}
                  description={view() === "access" ? "When you sign in to an app with Silicon Accounts, it shows up here with what it can see." : "Apps whose access you remove show up here. You can sign in to them again whenever you like."}
                />
              </div>
            }
          >
            <AnimatedRows items={shown()} keyOf={item => item.membership_id} layout="grid" class={styles.grid} label={view() === "access" ? "Apps with access" : "Apps whose access you removed"}>
              {item => <AppCard item={item()} now={now()} onRemove={() => removeAccess(item().app.app_id)} />}
            </AnimatedRows>
          </Show>
          <p class={styles.footnote}>
            Making an app? Apps are created in{" "}
            <a href={meta.data()?.silicon_apps_url ?? "https://apps.teamofsilicons.com"} target="_blank" rel="noopener">Silicon Apps<ArrowUpRight size={14} stroke-width={1.75} aria-hidden="true" /></a>
            , and the ones you own are under <a href={paths.developer}>Developer</a>.
          </p>
        </Match>
      </Switch>
    </Page>
  );
}

function AppCard(props: { item: Membership; now: number; onRemove: () => Promise<unknown> }) {
  const [error, setError] = createSignal<string | null>(null);
  const app = () => props.item.app;
  const rows = createMemo(() => {
    const scopes = props.item.granted_scopes.includes("profile") ? props.item.granted_scopes : (["profile", ...props.item.granted_scopes] as Scope[]);
    return scopes.map(scope => shared(scope, currentMe())).filter((row): row is { label: string; value: string | null } => !!row);
  });
  const removed = () => props.item.status === "access_removed";
  const imported = () => props.item.status === "imported";
  return (
    <article id={`app-${app().app_id}`} ref={el => useSquircle(el)} class={styles.card} data-status={props.item.status}>
      <header class={styles.cardHead}>
        <AppMark app={app()} size={44} />
        <div class={styles.cardTitle}>
          <h2 class={styles.name}>{app().name}</h2>
          <Show when={host(app().homepage_url)} fallback={<span class={styles.sub}>{app().app_id}</span>}>
            {domain => <a class={styles.sub} href={app().homepage_url ?? undefined} target="_blank" rel="noopener">{domain()}<ArrowUpRight size={12} stroke-width={1.75} aria-hidden="true" /></a>}
          </Show>
        </div>
        <Switch>
          <Match when={imported()}><Badge size="sm" tone="warning">Imported you</Badge></Match>
          <Match when={removed()}><Badge size="sm">Access removed</Badge></Match>
          <Match when={props.item.active_sessions > 0}><Badge size="sm" tone="success" dot>Signed in</Badge></Match>
        </Switch>
      </header>

      <Switch>
        <Match when={removed()}>
          <p class={styles.lead}>It can no longer see anything about you{props.item.access_removed_at ? `, since ${formatDate(props.item.access_removed_at)}` : ""}. Sign in to it again to give it access.</p>
        </Match>
        <Match when={imported()}>
          <p class={styles.lead}>{app().name} imported your account, so it holds what it imported. It gets nothing more until you sign in to it.</p>
        </Match>
        <Match when={true}>
          <div class={styles.shares}>
            <span class={styles.sharesLabel}>It can see</span>
            <ul class={styles.chips} role="list">
              <For each={rows()}>
                {row => (
                  <li ref={el => useSquircle(el)} class={styles.chip}>
                    <span class={styles.chipLabel}>{row.label}</span>
                    <Show when={row.value}><span class={styles.chipValue}>{row.value}</span></Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Match>
      </Switch>

      <dl class={styles.facts}>
        <div>
          <dt>Last signed in</dt>
          <dd>{props.item.last_signed_in_at ? formatRelative(props.item.last_signed_in_at, props.now) : "Never"}</dd>
        </div>
        <div>
          <dt>First signed in</dt>
          <dd>{props.item.first_signed_in_at ? formatDate(props.item.first_signed_in_at) : "Never"}</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>{props.item.active_sessions ? plural(props.item.active_sessions, "active session") : "None active"}</dd>
        </div>
      </dl>

      <footer class={styles.cardFoot}>
        <span class={styles.membership}>
          <span class={styles.membershipLabel}>Membership</span>
          <span class="mono">{props.item.membership_id}</span>
          <CopyButton value={props.item.membership_id} label={`Copy ${app().name}'s membership id`} iconOnly variant="plain" size="xs" />
        </span>
        <Show when={!removed()}>
          <ConfirmMorph
            label="Remove access"
            prompt={`Remove ${app().name}'s access?`}
            confirmLabel="Remove access"
            pendingLabel="Removing"
            doneLabel="Access removed"
            onConfirm={() => { setError(null); return props.onRemove(); }}
            onError={raw => setError(reportFailure(raw, `${app().name} still has access`))}
          />
        </Show>
      </footer>
      <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
    </article>
  );
}

function AppsSkeleton() {
  return (
    <div class={styles.skeleton} aria-busy="true" aria-label="Loading your apps">
      <SkeletonBlock width="300px" height="40px" radius="14px" />
      <div class={styles.grid}>
        <For each={[0, 1, 2, 3]}>{index => <SkeletonBlock width="100%" height="268px" radius="var(--radius-surface)" index={index + 1} />}</For>
      </div>
    </div>
  );
}

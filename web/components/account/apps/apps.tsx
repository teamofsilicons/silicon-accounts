"use client";

/**
 * /apps: every app this account has signed into (the list is read to its end), what each one can see (with the values
 * it gets), and when it last saw you. Removing an app's access signs you out of it everywhere, revokes the proofs it holds about you and tells the
 * app; you can sign in to it again later. Apps that imported you before you ever signed in are listed too, since they
 * hold data about you.
 */
import { useEffect, useState } from "react";
import { animate } from "motion/react";
import { ArrowUpRight, LayoutGrid } from "lucide-react";
import Link from "next/link";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { ConfirmMorph } from "@/components/arc/confirm-morph/confirm-morph";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import type { Me, MyApp, Scope } from "@/lib/api/types";
import { formatDate, formatPhone, formatRelative, plural } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useMe, useMeta } from "@/lib/query/session";
import { timezoneLabel } from "@/lib/timezones";
import { AnimatedRows } from "../parts/animated-rows";
import { AppMark } from "../parts/app-mark";
import { asCarbon, describeError, useNow } from "../parts/common";
import { FitPrompt } from "../parts/fit-prompt";
import { focusAfterRemoval, pageMain, pressedViewOption } from "../parts/focus";
import { ListCap } from "../parts/list-cap";
import { useEveryApp, useRemoveAccess } from "../parts/queries";
import styles from "./apps.module.css";

type View = "access" | "removed";

/** What a scope shows about this account: a label and, where it is a value, the value the app gets. */
function shared(scope: Scope, me: Me | undefined): { label: string; value: string | null } | null {
  const carbon = asCarbon(me);
  switch (scope) {
    case "profile":
      return { label: "Name, id and photo", value: me ? `${me.display_name} · ${me.id ?? me.uuid}` : null };
    case "email":
      return { label: "Email", value: carbon?.emails.find(item => item.is_primary)?.email ?? null };
    case "phone": {
      const phone = carbon?.phones.find(item => item.is_primary)?.phone;
      return { label: "Phone", value: phone ? formatPhone(phone) : null };
    }
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

export function Apps() {
  const apps = useEveryApp();
  const meta = useMeta();
  const me = useMe();
  const [view, setView] = useState<View>("access");
  const now = useNow(30_000);
  const remove = useRemoveAccess();
  const items = apps.data?.items ?? [];
  const withAccess = items.filter(item => item.status !== "access_removed");
  const removed = items.filter(item => item.status === "access_removed");
  const shown = view === "access" ? withAccess : removed;

  const removeAccess = async (appId: string) => {
    await remove.mutateAsync(appId);
    // "Access removed" shows in place first, then the card moves to the removed apps; focus goes to the next card,
    // else to the view switch.
    window.setTimeout(() => focusAfterRemoval(() => pageMain()?.querySelector('[role="list"][aria-label="Apps with access"]'), pressedViewOption), 960);
  };

  // A stamp on the identity card links here as /apps#app-<id>: bring that card into view and mark it for a moment.
  const loaded = !!apps.data;
  useEffect(() => {
    if (!loaded) return;
    const target = window.location.hash.replace(/^#/, "");
    if (!target.startsWith("app-")) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(target);
      if (!card) return;
      card.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
      card.setAttribute("data-highlight", "");
      if (!reduced) animate(card, { scale: [1, 1.012, 1] }, { duration: 0.6, delay: 0.25 });
      timer = window.setTimeout(() => card.removeAttribute("data-highlight"), 2200);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [loaded]);

  return (
    <Page width="default">
      <PageHeader
        title="Apps you have signed into"
        description="What each app can see about you and when it last saw you. Removing an app's access signs you out of it everywhere and ends the proofs it holds about you."
      />
      {apps.error && !apps.data ? (
        <Alert tone="danger" title="Your apps did not load">
          {describeError(apps.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void apps.refetch()}>Try again</Button></span>
        </Alert>
      ) : !apps.data ? (
        <AppsSkeleton />
      ) : (
        <>
          <div className={styles.toolbar}>
            <SegmentedControl
              label="Which apps"
              value={view}
              onValueChange={value => setView(value as View)}
              options={[
                { value: "access", label: `With access (${withAccess.length})` },
                { value: "removed", label: `Access removed (${removed.length})` },
              ]}
            />
          </div>
          {shown.length ? (
            <AnimatedRows items={shown} keyOf={item => item.membership_id} layout="grid" className={styles.grid} label={view === "access" ? "Apps with access" : "Apps whose access you removed"}>
              {item => <AppCard item={item} me={me.data} now={now} onRemove={() => removeAccess(item.app.app_id)} />}
            </AnimatedRows>
          ) : (
            <div data-sq="surface" className={styles.empty}>
              <EmptyState
                icon={<LayoutGrid width={24} height={24} strokeWidth={1.5} />}
                title={view === "access" ? "No apps yet" : "No removed apps"}
                description={view === "access" ? "When you sign in to an app with Silicon Accounts, it shows up here with what it can see." : "Apps whose access you remove show up here. You can sign in to them again whenever you like."}
              />
            </div>
          )}
          <ListCap page={apps.data} noun="apps" command="accounts apps list" />
          <p className={styles.footnote}>
            Making an app? Apps are created in{" "}
            <a data-sq="surface" href={meta.data?.silicon_apps_url ?? "https://apps.teamofsilicons.com"} target="_blank" rel="noopener">
              Silicon Apps<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
            </a>
            , and the ones you own are under <Link data-sq="surface" href={paths.developer}>Developer</Link>.
          </p>
        </>
      )}
    </Page>
  );
}

function AppCard({ item, me, now, onRemove }: { item: MyApp; me: Me | undefined; now: number; onRemove: () => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const app = item.app;
  const scopes: Scope[] = item.granted_scopes.includes("profile") ? item.granted_scopes : ["profile", ...item.granted_scopes];
  const rows = scopes.map(scope => shared(scope, me)).filter((row): row is { label: string; value: string | null } => !!row);
  const removed = item.status === "access_removed";
  const imported = item.status === "imported";
  const domain = host(app.homepage_url);
  return (
    <article id={`app-${app.app_id}`} data-sq="surface" className={styles.card} data-status={item.status}>
      <header className={styles.cardHead}>
        <AppMark app={app} size={44} />
        <div className={styles.cardTitle}>
          <h2 className={styles.name}>{app.name}</h2>
          {domain ? (
            <a className={styles.sub} href={app.homepage_url ?? undefined} target="_blank" rel="noopener">
              {domain}
              <ArrowUpRight size={12} strokeWidth={1.75} aria-hidden="true" />
            </a>
          ) : <span className={styles.sub}>{app.app_id}</span>}
        </div>
        {imported ? <Badge size="sm" tone="warning">Imported you</Badge>
          : removed ? <Badge size="sm">Access removed</Badge>
            : item.active_sessions > 0 ? <Badge size="sm" tone="success">Signed in</Badge> : null}
      </header>

      {removed ? (
        <p className={styles.lead}>It can no longer see anything about you{item.access_removed_at ? `, since ${formatDate(item.access_removed_at)}` : ""}. Sign in to it again to give it access.</p>
      ) : imported ? (
        <p className={styles.lead}>{app.name} imported your account, so it holds what it imported. It gets nothing more until you sign in to it.</p>
      ) : (
        <div className={styles.shares}>
          <span className={styles.sharesLabel}>It can see</span>
          <ul className={styles.chips} role="list">
            {rows.map(row => (
              <li key={row.label} data-sq="surface" className={styles.chip}>
                <span className={styles.chipLabel}>{row.label}</span>
                {row.value ? <span className={styles.chipValue} title={row.value}>{row.value}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className={styles.facts}>
        <div>
          <dt>Last signed in</dt>
          <dd>{item.last_signed_in_at ? formatRelative(item.last_signed_in_at, now) : "Never"}</dd>
        </div>
        <div>
          <dt>First signed in</dt>
          <dd>{item.first_signed_in_at ? formatDate(item.first_signed_in_at) : "Never"}</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>{item.active_sessions ? plural(item.active_sessions, "active session") : "None active"}</dd>
        </div>
      </dl>

      <footer className={styles.cardFoot}>
        <span className={styles.membership}>
          <span className={styles.membershipLabel}>Membership</span>
          <span className="mono" title={item.membership_id}>{item.membership_id}</span>
          <CopyButton value={item.membership_id} label={`Copy ${app.name}'s membership id`} iconOnly variant="plain" className={styles.copy} />
        </span>
        {!removed ? (
          <ConfirmMorph
            label="Remove access"
            prompt={<FitPrompt full={`Remove ${app.name}'s access?`} short="Remove its access?" tiny="Remove it?" />}
            confirmLabel="Remove"
            pendingLabel="Removing"
            doneLabel="Access removed"
            onConfirm={async () => {
              setError(null);
              try {
                await onRemove();
              } catch (raw) {
                setError(describeError(raw));
                throw raw;
              }
            }}
          />
        ) : null}
      </footer>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </article>
  );
}

function AppsSkeleton() {
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label="Loading your apps">
      <SkeletonBlock width="300px" height="40px" radius="14px" />
      <div className={styles.grid}>
        {[0, 1, 2, 3].map(index => <SkeletonBlock key={index} width="100%" height="268px" radius="var(--radius-surface)" index={index + 1} />)}
      </div>
    </div>
  );
}

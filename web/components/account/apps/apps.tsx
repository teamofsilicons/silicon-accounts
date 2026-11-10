"use client";

/**
 * /apps, Connected apps (Anil 2026-11-07): the page bar (parts/page-bar.tsx),
 * then every app this account has signed into (the list is read to its end), what each one can see (with the values
 * it gets), and when it last saw you. Removing an app's access signs you out of it everywhere, revokes the proofs it holds about you and tells the
 * app; you can sign in to it again later. Apps that imported you before you ever signed in are listed too, since they
 * hold data about you. Each app's card also lists the user verifications it holds to act for you at other apps
 * (ActingForYou), with Revoke in place; /proofs keeps the full view.
 */
import { useEffect, useState } from "react";
import { ArrowUpRight, LayoutGrid } from "lucide-react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Card } from "@teamofsilicons/silicon-ui/card";
import { ConfirmMorph } from "@teamofsilicons/silicon-ui/confirm-morph";
import { CopyButton } from "@teamofsilicons/silicon-ui/copy-button";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { Me, MyApp, MyProof, Scope } from "@/lib/api/types";
import { formatDate, formatPhone, formatRelative, plural } from "@/lib/format";
import { useDeveloperUrl, useMe, useMeta } from "@/lib/query/session";
import { timezoneLabel } from "@/lib/timezones";
import { AnimatedRows } from "../parts/animated-rows";
import { appLogo, asCarbon, describeError, useNow } from "../parts/common";
import { FitPrompt } from "../parts/fit-prompt";
import { focusAfterRemoval, pageMain, pressedViewOption } from "../parts/focus";
import { ListCap } from "../parts/list-cap";
import { PageBar } from "../parts/page-bar";
import { useEveryApp, useEveryProof, useRemoveAccess, useRevokeProof } from "../parts/queries";
import { ActingForYou } from "./acting-for-you";
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
  const developerUrl = useDeveloperUrl();
  const me = useMe();
  const [view, setView] = useState<View>("access");
  const now = useNow(30_000);
  const remove = useRemoveAccess();
  // User verifications load beside the apps; a card shows its app's live ones (nothing while they load or if they fail).
  const proofs = useEveryProof();
  const { mutateAsync: revokeProof } = useRevokeProof();
  const liveProofsOf = (appId: string): MyProof[] =>
    (proofs.data?.items ?? []).filter(proof => proof.status === "active" && proof.issuing_app.app_id === appId);
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

  // A stamp on the identity card links here as /apps#app-<id>: bring that card into view.
  const loaded = !!apps.data;
  useEffect(() => {
    if (!loaded) return;
    const target = window.location.hash.replace(/^#/, "");
    if (!target.startsWith("app-")) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" }));
    return () => cancelAnimationFrame(frame);
  }, [loaded]);

  return (
    <div>
      <PageBar title="Connected apps" />
      <Page>
        <p className={styles.lead}>What each app can see about you and when it last saw you. Removing an app&apos;s access signs you out of it everywhere and ends its user verifications for you.</p>
        {apps.error && !apps.data ? (
          <Alert tone="danger" title="Your apps did not load">
            {describeError(apps.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void apps.refetch()}>Try Again</Button></span>
          </Alert>
        ) : !apps.data ? (
          <AppsSkeleton />
        ) : (
          <>
            <SegmentedControl
              label="Which apps"
              value={view}
              onValueChange={value => setView(value as View)}
              options={[
                { value: "access", label: `With access (${withAccess.length})` },
                { value: "removed", label: `Access removed (${removed.length})` },
              ]}
            />
            {/* Names what the switch shows, so the headings below it (each app's name, or the empty state's) sit one level
                under the page's: h1, h2, h3. */}
            <h2 className="sr-only">{view === "access" ? "Apps with access" : "Apps whose access you removed"}</h2>
            {shown.length ? (
              <AnimatedRows items={shown} keyOf={item => item.membership_id} layout="grid" className={styles.cards} label={view === "access" ? "Apps with access" : "Apps whose access you removed"}>
                {item => <AppCard item={item} me={me.data} now={now} proofs={liveProofsOf(item.app.app_id)} onRevokeProof={revokeProof} onRemove={() => removeAccess(item.app.app_id)} />}
              </AnimatedRows>
            ) : (
              <EmptyState
                icon={<LayoutGrid width={24} height={24} strokeWidth={1.5} />}
                title={view === "access" ? "No apps yet" : "No removed apps"}
                description={view === "access" ? "When you sign in to an app with Silicon Accounts, it shows up here with what it can see." : "Apps whose access you remove show up here. You can sign in to them again whenever you like."}
              />
            )}
            <ListCap page={apps.data} noun="apps" command="silicon-accounts apps list" />
            <p className={styles.footnote}>
              Making an app? Apps are created in{" "}
              {/* The link and its comma stay on one line, so a phone can't start the next line with the comma. */}
              <span className={styles.keep}>
                <a href={meta.data?.silicon_apps_url ?? "https://apps.teamofsilicons.com"} target="_blank" rel="noopener">
                  Silicon Apps<ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                </a>
                ,
              </span>{" "}
              and you set up how people sign in to the ones you build on the{" "}
              <span className={styles.keep}>
                <a href={developerUrl}>
                  developer site<ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
                </a>
                .
              </span>
            </p>
          </>
        )}
      </Page>
    </div>
  );
}

/**
 * One app as a Silicon UI Card: its name and site (or app id), what it can see, when it first signed in, its sessions,
 * its membership id, where it acts for you; then the footer: its logo, its state, when it last signed in, Remove access.
 */
function AppCard({ item, me, now, proofs, onRevokeProof, onRemove }: { item: MyApp; me: Me | undefined; now: number; proofs: MyProof[]; onRevokeProof: (proofId: string) => Promise<unknown>; onRemove: () => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const { theme } = useTheme();
  const app = item.app;
  const scopes: Scope[] = item.granted_scopes.includes("profile") ? item.granted_scopes : ["profile", ...item.granted_scopes];
  const rows = scopes.map(scope => shared(scope, me)).filter((row): row is { label: string; value: string | null } => !!row);
  const removed = item.status === "access_removed";
  const imported = item.status === "imported";
  const state = imported ? <Badge size="sm" tone="warning">Imported you</Badge>
    : removed ? <Badge size="sm">Access removed</Badge>
      : item.active_sessions > 0 ? <Badge size="sm" tone="success">Signed in</Badge> : undefined;
  return (
    <Card
      id={`app-${app.app_id}`}
      title={app.name}
      description={host(app.homepage_url) ?? app.app_id}
      avatar={<Avatar name={app.name} src={appLogo(app, theme) ?? undefined} size="sm" />}
      meta={state}
      status={item.last_signed_in_at ? `Last signed in ${formatRelative(item.last_signed_in_at, now)}` : "Never signed in"}
      action={!removed ? (
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
      ) : undefined}
    >
      <div className={styles.body}>
        {removed ? (
          <p className={styles.text}>It can no longer see anything about you{item.access_removed_at ? `, since ${formatDate(item.access_removed_at)}` : ""}. Sign in to it again to give it access.</p>
        ) : imported ? (
          <p className={styles.text}>{app.name} imported your account, so it holds what it imported. It gets nothing more until you sign in to it.</p>
        ) : (
          <dl className={styles.facts}>
            {rows.map(row => (
              <div key={row.label} className={styles.fact}>
                <dt>{row === rows[0] ? "It can see" : <span className="sr-only">It can see</span>}</dt>
                <dd>{row.label}{row.value ? <span className={styles.value} title={row.value}>{row.value}</span> : null}</dd>
              </div>
            ))}
          </dl>
        )}
        <dl className={styles.facts}>
          <div className={styles.fact}>
            <dt>First signed in</dt>
            <dd>{item.first_signed_in_at ? formatDate(item.first_signed_in_at) : "Never"}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Sessions</dt>
            <dd>{item.active_sessions ? plural(item.active_sessions, "active session") : "None active"}</dd>
          </div>
          <div className={styles.fact}>
            <dt>Membership</dt>
            <dd className={styles.membership}>
              <span className="mono" title={item.membership_id}>{item.membership_id}</span>
              <CopyButton value={item.membership_id} label={`Copy ${app.name}'s membership id`} iconOnly variant="plain" />
            </dd>
          </div>
        </dl>
        {!removed ? <ActingForYou appName={app.name} proofs={proofs} onRevoke={onRevokeProof} /> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
    </Card>
  );
}

function AppsSkeleton() {
  return (
    <div className={styles.cards} aria-busy="true" aria-label="Loading your apps">
      {[0, 1, 2, 3].map(index => <Skeleton key={index} label="Loading" lines={5} avatar />)}
    </div>
  );
}

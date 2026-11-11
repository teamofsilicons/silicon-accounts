"use client";

/**
 * /apps, Connected apps, as the prototype draws it (Anil, 2026-11-11: "design the connected apps screen"): the page bar,
 * then one list of the apps you've signed into, each a row that opens its page (/apps/[id]) with when it last signed you
 * in; then the way to Permissions between apps; then, only if there are any, the apps whose access you removed. What an
 * app can see, where it acts for you and Remove are on its page. Apps that imported you before you ever signed in are
 * listed too, since they hold data about you. Built on parts/rows.tsx, as Security is.
 */
import { ArrowUpRight, LayoutGrid, Link2 } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
import type { MyApp } from "@/lib/api/types";
import { formatDate, formatRelative } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useDeveloperUrl, useMeta } from "@/lib/query/session";
import { AppMark } from "../parts/app-mark";
import { withAppIcon } from "../parts/app-icons";
import { describeError, useNow } from "../parts/common";
import { ListCap } from "../parts/list-cap";
import { PageBar } from "../parts/page-bar";
import { useEveryApp, useEveryProof } from "../parts/queries";
import { LinkItem, LinkRow, Section, Strong, Tile } from "../parts/rows";
import styles from "./apps.module.css";

/** An app's page. */
export const appHref = (appId: string) => `${paths.apps}/${encodeURIComponent(appId)}`;

/** What the row says about an app under its name: when it last signed you in, or how it came to hold your details. */
export function appLine(item: MyApp, now: number) {
  if (item.status === "access_removed") return <>Access removed{item.access_removed_at ? <> <Strong>{formatDate(item.access_removed_at)}</Strong></> : null}</>;
  if (item.status === "imported") return "Imported you. You haven’t signed in yet.";
  return item.last_signed_in_at ? <>Signed in <Strong>{formatRelative(item.last_signed_in_at, now)}</Strong></> : "You haven’t signed in yet";
}

export function Apps() {
  const apps = useEveryApp();
  const proofs = useEveryProof();
  const meta = useMeta();
  const developerUrl = useDeveloperUrl();
  const now = useNow(30_000);
  const items = apps.data?.items ?? [];
  const connected = items.filter(item => item.status !== "access_removed");
  const removed = items.filter(item => item.status === "access_removed");
  const allProofs = proofs.data?.items ?? [];
  const activeProofs = allProofs.filter(proof => proof.status === "active").length;

  const row = (item: MyApp) => (
    <LinkItem
      key={item.membership_id}
      href={appHref(item.app.app_id)}
      lead={<AppMark app={withAppIcon(item.app)} size={32} className={styles.mark} decorative />}
      title={item.app.name}
      detail={appLine(item, now)}
      end={item.status === "imported" ? <Badge size="sm" tone="warning">Imported you</Badge> : undefined}
    />
  );

  return (
    <div>
      <PageBar title="Connected apps" />
      <Page>
        {apps.error && !apps.data ? (
          <Alert tone="danger" title="Your apps did not load">
            {describeError(apps.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void apps.refetch()}>Try Again</Button></span>
          </Alert>
        ) : !apps.data ? (
          <div className={styles.skeleton} aria-busy="true" aria-label="Loading your apps"><Skeleton label="Loading" lines={4} avatar /></div>
        ) : (
          <>
            {connected.length ? (
              <Section id="apps-connected" label="Your apps">{connected.map(row)}</Section>
            ) : (
              <EmptyState
                icon={<LayoutGrid width={24} height={24} strokeWidth={1.5} />}
                title="No apps yet"
                description="Apps show up here after you sign in to them with Silicon Accounts."
              />
            )}
            {allProofs.length ? (
              <LinkRow
                href={paths.proofs}
                lead={<Tile><Link2 size={16} strokeWidth={2} /></Tile>}
                title="Permissions between apps"
                detail="One app doing something in another app for you"
                end={activeProofs ? <Badge size="sm" tone="neutral">{activeProofs} active</Badge> : undefined}
              />
            ) : null}
            {removed.length ? <Section id="apps-removed" title="Access removed">{removed.map(row)}</Section> : null}
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

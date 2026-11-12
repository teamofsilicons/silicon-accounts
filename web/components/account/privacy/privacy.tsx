"use client";

/**
 * /privacy, Data & privacy, as the prototype draws it (v7 `data`, Anil, 2026-11-12), on the account pages' rows
 * (parts/rows.tsx):
 *
 *   What apps see   each connected app, what it can see in one line (name, photo and id always, then what it asked
 *                   for), opening its page, where that changes.
 *   Delete account  one row, only its bin and title red, opening Delete your account (/privacy/delete,
 *                   delete-page.tsx), which holds the checks, what you lose and the last step (/__delete-entry A). (Opening in place on ExpandableCard was tried and dropped, Anil 2026-11-12: "previous
 *                   design is better, separate page".)
 *
 * The prototype's "Download your data" isn't built: the API has no export (redesign/api-gaps.md). Local time moved to
 * Personal info (its Timezone row), and where you are signed in is on Security, so the old /settings page's two other
 * sections are gone; /settings redirects here.
 */
import { LayoutGrid, Trash2 } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
import type { Me, MyApp } from "@/lib/api/types";
import { paths } from "@/lib/navigation";
import { useMe } from "@/lib/query/session";
import { appHref } from "../apps/apps";
import { seen } from "../apps/app-page";
import { AppMark } from "../parts/app-mark";
import { withAppIcon } from "../parts/app-icons";
import { asCarbon, asSilicon, describeError } from "../parts/common";
import { PageBar } from "../parts/page-bar";
import { useEveryApp } from "../parts/queries";
import { LinkItem, Row, Section, Tile } from "../parts/rows";
import styles from "./privacy.module.css";

/** "Name, photo, CarbonID and email": what every app sees, then what this one asked for, as the prototype's seesShort. */
function seesLine(item: MyApp, me: Me | undefined): string {
  const asked = item.granted_scopes.map(scope => seen(scope, me)?.label.toLowerCase()).filter((label): label is string => !!label);
  const all = ["Name", "photo", me?.kind === "silicon" ? "id" : "CarbonID", ...asked];
  return `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
}

export function Privacy() {
  const me = useMe();
  const apps = useEveryApp();
  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);
  const connected = (apps.data?.items ?? []).filter(item => item.status !== "access_removed");

  return (
    <div>
      <PageBar title="Data & privacy" />
      <Page>
        {(me.error && !me.data) || (apps.error && !apps.data) ? (
          <Alert tone="danger" title="Data & privacy did not load">
            {describeError(me.error ?? apps.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => { void me.refetch(); void apps.refetch(); }}>Try Again</Button></span>
          </Alert>
        ) : !me.data || !apps.data ? (
          <div className={styles.skeleton} aria-busy="true" aria-label="Loading Data & privacy"><Skeleton label="Loading" lines={4} avatar /></div>
        ) : (
          <>
            <Section id="privacy-apps" title="What apps see" description="Change what each app can see from its page.">
              {connected.length ? connected.map(item => (
                <LinkItem
                  key={item.membership_id}
                  href={appHref(item.app.app_id)}
                  lead={<AppMark app={withAppIcon(item.app)} size={28} className={styles.mark} decorative />}
                  title={item.app.name}
                  detail={seesLine(item, me.data)}
                />
              )) : (
                <Row lead={<Tile><LayoutGrid size={16} strokeWidth={2} /></Tile>} title="No app can see anything about you." />
              )}
            </Section>
            {carbon ? <DeleteAccount /> : silicon ? (
              <Section id="privacy-delete" label="Delete account" tone="danger">
                <Row lead={<Tile><Trash2 size={16} strokeWidth={2} /></Tile>} title="Delete account" detail={`${silicon.custodian?.id ?? "Your custodian"} deletes this Silicon’s account from their Silicons page.`} />
              </Section>
            ) : null}
          </>
        )}
      </Page>
    </div>
  );
}

/**
 * Delete account, as /__delete-entry's A (Anil, 2026-11-12: "try a"): one row in the page's own list look, only the bin
 * and the title in red, opening /privacy/delete, where the Silicons are dealt with. (B, a heading with a sentence and a
 * Delete Account button, was live just before; both are on /__delete-entry.)
 */
function DeleteAccount() {
  return (
    <Section id="privacy-delete" label="Delete account">
      <LinkItem
        href={paths.privacyDelete}
        lead={<span data-sq="surface" className={styles.deleteTile} aria-hidden="true"><Trash2 size={16} strokeWidth={2} /></span>}
        title={<span className={styles.deleteTitle}>Delete account</span>}
        detail="Remove your account and everything in it"
      />
    </Section>
  );
}

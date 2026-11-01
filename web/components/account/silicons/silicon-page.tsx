"use client";

/**
 * /silicons/[uuid]: one Silicon's own page (Anil, 2026-11-01, layout B), in place of the drawer the Silicons page used
 * to open. A back link to Silicons; a header in the Silicon's own colour pair (its mark, its name, its si:id, and its
 * status when it has one); then its settings, the same sections the drawer had (silicon-drawer.tsx SiliconSettings):
 * profile, STK, webhook, custodian, delete. The Silicon comes from the Silicons list (no request of its own); deleting
 * it goes back to the list.
 */
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Sparkle } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { ButtonLink } from "@/components/foundation/button-link";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useMe } from "@/lib/query/session";
import { asCarbon, describeError, personLabel, useNow } from "../parts/common";
import { useEverySilicon } from "../parts/queries";
import { addReveal, dismissReveal, dismissRevealsOf, usePendingReveals } from "../parts/reveals";
import { pairOf } from "../parts/silicon-mark";
import { SiliconSettings } from "./silicon-drawer";
import styles from "./silicon-page.module.css";

export function SiliconPage({ uuid }: { uuid: string }) {
  const me = useMe();
  const carbon = asCarbon(me.data);
  const silicons = useEverySilicon();
  const reveals = usePendingReveals();
  const now = useNow(30_000);
  const router = useRouter();
  const silicon = silicons.data?.items.find(item => item.uuid === uuid || item.id === uuid);
  const back = { href: paths.silicons, label: "Silicons" };

  if ((silicons.error && !silicons.data) || (me.error && !me.data)) {
    return (
      <Page header={<PageHeader title="Silicon" back={back} />}>
        <Alert tone="danger" title="This Silicon did not load">
          {describeError(silicons.error ?? me.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void silicons.refetch()}>Try again</Button></span>
        </Alert>
      </Page>
    );
  }
  if (!silicons.data || !carbon) {
    return (
      <Page header={<PageHeader title="Silicon" back={back} />}>
        <SkeletonBlock width="100%" height="168px" radius="var(--radius-container)" />
      </Page>
    );
  }
  if (!silicon) {
    return (
      <Page header={<PageHeader title="Silicon" back={back} />}>
        <EmptyState
          title="No Silicon here"
          description="It may have been deleted or handed to another Carbon, or it was never in your care."
          action={<ButtonLink href={paths.silicons} variant="secondary">See your Silicons</ButtonLink>}
        />
      </Page>
    );
  }

  const pair = pairOf(silicon.uuid);
  const style = { "--card-from": `var(--silicon-mark-${pair}-from)`, "--card-to": `var(--silicon-mark-${pair}-to)` } as CSSProperties;
  const status = silicon.status === "pending_custodian" ? "Waiting for a custodian"
    : silicon.pending_transfer ? `Handing over to ${personLabel(silicon.pending_transfer.to)}`
      : null;
  const deleted = (gone: string) => {
    dismissRevealsOf(gone);
    router.push(paths.silicons);
  };

  return (
    <Page header={<PageHeader title={silicon.display_name || silicon.id || "Silicon"} back={back} className={styles.srOnlyHeader} />}>
      <section data-sq="clip" className={styles.hero} style={style} aria-label={`${silicon.display_name}, ${silicon.id ?? silicon.uuid}`}>
        <Sparkle className={styles.heroSpark} fill="currentColor" strokeWidth={1} aria-hidden="true" />
        <span className={styles.heroName}>{silicon.display_name || silicon.id || "A Silicon"}</span>
        <span className={styles.heroId}>{silicon.id ?? silicon.uuid}</span>
        <span className={styles.heroFoot}>
          {status ? <span className={styles.heroStatus}>{status}</span> : null}
          <span className={styles.heroFact}>In your care since {formatDate(silicon.created_at, me.data?.timezone)}</span>
        </span>
      </section>
      <div className={styles.settings}>
        <SiliconSettings
          silicon={silicon}
          me={carbon}
          now={now}
          reveals={reveals}
          onReveal={addReveal}
          onRevealDone={dismissReveal}
          onDeleted={deleted}
          onClose={() => undefined}
          inPage
        />
      </div>
    </Page>
  );
}

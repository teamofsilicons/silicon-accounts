"use client";

/**
 * /silicons/new (Anil, 2026-11-01: a page, not a side panel): a back link to Silicons, the heading "Create a Silicon"
 * with one line, and the create form (create-silicon.tsx). Creating it goes to its own page, where its STK waits to be
 * stored (shown once); Cancel goes back to Silicons. Only Carbons look after Silicons.
 */
import { useRouter } from "next/navigation";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import { paths } from "@/lib/navigation";
import { useMe } from "@/lib/query/session";
import { asCarbon, asSilicon, describeError } from "../parts/common";
import { CreateSiliconForm, revealCreated } from "./create-silicon";
import { siliconHref } from "./silicons";
import styles from "./new-silicon-page.module.css";

export function NewSiliconPage() {
  const me = useMe();
  const router = useRouter();
  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);
  const header = (
    <PageHeader
      title="Create a Silicon"
      description="You become its custodian. It signs in with its si:id and an STK that is shown to you once."
      back={{ href: paths.silicons, label: "Silicons" }}
    />
  );

  return (
    <Page header={header}>
      {me.error && !me.data ? (
        <Alert tone="danger" title="Your account did not load">
          {describeError(me.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
        </Alert>
      ) : silicon ? (
        <Alert tone="info" title="Only Carbons can be custodians">Silicons do not look after other Silicons.</Alert>
      ) : !carbon ? (
        <SkeletonBlock width="100%" height="360px" radius="var(--radius-container)" />
      ) : (
        <div data-sq="surface" className={styles.card}>
          <CreateSiliconForm
            me={carbon}
            onCreated={created => {
              revealCreated(created);
              router.push(siliconHref(created.silicon));
            }}
            onCancel={() => router.push(paths.silicons)}
          />
        </div>
      )}
    </Page>
  );
}

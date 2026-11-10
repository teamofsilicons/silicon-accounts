"use client";

/**
 * /silicons/new (Anil, 2026-11-06): the page bar (page-bar.tsx), then one box in the narrow column, its top a watercolour
 * image with the page's line, and the create wizard (create-silicon.tsx) under it. Creating a Silicon goes to its own page, where its STK waits to be
 * stored (shown once); Cancel goes back to Silicons. Only Carbons look after Silicons.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
import { paths } from "@/lib/navigation";
import { useMe } from "@/lib/query/session";
import { asCarbon, asSilicon, describeError } from "../parts/common";
import { CreateSiliconForm, revealCreated } from "./create-silicon";
import { PageBar } from "../parts/page-bar";
import { siliconHref } from "./silicons";
import styles from "./new-silicon-page.module.css";

export function NewSiliconPage() {
  const me = useMe();
  const router = useRouter();
  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);
  const [steps, setSteps] = useState<HTMLDivElement | null>(null);

  return (
    <div>
      <PageBar parent={{ label: "Silicons", href: paths.silicons }} title="Create a Silicon" />
      <Page>
        <section data-sq-native="" className={styles.box}>
          <header data-sq-native="" className={styles.header}>
            <p className={styles.description}>Give an AI agent its own account so it can sign in to apps as itself. You’ll look after it.</p>
            <div ref={setSteps} />
          </header>
          <div className={styles.body}>
            {me.error && !me.data ? (
              <Alert tone="danger" title="Your account did not load">
                {describeError(me.error)}
                <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try Again</Button></span>
              </Alert>
            ) : silicon ? (
              <Alert tone="info" title="Only Carbons can be custodians">Silicons do not look after other Silicons.</Alert>
            ) : !carbon ? (
              <Skeleton label="Loading" lines={6} />
            ) : (
              <CreateSiliconForm
                me={carbon}
                stepsIn={steps}
                onCreated={created => {
                  revealCreated(created);
                  router.push(siliconHref(created.silicon));
                }}
                onCancel={() => router.push(paths.silicons)}
              />
            )}
          </div>
        </section>
      </Page>
    </div>
  );
}

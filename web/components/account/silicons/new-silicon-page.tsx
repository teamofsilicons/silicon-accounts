"use client";

/**
 * /silicons/new (Anil, 2026-11-06): the page on Silicon UI as it ships, inside [data-silicon-ui] (styles/tokens.css), to
 * compare with the rest of the site: breadcrumbs at the top of the content area, then the title, its line and the create
 * form (create-silicon.tsx) in the narrow column. Creating a Silicon goes to its own page, where its STK waits to be
 * stored (shown once); Cancel goes back to Silicons. Only Carbons look after Silicons.
 */
import { useRouter } from "next/navigation";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Breadcrumb } from "@teamofsilicons/silicon-ui/breadcrumb";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
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

  return (
    <div data-silicon-ui="">
      <div className={styles.crumbs}>
        <Breadcrumb items={[{ label: "Silicons", href: paths.silicons }, { label: "Create a Silicon" }]} />
      </div>
      <Page
        header={
          <header className={styles.header}>
            <h1 className={styles.title}>Create a Silicon</h1>
            <p className={styles.description}>Give an AI agent its own account so it can sign in to apps as itself. You’ll look after it.</p>
          </header>
        }
      >
        {me.error && !me.data ? (
          <Alert tone="danger" title="Your account did not load">
            {describeError(me.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
          </Alert>
        ) : silicon ? (
          <Alert tone="info" title="Only Carbons can be custodians">Silicons do not look after other Silicons.</Alert>
        ) : !carbon ? (
          <Skeleton label="Loading" lines={6} />
        ) : (
          <CreateSiliconForm
            me={carbon}
            onCreated={created => {
              revealCreated(created);
              router.push(siliconHref(created.silicon));
            }}
            onCancel={() => router.push(paths.silicons)}
          />
        )}
      </Page>
    </div>
  );
}

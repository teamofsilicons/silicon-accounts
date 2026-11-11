"use client";

/**
 * /proofs, Permissions between apps, as the prototype draws it (Anil, 2026-11-12): Connected apps above the title, one
 * line on what a permission is, then the Active ones (each app's mark, "Briefcase in Commit", what it may do and until
 * when, Stop asked first) and, only when there are any, the Ended ones (why and when). Each permission is a User
 * verification proof an app holds about you; stopping one makes the receiving app's next check fail at once. The rows
 * are the apps pages' (apps/proof-rows.tsx), on the account pages' rows (parts/rows.tsx).
 */
import { ShieldCheck } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
import { paths } from "@/lib/navigation";
import { ActiveProofRow, EndedProofRow } from "../apps/proof-rows";
import { describeError } from "../parts/common";
import { ListCap } from "../parts/list-cap";
import { PageBar } from "../parts/page-bar";
import { useEveryProof } from "../parts/queries";
import { Section } from "../parts/rows";
import styles from "../apps/apps.module.css";

export function Proofs() {
  const proofs = useEveryProof();
  const items = proofs.data?.items ?? [];
  const active = items.filter(item => item.status === "active");
  const ended = items.filter(item => item.status !== "active");

  return (
    <div>
      <PageBar parent={{ label: "Connected apps", href: paths.apps }} title="Permissions between apps" />
      <Page>
        <p className={styles.lead}>One app doing something in another app for you. Stop one and the other app&rsquo;s next check fails at once.</p>
        {proofs.error && !proofs.data ? (
          <Alert tone="danger" title="Your permissions did not load">
            {describeError(proofs.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void proofs.refetch()}>Try Again</Button></span>
          </Alert>
        ) : !proofs.data ? (
          <div className={styles.skeleton} aria-busy="true" aria-label="Loading your permissions"><Skeleton label="Loading" lines={4} avatar /></div>
        ) : (
          <>
            {active.length ? (
              <Section id="proofs-active" title="Active">{active.map(proof => <ActiveProofRow key={proof.proof_id} proof={proof} />)}</Section>
            ) : (
              <div className={styles.skeleton}>
                <EmptyState
                  icon={<ShieldCheck width={24} height={24} strokeWidth={1.5} />}
                  title="No app is acting for you"
                  description="When an app you use does something in another app for you, it shows up here and you can stop it."
                />
              </div>
            )}
            {ended.length ? <Section id="proofs-ended" title="Ended">{ended.map(proof => <EndedProofRow key={proof.proof_id} proof={proof} />)}</Section> : null}
            <ListCap page={proofs.data} noun="permissions" command="silicon-accounts proofs list" />
          </>
        )}
      </Page>
    </div>
  );
}

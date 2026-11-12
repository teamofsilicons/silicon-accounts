"use client";

/**
 * /goodbye, after an account is deleted (the prototype's "gone" screen; Anil, 2026-11-12): "Your account is deleted",
 * what happened, how long the CarbonID is held, and Start Again (the landing page). Delete your account
 * (account/privacy/delete-page.tsx) leaves the CarbonID in this tab's session storage just before it comes here, never
 * in the address: a CarbonID is the Carbon's, and an address ends up in history and logs. Without it (a reload in
 * another tab, an old link) the page says the same without naming one.
 */
import { useSyncExternalStore } from "react";
import { ButtonLink } from "@/components/foundation/button-link";
import { DELETED_ID_KEY } from "@/lib/deleted-account";
import { paths } from "@/lib/navigation";
import { HostedFrame } from "./flow/hosted-frame";
import { SILICON_ACCOUNTS } from "./flow/model";
import { ArrivalScope } from "./flow/problem";
import { StepHeading } from "./flow/parts";
import styles from "./flow/flow.module.css";


const readDeletedId = (): string | null => {
  try {
    return window.sessionStorage.getItem(DELETED_ID_KEY);
  } catch {
    return null;
  }
};
const noChanges = () => () => undefined;

export function Goodbye() {
  const id = useSyncExternalStore(noChanges, readDeletedId, () => null);
  return (
    <ArrivalScope>
      <HostedFrame app={SILICON_ACCOUNTS} site title="Your account is deleted" poweredBy={false}>
        <StepHeading
          title="Your account is deleted"
          description={id
            ? <>Every app was told and lost access. <strong className={styles.codeAddress}>{id}</strong> is reserved for 10 days, then anyone can take it.</>
            : "Every app was told and lost access. Your CarbonID is reserved for 10 days, then anyone can take it."}
        />
        <div><ButtonLink href={paths.home} variant="secondary">Start Again</ButtonLink></div>
      </HostedFrame>
    </ArrivalScope>
  );
}

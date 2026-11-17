"use client";

/**
 * /goodbye, after an account is deleted (the prototype's "gone" screen; Anil, 2026-11-12): "Account deletion requested",
 * what happened, the 10 days to get it back by signing in (the API archives it first), and Sign in to recover. Delete your account
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
      <HostedFrame app={SILICON_ACCOUNTS} site title="Account deletion requested" poweredBy={false}>
        <StepHeading
          title="Account deletion requested"
          description={id
            ? <>You&rsquo;re signed out everywhere. Changed your mind? Sign in with a code sent to your email or phone within 10 days and <strong className={styles.codeAddress}>{id}</strong> comes back.</>
            : "You’re signed out everywhere. Changed your mind? Sign in with a code sent to your email or phone within 10 days and your account comes back."}
        />
        <div><ButtonLink href={`${paths.signIn}?prompt=login`} variant="secondary">Sign in to recover</ButtonLink></div>
      </HostedFrame>
    </ArrivalScope>
  );
}

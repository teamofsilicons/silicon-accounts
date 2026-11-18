"use client";

/**
 * select_account: which account signs in to the app, when one sign-in reaches a personal account and work accounts
 * (from main's work accounts, 2026-11-03; on the flow's design 2026-11-13). Personal, then Work, each account on the
 * flow's AccountRow ("Continue as"'s row): its photo, name and id, a work account's org (logo and name) under them, and Continue. An
 * account whose org doesn't allow this app is greyed with the server's reason, and can't be chosen. "Sign in to Another
 * Account" goes back to signing in.
 */
import { useState } from "react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { AppMark } from "@/components/account/parts/app-mark";
import type { ApiError } from "@/lib/api/errors";
import type { FlowController } from "../flow/controller";
import type { HostedFlow } from "../flow/model";
import { AccountRow, FlowAlert, StepHeading } from "../flow/parts";
import styles from "../flow/flow.module.css";

export function SelectAccount({ flow, ctl, notice }: { flow: HostedFlow; ctl: FlowController; notice: ApiError | null }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const choose = async (uuid: string) => {
    setPending(uuid);
    setError(null);
    const failure = await ctl.selectAccount(uuid);
    if (failure) {
      setError(failure);
      setPending(null);
    }
  };
  return (
    <>
      <StepHeading title="Choose your account" description={`Which account would you like to use in ${flow.app.name}?`} />
      <FlowAlert error={error ?? notice} app={flow.app.name} />
      {([false, true] as const).map(work => {
        const accounts = (flow.accounts ?? []).filter(account => !!account.org === work);
        if (!accounts.length) return null;
        const label = work ? "Work" : "Personal";
        return (
          <section key={label} className={styles.accountGroup} aria-labelledby={`accounts-${label}`}>
            <h2 id={`accounts-${label}`} className={styles.groupLabel}>{label}</h2>
            {accounts.map(account => {
              const blocked = account.allowed === false;
              return (
                <AccountRow
                  key={account.uuid}
                  account={account}
                  size="sm"
                  blocked={blocked}
                  detail={blocked ? account.reason ?? `${account.org?.name ?? "Your org"} does not allow this app.` : account.org ? (
                    // Each work account shows its org's name and logo (UNDERSTANDING.md), so look-alike accounts stay apart.
                    <span className={styles.orgLine}>
                      <AppMark app={{ app_id: account.org.org_id, name: account.org.name, logo_url: account.org.logo_url }} size={16} decorative />
                      {account.org.name}
                    </span>
                  ) : undefined}
                  action={
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={blocked || (!!pending && pending !== account.uuid)}
                      loading={pending === account.uuid}
                      onClick={() => void choose(account.uuid)}
                      aria-label={`Continue as ${account.id}`}
                    >
                      Continue
                    </Button>
                  }
                />
              );
            })}
          </section>
        );
      })}
      <Button variant="ghost" disabled={!!pending} onClick={() => void ctl.switchAccount()}>Sign in to Another Account</Button>
    </>
  );
}

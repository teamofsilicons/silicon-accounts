"use client";

import Image from "next/image";
import { useState } from "react";
import { Building2, UserRound } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import type { ApiError } from "@/lib/api/errors";
import type { FlowController } from "../flow/controller";
import type { HostedFlow } from "../flow/model";
import { FlowAlert, StepHeading } from "../flow/parts";
import styles from "./select-account.module.css";

export function SelectAccount({
  flow,
  ctl,
  notice,
}: {
  flow: HostedFlow;
  ctl: FlowController;
  notice: ApiError | null;
}) {
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
      <StepHeading
        title="Choose your account"
        description={`Which account would you like to use in ${flow.app.name}?`}
      />
      <FlowAlert error={error ?? notice} app={flow.app.name} />
      {([false, true] as const).map((work) => {
        const accounts = (flow.accounts ?? []).filter(
          (account) => !!account.org === work,
        );
        if (!accounts.length) return null;
        return (
          <section
            key={String(work)}
            className={styles.group}
            aria-label={work ? "Work accounts" : "Personal account"}
          >
            <h2>{work ? "Work" : "Personal"}</h2>
            {accounts.map((account) => (
              <div
                key={account.uuid}
                className={styles.choice}
                data-sq="surface"
                data-blocked={account.allowed === false || undefined}
              >
                <span className={styles.icon} aria-hidden="true">
                  {account.org?.logo_url ? (
                    <Image
                      src={account.org.logo_url}
                      width={32}
                      height={32}
                      alt=""
                      unoptimized
                    />
                  ) : work ? (
                    <Building2 size={22} />
                  ) : (
                    <UserRound size={22} />
                  )}
                </span>
                <div className={styles.identity}>
                  <strong>{account.display_name}</strong>
                  <span>{account.id}</span>
                  {account.org ? <span>{account.org.name}</span> : null}
                  {account.allowed === false ? (
                    <p>
                      {account.reason ??
                        `${account.org?.name ?? "Your org"} does not allow this app.`}
                    </p>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    account.allowed === false ||
                    (!!pending && pending !== account.uuid)
                  }
                  loading={pending === account.uuid}
                  onClick={() => void choose(account.uuid)}
                  aria-label={`Continue as ${account.id}`}
                >
                  Continue
                </Button>
              </div>
            ))}
          </section>
        );
      })}
      <Button
        variant="ghost"
        disabled={!!pending}
        onClick={() => void ctl.switchAccount()}
      >
        Sign in to another account
      </Button>
    </>
  );
}

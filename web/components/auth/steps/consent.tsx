"use client";

/**
 * consent: what is shared with the app (UNDERSTANDING.md "What's shared with the app"). Required details are always
 * shared and locked on; optional ones have a switch. Shown the first time a Carbon signs into an app and again when
 * it asks for more. "Share and continue" approves; Cancel sends the browser back to the app with access_denied.
 */
import { useState } from "react";
import { Lock } from "lucide-react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Switch } from "@/components/arc/switch/switch";
import type { ApiError } from "@/lib/api/errors";
import type { Scope } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { isValidTimezone, timezoneLabel, utcOffset } from "@/lib/timezones";
import type { FlowController } from "../flow/controller";
import type { HostedFlow } from "../flow/model";
import { AccountRow, FlowAlert, StepHeading, useStepErrors } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface ConsentProps {
  flow: HostedFlow;
  ctl: FlowController;
  notice: ApiError | null;
}

/** Values as people read them: "Mar 14, 1998", "Kolkata, Asia (UTC+05:30)". */
function shown(scope: Scope, value: string | null): string | null {
  if (value === null) return null;
  if (scope === "dob" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  if (scope === "timezone" && isValidTimezone(value)) return `${timezoneLabel(value)} (UTC${utcOffset(value)})`;
  return value;
}

export function Consent({ flow, ctl, notice }: ConsentProps) {
  const consent = flow.consent;
  const account = flow.signed_in_as;
  const app = flow.app;
  const [chosen, setChosen] = useState<Set<Scope>>(() => new Set((consent?.optional ?? []).filter(row => row.granted && row.value !== null).map(row => row.scope)));
  const [pending, setPending] = useState<"approve" | "decline" | "switch" | null>(null);
  /** Why "Share and continue", "Cancel" or "Switch account" did not go through (shown by the buttons). */
  const [problem, setProblem] = useState<ApiError | null>(null);
  const errors = useStepErrors(flow.error ?? notice);
  if (!consent) return null;
  /** Signed out (or into another account) meanwhile: approving again cannot work until the account is chosen again. */
  const blocked = problem?.code === "session_required" || problem?.code === "account_changed";
  /**
   * The app saw more than the basic profile before (an earlier consent) and now asks for something it has not seen:
   * the new rows say so. A grant of just the profile (an imported account, or an app that asked for nothing else) is
   * not "before", and an app asking again for only what it already has (prompt=consent) is not asking for more.
   */
  const before = consent.previously_granted.filter(scope => scope !== "profile" && scope !== "openid" && scope !== "offline_access");
  const unseen = (scope: Scope) => scope !== "profile" && !consent.previously_granted.includes(scope);
  const asksAgain = before.length > 0 && [...consent.required, ...consent.optional].some(row => unseen(row.scope));
  const isNew = (scope: Scope) => asksAgain && unseen(scope);

  const toggle = (scope: Scope, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(scope);
    else next.delete(scope);
    setChosen(next);
  };

  const answer = async (approve: boolean) => {
    setProblem(null);
    errors.begin();
    setPending(approve ? "approve" : "decline");
    const failure = await ctl.consent(approve ? { approve: true, optional_scopes: [...chosen] } : { approve: false });
    if (failure) {
      setPending(null);
      setProblem(failure);
    }
    // On success the card moves on to the redirect; the buttons stay busy until it does.
  };

  const switchAccount = async () => {
    setProblem(null);
    errors.begin();
    setPending("switch");
    const failure = await ctl.switchAccount();
    if (failure) {
      setPending(null);
      setProblem(failure);
    }
  };

  return (
    <>
      <StepHeading
        title={asksAgain ? `${app.name} would like a little more` : `Share your details with ${app.name}`}
        description={`${app.name} sees these now and whenever they change. You can remove its access at any time in your account.`}
      />
      <FlowAlert error={errors.carried} app={app.name} onSwitch={() => ctl.switchAccount()} />
      {account ? (
        <AccountRow
          account={account}
          size="sm"
          action={<Button variant="ghost" size="sm" loading={pending === "switch"} disabled={!!pending && pending !== "switch"} onClick={() => void switchAccount()}>Switch account</Button>}
        />
      ) : null}
      <ul data-sq="surface" className={styles.shareList} aria-label={`Details shared with ${app.name}`}>
        {consent.required.map(row => (
          <li key={row.scope} className={styles.shareRow} data-scope={row.scope} data-required="">
            <span className={styles.shareText}>
              <span className={styles.shareLabel}>{row.label}{isNew(row.scope) ? <Badge tone="info" size="sm">New</Badge> : null}</span>
              <span className={styles.shareValue}>{shown(row.scope, row.value) ?? "Not added yet"}</span>
            </span>
            <span className={styles.shareLock} title="Always shared">
              <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>Required</span>
            </span>
          </li>
        ))}
        {consent.optional.map(row => {
          const missing = row.value === null;
          const labelId = `share-${row.scope}`;
          return (
            <li key={row.scope} className={styles.shareRow} data-scope={row.scope} data-optional="">
              <span className={styles.shareText}>
                <span id={labelId} className={styles.shareLabel}>{row.label}{isNew(row.scope) ? <Badge tone="info" size="sm">New</Badge> : null}</span>
                <span className={styles.shareValue}>{missing ? "You have not added one, so nothing is shared" : shown(row.scope, row.value)}</span>
              </span>
              <Switch aria-labelledby={labelId} checked={!missing && chosen.has(row.scope)} disabled={missing || !!pending} onCheckedChange={on => toggle(row.scope, on)} />
            </li>
          );
        })}
      </ul>
      <FlowAlert error={problem} app={app.name} onSwitch={() => ctl.switchAccount()} />
      <div className={styles.actions}>
        <Button className={styles.wide} loading={pending === "approve"} disabled={(!!pending && pending !== "approve") || blocked} onClick={() => void answer(true)}>
          Share and continue
        </Button>
        <Button variant="secondary" className={styles.wide} loading={pending === "decline"} disabled={!!pending && pending !== "decline"} onClick={() => void answer(false)}>
          Cancel
        </Button>
      </div>
    </>
  );
}

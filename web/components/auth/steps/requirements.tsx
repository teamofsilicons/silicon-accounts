"use client";

/**
 * requirements: the app needs an email or phone the account does not have yet (UNDERSTANDING.md "What's shared with
 * the app": "they must add it before continuing"). The Carbon adds it here with an inline code; when two details
 * are missing they are added one after the other. A detail added elsewhere meanwhile moves the flow on by itself.
 */
import { useState } from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import type { ApiError } from "@/lib/api/errors";
import type { ActionResult, FlowController } from "../flow/controller";
import { useFinePointer } from "../flow/hooks";
import type { HostedFlow } from "../flow/model";
import { StepMorph } from "../flow/morph";
import { AccountRow, CodeEntry, ContactForm, DestinationRow, FlowAlert, StepHeading, useStepErrors, type ContactKind } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface RequirementsProps {
  flow: HostedFlow;
  ctl: FlowController;
  notice: ApiError | null;
}

const NOUN: Record<ContactKind, string> = { email: "an email address", phone: "a phone number" };

/** Failures about the account rather than the detail: they belong in the step's alert, with its "Sign in again". */
const ACCOUNT_GONE = new Set(["session_required", "account_changed"]);

export function Requirements({ flow, ctl, notice }: RequirementsProps) {
  const requirements = flow.requirements;
  const account = flow.signed_in_as;
  const missing = (requirements?.missing ?? []).filter((field): field is ContactKind => field === "email" || field === "phone");
  // How many details this visit started with, for "1 of 2".
  const [total] = useState(() => Math.max(1, missing.length));
  const [changing, setChanging] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [lastValue, setLastValue] = useState<{ kind: ContactKind; value: string } | null>(null);
  const fine = useFinePointer();
  // Newest first: the reason the flow came here stays until the Carbon acts; a failed "Switch account" replaces it.
  // (A failed send or code shows under its own field.)
  const errors = useStepErrors(flow.error ?? notice);
  const sent = requirements?.challenge ?? null;
  const challenge = changing ? null : sent;
  /** The detail being added now: the one a code went to, else the first missing one. */
  const current: ContactKind = challenge?.channel && missing.includes(challenge.channel) ? challenge.channel : missing[0] ?? "email";
  const app = flow.app;
  const title = missing.length > 1 ? "Add your email and phone number" : current === "phone" ? "Add your phone number" : "Add your email address";
  const position = total - missing.length + 1;

  const switchAccount = async () => {
    if (switching) return;
    errors.begin();
    setSwitching(true);
    const failure = await ctl.switchAccount();
    setSwitching(false);
    if (failure) errors.fail(failure);
  };

  /** A failure about the account goes to the alert (with its fix); anything else stays by the field that caused it. */
  const routed = (failure: ActionResult): ActionResult => {
    if (failure && ACCOUNT_GONE.has(failure.code)) {
      errors.fail(failure);
      return null;
    }
    return failure;
  };

  const send = async (kind: ContactKind, value: string, country?: string) => {
    errors.begin();
    const failure = kind === "email" ? await ctl.requirementEmail(value) : await ctl.requirementPhone(value, country);
    if (!failure) {
      setLastValue({ kind, value });
      setChanging(false);
    }
    return routed(failure);
  };
  const verify = async (code: string) => {
    errors.begin();
    return routed(await ctl.requirementVerify(code));
  };
  const resend = async () => {
    errors.begin();
    return routed(await ctl.resend());
  };

  return (
    <>
      <StepHeading
        title={title}
        description={`${app.name} needs ${NOUN[current]} on your account before you can continue. We will send a code to make sure it is yours.`}
        noFocus={!!challenge && fine}
      />
      <FlowAlert error={errors.current} app={app.name} onSwitch={() => ctl.switchAccount()} />
      {account ? (
        <AccountRow account={account} size="sm" action={<Button variant="ghost" size="sm" loading={switching} onClick={() => void switchAccount()}>Switch account</Button>} />
      ) : null}
      {total > 1 ? (
        <div className={styles.progressLine}>
          <Badge tone="neutral">{`${position} of ${total}`}</Badge>
          <span className={styles.muted}>{current === "phone" ? "Phone number" : "Email address"}</span>
        </div>
      ) : null}
      {/* The field and the code morph into each other inside the card, like the sign-in steps. */}
      <StepMorph view={challenge ? `code:${current}` : `form:${current}`} order={["form", "code"]}>
        {view =>
          view.startsWith("code") && sent ? (
            <div className={styles.stack}>
              <DestinationRow
                channel={sent.channel}
                destination={sent.destination}
                action={<Button variant="ghost" size="sm" onClick={() => setChanging(true)} aria-label={`Change the ${sent.channel === "email" ? "email address" : "phone number"} the code goes to`}>Change</Button>}
              />
              <CodeEntry
                challenge={sent}
                verify={verify}
                resend={resend}
                label={sent.channel === "email" ? "Code from the email" : "Code from the text message"}
                submitLabel={sent.channel === "email" ? "Add email" : "Add phone number"}
              />
            </div>
          ) : (
            <div className={styles.stack}>
              <ContactForm
                kinds={[view.endsWith("phone") ? "phone" : "email"]}
                initialEmail={lastValue?.kind === "email" ? lastValue.value : ""}
                initialPhone={lastValue?.kind === "phone" ? lastValue.value : ""}
                submitLabel="Send code"
                onSubmit={send}
                autoFocus={fine}
                note={view.endsWith("phone") ? "We text a 6 digit code to this number." : "We email a 6 digit code to this address."}
                errorContext={{ app: app.name }}
              />
              {changing && sent ? <button type="button" className={styles.textButton} onClick={() => setChanging(false)}>Back to the code</button> : null}
            </div>
          )
        }
      </StepMorph>
    </>
  );
}

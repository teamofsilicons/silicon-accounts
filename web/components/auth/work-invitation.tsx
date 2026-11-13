"use client";

/**
 * An org's invitation to a work account (/invite/…, from main's work accounts, 2026-11-03; on the hosted flow's design
 * 2026-11-13). In the hosted frame like every sign-in page, with the flow's heading, alert and form spacing:
 *
 * - An invitation for an existing Carbon: what the work id will be, and "Sign In and Review Invitation" in Silicon
 *   Organizations.
 * - A new work account: its work id, "Send Verification Code" to the invited email, then the code (the flow's code
 *   boxes), name, date of birth (Silicon UI's DatePicker) and timezone (the timezone search Personal Info uses), and
 *   "Verify Email and Accept Work Account", which hands the proof to Silicon Organizations in a POST.
 *
 * The words and behaviour are main's; only the look moved onto the redesign.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Combobox } from "@teamofsilicons/silicon-ui/combobox";
import { DatePicker } from "@teamofsilicons/silicon-ui/date-picker";
import { Input } from "@teamofsilicons/silicon-ui/input";
import { OtpInput } from "@teamofsilicons/silicon-ui/otp-input";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { ButtonLink } from "@/components/foundation/button-link";
import { HostedFrame } from "./flow/hosted-frame";
import { FlowAlert, StepHeading } from "./flow/parts";
import { SILICON_ACCOUNTS } from "./flow/model";
import { useWorkInvitation, useWorkInvitationAction } from "@/lib/query/work-invitations";
import { useMeta } from "@/lib/query/session";
import { ApiError } from "@/lib/api/errors";
import { timezoneOptions } from "@/lib/timezones";
import styles from "./flow/flow.module.css";

const MIN_DOB = new Date(1900, 0, 2);
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function WorkInvitationPage({ ticket }: { ticket: string }) {
  const invite = useWorkInvitation(ticket);
  const meta = useMeta();
  const send = useWorkInvitationAction<{ challenge_id: string }, Record<string, never>>(ticket, "email-code");
  const verify = useWorkInvitationAction<
    { invitation_proof: string; invitation_id: string; return_to: string },
    { challenge_id: string; code: string; display_name: string; dob: string; timezone: string }
  >(ticket, "verify");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [dob, setDob] = useState<Date | undefined>(undefined);
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [maxDob] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  });
  const zones = useMemo(() => timezoneOptions(undefined, [timezone]), [timezone]);
  const [error, setError] = useState<ApiError | null>(null);
  const [verified, setVerified] = useState<{ invitation_proof: string; invitation_id: string; return_to: string } | null>(null);
  useEffect(() => {
    const blocked = (event: SecurityPolicyViolationEvent) => {
      if (event.effectiveDirective === "form-action")
        setError(new ApiError({
          status: 0,
          code: "handoff_blocked",
          message: "Your email was verified, but the browser blocked the handoff to your organization.",
          hint: "The site administrator must allow the configured Organizations origin. Your proof remains ready while this page is open.",
        }));
    };
    window.addEventListener("securitypolicyviolation", blocked);
    return () => window.removeEventListener("securitypolicyviolation", blocked);
  }, []);
  const data = invite.data;
  const orgsUrl = meta.data?.organizations_url ?? "https://organizations.teamofsilicons.com";
  const reviewUrl = new URL("/auth/start", orgsUrl);
  reviewUrl.searchParams.set("switch", "1");
  reviewUrl.searchParams.set("return_to", `/invites/${encodeURIComponent(data?.invitation_id ?? "")}`);
  const handoff = (result: { invitation_proof: string; invitation_id: string }) => {
    const target = new URL("/auth/work-invite", new URL(orgsUrl));
    const form = document.createElement("form");
    form.method = "POST";
    form.action = target.toString();
    for (const [key, value] of Object.entries({ invitation_id: result.invitation_id, invitation_proof: result.invitation_proof })) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  };
  const sendCode = () => void send.mutateAsync({}).then(result => setChallenge(result.challenge_id)).catch(() => {});
  const submit = async () => {
    if (!challenge || !dob) return;
    try {
      const result = await verify.mutateAsync({ challenge_id: challenge, code, display_name: name, dob: dateKey(dob), timezone });
      setVerified(result);
      verify.reset();
      handoff(result);
    } catch (failure) {
      setError(ApiError.from(failure));
    }
  };
  const problem = error ?? invite.error ?? send.error ?? verify.error;
  const workId = data ? <span className={styles.mono}>c:{data.handle}.{data.org.org_id}</span> : null;
  return (
    <HostedFrame app={SILICON_ACCOUNTS} site title="Your work account" poweredBy={false}>
      <div className={styles.stack}>
        <StepHeading
          title={data ? `Join ${data.org.name}` : "Organization invitation"}
          description={
            data?.needs_link
              ? "Sign in with the invited Carbon account, then review the new work account and its linking notice."
              : data
                ? "Create only the work account your organization invited you to. You can add a personal account later."
                : "Review your invitation to a separate organization work account."
          }
        />
        <FlowAlert error={problem ?? null} title="This could not be completed" app={SILICON_ACCOUNTS.name} />
        {!data && !invite.error ? (
          <p className={styles.note} role="status">Loading your invitation…</p>
        ) : data?.needs_link ? (
          <>
            <p className={styles.invitationText}>This invitation is for an existing Carbon account. Sign in with the account that was invited, even if you are currently using a different account.</p>
            <p className={styles.invitationText}>Your work ID will be {workId}. Before accepting, you will review how it links to your invited account. Their apps and history stay separate.</p>
            <ButtonLink href={reviewUrl.toString()} external className={styles.wide}>Sign In and Review Invitation</ButtonLink>
          </>
        ) : data ? (
          <>
            <p className={styles.invitationText}>Your work ID: {workId}</p>
            {verified ? (
              <>
                <Alert tone="success" title="Email verified">Your work account is ready to be accepted.</Alert>
                <Button className={styles.wide} onClick={() => handoff(verified)}>Continue to Your Organization</Button>
              </>
            ) : !challenge ? (
              <>
                <p className={styles.invitationText}>We will send a verification code to {data.email ?? "the invited email"}.</p>
                <Button className={styles.wide} loading={send.isPending} onClick={sendCode}>Send Verification Code</Button>
              </>
            ) : (
              <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(); }}>
                <OtpInput label="Verification code" length={6} value={code} onChange={setCode} autoFocus />
                <Input label="Display name" autoComplete="name" value={name} onChange={event => setName(event.target.value)} required maxLength={100} />
                <DatePicker label="Date of birth" value={dob} onChange={setDob} minDate={MIN_DOB} maxDate={maxDob} />
                <Combobox label="Timezone" options={zones} value={timezone} onValueChange={setTimezone} placeholder="Search a city or an offset" />
                <Button type="submit" className={styles.wide} loading={verify.isPending} disabled={code.length !== 6 || !name.trim() || !dob || !timezone}>Verify Email and Accept Work Account</Button>
                <Button type="button" variant="ghost" loading={send.isPending} onClick={sendCode}>Resend Code</Button>
              </form>
            )}
          </>
        ) : null}
      </div>
    </HostedFrame>
  );
}

"use client";
import { useEffect, useState } from "react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Input } from "@teamofsilicons/silicon-ui/input";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { HostedFrame } from "./flow/hosted-frame";
import { StepHeading } from "./flow/parts";
import { SILICON_ACCOUNTS } from "./flow/model";
import {
  useWorkInvitation,
  useWorkInvitationAction,
} from "@/lib/query/work-invitations";
import { useMeta } from "@/lib/query/session";
import { ApiError } from "@/lib/api/errors";
export function WorkInvitationPage({ ticket }: { ticket: string }) {
  const invite = useWorkInvitation(ticket);
  const meta = useMeta();
  const send = useWorkInvitationAction<
    { challenge_id: string },
    Record<string, never>
  >(ticket, "email-code");
  const verify = useWorkInvitationAction<
    { invitation_proof: string; invitation_id: string; return_to: string },
    {
      challenge_id: string;
      code: string;
      display_name: string;
      dob: string;
      timezone: string;
    }
  >(ticket, "verify");
  const [challenge, setChallenge] = useState<string | null>(null),
    [code, setCode] = useState(""),
    [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [verified, setVerified] = useState<{
    invitation_proof: string;
    invitation_id: string;
    return_to: string;
  } | null>(null);
  useEffect(() => {
    const blocked = (event: SecurityPolicyViolationEvent) => {
      if (event.effectiveDirective === "form-action")
        setError(
          new ApiError({
            status: 0,
            code: "handoff_blocked",
            message:
              "Your email was verified, but the browser blocked the handoff to your organization.",
            hint: "The site administrator must allow the configured Organizations origin. Your proof remains ready while this page is open.",
          }),
        );
    };
    window.addEventListener("securitypolicyviolation", blocked);
    return () => window.removeEventListener("securitypolicyviolation", blocked);
  }, []);
  const data = invite.data;
  const reviewUrl = new URL(
    "/auth/start",
    meta.data?.organizations_url ?? "https://organizations.teamofsilicons.com",
  );
  reviewUrl.searchParams.set("switch", "1");
  reviewUrl.searchParams.set(
    "return_to",
    `/invites/${encodeURIComponent(data?.invitation_id ?? "")}`,
  );
  const handoff = (result: {
    invitation_proof: string;
    invitation_id: string;
  }) => {
    const orgs = new URL(
      meta.data?.organizations_url ??
        "https://organizations.teamofsilicons.com",
    );
    const target = new URL("/auth/work-invite", orgs);
    const form = document.createElement("form");
    form.method = "POST";
    form.action = target.toString();
    for (const [key, value] of Object.entries({
      invitation_id: result.invitation_id,
      invitation_proof: result.invitation_proof,
    })) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  };
  const submit = async () => {
    if (!challenge) return;
    try {
      const result = await verify.mutateAsync({
        challenge_id: challenge,
        code,
        display_name: name,
        dob,
        timezone,
      });
      setVerified(result);
      verify.reset();
      handoff(result);
    } catch (failure) {
      setError(ApiError.from(failure));
    }
  };
  const problem = error ?? invite.error ?? send.error ?? verify.error;
  return (
    <HostedFrame app={SILICON_ACCOUNTS} site title="Your work account">
      <div style={{ display: "grid", gap: 20 }}>
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
        {problem ? (
          <Alert tone="danger" title="This could not be completed">
            {problem.message} {problem.hint}
          </Alert>
        ) : null}
        {!data && !invite.error ? (
          <p role="status">Loading your invitation…</p>
        ) : data?.needs_link ? (
          <>
            <p>
              This invitation is for an existing Carbon account. Sign in with
              the account that was invited, even if you are currently using a
              different account.
            </p>
            <p>
              Your work ID will be{" "}
              <strong>
                c:{data.handle}.{data.org.org_id}
              </strong>
              . Before accepting, you will review how it links to your invited
              account. Their apps and history stay separate.
            </p>
            <a href={reviewUrl.toString()}>Sign in and review invitation →</a>
          </>
        ) : data ? (
          <>
            <p>
              Your work ID:{" "}
              <strong>
                c:{data.handle}.{data.org.org_id}
              </strong>
            </p>
            {verified ? (
              <>
                <Alert tone="success" title="Email verified">
                  Your work account is ready to be accepted.
                </Alert>
                <Button onClick={() => handoff(verified)}>
                  Continue to your organization
                </Button>
              </>
            ) : !challenge ? (
              <>
                <p>
                  We will send a verification code to{" "}
                  {data.email ?? "the invited email"}.
                </p>
                <Button
                  loading={send.isPending}
                  onClick={() =>
                    void send
                      .mutateAsync({})
                      .then((result) => setChallenge(result.challenge_id))
                      .catch(() => {})
                  }
                >
                  Send verification code
                </Button>
              </>
            ) : (
              <form
                style={{ display: "grid", gap: 20 }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <Input
                  label="Verification code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
                <Input
                  label="Display name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={100}
                />
                <Input
                  label="Date of birth"
                  type="date"
                  value={dob}
                  onChange={(event) => setDob(event.target.value)}
                  required
                />
                <Input
                  label="Timezone"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  required
                />
                <Button type="submit" loading={verify.isPending}>
                  Verify email and accept work account
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  loading={send.isPending}
                  onClick={() =>
                    void send
                      .mutateAsync({})
                      .then((result) => setChallenge(result.challenge_id))
                      .catch(() => {})
                  }
                >
                  Resend code
                </Button>
              </form>
            )}
          </>
        ) : null}
      </div>
    </HostedFrame>
  );
}

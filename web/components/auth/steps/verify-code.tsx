"use client";

/**
 * verify_code: the 6 digit code that was sent to an email or phone. The code is checked as soon as the last digit
 * lands; "Change" goes back to send it somewhere else; "Resend code" waits for the server's resend time.
 */
import { Button } from "@/components/arc/button/button";
import type { ApiError } from "@/lib/api/errors";
import type { FlowController } from "../flow/controller";
import { useFinePointer, useNow } from "../flow/hooks";
import type { HostedFlow } from "../flow/model";
import { CodeEntry, DestinationRow, FlowAlert, StepHeading, useStepErrors } from "../flow/parts";

export interface VerifyCodeProps {
  flow: HostedFlow;
  ctl: FlowController;
  notice: ApiError | null;
  onChange: () => void;
}

export function VerifyCode({ flow, ctl, notice, onChange }: VerifyCodeProps) {
  const challenge = flow.challenge;
  const now = useNow(1000);
  const fine = useFinePointer();
  // The flow's own error stays until the Carbon types a code or asks for a new one; their failures show by the field.
  const errors = useStepErrors(flow.error ?? notice);
  if (!challenge) return null;
  const at = Date.parse(challenge.expires_at);
  /** Whole minutes the code still works (rounded up, so the last minute reads "1 more minute"); 0 once it expired. */
  const minutesLeft = !Number.isFinite(at) || !now ? 10 : at <= now ? 0 : Math.max(1, Math.ceil((at - now) / 60_000));
  const lifetime = minutesLeft === 0 ? "This code expired, so send a new one below." : `It works for ${minutesLeft === 1 ? "1 more minute" : `${minutesLeft} minutes`}.`;
  const isEmail = challenge.channel === "email";
  const verify = (code: string) => {
    errors.begin();
    return ctl.verify(code);
  };
  const resend = () => {
    errors.begin();
    return ctl.resend();
  };
  return (
    <>
      <StepHeading
        title={isEmail ? "Check your email" : "Check your phone"}
        description={`Enter the 6 digit code we ${isEmail ? "emailed" : "texted"} you. ${lifetime}`}
        noFocus={fine}
      />
      <FlowAlert error={errors.carried} app={flow.app.name} onSwitch={() => ctl.switchAccount()} />
      <DestinationRow
        channel={challenge.channel}
        destination={challenge.destination}
        action={<Button variant="ghost" size="sm" onClick={onChange} aria-label={`Change where the code goes (now ${challenge.destination})`}>Change</Button>}
      />
      <CodeEntry challenge={challenge} verify={verify} resend={resend} label={isEmail ? "Code from the email" : "Code from the text message"} />
    </>
  );
}

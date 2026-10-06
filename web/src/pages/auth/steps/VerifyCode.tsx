/**
 * verify_code: the 6 digit code that was sent to an email or phone. The code is checked as soon as the last digit
 * lands; "Change" goes back to send it somewhere else; "Resend code" waits for the server's resend time.
 */
import { Show, type Accessor } from "solid-js";
import type { ApiError } from "../../../api";
import { Button } from "../../../arc/button/button";
import type { FlowController } from "../flow/controller";
import type { HostedFlow } from "../flow/model";
import { CodeEntry, DestinationRow, FlowAlert, StepHeading, createNow, createStepErrors, finePointer, latest } from "../flow/parts";

export interface VerifyCodeProps {
  flow: Accessor<HostedFlow>;
  ctl: FlowController;
  notice: Accessor<ApiError | null>;
  onChange: () => void;
}

export function VerifyCode(props: VerifyCodeProps) {
  const challenge = latest(() => props.flow().challenge);
  const now = createNow(1000);
  /** Whole minutes the code still works (rounded up, so the last minute reads "1 more minute"); 0 once it expired. */
  const minutesLeft = () => {
    const at = challenge() ? Date.parse(challenge()!.expires_at) : NaN;
    if (!Number.isFinite(at)) return 10;
    return at <= now() ? 0 : Math.max(1, Math.ceil((at - now()) / 60_000));
  };
  const lifetime = () => {
    const minutes = minutesLeft();
    if (minutes === 0) return "This code expired, so send a new one below.";
    return `It works for ${minutes === 1 ? "1 more minute" : `${minutes} minutes`}.`;
  };
  const isEmail = () => challenge()?.channel === "email";
  // The flow's own error stays until the Carbon types a code or asks for a new one; their failures show by the field.
  const errors = createStepErrors(() => props.flow().error ?? props.notice());
  const verify = (code: string) => {
    errors.begin();
    return props.ctl.verify(code);
  };
  const resend = () => {
    errors.begin();
    return props.ctl.resend();
  };
  return (
    <Show when={challenge()}>
      {current => (
        <>
          <StepHeading
            title={isEmail() ? "Check your email" : "Check your phone"}
            description={`Enter the 6 digit code we ${isEmail() ? "emailed" : "texted"} you. ${lifetime()}`}
            noFocus={finePointer()}
          />
          <FlowAlert error={errors.carried()} app={props.flow().app.name} onSwitch={() => props.ctl.switchAccount()} />
          <DestinationRow
            channel={current().channel}
            destination={current().destination}
            action={<Button variant="ghost" size="sm" onClick={() => props.onChange()} aria-label={`Change where the code goes (now ${current().destination})`}>Change</Button>}
          />
          <CodeEntry challenge={current()} verify={verify} resend={resend} label={isEmail() ? "Code from the email" : "Code from the text message"} />
        </>
      )}
    </Show>
  );
}

"use client";

/**
 * complete (and failed): the flow is done and `redirect_to` says where the browser goes: back to the app with a code,
 * or with `error=access_denied` after Cancel, or with `error=login_required` for a `prompt=none` that could not sign
 * in silently. A short success moment (the ring draws around the photo, the check pops in), then the browser leaves.
 *
 * A code works once, so the page goes there once: coming back to a finished flow (the back button) shows a link to
 * the app instead of sending the spent code again. Only addresses that are safe to open (http(s), or a native app's
 * reverse-domain scheme) are ever followed.
 */
import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { ButtonLink } from "@/components/foundation/button-link";
import { appHome, firstName, markRedirected, redirectError, safeRedirect, wasRedirected, type HostedFlow } from "../flow/model";
import { StepHeading, SuccessMark } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface CompleteProps {
  flow: HostedFlow;
}

export function Complete({ flow }: CompleteProps) {
  const reduce = !!useReducedMotion();
  const redirectTo = safeRedirect(flow.redirect_to);
  const failure = redirectError(redirectTo);
  const appName = flow.app.first_party ? "your account" : flow.app.name;
  /** The flow ended, but where it points cannot be opened safely: say so instead of going anywhere. */
  const blocked = !!flow.redirect_to && !redirectTo;
  // Decided once: a flow this browser already left for shows the way back instead of a second redirect.
  const [spent] = useState(() => wasRedirected(flow.id));
  // prompt=none asked for no page at all, and a failed flow has nothing to show: go at once.
  const silent = flow.step === "failed" || /(^|\s)none(\s|$)/.test(flow.prompt ?? "");

  useEffect(() => {
    if (spent || !redirectTo) return;
    const timer = window.setTimeout(() => {
      markRedirected(flow.id);
      window.location.replace(redirectTo);
    }, silent ? 0 : reduce ? 450 : 1200);
    return () => window.clearTimeout(timer);
  }, [spent, redirectTo, silent, reduce, flow.id]);

  if (blocked) {
    return (
      <>
        <StepHeading title="This sign-in stopped here" description={`${appName} asked to send you to an address that is not a web or app address, so Silicon Accounts did not open it.`} />
        <Alert tone="warning" title="Nothing was sent to the app">
          {`Tell the people who run ${appName}: their redirect address must start with https:// (or be a native app's address).`}
        </Alert>
      </>
    );
  }

  if (spent) {
    const home = appHome(flow);
    return (
      <>
        <StepHeading title="This sign-in is finished" description={`You already went back to ${appName} from here. Each sign-in link works once.`} />
        {home ? (
          <ButtonLink href={home} external className={styles.wide}>
            <span className={styles.providerLabel}>Go to {appName} <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" /></span>
          </ButtonLink>
        ) : null}
      </>
    );
  }

  if (failure) {
    const declined = failure.error === "access_denied";
    return (
      <>
        <StepHeading
          title={declined ? "Nothing was shared" : `Returning to ${appName}`}
          description={declined ? `You cancelled, so ${appName} gets nothing. Taking you back now.` : failure.description ?? `Taking you back to ${appName}.`}
          noFocus
        />
        <ButtonLink href={redirectTo ?? "#"} external variant="secondary" className={styles.wide} onClick={() => markRedirected(flow.id)}>Back to {appName}</ButtonLink>
      </>
    );
  }

  const who = flow.signed_in_as;
  return (
    <div className={styles.complete}>
      {who ? <SuccessMark name={who.display_name} photo={who.pfp_url} /> : null}
      <StepHeading
        title={flow.app.first_party ? `Welcome, ${firstName(who?.display_name ?? "")}` : `Signed in to ${flow.app.name}`}
        description={<>{who?.id ? <>As <span className={styles.mono}>{who.id}</span>. </> : null}Taking you to {appName} now.</>}
        noFocus
      />
      <p className="sr-only" role="status">Signed in. Taking you to {appName}.</p>
      <ButtonLink href={redirectTo ?? "#"} external variant="secondary" className={styles.wide} onClick={() => markRedirected(flow.id)}>
        Continue to {appName}
      </ButtonLink>
    </div>
  );
}

"use client";

/**
 * The Opening page (UNDERSTANDING.md "Adding sign-in to an app"): a Carbon pressed "Continue with Google" (or Apple)
 * on the app's own site, so before the browser goes to Google we show, in the app's style and with "Powered by
 * Silicon Accounts" at the bottom, "Opening Google to sign you in to {app}…" (or the app's copy.opening_title), then
 * move on by ourselves after about 900 ms. "Continue to Google" is always there in case the move does not happen, and
 * "Other ways to sign in" leaves for the app's other methods.
 *
 * The move happens once per flow in this tab: coming back from Google with the browser's back button (or reloading
 * after the move) shows the page paused, with the button, instead of sending the Carbon straight back. Reduced motion
 * keeps the same behaviour without the animation.
 *
 * The pulsing dots and the filling bar are CSS animations (flow.module.css), not motion's: this page is usually the
 * card's first view, and the card's AnimatePresence (initial={false}, so the first view does not slide in) holds every
 * motion entrance inside it still. The CSS runs only when motion is allowed; otherwise the dots stay dim and the bar
 * full.
 */
import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/arc/button/button";
import type { FlowController } from "../flow/controller";
import { appSubtitle, autoStartClaimed, claimAutoStart, intentOf, openingTitle, providerName, type HostedFlow } from "../flow/model";
import { AppleMark, FlowAlert, GoogleMark, StepHeading, useStepErrors } from "../flow/parts";
import styles from "../flow/flow.module.css";

/** How long the page shows before the browser moves on to the provider. */
export const OPENING_DELAY_MS = 900;

export interface OpeningProps {
  flow: HostedFlow;
  ctl: FlowController;
  provider: "google" | "apple";
  /** "Other ways to sign in": the app's other methods (none when the provider is its only one). */
  onOtherWays?: () => void;
}

/** The bar fills over exactly the wait before the move. */
const BAR_STYLE = { "--opening-ms": `${OPENING_DELAY_MS}ms` } as CSSProperties;

export function Opening({ flow, ctl, provider, onOtherWays }: OpeningProps) {
  const name = providerName(provider);
  const app = flow.app.name;
  // A flow this tab already moved on (a reload, or back from the provider) waits for a press. The move is claimed when
  // it runs, so a development remount still moves once.
  const [paused, setPaused] = useState(() => autoStartClaimed(flow.id));
  const [busy, setBusy] = useState(false);
  const errors = useStepErrors(null);
  const moving = useRef(false);

  const go = async () => {
    if (moving.current) return;
    moving.current = true;
    errors.begin();
    setBusy(true);
    const failure = await ctl.startProvider(provider);
    // On success the browser is on its way; the button stays busy until the page leaves.
    if (failure) {
      moving.current = false;
      setBusy(false);
      setPaused(true);
      errors.fail(failure);
    }
  };

  const autoMove = useEffectEvent(() => {
    if (claimAutoStart(flow.id)) void go();
    else setPaused(true);
  });
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(autoMove, OPENING_DELAY_MS);
    return () => window.clearTimeout(timer);
    // Scheduled once, on arrival: pausing later (a failed start, back from the provider) never schedules it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back from the provider with the back button (the page comes out of the back-forward cache): paused, usable.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      moving.current = false;
      setBusy(false);
      setPaused(true);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const signup = intentOf(flow) === "signup";
  const title = paused ? (signup ? `Sign up for ${app} with ${name}` : `Sign in to ${app} with ${name}`) : openingTitle(flow.app, provider);
  const description = paused
    ? appSubtitle(flow) ?? `${name} checks it is you, then brings you back to ${app}.`
    : `${name} checks it is you, then brings you back to ${app}.`;

  return (
    <div className={styles.opening} data-opening={provider} data-paused={paused || undefined}>
      <div className={styles.openingMark} aria-hidden="true">
        <span data-sq="surface" className={styles.openingTile}>
          {provider === "google" ? <GoogleMark size={28} /> : <AppleMark size={28} />}
        </span>
        {paused ? null : (
          <span className={styles.openingDots}>
            <span />
            <span />
            <span />
          </span>
        )}
      </div>
      <StepHeading title={title} description={description} noFocus={!paused} />
      <FlowAlert error={errors.current} app={app} />
      {paused ? null : (
        <div className={styles.openingBar} style={BAR_STYLE} aria-hidden="true">
          <span />
        </div>
      )}
      <p className="sr-only" role="status">{paused ? "" : `Opening ${name}.`}</p>
      <div className={styles.actions}>
        <Button type="button" variant={paused ? "primary" : "secondary"} className={styles.wide} loading={busy} onClick={() => void go()} data-provider={provider}>
          <span className={styles.providerLabel}>
            {provider === "google" ? <GoogleMark /> : <AppleMark />}
            Continue to {name}
          </span>
        </Button>
        {onOtherWays ? (
          <button type="button" className={styles.textButton} disabled={busy} onClick={onOtherWays}>
            {signup ? "Other ways to sign up" : "Other ways to sign in"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

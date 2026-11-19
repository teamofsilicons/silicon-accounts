"use client";

/**
 * choose_method: how the Carbon signs in (or signs up: the app's intent=signup shows the sign-up version of the page,
 * the account logic is the same). In sections (Anil, 2026-11-19, /__signin D): the app (its icon, name and tagline; in
 * the split layout the side beside the form shows it), then "Sign in with your Team of Silicons account" ("Sign up
 * with…" on the sign-up page) over the ways in. A browser that is already signed in is offered "Continue as" there
 * (with "Use Another Account", which tells the server to forget it for this flow). Otherwise the app's methods show in
 * its order: Google and Apple as soft buttons, "or get a code", then email and phone as one field ("Email or phone")
 * and "Send Me a Code". The app's own title (copy.title) stays the browser tab's title and the split layout's large
 * text. The prototype's "No passwords" note is gone (Anil, 2026-11-19).
 *
 * `method` narrows the page to one method until the Carbon asks for the others: email or phone opens on that empty
 * field (nothing is ever filled in for the Carbon: an app cannot hand us an email or phone, and login_hint is ignored);
 * Google and Apple first show the Opening page (steps/opening.tsx), and this page only when they come back.
 */
import { useEffect, useState } from "react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import type { ApiError } from "@/lib/api/errors";
import type { FlowController } from "../flow/controller";
import { useFinePointer } from "../flow/hooks";
import { AppMark } from "@/components/account/parts/app-mark";
import { usePaint, useTosFrame } from "../flow/hosted-frame";
import { brandLogo } from "@/lib/branding/apply";
import { normalizeBranding } from "@/lib/branding/defaults";
import type { Branding } from "@/lib/api/types";
import { firstName, intentOf, isProvider, type HostedFlow } from "../flow/model";
import { AccountRow, ContactForm, FlowAlert, OrDivider, ProviderButton, StepHeading, contactKinds, useStepErrors, type ContactKind } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface ContactMemory {
  kind?: ContactKind;
  email?: string;
  phone?: string;
}

export interface ChooseMethodProps {
  flow: HostedFlow;
  ctl: FlowController;
  notice: ApiError | null;
  memory: ContactMemory;
  onSent: (kind: ContactKind, value: string) => void;
  /** Came back from the code to send it somewhere else: show the field only, with a way back. */
  changing?: boolean;
  onBack?: () => void;
  /** Every method from the start (the Carbon chose "Other Ways to Sign In" on the Opening page). */
  wide?: boolean;
}

/** The app's section: its icon (the account site's app mark: one size, one corner), its name and its own tagline. */
function AppSection({ flow }: { flow: HostedFlow }) {
  const paint = usePaint(flow.app, flow.app.first_party);
  const branding = normalizeBranding(flow.app.branding as Partial<Branding> | undefined);
  // Our own first-party apps wear the Silicon Accounts icon, as the frame's header does.
  const logo = brandLogo(branding, flow.app, paint) ?? (flow.app.first_party ? "/icon-512.png" : null);
  const tagline = flow.app.copy.subtitle?.trim() || null;
  return (
    <section className={styles.appSection} aria-label={flow.app.name}>
      <AppMark app={{ app_id: flow.app.app_id, name: flow.app.name, logo_url: logo }} size={40} decorative className={styles.appMark} />
      <div className={styles.appText}>
        <p className={styles.appName}>{flow.app.name}</p>
        {tagline ? <p className={styles.appTagline}>{tagline}</p> : null}
      </div>
    </section>
  );
}

export function ChooseMethod({ flow, ctl, notice, memory, onSent, changing, onBack, wide }: ChooseMethodProps) {
  const [busy, setBusy] = useState<string | null>(null);
  // Newest first: the error the flow arrived with (a cancelled Google sign-in…) steps aside once the Carbon tries
  // something else, so a new failure is never hidden behind an old one.
  const errors = useStepErrors(flow.error ?? notice);
  const [showAll, setShowAll] = useState(!!wide);
  const signup = intentOf(flow) === "signup";
  const fine = useFinePointer();
  const methods = flow.methods;
  const providers = methods.filter(isProvider);
  const contacts = contactKinds(methods);
  const hint = flow.method_hint ?? null;
  /**
   * `method=` narrows the page to that method until the Carbon asks for the others. Never while sending a code
   * somewhere else: that view is the email or phone field alone, whatever method the sign-in started with.
   */
  const narrowed = !changing && !showAll && !!hint && methods.includes(hint) && methods.length > 1;
  const visibleProviders = changing ? [] : narrowed ? providers.filter(method => method === hint) : providers;
  const visibleContacts = narrowed ? contacts.filter(kind => kind === hint) : contacts;
  /** What "Send the code somewhere else" asks for: the kinds the app offers. */
  const changeTarget = contacts.length > 1 ? "email or phone number" : contacts[0] === "phone" ? "phone number" : "email address";
  const firstProvider = methods.findIndex(isProvider);
  const firstContact = methods.findIndex(method => method === "email" || method === "phone");
  const providersFirst = firstProvider >= 0 && (firstContact < 0 || firstProvider < firstContact);
  const signedIn = changing ? null : flow.signed_in_as;
  const initialKind: ContactKind | undefined = memory.kind ?? (hint === "email" || hint === "phone" ? hint : undefined);

  const startProvider = async (provider: "google" | "apple") => {
    errors.begin();
    setBusy(provider);
    const failure = await ctl.startProvider(provider);
    // On success the browser is on its way to the provider; the button stays busy until the page leaves.
    if (failure) {
      setBusy(null);
      errors.fail(failure);
    }
  };

  // Back from the provider with the back button (the page comes out of the back-forward cache): buttons work again.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(null);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const continueAs = async () => {
    errors.begin();
    setBusy("continue");
    const failure = await ctl.continueAs();
    setBusy(null);
    if (failure) errors.fail(failure);
  };

  const chooseAnother = async () => {
    errors.begin();
    setBusy("switch");
    const failure = await ctl.switchAccount();
    setBusy(null);
    if (failure) errors.fail(failure);
  };

  /** A failed send shows under its field (ContactForm), so here it only moves older errors aside. */
  const send = async (kind: ContactKind, value: string, country?: string) => {
    errors.begin();
    const failure = kind === "email" ? await ctl.sendEmail(value) : await ctl.sendPhone(value, country);
    if (!failure) onSent(kind, value);
    return failure;
  };

  const providerButtons = visibleProviders.length ? (
    <div className={styles.providers} data-count={visibleProviders.length}>
      {visibleProviders.map(provider => (
        <ProviderButton key={provider} provider={provider} variant="soft" loading={busy === provider} disabled={!!busy && busy !== provider} onClick={() => void startProvider(provider)} />
      ))}
    </div>
  ) : null;
  const contactForm = visibleContacts.length ? (
    <ContactForm
      kinds={visibleContacts}
      initialKind={initialKind}
      initialEmail={memory.email ?? ""}
      initialPhone={memory.phone ?? ""}
      submitLabel={changing ? "Send Code" : "Send Me a Code"}
      onSubmit={send}
      autoFocus={fine && !signedIn}
      errorContext={{ app: flow.app.name }}
      kindsLabel={signup ? "Sign up with" : "Sign in with"}
    />
  ) : null;
  const both = !!providerButtons && !!contactForm;

  const tos = useTosFrame();
  const split = normalizeBranding(flow.app.branding as Partial<Branding> | undefined).layout === "split";
  const ways = signedIn ? (
    // The account and its two choices: 16 between them, 8 between the choices.
    <div className={styles.continueAs}>
      <AccountRow account={signedIn} />
      <div className={styles.choices}>
        <Button className={styles.wide} loading={busy === "continue"} disabled={busy === "switch"} onClick={() => void continueAs()}>
          Continue as {firstName(signedIn.display_name)}
        </Button>
        <Button variant="soft" className={styles.wide} loading={busy === "switch"} disabled={busy === "continue"} onClick={() => void chooseAnother()}>
          Use Another Account
        </Button>
      </div>
    </div>
  ) : methods.length ? (
    <div className={styles.methods}>
      {providersFirst ? (
        <>
          {providerButtons}
          {both ? <OrDivider label="or get a code" /> : null}
          {contactForm}
        </>
      ) : (
        <>
          {contactForm}
          {both ? <OrDivider /> : null}
          {providerButtons}
        </>
      )}
      {narrowed ? <button type="button" className={styles.textButton} onClick={() => setShowAll(true)}>{signup ? "Other Ways to Sign Up" : "Other Ways to Sign In"}</button> : null}
      {changing && onBack ? <button type="button" className={styles.textButton} onClick={onBack}>Back to the code</button> : null}
    </div>
  ) : (
    <Alert tone="warning" title={`${flow.app.name} has no sign-in methods yet`}>
      {`Nobody can sign in to ${flow.app.name} until it turns on at least one method. If you run this app, turn one on in its sign-in setup on the developer site.`}
    </Alert>
  );

  if (changing) {
    return (
      <>
        <StepHeading title="Send the code somewhere else" description={`Enter the ${changeTarget} to send a new 6 digit code to.`} />
        <FlowAlert error={errors.current} app={flow.app.name} />
        {ways}
      </>
    );
  }

  // Team of Silicons' card (an app in the default look): the bar already says "Sign in with Team of Silicons", so the
  // page heads itself "Sign in" (or "Sign up") "to continue to {app}", centred over the ways in (/__accounts-signin).
  if (tos) {
    return (
      <div className={styles.chooseSections}>
        <div className={styles.tosHead}>
          <StepHeading title={signup ? "Sign up" : "Sign in"} noFocus />
          <p className={styles.tosLine}>to continue to <strong>{flow.app.name}</strong></p>
        </div>
        <div className={styles.signinGroup}>
          <FlowAlert error={errors.current} app={flow.app.name} />
          {ways}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.chooseSections}>
      {split ? null : <AppSection flow={flow} />}
      <section className={styles.signinGroup}>
        <StepHeading title={signup ? "Sign up with your Team of Silicons account" : "Sign in with your Team of Silicons account"} section noFocus />
        <FlowAlert error={errors.current} app={flow.app.name} />
        {ways}
      </section>
    </div>
  );
}

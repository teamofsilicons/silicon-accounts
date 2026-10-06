"use client";

/**
 * choose_method: how the Carbon signs in. A browser that is already signed in is offered "Continue as" first (with
 * "Use another account", which tells the server to forget it for this flow). Otherwise the app's methods show in its
 * order: Google and Apple as neutral buttons, email and phone as one field with a code. `login_hint` fills the field;
 * `method` narrows the page to one method (Google and Apple open at once, a single time per flow).
 */
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import type { ApiError } from "@/lib/api/errors";
import type { FlowController } from "../flow/controller";
import { useFinePointer } from "../flow/hooks";
import { appTitle, claimAutoStart, firstName, isProvider, type HostedFlow } from "../flow/model";
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
}

export function ChooseMethod({ flow, ctl, notice, memory, onSent, changing, onBack }: ChooseMethodProps) {
  const [busy, setBusy] = useState<string | null>(null);
  // Newest first: the error the flow arrived with (a cancelled Google sign-in…) steps aside once the Carbon tries
  // something else, so a new failure is never hidden behind an old one.
  const errors = useStepErrors(flow.error ?? notice);
  const [showAll, setShowAll] = useState(false);
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
  const loginHint = flow.login_hint ?? "";
  const hintedPhone = loginHint.replace(/[\s().-]/g, "");
  const initialKind: ContactKind | undefined = memory.kind ?? (hint === "email" || hint === "phone" ? hint : loginHint.includes("@") ? "email" : /^\+?[\d\s().-]{6,}$/.test(loginHint) ? "phone" : undefined);

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

  // method=google|apple: open the provider straight away, once per flow, never after it came back with an error. It is
  // the press of the button, done for the Carbon: a start that fails (the provider is not set up, the network is down)
  // says why on the card exactly as a press would.
  const autoStart = useRef({ method: hint, flowId: flow.id, allowed: !!hint && isProvider(hint) && methods.includes(hint) && !flow.error && !flow.signed_in_as && !changing });
  const startHinted = useEffectEvent((provider: "google" | "apple") => void startProvider(provider));
  useEffect(() => {
    const { method, flowId, allowed } = autoStart.current;
    if (!allowed || !method || !isProvider(method)) return;
    // Claimed when it runs (not when scheduled), so a remounted page in development still starts it once.
    const timer = window.setTimeout(() => {
      if (claimAutoStart(flowId)) startHinted(method);
    }, 0);
    return () => window.clearTimeout(timer);
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
        <ProviderButton key={provider} provider={provider} loading={busy === provider} disabled={!!busy && busy !== provider} onClick={() => void startProvider(provider)} />
      ))}
    </div>
  ) : null;
  const contactForm = visibleContacts.length ? (
    <ContactForm
      kinds={visibleContacts}
      initialKind={initialKind}
      initialEmail={memory.email ?? (loginHint.includes("@") ? loginHint : "")}
      initialPhone={memory.phone ?? (/^\+\d{6,}$/.test(hintedPhone) ? hintedPhone : "")}
      submitLabel={changing ? "Send code" : "Continue"}
      onSubmit={send}
      autoFocus={fine && !signedIn}
      errorContext={{ app: flow.app.name }}
    />
  ) : null;
  const both = !!providerButtons && !!contactForm;

  return (
    <>
      {changing ? (
        <StepHeading title="Send the code somewhere else" description={`Enter the ${changeTarget} to send a new 6 digit code to.`} />
      ) : (
        <StepHeading title={appTitle(flow)} description={flow.app.copy.subtitle ?? undefined} appTitle noFocus />
      )}
      <FlowAlert error={errors.current} app={flow.app.name} />

      {signedIn ? (
        <div className={styles.continueAs}>
          <AccountRow account={signedIn} />
          <Button className={styles.wide} loading={busy === "continue"} disabled={busy === "switch"} onClick={() => void continueAs()}>
            Continue as {firstName(signedIn.display_name)}
          </Button>
          <Button variant="secondary" className={styles.wide} loading={busy === "switch"} disabled={busy === "continue"} onClick={() => void chooseAnother()}>
            Use another account
          </Button>
        </div>
      ) : methods.length ? (
        <div className={styles.methods}>
          {providersFirst ? (
            <>
              {providerButtons}
              {both ? <OrDivider /> : null}
              {contactForm}
            </>
          ) : (
            <>
              {contactForm}
              {both ? <OrDivider /> : null}
              {providerButtons}
            </>
          )}
          {narrowed ? <button type="button" className={styles.textButton} onClick={() => setShowAll(true)}>Other ways to sign in</button> : null}
          {changing && onBack ? <button type="button" className={styles.textButton} onClick={onBack}>Back to the code</button> : null}
        </div>
      ) : (
        <Alert tone="warning" title={`${flow.app.name} has no sign-in methods yet`}>
          {`Nobody can sign in to ${flow.app.name} until it turns on at least one method. If you run this app, turn one on in its sign-in setup.`}
        </Alert>
      )}
    </>
  );
}

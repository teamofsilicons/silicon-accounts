/**
 * choose_method: how the Carbon signs in. A browser that is already signed in is offered "Continue as" first (with
 * "Use another account", which tells the server to forget it for this flow). Otherwise the app's methods show in its
 * order: Google and Apple as neutral buttons, email and phone as one field with a code. `login_hint` fills the field;
 * `method` jumps straight to one method (Google and Apple open at once, a single time per flow).
 */
import { For, Show, createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import type { ApiError, SigninMethod } from "../../../api";
import { Alert } from "../../../arc/alert/alert";
import { Button } from "../../../arc/button/button";
import { ProviderButton, SignInDivider } from "../../../arc/blocks/sign-in/sign-in";
import type { FlowController } from "../flow/controller";
import { appTitle, claimAutoStart, firstName, isProvider, type HostedFlow } from "../flow/model";
import { AccountRow, ContactForm, FlowAlert, StepHeading, contactKinds, createStepErrors, finePointer, type ContactKind } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface ContactMemory {
  kind?: ContactKind;
  email?: string;
  phone?: string;
}

export interface ChooseMethodProps {
  flow: Accessor<HostedFlow>;
  ctl: FlowController;
  notice: Accessor<ApiError | null>;
  memory: ContactMemory;
  onSent: (kind: ContactKind, value: string) => void;
  /** Came back from the code to send it somewhere else: show the field only, with a way back. */
  changing?: boolean;
  onBack?: () => void;
}

export function ChooseMethod(props: ChooseMethodProps) {
  const flow = props.flow;
  const [busy, setBusy] = createSignal<string | null>(null);
  // Newest first: the error the flow arrived with (a cancelled Google sign-in…) steps aside once the Carbon tries
  // something else, so a new failure is never hidden behind an old one.
  const errors = createStepErrors(() => flow().error ?? props.notice());
  const [showAll, setShowAll] = createSignal(false);
  const methods = () => flow().methods;
  const providers = () => methods().filter(isProvider);
  const contacts = () => contactKinds(methods());
  const hint = () => flow().method_hint ?? null;
  /** `method=` narrows the page to that method until the Carbon asks for the others. */
  const narrowed = () => !showAll() && !!hint() && methods().includes(hint() as SigninMethod) && methods().length > 1;
  const visibleProviders = () => (narrowed() ? providers().filter(method => method === hint()) : props.changing ? [] : providers());
  const visibleContacts = () => (narrowed() ? contacts().filter(kind => kind === hint()) : contacts());
  const providersFirst = () => {
    const firstProvider = methods().findIndex(isProvider);
    const firstContact = methods().findIndex(method => method === "email" || method === "phone");
    return firstProvider >= 0 && (firstContact < 0 || firstProvider < firstContact);
  };
  const signedIn = () => (props.changing ? null : flow().signed_in_as);
  const loginHint = () => flow().login_hint ?? "";
  const initialKind = (): ContactKind | undefined => {
    if (props.memory.kind) return props.memory.kind;
    const h = hint();
    if (h === "email" || h === "phone") return h;
    if (loginHint().includes("@")) return "email";
    if (/^\+?[\d\s().-]{6,}$/.test(loginHint())) return "phone";
    return undefined;
  };

  const startProvider = async (provider: "google" | "apple") => {
    errors.begin();
    setBusy(provider);
    const failure = await props.ctl.startProvider(provider);
    // On success the browser is on its way to the provider; keep the button busy until the page leaves.
    if (failure) {
      setBusy(null);
      errors.fail(failure);
    }
  };

  // Back from the provider with the back button (the page comes out of the back-forward cache): buttons work again.
  onMount(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(null);
    };
    window.addEventListener("pageshow", onShow);
    onCleanup(() => window.removeEventListener("pageshow", onShow));
  });

  // method=google|apple: open the provider straight away, once per flow, never after it came back with an error.
  onMount(() => {
    const h = hint();
    if (!h || !isProvider(h) || !methods().includes(h) || flow().error || signedIn() || props.changing) return;
    if (claimAutoStart(flow().id)) void startProvider(h);
  });

  const continueAs = async () => {
    errors.begin();
    setBusy("continue");
    const failure = await props.ctl.continueAs();
    setBusy(null);
    if (failure) errors.fail(failure);
  };

  const useAnother = async () => {
    errors.begin();
    setBusy("switch");
    const failure = await props.ctl.switchAccount();
    setBusy(null);
    if (failure) errors.fail(failure);
  };

  /** A failed send shows under its field (ContactForm), so here it only moves older errors aside. */
  const send = async (kind: ContactKind, value: string, country?: string) => {
    errors.begin();
    const failure = kind === "email" ? await props.ctl.sendEmail(value) : await props.ctl.sendPhone(value, country);
    if (!failure) props.onSent(kind, value);
    return failure;
  };

  const providerButtons = () => (
    <Show when={visibleProviders().length}>
      <div class={styles.providers} data-count={visibleProviders().length}>
        <For each={visibleProviders()}>
          {provider => (
            <ProviderButton provider={provider} loading={busy() === provider} disabled={!!busy() && busy() !== provider} onClick={() => void startProvider(provider)} />
          )}
        </For>
      </div>
    </Show>
  );
  const contactForm = () => (
    <Show when={visibleContacts().length}>
      <ContactForm
        kinds={visibleContacts()}
        initialKind={initialKind()}
        initialEmail={props.memory.email ?? (loginHint().includes("@") ? loginHint() : "")}
        initialPhone={props.memory.phone ?? (/^\+\d{6,}$/.test(loginHint().replace(/[\s().-]/g, "")) ? loginHint().replace(/[\s().-]/g, "") : "")}
        submitLabel={props.changing ? "Send code" : "Continue"}
        onSubmit={send}
        autoFocus={finePointer() && !signedIn()}
      />
    </Show>
  );
  const both = () => visibleProviders().length > 0 && visibleContacts().length > 0;

  return (
    <>
      <Show
        when={!props.changing}
        fallback={<StepHeading title="Send the code somewhere else" description="Enter the email or phone number to send a new 6 digit code to." />}
      >
        <StepHeading title={appTitle(flow())} description={flow().app.copy.subtitle ?? undefined} appTitle noFocus />
      </Show>
      <FlowAlert error={errors.current()} app={flow().app.name} />

      <Show
        when={signedIn()}
        fallback={
          <Show
            when={methods().length}
            fallback={
              <Alert tone="warning" title={`${flow().app.name} has no sign-in methods yet`}>
                Nobody can sign in to {flow().app.name} until it turns on at least one method. If you run this app, turn one on in its sign-in setup.
              </Alert>
            }
          >
            <div class={styles.methods}>
              <Show when={providersFirst()} fallback={<>{contactForm()}<Show when={both()}><SignInDivider /></Show>{providerButtons()}</>}>
                {providerButtons()}
                <Show when={both()}><SignInDivider /></Show>
                {contactForm()}
              </Show>
              <Show when={narrowed()}>
                <button type="button" class={styles.textButton} onClick={() => setShowAll(true)}>Other ways to sign in</button>
              </Show>
              <Show when={props.changing && props.onBack}>
                <button type="button" class={styles.textButton} onClick={() => props.onBack?.()}>Back to the code</button>
              </Show>
            </div>
          </Show>
        }
      >
        {account => (
          <div class={styles.continueAs}>
            <AccountRow account={account()} />
            <Button class={styles.wide} loading={busy() === "continue"} disabled={busy() === "switch"} onClick={() => void continueAs()}>
              Continue as {firstName(account().display_name)}
            </Button>
            <Button variant="secondary" class={styles.wide} loading={busy() === "switch"} disabled={busy() === "continue"} onClick={() => void useAnother()}>
              Use another account
            </Button>
          </div>
        )}
      </Show>
    </>
  );
}

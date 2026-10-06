/**
 * /authorize/flow/:id: the hosted sign-in, driven by FlowView.step and painted with the app's branding.
 *
 *   choose_method → verify_code → signup (new) → requirements (a missing email/phone) → consent → complete
 *   (or failed, for prompt=none)
 *
 * The card morphs between steps (the Arc sign-in block). The page never decides where a sign-in goes next: the server
 * answers every action with the new FlowView. What the page owns is the moment-to-moment: the typed email or phone
 * (so "Change" can bring it back), sending a code somewhere else, and the photo picked at sign-up.
 */
import { useNavigate, useParams } from "@solidjs/router";
import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type Accessor, type JSX } from "solid-js";
import { ApiError } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { paths } from "../../app/navigation";
import { createFlowController } from "./flow/controller";
import { HostedFrame } from "./flow/HostedFrame";
import { StepMorph } from "./flow/StepMorph";
import { resetArrival } from "./flow/parts";
import { appHome, appTitle, authorizeQueryOf, takeHandedOver, type HostedFlow } from "./flow/model";
import { ChooseMethod, type ContactMemory } from "./steps/ChooseMethod";
import { Complete } from "./steps/Complete";
import { Consent } from "./steps/Consent";
import { Requirements } from "./steps/Requirements";
import { Signup } from "./steps/Signup";
import { VerifyCode } from "./steps/VerifyCode";
import { LoadingCard, Problem } from "./Problem";
import styles from "./flow/flow.module.css";

/** Views in their usual order (sub-views sort just after their step) for the direction of the morph. */
const VIEW_ORDER = ["loading", "choose_method", "verify_code", "signup", "requirements", "consent", "complete", "failed"] as const;

export default function Flow() {
  const params = useParams<{ id: string }>();
  // A different flow id is a different sign-in: start its page fresh.
  return <Show keyed when={params.id}>{id => <FlowPage id={id} />}</Show>;
}

function FlowPage(props: { id: string }) {
  resetArrival();
  const navigate = useNavigate();
  const ctl = createFlowController(props.id, takeHandedOver(props.id));
  if (!untrack(ctl.flow)) void ctl.reload();

  const [changing, setChanging] = createSignal(false);
  const [memory, setMemory] = createSignal<ContactMemory>({});
  const [photoWarning, setPhotoWarning] = createSignal<ApiError | null>(null);
  const [restored, setRestored] = createSignal(0);

  // Leaving the code to send it elsewhere ends when the flow moves on (a new code, another step), and only then: a
  // re-read that changes neither (after a refused address, say) keeps the field and its error on screen. The memo
  // compares a string, so an identical re-read never reaches the effect.
  const challengeKey = createMemo(() => {
    const flow = ctl.flow();
    return `${flow?.step ?? ""}|${flow?.challenge?.expires_at ?? ""}`;
  });
  createEffect(on(challengeKey, () => setChanging(false), { defer: true }));

  // Back to this page from the app (the back-forward cache): a finished flow must not send its spent code again.
  onMount(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setRestored(value => value + 1);
    };
    window.addEventListener("pageshow", onShow);
    onCleanup(() => window.removeEventListener("pageshow", onShow));
  });

  const view = createMemo(() => {
    const flow = ctl.flow();
    if (!flow) return "loading";
    if (flow.step === "verify_code" && changing()) return "choose_method:change";
    if (flow.step === "choose_method" && flow.signed_in_as) return "choose_method:account";
    if (flow.step === "complete" || flow.step === "failed") return `${flow.step}:${restored()}`;
    return flow.step;
  });

  /** The flow as one view saw it last: a leaving view keeps showing what it showed while it morphs away. */
  const snapshot = (key: string): Accessor<HostedFlow> => {
    let last = untrack(ctl.flow) as HostedFlow;
    return createMemo(() => {
      const flow = ctl.flow();
      if (flow && view() === key) last = flow;
      return last;
    });
  };

  // The tab says where the Carbon is signing in.
  createEffect(() => {
    const flow = ctl.flow();
    document.title = flow ? appTitle(flow) : ctl.failure() ? "Sign-in problem · Silicon Accounts" : "Signing in · Silicon Accounts";
  });
  onCleanup(() => {
    document.title = "Silicon Accounts";
  });

  const restart = () => {
    const query = authorizeQueryOf(props.id);
    if (query) navigate(`${paths.authorize}?${query}`, { replace: true });
  };

  const renderView = (key: string): JSX.Element => {
    const flow = snapshot(key);
    const base = key.split(":")[0];
    switch (base) {
      case "choose_method":
        return (
          <ChooseMethod
            flow={flow}
            ctl={ctl}
            notice={ctl.notice}
            memory={memory()}
            onSent={(kind, value) => setMemory(kind === "email" ? { kind, email: value, phone: memory().phone } : { kind, phone: value, email: memory().email })}
            changing={key === "choose_method:change"}
            onBack={() => setChanging(false)}
          />
        );
      case "verify_code":
        return <VerifyCode flow={flow} ctl={ctl} notice={ctl.notice} onChange={() => setChanging(true)} />;
      case "signup":
        return <Signup flow={flow} ctl={ctl} notice={ctl.notice} onPhotoFailed={setPhotoWarning} />;
      case "requirements":
        return <Requirements flow={flow} ctl={ctl} notice={ctl.notice} />;
      case "consent":
        return <Consent flow={flow} ctl={ctl} notice={ctl.notice} />;
      case "complete":
      case "failed":
        return <Complete flow={flow} warning={photoWarning} />;
      default:
        return <LoadingCard />;
    }
  };

  return (
    <Show when={!ctl.failure()} fallback={<FlowProblem error={ctl.failure() as ApiError} flow={ctl.flow()} canRestart={!!authorizeQueryOf(props.id)} onRestart={restart} onRetry={() => void ctl.reload()} />}>
      <HostedFrame
        app={ctl.flow()?.app ?? null}
        site={!!ctl.flow()?.app.first_party}
        title={ctl.flow() ? appTitle(ctl.flow() as HostedFlow) : "Signing in"}
        subtitle={ctl.flow()?.app.copy.subtitle}
        busy={ctl.loading()}
        hideName={view().startsWith("choose_method") && !!ctl.flow() && appTitle(ctl.flow() as HostedFlow).trim().toLowerCase() === ctl.flow()?.app.name.trim().toLowerCase()}
        footer={<Show when={ctl.flow()}>{flow => <FlowFooter flow={flow()} step={view()} />}</Show>}
      >
        <Show when={photoWarning() && !view().startsWith("complete")}>
          <Alert tone="warning" title="Your photo did not upload" onDismiss={() => setPhotoWarning(null)}>
            {photoWarning()?.message} Your account is ready; you can add a photo later in your account.
          </Alert>
        </Show>
        <StepMorph view={view()} order={VIEW_ORDER}>
          {key => renderView(key)}
        </StepMorph>
      </HostedFrame>
    </Show>
  );
}

/** Terms and privacy where the Carbon commits (methods, sign-up, consent), and the app's support address. */
function FlowFooter(props: { flow: HostedFlow; step: string }) {
  const copy = () => props.flow.app.copy;
  const legal = () => ["choose_method", "signup", "consent"].includes(props.step.split(":")[0] ?? "") && (copy().terms_url || copy().privacy_url);
  const name = () => props.flow.app.name;
  return (
    <Show when={legal() || copy().support_email}>
      <div class={styles.footer}>
        <Show when={legal()}>
          <p class="sa-brand-legal">
            By continuing, you agree to the{" "}
            <Show when={copy().terms_url}>{url => <a href={url()} target="_blank" rel="noopener noreferrer">terms</a>}</Show>
            <Show when={copy().terms_url && copy().privacy_url}> and </Show>
            <Show when={copy().privacy_url}>{url => <a href={url()} target="_blank" rel="noopener noreferrer">privacy policy</a>}</Show>
            {" "}of {name()}.
          </p>
        </Show>
        <Show when={copy().support_email}>
          {email => <p class="sa-brand-legal">Need help? Write to <a href={`mailto:${email()}`}>{email()}</a>.</p>}
        </Show>
      </div>
    </Show>
  );
}

/** The flow cannot go on: expired, ended, bound to another browser, or unreachable. */
function FlowProblem(props: { error: ApiError; flow: HostedFlow | null; canRestart: boolean; onRestart: () => void; onRetry: () => void }) {
  const app = () => props.flow?.app ?? null;
  const name = () => app()?.name ?? "the app";
  const home = () => (props.flow ? appHome(props.flow) : null);
  const homeAction = () => (home() ? [{ label: `Go to ${name()}`, href: home() as string, variant: "secondary" as const }] : []);
  switch (props.error.code) {
    case "flow_expired":
      return (
        <Problem
          app={app()}
          title="This sign-in expired"
          message={`A sign-in stays open for 60 minutes, and this one ran out. ${props.canRestart ? "Start it again: it takes a moment, and anything you verified in the last 48 hours is still ready." : `Start again from ${name()}.`}`}
          error={props.error}
          actions={[...(props.canRestart ? [{ label: "Start again", onClick: props.onRestart }] : []), ...homeAction()]}
        />
      );
    case "flow_not_bound":
      return (
        <Problem
          app={app()}
          title="Finish signing in where you started"
          message="This sign-in belongs to the browser it started in, and this browser is a different one (or its cookies were cleared)."
          hint={props.canRestart ? "Start again here, or go back to the browser you started in." : `Go back to the browser you started in, or start again from ${name()}.`}
          error={props.error}
          actions={[...(props.canRestart ? [{ label: "Start again here", onClick: props.onRestart }] : []), ...homeAction()]}
        />
      );
    case "flow_not_found":
      return (
        <Problem
          app={app()}
          title="This sign-in has ended"
          message="The sign-in link is no longer open: it finished, or it expired and was cleared away."
          hint={props.flow ? `Start again from ${name()}.` : "Start again from the app you were signing in to."}
          error={props.error}
          actions={[...(props.canRestart ? [{ label: "Start again", onClick: props.onRestart }] : []), ...homeAction()]}
        />
      );
    default:
      return (
        <Problem
          app={app()}
          title={props.error.isNetwork ? "Silicon Accounts is unreachable" : "This sign-in can't continue"}
          message={props.error.message}
          hint={props.error.hint}
          error={props.error}
          actions={[{ label: "Try again", onClick: props.onRetry }, ...homeAction()]}
        />
      );
  }
}

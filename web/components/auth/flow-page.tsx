"use client";

/**
 * /authorize/flow/[id]: the hosted sign-in, driven by FlowView.step and painted with the app's branding.
 *
 *   choose_method → verify_code → signup (new) → requirements (a missing email/phone) → consent → complete
 *   (or failed, for prompt=none)
 *
 * The card morphs between steps. The page never decides where a sign-in goes next: the server answers every action
 * with the new FlowView. What the page owns is the moment-to-moment: the typed email or phone (so "Change" can bring
 * it back), sending a code somewhere else, and the photo picked at sign-up.
 *
 * Google and Apple return here too (the GET that reads the flow finishes the provider leg). The flow is read in the
 * browser (its cookies prove it is this browser's), so the server renders a quiet loading card in the site's look,
 * and the app's look follows once the flow is known (at once when this tab saw the flow before).
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApiError } from "@/lib/api/errors";
import { paths } from "@/lib/navigation";
import { useFlowController } from "./flow/controller";
import { carbonError } from "./flow/errors";
import { useHydrated } from "./flow/hooks";
import { HostedFrame } from "./flow/hosted-frame";
import { appHome, appTitle, authorizeQueryOf, heroCopy, lookOfFlow, type FrameApp, type HostedFlow } from "./flow/model";
import { StepMorph } from "./flow/morph";
import { ArrivalContext } from "./flow/parts";
import { LoadingCard, Problem } from "./flow/problem";
import { ChooseMethod, type ContactMemory } from "./steps/choose-method";
import { Complete } from "./steps/complete";
import { Consent } from "./steps/consent";
import { Requirements } from "./steps/requirements";
import { Signup } from "./steps/signup";
import { VerifyCode } from "./steps/verify-code";
import styles from "./flow/flow.module.css";

/** Views in their usual order (sub-views sort just after their step) for the direction of the morph. */
const VIEW_ORDER = ["loading", "choose_method", "verify_code", "signup", "requirements", "consent", "complete", "failed"] as const;

export function Flow({ id }: { id: string }) {
  const hydrated = useHydrated();
  // Before hydration (and on the server) the flow is unknown: a quiet card in the site's look, the same both times.
  if (!hydrated) {
    return (
      // No "Powered by" until hydration: its palette follows the visitor's theme, known only in the browser.
      <HostedFrame app={null} site title="Signing in" busy poweredBy={false}>
        <LoadingCard />
      </HostedFrame>
    );
  }
  // A different flow id is a different sign-in: its page starts fresh.
  return <FlowPage key={id} id={id} />;
}

function FlowPage({ id }: { id: string }) {
  const router = useRouter();
  const ctl = useFlowController(id);
  const arrival = useRef(false);
  const flow = ctl.flow;
  const [changing, setChanging] = useState(false);
  const [memory, setMemory] = useState<ContactMemory>({});
  const [restored, setRestored] = useState(0);
  const [firstVisit, setFirstVisit] = useState(false);
  const [canRestart] = useState(() => !!authorizeQueryOf(id));
  const [look] = useState(() => lookOfFlow(id));

  // Leaving the code to send it elsewhere ends when the flow moves on (a new code, another step), and only then: a
  // re-read that changes neither (after a refused address, say) keeps the field and its error on screen.
  const challengeKey = `${flow?.step ?? ""}|${flow?.challenge?.expires_at ?? ""}`;
  const [seenChallenge, setSeenChallenge] = useState(challengeKey);
  if (seenChallenge !== challengeKey) {
    setSeenChallenge(challengeKey);
    setChanging(false);
  }
  // The split layout's hero welcomes a new account differently from a returning one.
  if (flow?.step === "signup" && !firstVisit) setFirstVisit(true);

  // Back to this page from the app (the back-forward cache): a finished flow must not send its spent code again.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setRestored(value => value + 1);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // The tab says where the Carbon is signing in.
  const tabTitle = flow ? appTitle(flow) : ctl.failure ? "Sign-in problem" : "Signing in";
  useEffect(() => {
    document.title = `${tabTitle} · Silicon Accounts`;
  }, [tabTitle]);

  const restart = () => {
    const query = authorizeQueryOf(id);
    if (query) router.replace(`${paths.authorize}?${query}`);
  };

  if (ctl.failure) {
    return (
      <ArrivalContext.Provider value={arrival}>
        <FlowProblem error={ctl.failure} flow={flow} look={look ? { app_id: look.app_id, name: look.name, branding: look.branding } : null} canRestart={canRestart} onRestart={restart} onRetry={() => void ctl.reload()} />
      </ArrivalContext.Provider>
    );
  }

  const view = !flow
    ? "loading"
    : flow.step === "verify_code" && changing
      ? "choose_method:change"
      : flow.step === "choose_method" && flow.signed_in_as
        ? "choose_method:account"
        : flow.step === "complete" || flow.step === "failed"
          ? `${flow.step}:${restored}`
          : flow.step;

  const renderView = (key: string) => {
    if (!flow) return <LoadingCard />;
    switch (key.split(":")[0]) {
      case "choose_method":
        return (
          <ChooseMethod
            flow={flow}
            ctl={ctl}
            notice={ctl.notice}
            memory={memory}
            onSent={(kind, value) => setMemory(current => (kind === "email" ? { kind, email: value, phone: current.phone } : { kind, phone: value, email: current.email }))}
            changing={key === "choose_method:change"}
            onBack={() => setChanging(false)}
          />
        );
      case "verify_code":
        return <VerifyCode flow={flow} ctl={ctl} notice={ctl.notice} onChange={() => setChanging(true)} />;
      case "signup":
        return <Signup flow={flow} ctl={ctl} notice={ctl.notice} />;
      case "requirements":
        return <Requirements flow={flow} ctl={ctl} notice={ctl.notice} />;
      case "consent":
        return <Consent flow={flow} ctl={ctl} notice={ctl.notice} />;
      case "complete":
      case "failed":
        return <Complete flow={flow} />;
      default:
        return <LoadingCard />;
    }
  };

  const frameApp = flow?.app ?? (look ? { app_id: look.app_id, name: look.name, branding: look.branding } : null);
  const site = flow ? flow.app.first_party : !look;
  const hero = flow ? heroCopy(flow, { firstVisit }) : { title: look ? `Sign in to ${look.name}` : "Signing in", subtitle: null };
  const hideName = !!flow && view.startsWith("choose_method") && appTitle(flow).trim().toLowerCase() === flow.app.name.trim().toLowerCase();

  return (
    <ArrivalContext.Provider value={arrival}>
      <HostedFrame
        app={frameApp}
        site={site}
        title={hero.title}
        subtitle={hero.subtitle}
        busy={ctl.loading}
        hideName={hideName}
        footer={flow ? <FlowFooter flow={flow} step={view} /> : null}
      >
        <StepMorph view={view} order={VIEW_ORDER}>{renderView}</StepMorph>
      </HostedFrame>
    </ArrivalContext.Provider>
  );
}

/** Terms and privacy where the Carbon commits (methods, sign-up, consent), and the app's support address. */
function FlowFooter({ flow, step }: { flow: HostedFlow; step: string }) {
  const copy = flow.app.copy;
  const base = step.split(":")[0] ?? "";
  const legal = ["choose_method", "signup", "consent"].includes(base) && !!(copy.terms_url || copy.privacy_url);
  if (!legal && !copy.support_email) return null;
  return (
    <div className={styles.footer}>
      {legal ? (
        <p className="sa-brand-legal">
          By continuing, you agree to the{" "}
          {copy.terms_url ? <a href={copy.terms_url} target="_blank" rel="noopener noreferrer">terms</a> : null}
          {copy.terms_url && copy.privacy_url ? " and " : null}
          {copy.privacy_url ? <a href={copy.privacy_url} target="_blank" rel="noopener noreferrer">privacy policy</a> : null}
          {" "}of {flow.app.name}.
        </p>
      ) : null}
      {copy.support_email ? (
        <p className="sa-brand-legal">Need help? Write to <a href={`mailto:${copy.support_email}`}>{copy.support_email}</a>.</p>
      ) : null}
    </div>
  );
}

/** The flow cannot go on: expired, ended, bound to another browser, or unreachable. */
function FlowProblem({ error, flow, look, canRestart, onRestart, onRetry }: { error: ApiError; flow: HostedFlow | null; look: FrameApp | null; canRestart: boolean; onRestart: () => void; onRetry: () => void }) {
  // The app's look when this tab saw the flow before it ended (a flow that expired while open, say).
  const app: FrameApp | null = flow?.app ?? look;
  const name = app?.name ?? "the app";
  const home = flow ? appHome(flow) : null;
  const homeAction = home ? [{ label: `Go to ${name}`, href: home, external: true, variant: "secondary" as const }] : [];
  switch (error.code) {
    case "flow_expired":
      return (
        <Problem
          app={app}
          title="This sign-in expired"
          message={`A sign-in stays open for 60 minutes, and this one ran out. ${canRestart ? "Start it again: it takes a moment, and anything you verified in the last 48 hours is still ready." : `Start again from ${name}.`}`}
          error={error}
          actions={[...(canRestart ? [{ label: "Start again", onClick: onRestart }] : []), ...homeAction]}
        />
      );
    case "flow_not_bound":
      return (
        <Problem
          app={app}
          title="Finish signing in where you started"
          message="This sign-in belongs to the browser it started in, and this browser is a different one (or its cookies were cleared)."
          hint={canRestart ? "Start again here, or go back to the browser you started in." : `Go back to the browser you started in, or start again from ${name}.`}
          error={error}
          actions={[...(canRestart ? [{ label: "Start again here", onClick: onRestart }] : []), ...homeAction]}
        />
      );
    case "flow_not_found":
      return (
        <Problem
          app={app}
          title="This sign-in has ended"
          message="The sign-in link is no longer open: it finished, or it expired and was cleared away."
          hint={flow ? `Start again from ${name}.` : "Start again from the app you were signing in to."}
          error={error}
          actions={[...(canRestart ? [{ label: "Start again", onClick: onRestart }] : []), ...homeAction]}
        />
      );
    default: {
      const words = carbonError(error, { app: app?.name });
      return (
        <Problem
          app={app}
          title={error.isNetwork ? "Silicon Accounts is unreachable" : "This sign-in can't continue"}
          message={words.text}
          error={error}
          actions={[{ label: "Try again", onClick: onRetry }, ...homeAction]}
        />
      );
    }
  }
}

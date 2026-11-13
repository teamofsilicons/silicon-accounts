"use client";

/**
 * /interface-authorize: an Interface asks to sign you in to its apps. On the hosted steps' parts, as the consent step
 * draws it (steps/consent-aligned.tsx): the heading, your AccountRow with Switch Account, one list of the apps (each with
 * what it always sees), a Switch for each detail you may choose to share, then Continue and Deny. A signed-out visitor,
 * or one the Interface sends with a provider, signs in first and comes back here.
 */
import { Fragment, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Cake, Clock, Mail, Phone, UserRound } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Switch } from "@teamofsilicons/silicon-ui/switch";
import { AppMark } from "@/components/account/parts/app-mark";
import { Row, Section, Tile } from "@/components/account/parts/rows";
import { ApiError } from "@/lib/api/errors";
import { useSession } from "@/lib/query/session";
import { useInterfaceAuth, type InterfaceFlow } from "@/lib/query/interface-auth";
import { HostedFrame } from "./flow/hosted-frame";
import { AccountRow, StepHeading } from "./flow/parts";
import { LoadingCard } from "./flow/problem";
import flowStyles from "./flow/flow.module.css";

const REQUIRED = ["interface_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"] as const;

/** The icons Connected Apps and the consent step use for each detail. */
const ICON: Record<string, ReactNode> = {
  email: <Mail size={16} strokeWidth={2} />,
  phone: <Phone size={16} strokeWidth={2} />,
  dob: <Cake size={16} strokeWidth={2} />,
  timezone: <Clock size={16} strokeWidth={2} />,
};

export function InterfaceAuthorize({ query }: { query: Record<string, string> }) {
  const router = useRouter();
  const { status, session } = useSession();
  const { start, decide } = useInterfaceAuth();
  const [flow, setFlow] = useState<InterfaceFlow | null>(null);
  const [actionError, setError] = useState<ApiError | null>(null);
  const initialError = query.proof_error === "storage"
    ? new ApiError({ status: 0, code: "storage_unavailable", message: "This browser could not store the sign-in proof. Enable session storage and start again." })
    : status === "error"
    ? new ApiError({ status: 0, code: "session_error", message: "Silicon Accounts could not read your sign-in. Reload this page to try again." })
    : REQUIRED.some(key => !query[key]) || (!!query.method && !["google", "apple"].includes(query.method))
      ? new ApiError({ status: 400, code: "invalid_request", message: "This sign-in link is missing information. Return to the Interface and try again." })
      : null;
  const error = actionError ?? initialError;
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [pending, setPending] = useState(false);
  const started = useRef(false);
  const target = query.redirect_uri ?? "";
  const proofKey = `silicon-accounts:interface-proof:${query.interface_id}:${query.state}`;
  const returnTo = `/interface-authorize?${new URLSearchParams(Object.fromEntries(REQUIRED.map(key => [key, query[key] ?? ""]))).toString()}`;
  const signInPath = (force: boolean) => {
    const binding = JSON.stringify({ interface_id: query.interface_id, redirect_uri: query.redirect_uri, state: query.state, code_challenge: query.code_challenge });
    const params = new URLSearchParams({ return_to: returnTo, interface_id: query.interface_id, interface_request: binding });
    if (query.method) { params.set("method", query.method); params.set("prompt", "login"); }
    else if (force) params.set("prompt", "select_account");
    return `/sign-in?${params.toString()}`;
  };

  const finish = async (current: InterfaceFlow, approve: boolean) => {
    try {
      const result = await decide.mutateAsync({ id: current.flow_id, approve, optional_scopes: approve ? selected : {} });
      const registered = new URL(target);
      const redirect = new URL(result.redirect_to);
      if (registered.origin !== redirect.origin || registered.pathname !== redirect.pathname || registered.protocol !== redirect.protocol) throw new Error("The return address did not match this sign-in.");
      window.location.replace(redirect.toString());
    } catch (reason) {
      setError(ApiError.from(reason));
      setPending(false);
    }
  };
  const choose = (approve: boolean) => {
    if (!flow) return;
    setPending(true);
    setError(null);
    void finish(flow, approve);
  };
  const begin = async () => {
    try {
      const body = Object.fromEntries(REQUIRED.map(key => [key, query[key]]));
      const proof = sessionStorage.getItem(proofKey);
      if (proof) body.signin_proof = proof;
      const current = await start.mutateAsync(body);
      if (proof) sessionStorage.removeItem(proofKey);
      setFlow(current);
      if (!current.consent_required) await finish(current, true);
    } catch (reason) {
      const failure = ApiError.from(reason);
      if (failure.code === "interface_signin_required") { router.replace(signInPath(true)); return; }
      setError(failure);
    }
  };
  const arrive = useEffectEvent(() => {
    if (started.current || status === "loading") return;
    if (query.proof_error === "storage" || status === "error" || REQUIRED.some(key => !query[key]) || (!!query.method && !["google", "apple"].includes(query.method))) return;
    started.current = true;
    if (status === "signed_out" || query.method) {
      router.replace(signInPath(false));
      return;
    }
    void begin();
  });
  // Start the server flow when the session loads; state changes only after network replies.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { arrive(); }, [status]);

  const share = (appId: string, scope: string, on: boolean) => setSelected(previous => {
    const current = previous[appId] ?? [];
    return { ...previous, [appId]: on ? [...current, scope] : current.filter(item => item !== scope) };
  });
  const frame = flow ? { app_id: flow.interface.interface_id, name: flow.interface.name, logo_url: flow.interface.logo_url, branding: flow.interface.branding } : null;
  const title = flow ? `Sign in to ${flow.interface.name}` : "Sign in to an Interface";
  return (
    <HostedFrame app={frame} title={title} busy={pending || (!flow && !error)}>
      {!flow && !error ? <LoadingCard /> : error ? (
        <div className={flowStyles.step} role="alert">
          <StepHeading title="This sign-in could not continue" description={error.message} noFocus />
          <div className={flowStyles.actions}>
            {error.code === "required_detail_missing" ? (
              <Button className={flowStyles.wide} onClick={() => router.push(`/sign-in-methods?${new URLSearchParams({ return_to: returnTo }).toString()}`)}>Add the Required Detail</Button>
            ) : error.code === "invalid_signin_proof" ? (
              <Button className={flowStyles.wide} onClick={() => { sessionStorage.removeItem(proofKey); router.replace(signInPath(true)); }}>Start Sign-In Again</Button>
            ) : null}
            <Button variant="secondary" className={flowStyles.wide} onClick={() => window.location.reload()}>Try Again</Button>
          </div>
        </div>
      ) : flow ? (
        <div className={flowStyles.step}>
          <StepHeading title={`Continue to ${flow.interface.name}`} description={`${flow.interface.name} will sign you in to these apps.`} />
          {session ? <AccountRow account={session.account} action={<Button variant="link" size="sm" disabled={pending} onClick={() => router.push(signInPath(true))}>Switch Account</Button>} /> : null}
          <Section id="interface-apps" label={`Apps ${flow.interface.name} signs you in to`}>
            {flow.apps.map(app => (
              <Fragment key={app.app_id}>
                <Row
                  lead={<AppMark app={{ app_id: app.app_id, name: app.name, logo_url: app.logo_url }} size={28} decorative />}
                  title={app.name}
                  detail={`Sees your ${app.scopes.join(", ")}`}
                />
                {app.optional_scopes.map(scope => (
                  <Row key={scope} lead={<Tile>{ICON[scope] ?? <UserRound size={16} strokeWidth={2} />}</Tile>} title={`Share your ${scope}`} detail={`Optional, for ${app.name}`}>
                    <Switch checked={(selected[app.app_id] ?? []).includes(scope)} onCheckedChange={on => share(app.app_id, scope, on)} aria-label={`Share your ${scope} with ${app.name}`} disabled={pending} />
                  </Row>
                ))}
              </Fragment>
            ))}
          </Section>
          <div className={flowStyles.actions}>
            <Button className={flowStyles.wide} loading={pending} onClick={() => choose(true)}>Continue</Button>
            <Button variant="ghost" className={flowStyles.wide} disabled={pending} onClick={() => choose(false)}>Deny</Button>
          </div>
        </div>
      ) : null}
    </HostedFrame>
  );
}

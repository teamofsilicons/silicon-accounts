"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/silicon-ui/button/button";
import { ApiError } from "@/lib/api/errors";
import { useSession } from "@/lib/query/session";
import { useInterfaceAuth, type InterfaceFlow } from "@/lib/query/interface-auth";
import { HostedFrame } from "./flow/hosted-frame";
import { LoadingCard } from "./flow/problem";
import styles from "./interface-authorize.module.css";

const REQUIRED = ["interface_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"] as const;

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

  const frame = flow ? { app_id: flow.interface.interface_id, name: flow.interface.name, logo_url: flow.interface.logo_url, branding: flow.interface.branding } : null;
  const title = flow ? `Sign in to ${flow.interface.name}` : "Sign in to an Interface";
  return (
    <HostedFrame app={frame} title={title} busy={pending || (!flow && !error)}>
      {!flow && !error ? <LoadingCard /> : error ? (
        <div className={styles.stack} role="alert"><h1 className={styles.title}>This sign-in could not continue</h1><p className={styles.copy}>{error.message}</p>{error.code === "required_detail_missing" ? <Button onClick={() => router.push(`/sign-in-methods?${new URLSearchParams({ return_to: returnTo }).toString()}`)}>Add the required detail</Button> : error.code === "invalid_signin_proof" ? <Button onClick={() => { sessionStorage.removeItem(proofKey); router.replace(signInPath(true)); }}>Start sign-in again</Button> : null}<Button variant="secondary" onClick={() => window.location.reload()}>Try again</Button></div>
      ) : flow ? (
        <div className={styles.stack}>
          <div><h1 className={styles.title}>Continue to {flow.interface.name}</h1><p className={styles.copy}>Signed in as {session?.account.display_name ?? "your account"}. This Interface will sign you in to these apps:</p><button className={styles.switch} type="button" onClick={() => router.push(signInPath(true))}>Use another account</button></div>
          <ul className={styles.apps}>
            {flow.apps.map(app => <li key={app.app_id} className={styles.app} data-sq style={{ "--sq-r": "12px", "--sq-fill": "var(--surface)", "--sq-stroke": "var(--border)" } as React.CSSProperties}>
              <strong>{app.name}</strong><span>{app.description || `${flow.interface.name} uses ${app.name} for you.`}</span><small>Required account details: {app.scopes.join(", ")}</small>
              {app.optional_scopes.map(scope => <label className={styles.optional} key={scope}><input type="checkbox" checked={(selected[app.app_id] ?? []).includes(scope)} onChange={event => setSelected(previous => ({ ...previous, [app.app_id]: event.target.checked ? [...(previous[app.app_id] ?? []), scope] : (previous[app.app_id] ?? []).filter(item => item !== scope) }))} /> Share {scope} with {app.name}</label>)}
            </li>)}
          </ul>
          <Button disabled={pending} onClick={() => choose(true)}>Continue</Button>
          <Button disabled={pending} variant="secondary" onClick={() => choose(false)}>Deny</Button>
        </div>
      ) : null}
    </HostedFrame>
  );
}

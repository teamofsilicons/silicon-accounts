"use client";

/**
 * /device: approve a terminal sign-in (the device flow). `silicon-accounts login`, or an app's own command-line tool,
 * prints a code and this address; a signed-in Carbon opens it, checks that the code matches the terminal, sees which
 * app is asking and what it will see, and approves or denies. Signed out, the page first sends the visitor to sign in
 * and comes back here with the code. An app's tool is shown in the app's own look (its branding, logo and name, with
 * "Powered by Silicon Accounts"); the silicon-accounts CLI's sign-in in the Silicon Accounts look.
 *
 *   GET  /v1/device/{user_code}           what is asking (client label, the app and its scopes, times, status)
 *   POST /v1/device/{user_code}/approve   the CLI's next poll receives tokens for this Carbon
 *   POST /v1/device/{user_code}/deny      the CLI's next poll gets access_denied
 */
import { useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Button } from "@/components/silicon-ui/button/button";
import { Input } from "@/components/silicon-ui/input/input";
import { ApiError } from "@/lib/api/errors";
import type { AccountSummary, DeviceRequest } from "@/lib/api/types";
import { formatRelative } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useDecideDevice, useDeviceRequest } from "@/lib/query/auth";
import { useSession } from "@/lib/query/session";
import { describe } from "./flow/errors";
import { useHydrated, useNow } from "./flow/hooks";
import { HostedFrame } from "./flow/hosted-frame";
import { SILICON_ACCOUNTS, type FrameApp } from "./flow/model";
import { StepMorph } from "./flow/morph";
import { AccountRow, StepHeading, SuccessMark } from "./flow/parts";
import { ArrivalScope, LoadingCard } from "./flow/problem";
import flow from "./flow/flow.module.css";
import styles from "./device.module.css";

/** `wdjb mjht`, `WDJBMJHT` → `WDJB-MJHT`; null when it cannot be a code (8 letters and digits). */
export function normalizeUserCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
}

/** What the visitor types, shaped as they type: letters and digits, a dash after four. */
function shapeTyping(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/** What each scope an app's tool asks for lets it see, in the Carbon's words (openid comes with the profile). */
const SCOPE_WORDS: Record<string, string> = {
  profile: "Your name, id, uuid and profile photo",
  email: "Your email address",
  phone: "Your phone number",
  dob: "Your date of birth",
  timezone: "Your timezone",
  offline_access: "Staying signed in until you sign it out",
};

/** The lines "What it will see" lists: the profile first, unknown scopes as they are named. */
export function scopeLines(scopes: readonly string[] | undefined): string[] {
  const list = scopes?.length ? scopes : ["profile"];
  const wanted = new Set(list.filter(scope => scope !== "openid"));
  wanted.add("profile");
  const order = ["profile", "email", "phone", "dob", "timezone", "offline_access"];
  const known = order.filter(scope => wanted.has(scope)).map(scope => SCOPE_WORDS[scope]!);
  const unknown = [...wanted].filter(scope => !order.includes(scope)).map(scope => `Its "${scope}" access`);
  return [...known, ...unknown];
}

/** The app an app's own tool signs into (null for the silicon-accounts CLI, whose sign-in is first party). */
export function deviceApp(request: DeviceRequest | null | undefined): FrameApp | null {
  const app = request?.app;
  if (!app || request?.first_party) return null;
  return { app_id: app.app_id, name: app.name, logo_url: app.logo_url ?? null, logo_dark_url: app.logo_dark_url ?? null, branding: app.branding ?? null, copy: app.copy ?? null };
}

const VIEWS = ["loading", "enter", "review", "approved", "already-approved", "denied", "expired", "used", "unknown", "failed", "silicon", "offline"] as const;

export function Device() {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <HostedFrame app={SILICON_ACCOUNTS} site title="Approve a sign-in" poweredBy={false} busy>
        <LoadingCard label="Loading the sign-in request" />
      </HostedFrame>
    );
  }
  return (
    <ArrivalScope>
      <DeviceApproval />
    </ArrivalScope>
  );
}

function DeviceApproval() {
  const router = useRouter();
  const search = useSearchParams();
  const { status, session, error: sessionError, refetch } = useSession();
  const account = session?.account ?? null;
  const code = normalizeUserCode(search.get("code") ?? "");
  const [typed, setTyped] = useState(() => shapeTyping(search.get("code") ?? ""));
  const [typedError, setTypedError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ code: string; approved: boolean } | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  // Every second: the review turns into "This code expired" the moment the code runs out.
  const now = useNow(1000);
  const request = useDeviceRequest(status === "signed_in" && account?.kind === "carbon" && code ? code : null);
  const decide = useDecideDevice();
  const acting = decide.isPending ? (decide.variables?.approve ? "approve" : "deny") : null;

  useEffect(() => {
    document.title = "Approve a sign-in · Silicon Accounts";
  }, []);

  // Signed out: sign in first, then come back to this exact page (code included).
  useEffect(() => {
    if (status !== "signed_out") return;
    router.replace(`${paths.signIn}?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }, [status, router]);

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeUserCode(typed);
    if (!normalized) {
      setTypedError("Enter the 8 letters and digits your terminal shows, like WDJB-MJHT.");
      return;
    }
    setTypedError(null);
    setActionError(null);
    router.replace(`${paths.device}?code=${encodeURIComponent(normalized)}`);
  };

  const answer = async (approve: boolean) => {
    if (!code || decide.isPending) return;
    setActionError(null);
    try {
      await decide.mutateAsync({ userCode: code, approve });
      setOutcome({ code, approved: approve });
    } catch (raw) {
      // The code changed under us (expired, used elsewhere): the request is read again and shows what it is now.
      setActionError(ApiError.from(raw));
    }
  };

  const enterAnother = () => {
    setTyped("");
    setOutcome(null);
    setActionError(null);
    router.replace(paths.device);
  };

  const switchAccount = () => router.push(`${paths.signIn}?prompt=login&return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);

  const failure = request.error ? ApiError.from(request.error) : null;
  const req = request.data ?? null;
  const expiresAt = req ? Date.parse(req.expires_at) : NaN;
  /**
   * The code ran out while this page was open. The request still reads "pending" (it is not read again), but approving
   * it can only fail now: the clock says what the server would.
   */
  const ranOut = Number.isFinite(expiresAt) && now > 0 && now >= expiresAt;
  const view: (typeof VIEWS)[number] = (() => {
    if (status === "loading" || status === "signed_out") return "loading";
    if (status === "error") return "offline";
    if (account?.kind === "silicon") return "silicon";
    if (!code) return "enter";
    if (outcome && outcome.code === code) return outcome.approved ? "approved" : "denied";
    if (failure) {
      if (failure.code === "device_code_not_found") return "unknown";
      if (failure.code === "device_code_expired") return "expired";
      if (failure.code === "device_code_used") return "used";
      return "failed";
    }
    switch (request.data?.status) {
      case "pending":
        return ranOut ? "expired" : "review";
      // Answered before this page did anything: say so without claiming it was this Carbon's doing (the code says
      // nothing about who approved it).
      case "approved":
        return "already-approved";
      case "denied":
        return "denied";
      case "consumed":
        return "used";
      case "expired":
        return "expired";
      default:
        return "loading";
    }
  })();

  /** "in 4 minutes", never more time than is left (whole minutes round down; the last one reads "in under a minute"). */
  const expiresText = (() => {
    if (!Number.isFinite(expiresAt) || !now) return "soon";
    const seconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
    if (seconds < 60) return "in under a minute";
    const minutes = Math.floor(seconds / 60);
    return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
  })();

  const signedInAs = account ? <SignedInAs account={account} onSwitch={switchAccount} /> : null;
  // An app's own tool: the page takes the app's look and names it; the silicon-accounts CLI keeps ours.
  const app = deviceApp(req);
  const tool = app ? `${app.name}'s command-line tool` : "the silicon-accounts CLI";
  const again = app ? <>Start the sign-in again in your terminal for a new code.</> : <>Run <code className={flow.mono}>silicon-accounts login</code> again in your terminal for a new one.</>;

  const render = (current: string) => {
    switch (current) {
      case "enter":
        return (
          <>
            <StepHeading title="Connect your terminal" description={<>Enter the code that <code className={flow.mono}>silicon-accounts login</code> shows in your terminal. It looks like WDJB-MJHT.</>} />
            <form className={flow.form} noValidate onSubmit={submitCode}>
              <Input
                label="Code from your terminal"
                value={typed}
                placeholder="XXXX-XXXX"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={9}
                className={styles.codeInput}
                onChange={event => {
                  setTyped(shapeTyping(event.currentTarget.value));
                  setTypedError(null);
                }}
                error={typedError ?? undefined}
              />
              <Button type="submit" className={flow.wide}>Continue</Button>
            </form>
            {signedInAs}
          </>
        );
      case "review":
        return req ? (
          <>
            <StepHeading
              title={app ? `Sign in to ${app.name}?` : "Approve this sign-in?"}
              description={app
                ? <>{tool} is asking to sign in to {app.name} as you. Approve it only if you just started this sign-in in your terminal yourself.</>
                : <>A terminal is asking to sign in to Silicon Accounts as you. Approve it only if you just ran <code className={flow.mono}>silicon-accounts login</code> yourself.</>}
            />
            <div data-sq="surface" className={styles.codeCard}>
              <span className={styles.codeLabel}>Check that your terminal shows</span>
              <span className={styles.code} aria-label={`Code ${req.user_code.split("").join(" ")}`}>{req.user_code}</span>
            </div>
            {app ? (
              <section className={styles.sees} aria-labelledby="device-sees">
                <h2 id="device-sees" className={styles.seesTitle}>{app.name} will see</h2>
                <ul className={styles.seesList}>
                  {scopeLines(req.scopes).map(line => <li key={line}>{line}</li>)}
                </ul>
              </section>
            ) : null}
            <dl className={styles.facts}>
              <div><dt>Asking</dt><dd>{req.client_label ?? (app ? `${app.name}'s command-line tool` : "The silicon-accounts CLI")}</dd></div>
              <div><dt>Started</dt><dd>{now ? formatRelative(req.created_at, now) : "just now"}</dd></div>
              <div><dt>Code expires</dt><dd>{expiresText}</dd></div>
            </dl>
            {signedInAs}
            {actionError ? <Alert tone="danger" title="That did not go through" data-error-code={actionError.code}>{describe(actionError) ?? ""}</Alert> : null}
            <div className={flow.actions}>
              <Button className={flow.wide} loading={acting === "approve"} disabled={acting === "deny"} onClick={() => void answer(true)}>Approve sign-in</Button>
              <Button variant="secondary" className={flow.wide} loading={acting === "deny"} disabled={acting === "approve"} onClick={() => void answer(false)}>Deny</Button>
            </div>
          </>
        ) : <LoadingCard label="Loading the sign-in request" />;
      case "approved":
        // Only after this page's own approval: then the terminal signs in as exactly this account.
        return (
          <div className={flow.complete}>
            {account ? <SuccessMark name={account.display_name} photo={account.pfp_url} /> : null}
            <StepHeading
              title="Your terminal is signed in"
              description={app
                ? <>Go back to your terminal: {tool} is now signed in to {app.name} as <span className={flow.mono}>{account?.id ?? "you"}</span>. You can close this tab.</>
                : <>Go back to your terminal: <code className={flow.mono}>silicon-accounts</code> is now signed in as <span className={flow.mono}>{account?.id ?? "you"}</span>. You can close this tab.</>}
            />
          </div>
        );
      case "already-approved":
        return (
          <>
            <StepHeading
              title="This sign-in was already approved"
              description={<>Someone approved this code before this page loaded (perhaps you, in another tab), so the terminal signs in as the account that approved it. If you did not expect that, {app ? "start the sign-in again in your terminal for a new code." : <>run <code className={flow.mono}>silicon-accounts login</code> again in your terminal for a new code.</>}</>}
            />
            <Button variant="secondary" className={flow.wide} onClick={enterAnother}>Enter another code</Button>
          </>
        );
      case "denied":
        return (
          <>
            <StepHeading title="Sign-in denied" description="The terminal was not signed in, and its code no longer works. If you did not start this sign-in, nothing else is needed." />
            <Button variant="secondary" className={flow.wide} onClick={enterAnother}>Enter another code</Button>
          </>
        );
      case "expired":
        return (
          <>
            <StepHeading title="This code expired" description={<>Codes work for 10 minutes. {again}</>} />
            <Button variant="secondary" className={flow.wide} onClick={enterAnother}>Enter another code</Button>
          </>
        );
      case "used":
        return (
          <>
            <StepHeading title="This code was already used" description={<>A terminal already signed in with it, and each code works once. {app ? "Start the sign-in again in your terminal if you need a new one." : <>Run <code className={flow.mono}>silicon-accounts login</code> again in your terminal if you need a new sign-in.</>}</>} />
            <Button variant="secondary" className={flow.wide} onClick={enterAnother}>Enter another code</Button>
          </>
        );
      case "unknown":
        return (
          <>
            <StepHeading title={`No sign-in uses ${code ?? "that code"}`} description="Check the code in your terminal and enter it again. Codes are 8 letters and digits, like WDJB-MJHT." />
            <Button variant="secondary" className={flow.wide} onClick={enterAnother}>Enter the code again</Button>
          </>
        );
      case "silicon":
        return <StepHeading title="Only Carbons approve terminal sign-ins" description={<>This browser is signed in as a Silicon. Silicons sign in to the CLI with their si:id and STK: <code className={flow.mono}>silicon-accounts login --silicon si:your-id</code>.</>} />;
      case "offline":
      case "failed": {
        const problem = current === "offline" ? sessionError : failure;
        return (
          <>
            <StepHeading title={current === "offline" ? "Silicon Accounts is unreachable" : "This sign-in request could not be loaded"} description={describe(problem) ?? "Check your connection, then try again."} />
            <Button className={flow.wide} onClick={() => (current === "offline" ? refetch() : void request.refetch())}>Try again</Button>
          </>
        );
      }
      default:
        return <LoadingCard label="Loading the sign-in request" />;
    }
  };

  return (
    app ? (
      <HostedFrame app={app} title={`Sign in to ${app.name}`} hideName>
        <StepMorph view={view} order={VIEWS}>{render}</StepMorph>
      </HostedFrame>
    ) : (
      <HostedFrame app={SILICON_ACCOUNTS} site title="Approve a sign-in" poweredBy={false}>
        <StepMorph view={view} order={VIEWS}>{render}</StepMorph>
      </HostedFrame>
    )
  );
}

/** Who approves: the signed-in Carbon, with a way to switch. */
function SignedInAs({ account, onSwitch }: { account: AccountSummary; onSwitch: () => void }) {
  return <AccountRow account={account} size="sm" action={<Button variant="ghost" size="sm" onClick={onSwitch}>Not you?</Button>} />;
}

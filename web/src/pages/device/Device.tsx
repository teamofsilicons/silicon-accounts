/**
 * /device: approve a CLI sign-in (the device flow). `accounts login` prints a code and this address; a signed-in
 * Carbon opens it, checks that the code matches the terminal, and approves or denies. Signed out, the page first
 * sends the visitor to sign in and comes back here with the code.
 *
 *   GET  /v1/device/{user_code}           what is asking (client label, times, status)
 *   POST /v1/device/{user_code}/approve   the CLI's next poll receives tokens for this Carbon
 *   POST /v1/device/{user_code}/deny      the CLI's next poll gets access_denied
 */
import { useLocation, useNavigate, useSearchParams } from "@solidjs/router";
import { Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { ApiError, api, type DeviceRequest } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { Button } from "../../arc/button/button";
import { Input } from "../../arc/input/input";
import { useSquircle } from "../../arc/lib/squircle";
import { paths } from "../../app/navigation";
import { refreshSession, sessionStatus, signedInAccount } from "../../app/session";
import { formatRelative } from "../../lib/format";
import { HostedFrame } from "../auth/flow/HostedFrame";
import { StepMorph } from "../auth/flow/StepMorph";
import { AccountRow, StepHeading, SuccessMark, createNow, describe, resetArrival } from "../auth/flow/parts";
import { LoadingCard } from "../auth/Problem";
import flow from "../auth/flow/flow.module.css";
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

type Outcome = "approved" | "denied";

export default function Device() {
  resetArrival();
  const [params] = useSearchParams<{ code?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const code = createMemo(() => normalizeUserCode(typeof params.code === "string" ? params.code : ""));
  const [request, setRequest] = createSignal<DeviceRequest | null>(null);
  const [failure, setFailure] = createSignal<ApiError | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [outcome, setOutcome] = createSignal<Outcome | null>(null);
  const [acting, setActing] = createSignal<"approve" | "deny" | null>(null);
  const [actionError, setActionError] = createSignal<ApiError | null>(null);
  const [typed, setTyped] = createSignal(untrack(() => (typeof params.code === "string" ? shapeTyping(params.code) : "")));
  const [typedError, setTypedError] = createSignal<string | null>(null);
  const now = createNow(15_000);

  onMount(() => {
    document.title = "Approve a sign-in · Silicon Accounts";
    if (sessionStatus() === "error") void refreshSession();
  });
  onCleanup(() => {
    document.title = "Silicon Accounts";
  });

  // Signed out: sign in first, then come back to this exact page (code included).
  createEffect(() => {
    if (sessionStatus() !== "signed_out") return;
    navigate(`${paths.signIn}?return_to=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
  });

  const load = async (userCode: string) => {
    setLoading(true);
    setFailure(null);
    setOutcome(null);
    setActionError(null);
    try {
      setRequest(await api.device.get(userCode));
    } catch (raw) {
      setRequest(null);
      setFailure(ApiError.from(raw));
    } finally {
      setLoading(false);
    }
  };
  createEffect(on([code, () => sessionStatus() === "signed_in"], ([userCode, signedIn]) => {
    if (signedIn && userCode) void load(userCode);
    if (!userCode) {
      setRequest(null);
      setFailure(null);
    }
  }));

  const submitCode = (event: SubmitEvent) => {
    event.preventDefault();
    const normalized = normalizeUserCode(typed());
    if (!normalized) {
      setTypedError("Enter the 8 letters and digits your terminal shows, like WDJB-MJHT.");
      return;
    }
    setTypedError(null);
    navigate(`${paths.device}?code=${encodeURIComponent(normalized)}`, { replace: true });
  };

  const decide = async (approve: boolean) => {
    const userCode = code();
    if (!userCode || acting()) return;
    setActing(approve ? "approve" : "deny");
    setActionError(null);
    try {
      if (approve) await api.device.approve(userCode);
      else await api.device.deny(userCode);
      setOutcome(approve ? "approved" : "denied");
    } catch (raw) {
      const error = ApiError.from(raw);
      setActionError(error);
      // The code changed under us (expired, used elsewhere): show what it is now.
      if (["device_code_expired", "device_code_used", "device_code_not_found"].includes(error.code)) void load(userCode);
    } finally {
      setActing(null);
    }
  };

  const enterAnother = () => {
    setTyped("");
    setOutcome(null);
    navigate(paths.device, { replace: true });
  };

  const switchAccount = () => navigate(`${paths.signIn}?prompt=login&return_to=${encodeURIComponent(location.pathname + location.search)}`);

  const status = () => request()?.status ?? null;
  const view = createMemo(() => {
    if (sessionStatus() === "loading" || sessionStatus() === "signed_out") return "loading";
    if (sessionStatus() === "error") return "offline";
    if (signedInAccount()?.kind === "silicon") return "silicon";
    if (!code()) return "enter";
    if (outcome()) return outcome() as string;
    if (loading() && !request()) return "loading";
    if (failure()) return failure()?.code === "device_code_not_found" ? "unknown" : "failed";
    switch (status()) {
      case "pending":
        return "review";
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
        return request() ? "failed" : "loading";
    }
  });

  const account = () => signedInAccount();
  const expiresIn = () => {
    const at = request() ? Date.parse(request()!.expires_at) : NaN;
    if (!Number.isFinite(at)) return null;
    const minutes = Math.max(0, Math.ceil((at - now()) / 60_000));
    return minutes <= 1 ? "in a minute" : `in ${minutes} minutes`;
  };

  return (
    <HostedFrame app={{ app_id: "accounts", name: "Silicon Accounts" }} site title="Approve a sign-in" poweredBy={false}>
      <StepMorph view={view()} order={["loading", "enter", "review", "approved", "already-approved", "denied", "expired", "used", "unknown", "failed", "silicon", "offline"]}>
        {current => (
          <Switch fallback={<LoadingCard label="Loading the sign-in request" />}>
            <Match when={current === "enter"}>
              <StepHeading title="Connect your terminal" description={<>Enter the code that <code class={flow.mono}>accounts login</code> shows in your terminal. It looks like WDJB-MJHT.</>} />
              <form class={flow.form} novalidate onSubmit={submitCode}>
                <Input
                  label="Code from your terminal"
                  mono
                  value={typed()}
                  placeholder="XXXX-XXXX"
                  autocomplete="one-time-code"
                  autocapitalize="characters"
                  spellcheck={false}
                  maxLength={9}
                  class={styles.codeInput}
                  onInput={event => {
                    const next = shapeTyping(event.currentTarget.value);
                    if (next !== event.currentTarget.value) event.currentTarget.value = next;
                    setTyped(next);
                    setTypedError(null);
                  }}
                  error={typedError()}
                />
                <Button type="submit" class={flow.wide}>Continue</Button>
              </form>
              <SignedInAs account={account()} onSwitch={switchAccount} />
            </Match>

            <Match when={current === "review" && request()}>
              {req => (
                <>
                  <StepHeading
                    title="Approve this sign-in?"
                    description={<>A terminal is asking to sign in to Silicon Accounts as you. Approve it only if you just ran <code class={flow.mono}>accounts login</code> yourself.</>}
                  />
                  <div ref={el => useSquircle(el)} class={styles.codeCard}>
                    <span class={styles.codeLabel}>Check that your terminal shows</span>
                    <span class={styles.code} aria-label={`Code ${req().user_code.split("").join(" ")}`}>{req().user_code}</span>
                  </div>
                  <dl class={styles.facts}>
                    <div><dt>Asking</dt><dd>{req().client_label ?? "The accounts CLI"}</dd></div>
                    <div><dt>Started</dt><dd>{formatRelative(req().created_at, now())}</dd></div>
                    <div><dt>Code expires</dt><dd>{expiresIn() ?? "soon"}</dd></div>
                  </dl>
                  <SignedInAs account={account()} onSwitch={switchAccount} />
                  <Show when={actionError()}>
                    {error => <Alert tone="danger" title="That did not go through" data-error-code={error().code}>{describe(error())}</Alert>}
                  </Show>
                  <div class={flow.actions}>
                    <Button class={flow.wide} loading={acting() === "approve"} disabled={acting() === "deny"} onClick={() => void decide(true)}>Approve sign-in</Button>
                    <Button variant="secondary" class={flow.wide} loading={acting() === "deny"} disabled={acting() === "approve"} onClick={() => void decide(false)}>Deny</Button>
                  </div>
                </>
              )}
            </Match>

            <Match when={current === "approved"}>
              {/* Only after this page's own approval: then the terminal signs in as exactly this account. */}
              <div class={flow.complete}>
                <Show when={account()}>{who => <SuccessMark name={who().display_name} photo={who().pfp_url} kind={who().kind} />}</Show>
                <StepHeading
                  title="Your terminal is signed in"
                  description={<>Go back to your terminal: <code class={flow.mono}>accounts</code> is now signed in as <span class={flow.mono}>{account()?.id ?? "you"}</span>. You can close this tab.</>}
                />
              </div>
            </Match>

            <Match when={current === "already-approved"}>
              <StepHeading
                title="This sign-in was already approved"
                description={<>Someone approved this code before this page loaded (perhaps you, in another tab), so the terminal signs in as the account that approved it. If you did not expect that, run <code class={flow.mono}>accounts login</code> again in your terminal for a new code.</>}
              />
              <Button variant="secondary" class={flow.wide} onClick={enterAnother}>Enter another code</Button>
            </Match>

            <Match when={current === "denied"}>
              <StepHeading title="Sign-in denied" description="The terminal was not signed in, and its code no longer works. If you did not start this sign-in, nothing else is needed." />
              <Button variant="secondary" class={flow.wide} onClick={enterAnother}>Enter another code</Button>
            </Match>

            <Match when={current === "expired"}>
              <StepHeading title="This code expired" description={<>Codes work for 10 minutes. Run <code class={flow.mono}>accounts login</code> again in your terminal for a new one.</>} />
              <Button variant="secondary" class={flow.wide} onClick={enterAnother}>Enter another code</Button>
            </Match>

            <Match when={current === "used"}>
              <StepHeading title="This code was already used" description={<>A terminal already signed in with it, and each code works once. Run <code class={flow.mono}>accounts login</code> again in your terminal if you need a new sign-in.</>} />
              <Button variant="secondary" class={flow.wide} onClick={enterAnother}>Enter another code</Button>
            </Match>

            <Match when={current === "unknown"}>
              <StepHeading title={`No sign-in uses ${code() ?? "that code"}`} description={failure()?.message ?? "Check the code in your terminal and enter it again."} />
              <Show when={failure()?.hint}><p class={flow.description}>{failure()?.hint}</p></Show>
              <Button variant="secondary" class={flow.wide} onClick={enterAnother}>Enter the code again</Button>
            </Match>

            <Match when={current === "silicon"}>
              <StepHeading title="Only Carbons approve terminal sign-ins" description={<>This browser is signed in as a Silicon. Silicons sign in to the CLI with their si:id and STK: <code class={flow.mono}>accounts login --silicon si:your-id</code>.</>} />
            </Match>

            <Match when={current === "offline" || current === "failed"}>
              <StepHeading title={current === "offline" ? "Silicon Accounts is unreachable" : "This sign-in request could not be loaded"} description={(failure() ?? undefined)?.message ?? "Check your connection, then try again."} />
              <Show when={failure()?.hint}><p class={flow.description}>{failure()?.hint}</p></Show>
              <Button class={flow.wide} onClick={() => (current === "offline" ? void refreshSession() : code() && void load(code() as string))}>Try again</Button>
            </Match>
          </Switch>
        )}
      </StepMorph>
    </HostedFrame>
  );
}

/** Who approves: the signed-in Carbon, with a way to switch. */
function SignedInAs(props: { account: ReturnType<typeof signedInAccount>; onSwitch: () => void }) {
  return (
    <Show when={props.account}>
      {who => <AccountRow account={who()} size="sm" action={<Button variant="ghost" size="sm" onClick={() => props.onSwitch()}>Not you?</Button>} />}
    </Show>
  );
}

/**
 * consent: what is shared with the app (UNDERSTANDING.md "What's shared with the app"). Required details are always
 * shared and locked on; optional ones have a switch. Shown the first time a Carbon signs into an app and again when
 * it asks for more. Continue approves; Cancel sends the browser back to the app with access_denied.
 */
import { For, Show, createSignal, untrack, type Accessor } from "solid-js";
import { Lock } from "lucide-solid";
import type { ApiError, Scope } from "../../../api";
import { Badge } from "../../../arc/badge/badge";
import { Button } from "../../../arc/button/button";
import { Switch } from "../../../arc/switch/switch";
import { useSquircle } from "../../../arc/lib/squircle";
import { formatDate } from "../../../lib/format";
import { isValidTimezone, timezoneLabel, utcOffset } from "../../../lib/timezones";
import type { FlowController } from "../flow/controller";
import type { HostedFlow } from "../flow/model";
import { AccountRow, FlowAlert, StepHeading, createStepErrors, latest } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface ConsentProps {
  flow: Accessor<HostedFlow>;
  ctl: FlowController;
  notice: Accessor<ApiError | null>;
}

/** Values as people read them: "Mar 14, 1998", "Kolkata, Asia (UTC+05:30)". */
function shown(scope: Scope, value: string | null): string | null {
  if (value === null) return null;
  if (scope === "dob" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  if (scope === "timezone" && isValidTimezone(value)) return `${timezoneLabel(value)} (UTC${utcOffset(value)})`;
  return value;
}

export function Consent(props: ConsentProps) {
  const consent = latest(() => props.flow().consent);
  const account = latest(() => props.flow().signed_in_as);
  const app = () => props.flow().app;
  const [chosen, setChosen] = createSignal<Set<Scope>>(new Set(untrack(() => (consent()?.optional ?? []).filter(row => row.granted && row.value !== null).map(row => row.scope))));
  const [pending, setPending] = createSignal<"approve" | "decline" | "switch" | null>(null);
  /** Why "Share and continue", "Cancel" or "Switch account" did not go through (shown by the buttons). */
  const [problem, setProblem] = createSignal<ApiError | null>(null);
  const errors = createStepErrors(() => props.flow().error ?? props.notice());
  /** Signed out (or into another account) meanwhile: approving again cannot work until the account is chosen again. */
  const blocked = () => problem()?.code === "session_required" || problem()?.code === "account_changed";
  /**
   * The app saw more than the basic profile before (an earlier consent) and now asks for something it has not seen:
   * the new rows say so. A grant of just the profile (an imported account, or an app that asked for nothing else) is
   * not "before", and an app asking again for only what it already has (prompt=consent) is not asking for more.
   */
  const before = () => (consent()?.previously_granted ?? []).filter(scope => scope !== "profile" && scope !== "openid" && scope !== "offline_access");
  const unseen = (scope: Scope) => scope !== "profile" && !(consent()?.previously_granted ?? []).includes(scope);
  const asksAgain = () => before().length > 0 && [...(consent()?.required ?? []), ...(consent()?.optional ?? [])].some(row => unseen(row.scope));
  const isNew = (scope: Scope) => asksAgain() && unseen(scope);

  const toggle = (scope: Scope, on: boolean) => {
    const next = new Set(chosen());
    if (on) next.add(scope);
    else next.delete(scope);
    setChosen(next);
  };

  const answer = async (approve: boolean) => {
    setProblem(null);
    errors.begin();
    setPending(approve ? "approve" : "decline");
    const failure = await props.ctl.consent(approve ? { approve: true, optional_scopes: [...chosen()] } : { approve: false });
    if (failure) {
      setPending(null);
      setProblem(failure);
    }
    // On success the card moves on to the redirect; the buttons stay busy until it does.
  };

  const switchAccount = async () => {
    setProblem(null);
    errors.begin();
    setPending("switch");
    const failure = await props.ctl.switchAccount();
    if (failure) {
      setPending(null);
      setProblem(failure);
    }
  };

  return (
    <Show when={consent()}>
      {current => (
        <>
          <StepHeading
            title={asksAgain() ? `${app().name} would like a little more` : `Share your details with ${app().name}`}
            description={`${app().name} sees these now and whenever they change. You can remove its access at any time in your account.`}
          />
          <FlowAlert error={errors.carried()} app={app().name} onSwitch={() => props.ctl.switchAccount()} />
          <Show when={account()}>
            {who => (
              <AccountRow
                account={who()}
                size="sm"
                action={<Button variant="ghost" size="sm" loading={pending() === "switch"} disabled={!!pending() && pending() !== "switch"} onClick={() => void switchAccount()}>Switch account</Button>}
              />
            )}
          </Show>
          <ul ref={el => useSquircle(el)} class={styles.shareList} aria-label={`Details shared with ${app().name}`}>
            <For each={current().required}>
              {row => (
                <li class={styles.shareRow} data-scope={row.scope} data-required="">
                  <span class={styles.shareText}>
                    <span class={styles.shareLabel}>{row.label}<Show when={isNew(row.scope)}> <Badge tone="info" size="sm">New</Badge></Show></span>
                    <span class={styles.shareValue}>{shown(row.scope, row.value) ?? "Not added yet"}</span>
                  </span>
                  <span class={styles.shareLock} title="Always shared">
                    <Lock size={14} stroke-width={1.75} aria-hidden="true" />
                    <span>Required</span>
                  </span>
                </li>
              )}
            </For>
            <For each={current().optional}>
              {row => {
                const missing = () => row.value === null;
                const labelId = `share-${row.scope}`;
                return (
                  <li class={styles.shareRow} data-scope={row.scope} data-optional="">
                    <span class={styles.shareText}>
                      <span id={labelId} class={styles.shareLabel}>{row.label}<Show when={isNew(row.scope)}> <Badge tone="info" size="sm">New</Badge></Show></span>
                      <span class={styles.shareValue}>{missing() ? "You have not added one, so nothing is shared" : shown(row.scope, row.value)}</span>
                    </span>
                    <Switch
                      aria-labelledby={labelId}
                      checked={!missing() && chosen().has(row.scope)}
                      disabled={missing() || !!pending()}
                      onChange={on => toggle(row.scope, on)}
                    />
                  </li>
                );
              }}
            </For>
          </ul>
          <FlowAlert error={problem()} app={app().name} onSwitch={() => props.ctl.switchAccount()} />
          <div class={styles.actions}>
            <Button class={styles.wide} loading={pending() === "approve"} disabled={(!!pending() && pending() !== "approve") || blocked()} onClick={() => void answer(true)}>
              Share and continue
            </Button>
            <Button variant="secondary" class={styles.wide} loading={pending() === "decline"} disabled={!!pending() && pending() !== "decline"} onClick={() => void answer(false)}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Show>
  );
}

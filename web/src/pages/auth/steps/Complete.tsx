/**
 * complete (and failed): the flow is done and `redirect_to` says where the browser goes: back to the app with a code,
 * or with `error=access_denied` after Cancel, or with `error=login_required` for a `prompt=none` that could not sign
 * in silently. A short success moment (the ring draws around the photo, the check pops in), then the browser leaves.
 *
 * A code works once, so the page goes there once: coming back to a finished flow (the back button) shows a link to
 * the app instead of sending the spent code again. Only addresses that are safe to open (http(s), or a native app's
 * reverse-domain scheme) are ever followed.
 */
import { Match, Show, Switch, createMemo, onCleanup, onMount, type Accessor } from "solid-js";
import { ArrowRight } from "lucide-solid";
import type { ApiError } from "../../../api";
import { Alert } from "../../../arc/alert/alert";
import { LinkButton } from "../../../arc/button/button";
import { prefersReducedMotion } from "../../../arc/lib/motion";
import { appHome, firstName, markRedirected, redirectError, safeRedirect, wasRedirected, type HostedFlow } from "../flow/model";
import { StepHeading, SuccessMark, latest } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface CompleteProps {
  flow: Accessor<HostedFlow>;
  /** A warning to show before leaving (the photo did not upload); it holds the redirect a little longer. */
  warning?: Accessor<ApiError | null>;
}

export function Complete(props: CompleteProps) {
  const flow = latest(() => props.flow());
  const redirectTo = () => safeRedirect(flow()?.redirect_to);
  const failure = createMemo(() => redirectError(redirectTo()));
  const appName = () => (flow()?.app.first_party ? "your account" : flow()?.app.name ?? "the app");
  /** The flow ended, but where it points cannot be opened safely: say so instead of going anywhere. */
  const blocked = () => !!flow()?.redirect_to && !redirectTo();
  // Decided once: a flow this browser already left for shows the way back instead of a second redirect.
  const spent = flow() ? wasRedirected(flow()!.id) : false;
  let timer: number | undefined;

  const go = () => {
    const current = flow();
    const target = redirectTo();
    if (!current || !target) return;
    markRedirected(current.id);
    window.location.replace(target);
  };

  onMount(() => {
    if (spent || !redirectTo()) return;
    // prompt=none asked for no page at all, and a failed flow has nothing to show: go at once.
    const silent = flow()?.step === "failed" || /(^|\s)none(\s|$)/.test(flow()?.prompt ?? "");
    const delay = silent ? 0 : props.warning?.() ? 3200 : prefersReducedMotion() ? 450 : 1200;
    timer = window.setTimeout(go, delay);
  });
  onCleanup(() => window.clearTimeout(timer));

  return (
    <Show when={flow()}>
      {current => (
        <Switch>
          <Match when={blocked()}>
            <StepHeading title="This sign-in stopped here" description={`${appName()} asked to send you to an address that is not a web or app address, so Silicon Accounts did not open it.`} />
            <Alert tone="warning" title="Nothing was sent to the app">
              Tell the people who run {appName()}: their redirect address must start with https:// (or be a native app's address).
            </Alert>
          </Match>

          <Match when={spent}>
            <StepHeading title="This sign-in is finished" description={`You already went back to ${appName()} from here. Each sign-in link works once.`} />
            <Show when={appHome(current())}>
              {home => <LinkButton href={home()} class={styles.wide}>Go to {appName()} <ArrowRight size={16} stroke-width={1.75} aria-hidden="true" /></LinkButton>}
            </Show>
          </Match>

          <Match when={failure()}>
            {ended => (
              <>
                <StepHeading
                  title={ended().error === "access_denied" ? "Nothing was shared" : `Returning to ${appName()}`}
                  description={ended().error === "access_denied" ? `You cancelled, so ${appName()} gets nothing. Taking you back now.` : ended().description ?? `Taking you back to ${appName()}.`}
                  noFocus
                />
                <LinkButton href={redirectTo() ?? "#"} variant="secondary" class={styles.wide} onClick={() => markRedirected(current().id)}>Back to {appName()}</LinkButton>
              </>
            )}
          </Match>

          <Match when={true}>
            <div class={styles.complete}>
              <Show when={current().signed_in_as}>
                {who => <SuccessMark name={who().display_name} photo={who().pfp_url} kind={who().kind} />}
              </Show>
              <StepHeading
                title={current().app.first_party ? `Welcome, ${firstName(current().signed_in_as?.display_name ?? "")}` : `Signed in to ${current().app.name}`}
                description={<>
                  <Show when={current().signed_in_as?.id}>{id => <>As <span class={styles.mono}>{id()}</span>. </>}</Show>
                  Taking you to {appName()} now.
                </>}
                noFocus
              />
              <p class="sr-only" role="status">Signed in. Taking you to {appName()}.</p>
              <Show when={props.warning?.()}>
                {warning => (
                  <Alert tone="warning" title="Your photo did not upload">
                    {warning().message} You can add a photo later in your account.
                  </Alert>
                )}
              </Show>
              <LinkButton href={redirectTo() ?? "#"} variant="secondary" class={styles.wide} onClick={() => markRedirected(current().id)}>
                Continue to {appName()}
              </LinkButton>
            </div>
          </Match>
        </Switch>
      )}
    </Show>
  );
}

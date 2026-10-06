/**
 * Full-page problems of the hosted sign-in: a link that cannot start (unknown app, redirect URI not registered, a
 * disabled app), and a flow that cannot go on (expired, ended, opened in another browser). They never redirect on
 * their own: an unknown app or unregistered redirect URI must not send the browser anywhere (02-api.md). Each says
 * what happened in the server's words, what to do next, and the exact code for the app's developers.
 */
import { For, Show, createMemo, type JSX } from "solid-js";
import type { ApiError } from "../../api";
import { Button, LinkButton } from "../../arc/button/button";
import { FieldMessage } from "../../arc/lib/FieldMessage";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { HostedFrame, type FrameApp } from "./flow/HostedFrame";
import { isApiSpeak } from "./flow/errors";
import { StepHeading, createNow } from "./flow/parts";
import { formatCountdown } from "../../lib/format";
import styles from "./flow/flow.module.css";

/** Without a trustworthy app, problems speak as Silicon Accounts itself (its mark, its look). */
const SILICON_ACCOUNTS: FrameApp = { app_id: "accounts", name: "Silicon Accounts" };

export interface ProblemAction {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "secondary";
}

export interface ProblemProps {
  title: string;
  /** Exactly what happened (usually the server's message). */
  message: string;
  /** What to do next. */
  hint?: string | null;
  error?: ApiError | null;
  /** Developer details (shown small, in mono). */
  details?: Array<[string, string | null | undefined]>;
  actions?: ProblemAction[];
  /** Paint the app's look when it is known and trustworthy; null for the Silicon Accounts look. */
  app?: FrameApp | null;
}

export function Problem(props: ProblemProps): JSX.Element {
  const now = createNow(1000);
  const retryAt = createMemo(() => (props.error?.retryAfter ? Date.now() + props.error.retryAfter * 1000 : null));
  const wait = () => {
    const at = retryAt();
    return at ? Math.max(0, Math.ceil((at - now()) / 1000)) : 0;
  };
  /** A hint written for an API client (an endpoint to call, a field to set) goes to the developers' details instead. */
  const forDevelopers = () => isApiSpeak(props.hint);
  const details = () => {
    const rows: Array<[string, string]> = [];
    for (const [label, value] of props.details ?? []) if (value) rows.push([label, value]);
    if (forDevelopers() && props.hint) rows.push(["fix", props.hint]);
    if (props.error?.code) rows.push(["code", props.error.code]);
    if (props.error?.requestId && props.error.requestId !== "mock") rows.push(["request", props.error.requestId]);
    return rows;
  };
  return (
    <HostedFrame app={props.app ?? SILICON_ACCOUNTS} site={!props.app || props.app.app_id === "accounts"} title={props.title}>
      <div class={styles.problem} data-problem={props.error?.code ?? "problem"} role="alert">
        <StepHeading title={props.title} description={props.message} noFocus />
        <Show when={props.hint && !forDevelopers()}><p class={styles.description}>{props.hint}</p></Show>
        <FieldMessage text={wait() > 0 ? `You can try again in ${formatCountdown(wait())}.` : null} />
        <Show when={props.actions?.length}>
          <div class={styles.actions}>
            <For each={props.actions}>
              {(action, index) => (
                <Show
                  when={action.href}
                  fallback={
                    <Button variant={action.variant ?? (index() === 0 ? "primary" : "secondary")} class={styles.wide} disabled={wait() > 0} onClick={() => action.onClick?.()}>
                      {action.label}
                    </Button>
                  }
                >
                  {href => <LinkButton href={href()} variant={action.variant ?? (index() === 0 ? "primary" : "secondary")} class={styles.wide}>{action.label}</LinkButton>}
                </Show>
              )}
            </For>
          </div>
        </Show>
        <Show when={details().length}>
          <dl class={styles.details} aria-label="Details for the app's developers">
            <For each={details()}>
              {([label, value]) => (
                <div>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              )}
            </For>
          </dl>
        </Show>
      </div>
    </HostedFrame>
  );
}

/** "Opening sign-in" while /authorize creates the flow or a flow loads: the card's shape, quietly. */
export function LoadingCard(props: { label?: string }) {
  return (
    <div class={styles.skeleton} aria-busy="true">
      <p class="sr-only" role="status">{props.label ?? "Opening sign-in"}</p>
      <SkeletonBlock width="72%" height="30px" index={0} />
      <SkeletonBlock width="48%" height="14px" index={1} />
      <SkeletonBlock width="100%" height="var(--control-height-md)" index={2} />
      <SkeletonBlock width="100%" height="var(--control-height-md)" index={3} />
    </div>
  );
}

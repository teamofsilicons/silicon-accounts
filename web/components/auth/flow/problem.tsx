"use client";

/**
 * Full-page problems of the hosted sign-in: a link that cannot start (unknown app, redirect URI not registered, a
 * disabled app), and a flow that cannot go on (expired, ended, opened in another browser). They never redirect on
 * their own: an unknown app or unregistered redirect URI must not send the browser anywhere. Each says what happened
 * in the Carbon's words, what to do next, and keeps the exact code and reason for the app's developers.
 */
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/arc/button/button";
import { ButtonLink } from "@/components/foundation/button-link";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import type { ApiError } from "@/lib/api/errors";
import { formatCountdown } from "@/lib/format";
import { isApiSpeak } from "./errors";
import { useNow } from "./hooks";
import { HostedFrame } from "./hosted-frame";
import { SILICON_ACCOUNTS, type FrameApp } from "./model";
import { ArrivalContext, FieldNote, StepHeading } from "./parts";
import styles from "./flow.module.css";

export interface ProblemAction {
  label: string;
  href?: string;
  /** A link to another site (the app): a plain anchor, no client navigation. */
  external?: boolean;
  onClick?: () => void;
  variant?: "primary" | "secondary";
}

export interface ProblemProps {
  title: string;
  /** Exactly what happened, in the Carbon's words. */
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

export function Problem({ title, message, hint, error, details, actions, app }: ProblemProps) {
  const now = useNow(1000);
  const [retryAt] = useState(() => (error?.retryAfter ? Date.now() + error.retryAfter * 1000 : null));
  const wait = retryAt && now ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  /** A hint written for an API client (an endpoint to call, a field to set) goes to the developers' details instead. */
  const forDevelopers = isApiSpeak(hint);
  const rows: Array<[string, string]> = [];
  for (const [label, value] of details ?? []) if (value) rows.push([label, value]);
  if (forDevelopers && hint) rows.push(["fix", hint]);
  if (error?.code) rows.push(["code", error.code]);
  if (error?.requestId && error.requestId !== "mock") rows.push(["request", error.requestId]);
  const frameApp = app ?? SILICON_ACCOUNTS;
  return (
    <HostedFrame app={frameApp} site={!app || app.app_id === "accounts"} title={title}>
      <div className={styles.problem} data-problem={error?.code ?? "problem"} role="alert">
        <StepHeading title={title} description={message} noFocus />
        {hint && !forDevelopers ? <p className={styles.description}>{hint}</p> : null}
        <FieldNote text={wait > 0 ? `You can try again in ${formatCountdown(wait)}.` : null} tone="status" />
        {actions?.length ? (
          <div className={styles.actions}>
            {actions.map((action, index) => {
              const variant = action.variant ?? (index === 0 ? "primary" : "secondary");
              return action.href ? (
                <ButtonLink key={action.label} href={action.href} external={action.external} variant={variant} className={styles.wide}>{action.label}</ButtonLink>
              ) : (
                <Button key={action.label} variant={variant} className={styles.wide} disabled={wait > 0} onClick={() => action.onClick?.()}>{action.label}</Button>
              );
            })}
          </div>
        ) : null}
        {rows.length ? (
          <dl className={styles.details} aria-label="Details for the app's developers">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </HostedFrame>
  );
}

/** "Opening sign-in" while /authorize creates the flow or a flow loads: the card's shape, quietly. */
export function LoadingCard({ label = "Opening sign-in" }: { label?: string }) {
  return (
    <div className={styles.skeleton} aria-busy="true">
      <p className="sr-only" role="status">{label}</p>
      <SkeletonBlock width="72%" height="30px" index={0} />
      <SkeletonBlock width="48%" height="14px" index={1} />
      <SkeletonBlock width="100%" height="var(--control-height-md)" index={2} />
      <SkeletonBlock width="100%" height="var(--control-height-md)" index={3} />
    </div>
  );
}

/** A page of its own for one hosted problem or loading state (each page gives its headings their own arrival). */
export function ArrivalScope({ children }: { children: ReactNode }) {
  const arrival = useRef(false);
  return <ArrivalContext.Provider value={arrival}>{children}</ArrivalContext.Provider>;
}

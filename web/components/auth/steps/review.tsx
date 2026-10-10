"use client";

/**
 * review: the last page of an app's flow when the app turned it on (flow.review): everything the app will see, the
 * profile first, and what the Carbon chose not to share. "Share and continue" completes the sign-in; Back returns to
 * the last details page with its choices; Cancel ends the sign-in and the app gets nothing.
 */
import { useState } from "react";
import { Check, Lock } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import type { ApiError } from "@/lib/api/errors";
import type { ActionResult, FlowController } from "../flow/controller";
import type { HostedFlow } from "../flow/model";
import { FlowAlert, StepHeading, useStepErrors } from "../flow/parts";
import { DETAIL_LABEL, detailValue } from "./details";
import styles from "../flow/flow.module.css";

export interface ReviewProps {
  flow: HostedFlow;
  ctl: FlowController;
  notice: ApiError | null;
}

const ACCOUNT_GONE = new Set(["session_required", "account_changed"]);

export function Review({ flow, ctl, notice }: ReviewProps) {
  const app = flow.app.name;
  const [pending, setPending] = useState<"approve" | "back" | "cancel" | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const errors = useStepErrors(flow.error ?? notice);
  const review = flow.review;
  if (!review) return null;
  const shared = review.fields.filter(field => field.shared);
  const kept = review.fields.filter(field => !field.shared);
  const label = (field: string, own: string | null | undefined) => own?.trim() || DETAIL_LABEL[field as keyof typeof DETAIL_LABEL] || field;

  const act = async (kind: "approve" | "back" | "cancel", call: () => Promise<ActionResult>) => {
    setProblem(null);
    errors.begin();
    setPending(kind);
    const failure = await call();
    if (!failure) return;
    setPending(null);
    if (ACCOUNT_GONE.has(failure.code)) errors.fail(failure);
    else setProblem(failure);
  };

  return (
    <>
      <StepHeading
        title={`Check what ${app} sees`}
        description={`${app} sees these now and whenever they change. You can remove its access at any time in your account.`}
      />
      <FlowAlert error={errors.current} app={app} onSwitch={() => ctl.switchAccount()} />
      <ul data-sq="surface" className={styles.shareList} aria-label={`Shared with ${app}`}>
        {shared.map(field => (
          <li key={field.field} className={styles.shareRow} data-field={field.field} data-shared="">
            <span className={styles.shareText}>
              <span className={styles.shareLabel}>{label(field.field, field.label)}</span>
              <span className={styles.shareValue}>{detailValue(field.field, field.value) ?? "Not added"}</span>
            </span>
            {field.field === "profile" || field.mode === "required" ? (
              <span className={styles.shareLock} title="Always shared">
                <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{field.field === "profile" ? "Always" : "Required"}</span>
              </span>
            ) : (
              <span className={styles.shareLock}>
                <Check size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>You chose</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      {kept.length ? (
        <div className={styles.keptBack}>
          <p className={styles.keptTitle}>{`Not shared with ${app}`}</p>
          <ul data-sq="surface" className={`${styles.shareList} ${styles.quietList}`} aria-label={`Not shared with ${app}`}>
            {kept.map(field => (
              <li key={field.field} className={styles.shareRow} data-field={field.field} data-kept="">
                <span className={styles.shareText}>
                  <span className={styles.shareLabel}>{label(field.field, field.label)}</span>
                  <span className={styles.shareValue}>{field.value === null ? "You have not added one" : "You left it unticked. Go back to share it."}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <FlowAlert error={problem} app={app} onSwitch={() => ctl.switchAccount()} />
      <div className={styles.actions}>
        <Button className={styles.wide} loading={pending === "approve"} disabled={!!pending && pending !== "approve"} onClick={() => void act("approve", () => ctl.review(true))}>
          Share and continue
        </Button>
        <Button variant="secondary" className={styles.wide} loading={pending === "back"} disabled={!!pending && pending !== "back"} onClick={() => void act("back", () => ctl.detailsBack())}>
          Back
        </Button>
        <button type="button" className={styles.textButton} disabled={!!pending} onClick={() => void act("cancel", () => ctl.review(false))}>
          {pending === "cancel" ? "Cancelling…" : "Cancel signing in"}
        </button>
      </div>
    </>
  );
}

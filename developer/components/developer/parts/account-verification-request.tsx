"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { Skeleton } from "@/components/arc/skeleton/skeleton";
import { Textarea } from "@/components/arc/textarea/textarea";
import { Section, Surface } from "@/components/foundation/layout/layout";
import { MAX_VERIFICATION_REASON, verificationReasonProblem } from "@/lib/account-verification";
import { ApiError } from "@/lib/api/errors";
import { formatDateTime } from "@/lib/format";
import { useAccountVerificationRequest, useRequestAccountVerification } from "@/lib/query/developer";
import styles from "./account-verification-request.module.css";

export function AccountVerificationRequestSection({ appId }: { appId: string }) {
  const state = useAccountVerificationRequest(appId);
  const submit = useRequestAccountVerification(appId);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string>();
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [justSubmitted, setJustSubmitted] = useState(false);
  const [alreadyPending, setAlreadyPending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const status = useRef<HTMLDivElement>(null);
  // The exiting animated dialog retains its previous render; the focus target must use the latest submission state.
  const focusReceipt = useRef(false);
  const request = state.error && [401, 403, 404].includes(state.error.status) ? null : state.data?.request;
  const pending = request?.status === "pending";

  useEffect(() => {
    // Wait for React to enable the field after a failed request before moving focus back to its error.
    if (reasonError && !submit.isPending) field.current?.focus();
  }, [reasonError, submit.isPending]);

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submit.isPending) return;
    const problem = verificationReasonProblem(reason);
    setReasonError(problem);
    setFailure(null);
    if (problem) { field.current?.focus(); return; }
    try {
      const result = await submit.mutateAsync(reason.trim());
      setAlreadyPending(!result.created);
      setJustSubmitted(true);
      setReason("");
      focusReceipt.current = true;
      setOpen(false);
    } catch (error) {
      const problem = ApiError.from(error);
      setFailure(problem);
      setReasonError(problem.fields.reason);
      if ([401, 403, 404].includes(problem.status)) void state.refetch();
    }
  };

  return <Section id="signin-account-verification" title="Account verification" description="Want to use your own domain for sign-in, such as login.yourapp.com? Request account verification and our team will review it. A response may take up to 48 hours.">
    {state.isPending ? <Skeleton lines={2} label="Checking account verification request" /> : null}
    {state.error ? <Alert tone="danger" title="Request status could not be loaded">{state.error.message} {state.error.hint}<span className={styles.retry}><Button variant="secondary" size="sm" onClick={() => void state.refetch()}>Try request status again</Button></span></Alert> : null}
    {request ? <Surface className={styles.receipt}>
      <div ref={status} tabIndex={-1} role="status" className={styles.status}>
        <strong>{alreadyPending ? "Request already pending" : justSubmitted ? "Request submitted" : request.status === "pending" ? "Request awaiting review" : request.status === "approved" ? "Request approved" : "Request not approved"}</strong>
        <Badge size="sm" tone={pending ? "info" : request.status === "approved" ? "success" : "neutral"}>{pending ? "Pending review" : "Reviewed"}</Badge>
      </div>
      {alreadyPending ? <p className={styles.note}>You already have a pending request. This is your existing request; another one was not created.</p> : null}
      <p className={styles.note}>Submitted {formatDateTime(request.submitted_at)} from {request.context_app.name} ({request.context_app.app_id}).</p>
      <p className={styles.reason}>{request.reason}</p>
      {pending ? <p className={styles.note}>A response may take up to 48 hours, expected by {formatDateTime(request.response_expected_by)}. This request applies to your account across the apps you manage.</p> : request.reviewed_at ? <p className={styles.note}>Reviewed {formatDateTime(request.reviewed_at)}.</p> : null}
      <p className={styles.note}>Domain setup is handled with our team after review. Submitting a request does not change your sign-in domain.</p>
    </Surface> : null}
    {!state.isPending && !state.error && !pending ? <div className={styles.actions}><Button variant="secondary" onClick={() => { setFailure(null); setReasonError(undefined); setJustSubmitted(false); setOpen(true); }}>Request account verification</Button></div> : null}

    <Dialog open={open} onOpenChange={next => { if (!submit.isPending) setOpen(next); }}>
      <DialogContent title="Request account verification" description="Tell us why you want to use your own domain for sign-in. Our team will review your request; a response may take up to 48 hours." className={styles.dialog}
        onCloseAutoFocus={event => { if (focusReceipt.current && status.current) { event.preventDefault(); status.current.focus({ preventScroll: true }); } focusReceipt.current = false; }}>
        <form className={styles.form} onSubmit={event => void send(event)} noValidate>
          <Textarea ref={field} label="Reason" rows={5} value={reason} disabled={submit.isPending} error={reasonError} description={`${[...reason.trim()].length.toLocaleString()} / ${MAX_VERIFICATION_REASON.toLocaleString()} characters`} onChange={event => { setReason(event.currentTarget.value); setReasonError(undefined); setFailure(null); }} placeholder="How would using your own sign-in domain help your app?" />
          {failure ? <Alert tone="danger" title="Request could not be submitted">{failure.message} {failure.hint}</Alert> : null}
          <div className={styles.actions}><Button type="button" variant="ghost" disabled={submit.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={submit.isPending}>Submit request</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </Section>;
}

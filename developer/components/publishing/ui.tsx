"use client";

import { useRef, type ReactNode } from "react";
import { publishingMediaUrl } from "@/lib/apps-media";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Box,
  LoaderCircle,
  LockKeyhole,
} from "lucide-react";
import { ApiError, login } from "./api";
export { Button } from "@/components/silicon-ui/button/button";
export { Input } from "@/components/silicon-ui/input/input";
export { Textarea } from "@/components/silicon-ui/textarea/textarea";
export { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import { CopyButton } from "@/components/silicon-ui/copy-button/copy-button";
import { EmptyState } from "@/components/silicon-ui/empty-state/empty-state";
import { Dialog, DialogContent } from "@/components/silicon-ui/dialog/dialog";
export function ErrorNotice({
  error,
  retry,
}: {
  error?: Error;
  retry?: () => void;
}) {
  if (!error) return null;
  return (
    <div data-sq="surface" className="notice error" role="alert">
      <AlertCircle size={18} />
      <div>
        <strong>{error.message}</strong>
        {error instanceof ApiError && error.hint && <p>{error.hint}</p>}
        {error instanceof ApiError && Object.keys(error.details).length > 0 && (
          <details>
            <summary>View exact error details</summary>
            <pre>{JSON.stringify(error.details, null, 2)}</pre>
          </details>
        )}
        {error instanceof ApiError && error.status === 401 && <Button type="button" size="sm" onClick={login}>Sign in again</Button>}
        {retry && (
          <Button type="button" variant="secondary" size="sm" onClick={retry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={22} className="spin" />
      <span>{label}</span>
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <EmptyState
      title={title}
      description={description}
      action={action}
      icon={icon || <Box />}
      className="empty"
    />
  );
}
export function SignIn({ privateView = false }: { privateView?: boolean }) {
  return (
    <Empty
      title={
        privateView ? "Log in to see private apps" : "Your next app starts here"
      }
      description={
        privateView
          ? "Apps shared with you appear here after you sign in."
          : "Sign in with Silicon Accounts to create apps, manage releases, and build with others."
      }
      icon={<LockKeyhole size={30} />}
      action={
        <Button onClick={login}>
          Sign in with Silicon Accounts <ArrowRight size={16} />
        </Button>
      }
    />
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent
        title={title}
        description={description}
        className="publishing-panel app-modal"
        onOpenAutoFocus={() => {
          opener.current = document.activeElement as HTMLElement;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function SecretModal({
  secret,
  title = "Save your app secret",
  onClose,
}: {
  secret: string | null;
  title?: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open={!!secret}
      onClose={onClose}
      title={title}
      description="This secret is shown only once. Save it somewhere secure before closing this window."
    >
      <div className="stack">
        <div data-sq="surface" className="secret-value">
          <code>{secret}</code>
        </div>
        <CopyButton value={secret || ""} label="Copy secret" />
        <p className="muted">
          If you lose it, generate a new secret. The previous secret stops
          working immediately.
        </p>
        <Button onClick={onClose}>
          <Check size={16} /> I saved my secret
        </Button>
      </div>
    </Modal>
  );
}
export function PageTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}
export function SaveStatus({
  status,
  error,
  retry,
}: {
  status: string;
  error?: Error;
  retry?: () => void;
}) {
  return (
    <>
      <div
        className={`save-status ${status === "error" ? "danger" : ""}`}
        role="status"
      >
        {status === "saving" ? (
          <LoaderCircle size={14} className="spin" />
        ) : status === "saved" ? (
          <Check size={14} />
        ) : null}
        {status === "saving"
          ? "Saving changes…"
          : status === "saved"
            ? "All changes saved"
            : status === "error"
              ? "Changes could not be saved"
              : "Unsaved changes"}
      </div>
      <ErrorNotice error={error} retry={retry} />
    </>
  );
}
export function safeUrl(value?: string) {
  if (!value) return undefined;
  try {
    const normalized = publishingMediaUrl(value)!;
    const url = new URL(normalized, typeof window === "undefined" ? "https://developers.teamofsilicons.com" : window.location.origin);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
export function date(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

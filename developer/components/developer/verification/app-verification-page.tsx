"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ShieldCheck } from "lucide-react";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import { ConfirmMorph } from "@/components/silicon-ui/confirm-morph/confirm-morph";
import { EmptyState } from "@/components/silicon-ui/empty-state/empty-state";
import { Select } from "@/components/silicon-ui/select/select";
import { Skeleton } from "@/components/silicon-ui/skeleton/skeleton";
import { Page, PageHeader, Surface } from "@/components/foundation/layout/layout";
import { proofRevokeReason } from "@/lib/api/labels";
import type { AppProofHistoryEvent, ManagedAppProof, ManagedAppProofsQuery } from "@/lib/api/types";
import { formatDateTime, formatRelative, plural } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useAppProofHistory, useManagedAppProofs, useOwnedApps, useRevokeAppProof } from "@/lib/query/developer";
import { useAppLookups, type AppLookup, type KnownApp } from "../lib/apps";
import { PROOF_STATUS } from "../lib/labels";
import { AppIcon } from "../parts/app-icon";
import styles from "./verification.module.css";

const EVENTS: Record<AppProofHistoryEvent["action"], string> = {
  "proof.issued": "Verification issued",
  "proof.refreshed": "Token refreshed",
  "proof.revoked": "Verification revoked",
  "proof.refresh_token_reused": "Refresh token reused; verification revoked",
};

const unavailable = (error: { status: number } | null) => !!error && [401, 403, 404].includes(error.status);

function History({ history }: { history: ReturnType<typeof useAppProofHistory> }) {
  const events = unavailable(history.error) ? [] : history.data?.pages.flatMap(page => page.items) ?? [];
  const retry = () => history.isFetchNextPageError ? history.fetchNextPage() : history.refetch();
  return (
    <div className={styles.history}>
      <h3>Issuance and token history</h3>
      <p className={styles.note}>Each issuance, refresh and revocation is retained. Token values are shown only when created and cannot be retrieved here.</p>
      {history.isPending ? <Skeleton lines={3} label="Loading verification history" /> : null}
      {history.error ? <Alert tone="danger" title="History could not be loaded">{history.error.message} {history.error.hint}<span className={styles.retry}><Button size="sm" variant="secondary" onClick={() => void retry()}>Try history again</Button></span></Alert> : null}
      {events.length ? <ol className={styles.events}>
        {events.map(event => <li key={event.event_id}>
          <div className={styles.eventHead}><strong>{EVENTS[event.action] ?? event.action}</strong><time dateTime={event.at}>{formatDateTime(event.at)}</time></div>
          <p className={styles.note}>Recorded by {event.actor.kind === "system" ? "Silicon Accounts" : event.actor.id ?? event.actor.kind}</p>
          {event.action === "proof.issued" || event.action === "proof.refreshed" ? <p className={styles.note}>Token expiry: {event.token_expires_at ? formatDateTime(event.token_expires_at) : "Unavailable"}{event.token_expiry_source === "derived" ? <span className={styles.derived}>Derived from event time and recorded lifetime</span> : event.token_expiry_source === "recorded" ? <span className={styles.derived}>Recorded at issuance</span> : null}</p> : null}
          {event.details.reason ? <p className={styles.note}>{proofRevokeReason(event.details.reason)}</p> : null}
          {event.details.scopes?.length ? <p className={styles.note}>Scopes: <span className={styles.mono}>{event.details.scopes.join(", ")}</span></p> : null}
        </li>)}
      </ol> : !history.isPending && !history.error ? <p className={styles.note}>No retained events were returned for this verification.</p> : null}
      {history.hasNextPage && !unavailable(history.error) ? <Button size="sm" variant="secondary" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Load more history</Button> : null}
    </div>
  );
}

function VerificationRow({ proof, receiver }: { proof: ManagedAppProof; receiver?: AppLookup }) {
  const [expanded, setExpanded] = useState(false);
  const statusRef = useRef<HTMLSpanElement>(null);
  const historyId = useId();
  const revoke = useRevokeAppProof(proof.issuing_app.app_id);
  const history = useAppProofHistory(proof.issuing_app.app_id, proof.proof_id, expanded);
  const status = PROOF_STATUS[proof.status] ?? { label: proof.status, tone: "neutral" as const };
  const receivingId = proof.receiving_app ?? proof.audiences?.[0] ?? "Unknown receiving app";
  const receivingApp = receiver?.state === "found" ? receiver.app : null;
  if (unavailable(history.error)) return <li className={styles.unavailable}><Alert tone="danger" title="This verification is no longer available">{history.error?.message} {history.error?.hint}<span className={styles.retry}><Button size="sm" variant="secondary" onClick={() => void history.refetch()}>Try history again</Button></span></Alert></li>;
  return (
    <li data-sq="surface" className={styles.record} aria-label={`Verification ${proof.proof_id}`}>
      <div className={styles.recordHead}>
        <div className={styles.appFlow}>
          <div className={styles.appIdentity}><AppIcon name={proof.issuing_app.name} src={proof.issuing_app.logo_url} size={32} decorative /><div><Link href={paths.developerApp(proof.issuing_app.app_id, "app-verification")}>{proof.issuing_app.name}</Link><code>{proof.issuing_app.app_id}</code></div></div>
          <ArrowRight size={16} aria-label="verifies to" />
          <div className={styles.appIdentity}><AppIcon name={receivingApp?.name ?? receivingId} src={receivingApp?.logo_url ?? null} size={32} decorative /><div><span>{receivingApp?.name ?? receivingId}</span><code>{receivingId}</code></div></div>
        </div>
        <span ref={statusRef} tabIndex={-1} className={styles.status}><Badge size="sm" tone={status.tone}>{status.label}</Badge></span>
      </div>
      <dl className={styles.metadata}>
        <div><dt>Issued</dt><dd><time dateTime={proof.created_at} title={formatDateTime(proof.created_at)}>{formatDateTime(proof.created_at)}</time></dd></div>
        <div><dt>Latest token expires</dt><dd>{proof.token_expires_at ? <time dateTime={proof.token_expires_at}>{formatDateTime(proof.token_expires_at)}</time> : "No longer retained"}</dd></div>
        <div><dt>Verification expires (refresh lifetime)</dt><dd><time dateTime={proof.expires_at}>{formatDateTime(proof.expires_at)}</time></dd></div>
      </dl>
      <div className={styles.scopes}>{proof.scopes.length ? proof.scopes.map(scope => <code key={scope} data-sq="surface">{scope}</code>) : <span className={styles.note}>No scopes</span>}</div>
      {proof.revoked_at ? <p className={styles.note}>Revoked {formatRelative(proof.revoked_at)}{proof.revoke_reason ? `: ${proofRevokeReason(proof.revoke_reason)}` : ""}.</p> : null}
      <div className={styles.recordFoot}>
        <code className={styles.proofId}>Verification ID: {proof.proof_id}</code>
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" aria-expanded={expanded} aria-controls={historyId} onClick={() => setExpanded(value => !value)}>{expanded ? "Hide history" : "View history"}<ChevronDown size={14} className={styles.chevron} data-expanded={expanded || undefined} /></Button>
          {proof.status === "active" ? <ConfirmMorph label="Revoke" prompt="Revoke this verification?" confirmLabel="Revoke" pendingLabel="Revoking" doneLabel="Revoked" onConfirm={async () => {
            await revoke.mutateAsync(proof.proof_id);
            requestAnimationFrame(() => {
              const active = document.activeElement;
              if (!active || active === document.body || !active.isConnected) (statusRef.current ?? document.getElementById("app-verification-heading"))?.focus({ preventScroll: true });
            });
          }} /> : null}
        </div>
      </div>
      <div id={historyId} hidden={!expanded}>{expanded ? <History history={history} /> : null}</div>
    </li>
  );
}

export function AppVerificationPage() {
  const search = useSearchParams();
  const router = useRouter();
  const appId = search.get("app_id") ?? "";
  const rawStatus = search.get("status");
  const status: ManagedAppProofsQuery["status"] = rawStatus === "active" || rawStatus === "expired" || rawStatus === "revoked" ? rawStatus : undefined;
  const owned = useOwnedApps();
  const list = useManagedAppProofs({ app_id: appId || undefined, status });
  const proofs = useMemo(() => unavailable(list.error) ? [] : list.data?.pages.flatMap(page => page.items) ?? [], [list.data, list.error]);
  const known = useMemo<KnownApp[]>(() => (owned.data?.items ?? []).map(app => ({ app_id: app.app_id, name: app.name, logo_url: app.logo_url })), [owned.data]);
  const receiverIds = useMemo(() => [...new Set(proofs.flatMap(proof => proof.receiving_app ? [proof.receiving_app] : proof.audiences ?? []))], [proofs]);
  const lookups = useAppLookups(receiverIds, known);
  const options = [{ value: "*", label: "All managed apps" }, ...known.map(app => ({ value: app.app_id, label: `${app.name} · ${app.app_id}` }))];
  if (appId && !known.some(app => app.app_id === appId)) options.push({ value: appId, label: appId });
  const filter = (key: "app_id" | "status", value: string) => {
    const query = new URLSearchParams(search.toString());
    if (value === (key === "app_id" ? "*" : "all")) query.delete(key); else query.set(key, value);
    router.replace(`${paths.appVerification()}${query.size ? `?${query}` : ""}`, { scroll: false });
  };
  const filtered = !!appId || !!status;
  const retry = () => list.isFetchNextPageError ? list.fetchNextPage() : list.refetch();
  return <Page>
    <PageHeader title={<span id="app-verification-heading" tabIndex={-1}>App verification</span>} description="Every app verification issued by the apps you manage, including expired and revoked records." />
    <div className={styles.filters}>
      <Select label="Issuing app" value={appId || "*"} options={options} onValueChange={value => filter("app_id", value)} />
      <Select label="Status" value={status ?? "all"} options={[{ value: "all", label: "Any status" }, { value: "active", label: "Active" }, { value: "expired", label: "Expired" }, { value: "revoked", label: "Revoked" }]} onValueChange={value => filter("status", value)} />
      {filtered ? <Button size="sm" variant="ghost" onClick={() => router.replace(paths.appVerification(), { scroll: false })}>Clear filters</Button> : null}
    </div>
    <p className={styles.explanation}>Active verifications can issue new tokens until their refresh period ends. A token has its own shorter lifetime. Open an app’s App verification tab to create one.</p>
    {owned.error ? <Alert tone="danger" title="The app filter could not be loaded">{owned.error.message}<span className={styles.retry}><Button size="sm" variant="secondary" onClick={() => void owned.refetch()}>Try apps again</Button></span></Alert> : null}
    {list.isPending ? <Skeleton lines={6} label="Loading app verifications" /> : null}
    {list.error ? <Alert tone="danger" title="App verifications could not be loaded">{list.error.message} {list.error.hint}<span className={styles.retry}><Button size="sm" variant="secondary" onClick={() => void retry()}>Try again</Button></span></Alert> : null}
    {!list.isPending && !list.error && !proofs.length ? <Surface padding="none"><EmptyState icon={<ShieldCheck size={26} />} title={filtered ? "No app verifications match" : "No app verifications yet"} description={filtered ? "Try another issuing app or status, or clear the filters." : "App verifications created in this portal or by your apps’ servers will appear here."} /></Surface> : null}
    {proofs.length ? <ul className={styles.records} aria-label="App verifications">{proofs.map(proof => <VerificationRow key={proof.proof_id} proof={proof} receiver={lookups[proof.receiving_app ?? proof.audiences?.[0] ?? ""]} />)}</ul> : null}
    {list.hasNextPage && !unavailable(list.error) ? <div className={styles.more}><Button size="sm" variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more verifications</Button></div> : null}
    {proofs.length ? <p className={styles.count} aria-live="polite">{plural(proofs.length, "verification")} shown.</p> : null}
  </Page>;
}

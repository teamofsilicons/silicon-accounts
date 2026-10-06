/**
 * /proofs: the OBO proofs apps hold about you. Each is drawn as the issuing app acting at the receiving app, with a dash
 * flowing along the connector while it is live and a ring that empties as its current proof token runs out (the
 * issuing app refreshes it; the proof itself can last until its sign-in ends). Revoking one makes the receiving app's
 * next check fail at once.
 */
import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { ShieldCheck } from "lucide-solid";
import { api, collectPages, type MyProof } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { Badge } from "../../arc/badge/badge";
import { Button } from "../../arc/button/button";
import { ConfirmMorph } from "../../arc/confirm-morph/confirm-morph";
import { EmptyState } from "../../arc/empty-state/empty-state";
import { SegmentedControl } from "../../arc/segmented-control/segmented-control";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { useSquircle } from "../../arc/lib/squircle";
import { Page, PageHeader } from "../../app/layout/layout";
import { formatCountdown, formatDate, formatDateTime, formatRelative } from "../../lib/format";
import { AppMark } from "./parts/AppMark";
import { AnimatedRows } from "./parts/AnimatedRows";
import { createLoader, createNow, describeError, msUntil, reportFailure, spanText } from "./parts/common";
import { focusAfterRemoval, pageMain, pressedViewOption } from "./parts/focus";
import styles from "./proofs.module.css";
import "./parts/telemetry";

/** `GET /v1/me/proofs` items as the service sends them (the listing adds these to the documented fields). */
type Proof = MyProof & { token_expires_at?: string | null; revoked_at?: string | null; revoke_reason?: string | null };
type View = "active" | "ended";

/** Why a proof ended, in words (the service's revoke_reason codes). */
function endedBecause(proof: Proof): string {
  const issuing = proof.issuing_app.name;
  switch (proof.revoke_reason) {
    case "revoked_by_account": return "You revoked it";
    case "revoked_by_app": return `${issuing} revoked it`;
    case "revoked_by_owner": return `${issuing}'s owner revoked it`;
    case "refresh_token_reuse": return "Revoked because its refresh token was used twice, which can mean it leaked";
    case "sign_in_revoked": return `Ended when your sign-in at ${issuing} ended`;
    case "access_removed":
    case "membership_inactive": return `Ended when ${issuing}'s access was removed`;
    case "account_deleted":
    case "account_inactive": return "Ended with the account";
    default: return proof.status === "expired" ? "Expired" : "Revoked";
  }
}

export default function Proofs() {
  const proofs = createLoader(() => collectPages<Proof>(query => api.me.proofs.list(query) as Promise<{ items: Proof[]; next_cursor: string | null }>, 10));
  const [view, setView] = createSignal<View>("active");
  const now = createNow(1000);
  const active = createMemo(() => (proofs.data() ?? []).filter(item => item.status === "active"));
  const ended = createMemo(() => (proofs.data() ?? []).filter(item => item.status !== "active"));
  const shown = () => (view() === "active" ? active() : ended());

  const revoke = async (proofId: string) => {
    await api.me.proofs.revoke(proofId);
    window.setTimeout(() => {
      proofs.set(list => (list ?? []).map(item => (item.proof_id === proofId ? { ...item, status: "revoked", revoked_at: new Date().toISOString(), revoke_reason: "revoked_by_account" } : item)));
      // The card left the active view with keyboard focus in it: the next proof takes it, else the view switch.
      focusAfterRemoval(() => pageMain()?.querySelector('[role="list"][aria-label="Active proofs"]'), pressedViewOption);
    }, 900);
  };

  return (
    <Page width="reading">
      <PageHeader
        title="Proofs about you"
        description="When one app acts at another for you, it carries a proof from Silicon Accounts that the other app checks with us. Revoke one and the receiving app stops accepting it at once."
      />
      <Switch>
        <Match when={proofs.error() && !proofs.data()}>
          <Alert tone="danger" title="Your proofs did not load" action={<Button variant="secondary" onClick={() => void proofs.reload()}>Try again</Button>}>{describeError(proofs.error())}</Alert>
        </Match>
        <Match when={proofs.loading()}>
          <div class={styles.list} aria-busy="true" aria-label="Loading your proofs">
            <SkeletonBlock width="260px" height="40px" radius="14px" />
            <For each={[0, 1]}>{index => <SkeletonBlock width="100%" height="232px" radius="var(--radius-surface)" index={index + 1} />}</For>
          </div>
        </Match>
        <Match when={proofs.data()}>
          <div class={styles.toolbar}>
            <SegmentedControl
              label="Which proofs"
              value={view()}
              onValueChange={setView}
              options={[
                { value: "active", label: `Active (${active().length})` },
                { value: "ended", label: `Ended (${ended().length})` },
              ]}
            />
          </div>
          <Show
            when={shown().length}
            fallback={
              <div ref={el => useSquircle(el)} class={styles.empty}>
                <EmptyState
                  icon={<ShieldCheck width={24} height={24} stroke-width={1.5} />}
                  title={view() === "active" ? "No app is acting for you" : "No ended proofs"}
                  description={view() === "active" ? "When an app you use acts at another app on your behalf, its proof appears here and you can revoke it." : "Proofs that expire or are revoked appear here."}
                />
              </div>
            }
          >
            <AnimatedRows items={shown()} keyOf={item => item.proof_id} class={styles.list} label={view() === "active" ? "Active proofs" : "Ended proofs"}>
              {item => <ProofCard proof={item()} now={now()} onRevoke={() => revoke(item().proof_id)} />}
            </AnimatedRows>
          </Show>
        </Match>
      </Switch>
    </Page>
  );
}

function ProofCard(props: { proof: Proof; now: number; onRevoke: () => Promise<unknown> }) {
  const [error, setError] = createSignal<string | null>(null);
  const live = () => props.proof.status === "active";
  const issuing = () => props.proof.issuing_app;
  const receiving = () => props.proof.receiving_app;
  // The ring tracks the current proof token: from when it was minted (last refresh, else issue) to when it stops verifying.
  const tokenEnd = () => props.proof.token_expires_at ?? null;
  const left = () => msUntil(tokenEnd(), props.now);
  const fraction = () => {
    const end = tokenEnd();
    if (!live() || !end) return 0;
    const start = Date.parse(props.proof.last_refreshed_at ?? props.proof.created_at);
    const total = Date.parse(end) - start;
    if (!(total > 0)) return 0;
    return Math.min(1, Math.max(0, left() / total));
  };
  const flowing = () => live() && left() > 0;
  const status = () => {
    if (!live()) return endedBecause(props.proof);
    if (!tokenEnd()) return `Valid until ${formatDateTime(props.proof.expires_at)} unless revoked`;
    if (left() > 0) return `Current token checks out for ${spanText(left())} more`;
    return `Its token ran out ${formatRelative(tokenEnd(), props.now)}; ${issuing().name} can get a new one until ${formatDate(props.proof.expires_at)}`;
  };
  const ringLabel = () => {
    if (!live()) return "";
    if (!tokenEnd() || !(left() > 0)) return "0:00";
    const seconds = left() / 1000;
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h` : formatCountdown(seconds);
  };
  const ring = { r: 25, c: 2 * Math.PI * 25 };
  return (
    <article ref={el => useSquircle(el)} class={styles.card} data-live={live() || undefined} aria-label={`${issuing().name} acts at ${receiving().name} for you`}>
      <div class={styles.diagram}>
        <div class={styles.end}>
          <AppMark app={issuing()} size={52} />
          <span class={styles.endName}>{issuing().name}</span>
          <span class={styles.endRole}>acts for you</span>
        </div>
        <div class={styles.connector} data-flowing={flowing() || undefined} aria-hidden="true">
          <svg class={styles.line} viewBox="0 0 100 10" preserveAspectRatio="none">
            <line x1="0" y1="5" x2="100" y2="5" class={styles.track} vector-effect="non-scaling-stroke" />
            <line x1="0" y1="5" x2="100" y2="5" class={styles.flow} vector-effect="non-scaling-stroke" />
          </svg>
          <svg class={styles.head} viewBox="0 0 10 12"><path d="M1 1l7 5-7 5" /></svg>
          <span class={styles.ringWrap}>
            <svg class={styles.ring} viewBox="0 0 56 56">
              <circle cx="28" cy="28" r={ring.r} class={styles.ringTrack} />
              <circle cx="28" cy="28" r={ring.r} class={styles.ringFill} stroke-dasharray={`${ring.c}`} stroke-dashoffset={`${ring.c * (1 - fraction())}`} transform="rotate(-90 28 28)" />
            </svg>
            <span class={styles.ringText}>{live() ? ringLabel() : "×"}</span>
          </span>
        </div>
        <div class={styles.end}>
          <AppMark app={receiving()} size={52} />
          <span class={styles.endName}>{receiving().name}</span>
          <span class={styles.endRole}>checks the proof</span>
        </div>
      </div>
      <p class={styles.status}>{status()}</p>
      <div class={styles.meta}>
        <div class={styles.scopes}>
          <span class={styles.metaLabel}>Allowed to</span>
          <Show when={props.proof.scopes.length} fallback={<span class={styles.metaValue}>Anything {receiving().name} accepts from {issuing().name}</span>}>
            <ul class={styles.scopeList} role="list">
              <For each={props.proof.scopes}>{scope => <li ref={el => useSquircle(el)} class={styles.scope}>{scope}</li>}</For>
            </ul>
          </Show>
        </div>
        <dl class={styles.facts}>
          <div><dt>Issued</dt><dd>{formatRelative(props.proof.created_at, props.now)}</dd></div>
          <Show when={live()} fallback={<div><dt>{props.proof.status === "expired" ? "Expired" : "Ended"}</dt><dd>{props.proof.revoked_at ? formatRelative(props.proof.revoked_at, props.now) : formatDate(props.proof.expires_at)}</dd></div>}>
            <div><dt>Refreshed</dt><dd>{props.proof.last_refreshed_at ? formatRelative(props.proof.last_refreshed_at, props.now) : "Not yet"}</dd></div>
            <div><dt>Ends by</dt><dd>{formatDate(props.proof.expires_at)}</dd></div>
          </Show>
        </dl>
      </div>
      <div class={styles.foot}>
        <Badge size="sm" tone={live() ? "success" : "neutral"} dot={live()}>{live() ? "Active" : props.proof.status === "expired" ? "Expired" : "Revoked"}</Badge>
        <Show when={live()}>
          <ConfirmMorph
            label="Revoke"
            prompt={`Revoke ${issuing().name}'s proof?`}
            confirmLabel="Revoke"
            pendingLabel="Revoking"
            doneLabel="Revoked"
            onConfirm={() => { setError(null); return props.onRevoke(); }}
            onError={raw => setError(reportFailure(raw, "The proof was not revoked"))}
          />
        </Show>
      </div>
      <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
    </article>
  );
}

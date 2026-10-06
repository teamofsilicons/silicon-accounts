"use client";

/**
 * /proofs: the OBO proofs apps hold about you, every one of them (the list is read to its end). Each is drawn as the
 * issuing app acting at the receiving app, with a dash flowing along the connector while it is live and a ring that
 * empties as its current proof token runs out (the issuing app refreshes it; the proof itself can last until its
 * sign-in ends). Revoking one makes the receiving app's next check fail at once.
 *
 * Only a live card's ring, countdown and status line tick (once a second, from one shared clock); the rest of each card
 * renders once and follows the minute, so a long list stays smooth.
 */
import { memo, useCallback, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { ConfirmMorph } from "@/components/arc/confirm-morph/confirm-morph";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import type { MyProof } from "@/lib/api/types";
import { formatCountdown, formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { AnimatedRows } from "../parts/animated-rows";
import { AppMark } from "../parts/app-mark";
import { describeError, msUntil, spanText, useNow, useSecondTick } from "../parts/common";
import { FitPrompt } from "../parts/fit-prompt";
import { focusAfterRemoval, pageMain, pressedViewOption } from "../parts/focus";
import { ListCap } from "../parts/list-cap";
import { useEveryProof, useRevokeProof } from "../parts/queries";
import styles from "./proofs.module.css";

type View = "active" | "ended";

/** Why a proof ended, in words (the service's revoke_reason codes). */
function endedBecause(proof: MyProof): string {
  const issuing = proof.issuing_app.name;
  switch (proof.revoke_reason) {
    case "revoked_by_account": return "You revoked it";
    case "revoked_by_app": return `${issuing} revoked it`;
    case "revoked_by_owner": return `${issuing}'s owner revoked it`;
    case "refresh_token_reuse": return "Revoked because its refresh token was used twice, which can mean it leaked";
    case "sign_in_revoked": return `Ended when your sign-in at ${issuing} ended`;
    case "sign_in_expired": return `Ended when your sign-in at ${issuing} expired`;
    case "access_removed":
    case "membership_inactive": return `Ended when ${issuing}'s access was removed`;
    case "account_deleted":
    case "account_inactive": return "Ended with the account";
    default: return proof.status === "expired" ? "Expired" : "Revoked";
  }
}

export function Proofs() {
  const proofs = useEveryProof();
  const [view, setView] = useState<View>("active");
  // Issued, refreshed and ended times follow the minute; the live parts of a card tick on their own.
  const now = useNow(60_000);
  const { mutateAsync: revoke } = useRevokeProof();
  const items = proofs.data?.items ?? [];
  const active = items.filter(item => item.status === "active");
  const ended = items.filter(item => item.status !== "active");
  const shown = view === "active" ? active : ended;

  const revokeOne = useCallback(async (proofId: string) => {
    await revoke(proofId);
    // "Revoked" shows in place, then the card moves to the ended proofs; focus goes to the next proof, else the switch.
    window.setTimeout(() => focusAfterRemoval(() => pageMain()?.querySelector('[role="list"][aria-label="Active proofs"]'), pressedViewOption), 960);
  }, [revoke]);

  return (
    <Page width="reading">
      <PageHeader
        title="Proofs about you"
        description="When one app acts at another for you, it carries a proof from Silicon Accounts that the other app checks with us. Revoke one and the receiving app stops accepting it at once."
      />
      {proofs.error && !proofs.data ? (
        <Alert tone="danger" title="Your proofs did not load">
          {describeError(proofs.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void proofs.refetch()}>Try again</Button></span>
        </Alert>
      ) : !proofs.data ? (
        <div className={styles.list} aria-busy="true" aria-label="Loading your proofs">
          <SkeletonBlock width="260px" height="40px" radius="14px" />
          {[0, 1].map(index => <SkeletonBlock key={index} width="100%" height="232px" radius="var(--radius-surface)" index={index + 1} />)}
        </div>
      ) : (
        <>
          <div className={styles.toolbar}>
            <SegmentedControl
              label="Which proofs"
              value={view}
              onValueChange={value => setView(value as View)}
              options={[
                { value: "active", label: `Active (${active.length})` },
                { value: "ended", label: `Ended (${ended.length})` },
              ]}
            />
          </div>
          {shown.length ? (
            <AnimatedRows items={shown} keyOf={item => item.proof_id} className={styles.list} label={view === "active" ? "Active proofs" : "Ended proofs"}>
              {item => <ProofCard proof={item} now={now} onRevoke={revokeOne} />}
            </AnimatedRows>
          ) : (
            <div data-sq="surface" className={styles.empty}>
              <EmptyState
                icon={<ShieldCheck width={24} height={24} strokeWidth={1.5} />}
                title={view === "active" ? "No app is acting for you" : "No ended proofs"}
                description={view === "active" ? "When an app you use acts at another app on your behalf, its proof appears here and you can revoke it." : "Proofs that expire or are revoked appear here."}
              />
            </div>
          )}
          <ListCap page={proofs.data} noun="proofs" command="accounts proofs list" />
        </>
      )}
    </Page>
  );
}

const RING = { r: 25, c: 2 * Math.PI * 25 };

/** Where the current proof token stands at `now`: the ring tracks it from when it was minted (last refresh, else issue). */
function tokenState(proof: MyProof, now: number) {
  const tokenEnd = proof.token_expires_at ?? null;
  const left = msUntil(tokenEnd, now);
  const start = Date.parse(proof.last_refreshed_at ?? proof.created_at);
  const total = tokenEnd ? Date.parse(tokenEnd) - start : Number.NaN;
  const fraction = !tokenEnd || !(total > 0) ? 0 : Math.min(1, Math.max(0, left / total));
  return { tokenEnd, left, fraction };
}

/** The connector, its flowing dash and the expiry ring. A live proof's part ticks every second; an ended one never. */
function Connector({ proof }: { proof: MyProof }) {
  return proof.status === "active" ? <LiveConnector proof={proof} /> : <ConnectorShape flowing={false} fraction={0} label="×" />;
}

function LiveConnector({ proof }: { proof: MyProof }) {
  const now = useSecondTick();
  const { tokenEnd, left, fraction } = tokenState(proof, now);
  const label = !tokenEnd || !(left > 0) ? "0:00" : left / 1000 >= 3600 ? `${Math.floor(left / 3_600_000)}h` : formatCountdown(left / 1000);
  return <ConnectorShape flowing={left > 0} fraction={fraction} label={label} />;
}

function ConnectorShape({ flowing, fraction, label }: { flowing: boolean; fraction: number; label: string }) {
  return (
    <div className={styles.connector} data-flowing={flowing || undefined} aria-hidden="true">
      <svg className={styles.line} viewBox="0 0 100 10" preserveAspectRatio="none">
        <line x1="0" y1="5" x2="100" y2="5" className={styles.track} vectorEffect="non-scaling-stroke" />
        <line x1="0" y1="5" x2="100" y2="5" className={styles.flow} vectorEffect="non-scaling-stroke" />
      </svg>
      <svg className={styles.head} viewBox="0 0 10 12"><path d="M1 1l7 5-7 5" /></svg>
      <span className={styles.ringWrap}>
        <svg className={styles.ring} viewBox="0 0 56 56">
          <circle cx="28" cy="28" r={RING.r} className={styles.ringTrack} />
          <circle cx="28" cy="28" r={RING.r} className={styles.ringFill} strokeDasharray={`${RING.c}`} strokeDashoffset={`${RING.c * (1 - fraction)}`} transform="rotate(-90 28 28)" />
        </svg>
        <span className={styles.ringText}>{label}</span>
      </span>
    </div>
  );
}

/** The line under the diagram: why an ended proof ended, or how long a live one's token still checks out (ticking). */
function Status({ proof }: { proof: MyProof }) {
  if (proof.status !== "active") return <p className={styles.status}>{endedBecause(proof)}</p>;
  if (!proof.token_expires_at) return <p className={styles.status}>Valid until {formatDateTime(proof.expires_at)} unless revoked</p>;
  return <LiveStatus proof={proof} />;
}

function LiveStatus({ proof }: { proof: MyProof }) {
  const now = useSecondTick();
  const { tokenEnd, left } = tokenState(proof, now);
  return (
    <p className={styles.status}>
      {left > 0
        ? `Current token checks out for ${spanText(left)} more`
        : `Its token ran out ${formatRelative(tokenEnd, now)}; ${proof.issuing_app.name} can get a new one until ${formatDate(proof.expires_at)}`}
    </p>
  );
}

/** One proof. Memoized: the page re-renders it only when the proof or the minute changes. */
const ProofCard = memo(function ProofCard({ proof, now, onRevoke }: { proof: MyProof; now: number; onRevoke: (proofId: string) => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const live = proof.status === "active";
  const issuing = proof.issuing_app;
  const receiving = proof.receiving_app;
  return (
    <article data-sq="surface" className={styles.card} data-live={live || undefined} aria-label={`${issuing.name} acts at ${receiving.name} for you`}>
      <div className={styles.diagram}>
        <div className={styles.end}>
          <AppMark app={issuing} size={52} />
          <span className={styles.endName}>{issuing.name}</span>
          <span className={styles.endRole}>acts for you</span>
        </div>
        <Connector proof={proof} />
        <div className={styles.end}>
          <AppMark app={receiving} size={52} />
          <span className={styles.endName}>{receiving.name}</span>
          <span className={styles.endRole}>checks the proof</span>
        </div>
      </div>
      <Status proof={proof} />
      <div className={styles.meta}>
        <div className={styles.scopes}>
          <span className={styles.metaLabel}>Allowed to</span>
          {proof.scopes.length ? (
            <ul className={styles.scopeList} role="list">
              {proof.scopes.map(scope => <li key={scope} data-sq="surface" className={styles.scope}>{scope}</li>)}
            </ul>
          ) : <span className={styles.metaValue}>Anything {receiving.name} accepts from {issuing.name}</span>}
        </div>
        <dl className={styles.facts}>
          <div><dt>Issued</dt><dd>{formatRelative(proof.created_at, now)}</dd></div>
          {live ? (
            <>
              <div><dt>Refreshed</dt><dd>{proof.last_refreshed_at ? formatRelative(proof.last_refreshed_at, now) : "Not yet"}</dd></div>
              <div><dt>Ends by</dt><dd>{formatDate(proof.expires_at)}</dd></div>
            </>
          ) : (
            <div><dt>{proof.status === "expired" ? "Expired" : "Ended"}</dt><dd>{proof.revoked_at ? formatRelative(proof.revoked_at, now) : formatDate(proof.expires_at)}</dd></div>
          )}
        </dl>
      </div>
      <div className={styles.foot}>
        <Badge size="sm" tone={live ? "success" : "neutral"}>{live ? "Active" : proof.status === "expired" ? "Expired" : "Revoked"}</Badge>
        {live ? (
          <ConfirmMorph
            label="Revoke"
            prompt={<FitPrompt full={`Revoke ${issuing.name}'s proof?`} short="Revoke this proof?" tiny="Revoke it?" />}
            confirmLabel="Revoke"
            pendingLabel="Revoking"
            doneLabel="Revoked"
            onConfirm={async () => {
              setError(null);
              try {
                await onRevoke(proof.proof_id);
              } catch (raw) {
                setError(describeError(raw));
                throw raw;
              }
            }}
          />
        ) : null}
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </article>
  );
});

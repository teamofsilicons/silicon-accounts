"use client";

/**
 * Permissions between apps as rows (the prototype's `proof` row, Anil 2026-11-12): one app doing something in another
 * app for you. A live one: both apps' marks, "Briefcase in Commit", what it may do and until when, and Stop, asked first
 * in a dialog (the dialog rules). An ended one: the marks faded, and why and when it ended. Used by /proofs and by an
 * app's page (/apps/[id], "Also acts for you", where the acting app is the page's own, so only the other one is named).
 */
import { useState } from "react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import type { MyProof } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { AppMark } from "../parts/app-mark";
import { withAppIcon } from "../parts/app-icons";
import { describeError } from "../parts/common";
import { useRevokeProof } from "../parts/queries";
import { Row, Strong } from "../parts/rows";
import styles from "./apps.module.css";

/** What a permission lets the acting app do, in words. */
const allowedOf = (proof: MyProof) => proof.scopes.length ? proof.scopes.join(", ") : `anything ${proof.receiving_app.name} accepts`;

/** Why a permission ended, in words (the service's revoke_reason codes). */
export function endedBecause(proof: MyProof): string {
  const issuing = proof.issuing_app.name;
  switch (proof.revoke_reason) {
    case "revoked_by_account": return "You stopped it";
    case "revoked_by_app": return `${issuing} stopped it`;
    case "revoked_by_owner": return `${issuing}’s owner stopped it`;
    case "refresh_token_reuse": return "Stopped because its refresh token was used twice";
    case "sign_in_revoked": return `Ended with your sign-in at ${issuing}`;
    case "sign_in_expired": return `Ended when your sign-in at ${issuing} expired`;
    case "access_removed":
    case "membership_inactive": return `Ended when ${issuing}’s access was removed`;
    case "account_deleted":
    case "account_inactive": return "Ended with the account";
    default: return proof.status === "expired" ? "Expired" : "Stopped";
  }
}

/** Both apps' marks, the acting one first, overlapping. */
function Pair({ proof, faded }: { proof: MyProof; faded?: boolean }) {
  return (
    <span className={styles.pair} data-faded={faded || undefined} aria-hidden="true">
      <AppMark app={withAppIcon(proof.issuing_app)} size={28} className={styles.mark} decorative />
      <AppMark app={withAppIcon(proof.receiving_app)} size={28} className={styles.mark} decorative />
    </span>
  );
}

/** A live permission with Stop. `own` drops the acting app from the title (on that app's own page). */
export function ActiveProofRow({ proof, own }: { proof: MyProof; own?: boolean }) {
  const revoke = useRevokeProof();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issuing = proof.issuing_app.name;
  const receiving = proof.receiving_app.name;
  const allowed = allowedOf(proof);
  const stop = async () => {
    setError(null);
    try {
      await revoke.mutateAsync(proof.proof_id);
      setAsking(false);
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  return (
    <Row
      lead={own ? <AppMark app={withAppIcon(proof.receiving_app)} size={28} className={styles.mark} decorative /> : <Pair proof={proof} />}
      title={own ? `In ${receiving}` : `${issuing} in ${receiving}`}
      detail={<>May do {allowed} · ends <Strong>{formatDate(proof.expires_at)}</Strong></>}
    >
      <Button variant="secondary" size="sm" onClick={() => setAsking(true)} aria-label={`Stop ${issuing} acting in ${receiving}`}>Stop</Button>
      <Dialog open={asking} onOpenChange={open => { if (!open && !revoke.isPending) setAsking(false); }}>
        <DialogContent title={`Stop ${issuing} acting in ${receiving}?`} description={<>It can no longer do <strong>{allowed}</strong> in {receiving} for you. {receiving}&rsquo;s next check fails at once.</>}>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setAsking(false)} disabled={revoke.isPending}>Cancel</Button>
            <Button variant="danger" loading={revoke.isPending} onClick={() => void stop()}>Stop</Button>
          </div>
        </DialogContent>
      </Dialog>
    </Row>
  );
}

/** An ended permission: why and when it ended. */
export function EndedProofRow({ proof }: { proof: MyProof }) {
  const at = proof.revoked_at ?? proof.expires_at;
  return (
    <Row
      lead={<Pair proof={proof} faded />}
      title={`${proof.issuing_app.name} in ${proof.receiving_app.name}`}
      detail={<>{endedBecause(proof)} · <Strong>{formatDate(at)}</Strong></>}
    />
  );
}

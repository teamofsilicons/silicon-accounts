"use client";

/**
 * Inside an app's card on /apps: the user verifications that app holds to act for you at other apps (each one is part
 * of your relationship with the app that acts, so it lives in that app's card). A compact row per live verification:
 * where it acts, what it may do and until when, and Revoke in place. The full picture (the diagram, the token's
 * countdown, ended verifications) is on /proofs, linked below the rows.
 */
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { ConfirmMorph } from "@teamofsilicons/silicon-ui/confirm-morph";
import Link from "next/link";
import type { MyProof } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useTheme } from "@/components/foundation/theme/use-theme";
import { appLogo, describeError } from "../parts/common";
import { FitPrompt } from "../parts/fit-prompt";
import styles from "./acting-for-you.module.css";

export function ActingForYou({ appName, proofs, onRevoke }: { appName: string; proofs: MyProof[]; onRevoke: (proofId: string) => Promise<unknown> }) {
  if (!proofs.length) return null;
  return (
    <section className={styles.root} aria-label={`Where ${appName} acts for you`}>
      <span className={styles.label}>Acts for you at</span>
      <ul className={styles.list} role="list">
        {proofs.map(proof => <ProofRow key={proof.proof_id} proof={proof} onRevoke={onRevoke} />)}
      </ul>
      <Link href={paths.proofs} className={styles.more}>
        User verification details
        <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
      </Link>
    </section>
  );
}

function ProofRow({ proof, onRevoke }: { proof: MyProof; onRevoke: (proofId: string) => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const { theme } = useTheme();
  const receiving = proof.receiving_app;
  const allowed = proof.scopes.length ? proof.scopes.join(", ") : `anything ${receiving.name} accepts`;
  return (
    <li className={styles.row}>
      <Avatar name={receiving.name} src={appLogo(receiving, theme) ?? undefined} size="sm" />
      <span className={styles.text}>
        <span className={styles.name}>{receiving.name}</span>
        <span className={styles.meta}>May do {allowed} · ends by {formatDate(proof.expires_at)}</span>
        {error ? <span className={styles.error} role="alert">{error}</span> : null}
      </span>
      <ConfirmMorph
        label="Revoke"
        prompt={<FitPrompt full={`Stop it acting at ${receiving.name}?`} short="Revoke it?" />}
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
    </li>
  );
}

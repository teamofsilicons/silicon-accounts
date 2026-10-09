/**
 * Carbon-facing words for codes the API sends, shared by every page area so the same code always reads the same way.
 * Unknown codes fall back to a neutral sentence (never the raw code).
 */
import type { ProofRevokeReason } from "./types";

/** "Ended because …" for `revoke_reason` (mirrors crates/proofs model.rs revoke_reason::describe). */
export const PROOF_REVOKE_REASONS: Record<string, string> = {
  revoked_by_app: "the issuing app revoked it",
  revoked_by_owner: "the issuing app's owner revoked it",
  revoked_by_account: "the account it speaks for revoked it",
  refresh_token_reuse: "one of its refresh tokens was presented again after it had been used",
  access_removed: "the account removed the issuing app's access",
  account_deleted: "the account it speaks for was deleted",
  sign_in_revoked: "the account's sign-in at the issuing app was revoked",
  sign_in_expired: "the account's sign-in at the issuing app expired",
  membership_inactive: "the account is no longer an active member of the issuing app",
  account_inactive: "the account is no longer active",
};

/** A readable reason for a proof's `revoke_reason` (or a neutral fallback for codes the site does not know yet). */
export function proofRevokeReason(reason: ProofRevokeReason | null | undefined): string {
  if (!reason) return "it was revoked";
  return PROOF_REVOKE_REASONS[reason] ?? "it was revoked";
}

/** Session origins (`GET /v1/me/sessions`). */
export const SESSION_ORIGINS: Record<string, string> = {
  browser: "Browser",
  device: "CLI sign-in approved in a browser",
  cli_code: "CLI sign-in with a code",
  silicon_login: "Silicon sign-in with its STK",
  federated: "Silicon sign-in from a trusted CI job",
};

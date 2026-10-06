/**
 * Words for the developer area: methods, statuses, sources, webhook events and import outcomes. One word per concept,
 * the same words the API and the CLI use.
 */
import type { AppSource, AppStatus, DeliveryStatus, ImportOutcome, MembershipSource, SigninMethod } from "../../../api";
import type { BadgeTone } from "../../../arc/badge/badge";

export const METHOD_LABEL: Record<SigninMethod, string> = { google: "Google", apple: "Apple", email: "Email", phone: "Phone" };

export const METHOD_DESCRIPTION: Record<SigninMethod, string> = {
  google: "Sign in with Google",
  apple: "Sign in with Apple",
  email: "A 6 digit code sent by email",
  phone: "A 6 digit code sent by SMS",
};

export const SOURCE_LABEL: Record<AppSource, string> = {
  first_party: "First-party",
  fake: "Stand-in app",
  silicon_apps: "Silicon Apps",
};

export const SOURCE_NOTE: Record<AppSource, string> = {
  first_party: "Silicon Accounts' own app: the account site and the CLI.",
  fake: "Created inside Silicon Accounts until Silicon Apps ships. It keeps its app_id and its users when it moves there.",
  silicon_apps: "Created in Silicon Apps.",
};

export const APP_STATUS: Record<AppStatus, { label: string; tone: BadgeTone }> = {
  active: { label: "Active", tone: "success" },
  disabled: { label: "Disabled", tone: "warning" },
};

/** User base row statuses (the server adds "deleted" for accounts that no longer exist). */
export const USER_STATUS: Record<string, { label: string; tone: BadgeTone; description: string }> = {
  active: { label: "Active", tone: "success", description: "Signed in and has access." },
  imported: { label: "Imported", tone: "info", description: "Imported by the app; becomes active the first time they sign in here." },
  access_removed: { label: "Access removed", tone: "warning", description: "Signed out of the app or removed its access." },
  deleted: { label: "Deleted", tone: "neutral", description: "The account was deleted. Its uuid stays reserved forever." },
};

export const MEMBERSHIP_SOURCE: Record<MembershipSource, string> = {
  signin: "Sign-in",
  slt: "Silicon token",
  import: "Import",
};

export const SIGNIN_METHOD_LABEL: Record<string, string> = {
  email: "Email code",
  phone: "SMS code",
  google: "Google",
  apple: "Apple",
  silicon_stk: "Silicon STK",
  slt: "Short-lived token",
  device: "CLI device code",
  session: "Browser session",
};

export const SIGNIN_OUTCOME: Record<string, { label: string; tone: BadgeTone }> = {
  success: { label: "Signed in", tone: "success" },
  new_account: { label: "New account", tone: "info" },
  failed: { label: "Failed", tone: "danger" },
};

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: BadgeTone }> = {
  delivered: { label: "Delivered", tone: "success" },
  pending: { label: "Retrying", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export const EVENT_DESCRIPTION: Record<string, string> = {
  "account.id_changed": "A member changed their c:id or si:id. Store the uuid; ids can change.",
  "account.updated": "A detail the app can see changed (name, photo, email, phone, date of birth, timezone).",
  "account.deleted": "A member deleted their account.",
  "membership.signed_out": "A member signed out of the app, or their tokens were revoked.",
  "membership.access_removed": "A member removed the app's access on account.teamofsilicons.com.",
  "silicon.custodian_changed": "A Silicon member moved to another custodian.",
  ping: "A test event, sent when you press Send test ping.",
};

export const IMPORT_OUTCOME: Record<ImportOutcome | "pending", { label: string; tone: BadgeTone }> = {
  created: { label: "Created", tone: "success" },
  matched: { label: "Matched", tone: "info" },
  updated: { label: "Updated", tone: "info" },
  skipped: { label: "Skipped", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
  pending: { label: "Waiting", tone: "neutral" },
};

export const PROOF_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  active: { label: "Active", tone: "success" },
  expired: { label: "Expired", tone: "neutral" },
  revoked: { label: "Revoked", tone: "warning" },
};

/** "1 minute", "30 minutes" for TTLs in seconds. */
export function ttlLabel(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} seconds`;
}

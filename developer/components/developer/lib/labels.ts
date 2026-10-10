/**
 * Words for the developer area: methods, statuses, sources, webhook events and import outcomes. One word per concept,
 * the same words the API and the CLI use.
 */
import type { BadgeTone } from "@/components/silicon-ui/badge/badge";
import type { AppSource, AppStatus, DeliveryStatus, ImportOutcome, MembershipSource, SigninMethod } from "@/lib/api/types";

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

export const appStatus = (status: string) => APP_STATUS[status as AppStatus] ?? { label: status, tone: "neutral" as BadgeTone };

/** User base row statuses (the server adds "deleted" for accounts that no longer exist). */
export const USER_STATUS: Record<string, { label: string; tone: BadgeTone; description: string }> = {
  active: { label: "Active", tone: "success", description: "Signed in and has access." },
  imported: { label: "Imported", tone: "info", description: "Imported by the app; becomes active the first time they sign in." },
  access_removed: { label: "Access removed", tone: "warning", description: "Signed out of the app or removed its access." },
  deleted: { label: "Deleted", tone: "neutral", description: "The account was deleted. Its uuid stays reserved forever." },
};

export const userStatus = (status: string) => USER_STATUS[status] ?? { label: status, tone: "neutral" as BadgeTone, description: "" };

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
  session: "Continue as, from a signed-in browser",
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

export const deliveryStatus = (status: string) => DELIVERY_STATUS[status as DeliveryStatus] ?? { label: status, tone: "neutral" as BadgeTone };

export const EVENT_DESCRIPTION: Record<string, string> = {
  "account.id_changed": "A member changed their c:id or si:id. Store the uuid; ids can change.",
  "account.updated": "A detail the app can see changed (name, photo, email, phone, date of birth, timezone).",
  "account.deleted": "A member deleted their account.",
  "membership.signed_out": "A member signed out of the app, or their tokens were revoked.",
  "membership.access_removed": "A member removed the app's access on accounts.teamofsilicons.com.",
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

export const importOutcome = (outcome: string) => IMPORT_OUTCOME[outcome as ImportOutcome] ?? { label: outcome, tone: "neutral" as BadgeTone };

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

/** "host/path" of a URL for compact display; the URL itself when it does not parse. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

/** "0192a6f0…00e3" for long ids in lists; the full id stays reachable (title, drawer, copy). */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

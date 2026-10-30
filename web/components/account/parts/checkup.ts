/**
 * The prototype's security checkup as Home's "Finish setting up" steps (Anil, 2026-10-30, picked in /__needs): a second
 * way in (Google or Apple), a verified email, a recovery phone, and only devices still in use. A device counts as not
 * used lately after 7 days; Keep remembers the choice in this browser. Home (home-needs.tsx) asks about such a device
 * in Needs you and shows no checklist for now (Anil, 2026-10-31); the previous Home (overview/overview.tsx) still uses
 * the steps.
 */
import { AtSign, KeyRound, Laptop, Smartphone } from "lucide-react";
import type { CarbonMe, SessionInfo } from "@/lib/api/types";
import { formatPhone, formatRelative } from "@/lib/format";
import { sessionName } from "../security/sessions";

/** A device not used for this long is "not used lately" (Anil, 2026-10-30). */
const STALE_MS = 7 * 86_400_000;

/** Sessions the Carbon chose to keep although they are not used lately, remembered in this browser. */
const KEPT_KEY = "accounts.home.kept-sessions";
const keptListeners = new Set<() => void>();

export const subscribeKept = (listener: () => void) => {
  keptListeners.add(listener);
  return () => keptListeners.delete(listener);
};

export function readKept(): string {
  try {
    return window.localStorage.getItem(KEPT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function keepSession(id: string) {
  try {
    const ids = new Set(readKept().split(",").filter(Boolean));
    ids.add(id);
    window.localStorage.setItem(KEPT_KEY, [...ids].join(","));
  } catch {
    // Storage blocked: the question comes back next visit.
  }
  keptListeners.forEach(listener => listener());
}

export interface Step {
  key: "provider" | "email" | "phone" | "devices";
  done: boolean;
  title: string;
  detail: string;
  /** The device not used lately, for Keep and Sign out. */
  stale?: SessionInfo;
}

/** A device signed in here but not used lately (7 days), unless the Carbon chose to keep it; undefined while loading. */
export function staleSession(sessions: SessionInfo[] | undefined, now: number, kept: string): SessionInfo | undefined {
  const keptIds = new Set(kept.split(",").filter(Boolean));
  return (sessions ?? []).find(item => !item.current && !keptIds.has(item.id) && !!item.last_seen_at && now - Date.parse(item.last_seen_at) > STALE_MS);
}

/** The prototype's checkup (Security), in its order: a second way in, a verified email, a recovery phone, devices. */
export function checkupSteps(carbon: CarbonMe, sessions: SessionInfo[] | undefined, now: number, kept: string): Step[] {
  const providers = carbon.identities.map(identity => (identity.provider === "google" ? "Google" : identity.provider === "apple" ? "Apple" : null)).filter(Boolean);
  const email = carbon.emails.find(item => item.verified_at && item.is_primary) ?? carbon.emails.find(item => item.verified_at);
  const phone = carbon.phones.find(item => item.is_primary) ?? carbon.phones[0];
  // Until the sessions load, devices count as fine rather than flash a question.
  const stale = staleSession(sessions, now, kept);
  return [
    { key: "provider", done: providers.length > 0, title: "Sign in with Google or Apple", detail: providers.length ? `${providers.join(" and ")} signs you in` : "A second way in that isn't a code" },
    { key: "email", done: !!email, title: "Verified email", detail: email?.email ?? "Add an email" },
    { key: "phone", done: !!phone, title: "Recovery phone", detail: phone ? formatPhone(phone.phone) : "Gets you in if you lose your email" },
    stale
      ? { key: "devices", done: false, title: "Only devices you still use", detail: `${sessionName(stale)} · last used ${formatRelative(stale.last_seen_at ?? stale.created_at, now)}`, stale }
      : { key: "devices", done: true, title: "Only devices you still use", detail: "Every device was used recently" },
  ];
}

export const STEP_ICON = { provider: KeyRound, email: AtSign, phone: Smartphone, devices: Laptop } as const;

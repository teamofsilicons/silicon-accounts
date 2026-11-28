/**
 * The prototype's security checkup as Home's "Finish setting up" steps (Anil, 2026-10-30, picked in /__needs): a second
 * way in (Google or Apple), a verified email, a recovery phone, and only devices still in use. Home (home-needs.tsx)
 * asks about such a device in Needs you and shows no checklist for now (Anil, 2026-10-31); the previous Home
 * (overview/overview.tsx) still uses the steps.
 *
 * Devices not used lately (Anil, 2026-11-26, after the question came back every day): a sign-in counts after 30 days
 * unused (it was 7), one question per device (every old sign-in with the same name, "Chrome on macOS", together), and
 * Keep is stored on the sign-ins (`kept_at`, POST /v1/me/sessions/{id}/keep), so no browser asks again until one is used
 * and goes quiet again. An API without `kept_at` (one deployed before it) falls back to the list kept in this browser.
 */
import { AtSign, KeyRound, Laptop, Smartphone } from "lucide-react";
import type { CarbonMe, SessionInfo } from "@/lib/api/types";
import { formatPhone, formatRelative } from "@/lib/format";
import { sessionName } from "../security/sessions";
import { spanText } from "./common";

/** A sign-in not used for this long is "not used lately" (Anil, 2026-11-26; 7 days from 2026-10-30). */
export const STALE_MS = 30 * 86_400_000;

/** Sessions the Carbon chose to keep, remembered in this browser, for an API without `kept_at`. */
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

/** The passkey offer on Home (Anil, 2026-11-23): "Not now" is remembered in this browser, as Keep is. */
const PASSKEY_OFFER_KEY = "accounts.home.passkey-offer";
const offerListeners = new Set<() => void>();

export const subscribePasskeyOffer = (listener: () => void) => {
  offerListeners.add(listener);
  return () => offerListeners.delete(listener);
};

export function readPasskeyOfferDismissed(): boolean {
  try {
    return window.localStorage.getItem(PASSKEY_OFFER_KEY) === "dismissed";
  } catch {
    return false;
  }
}

export function dismissPasskeyOffer() {
  try {
    window.localStorage.setItem(PASSKEY_OFFER_KEY, "dismissed");
  } catch {
    // Storage blocked: the offer comes back next visit.
  }
  offerListeners.forEach(listener => listener());
}

export interface Step {
  key: "provider" | "email" | "phone" | "devices";
  done: boolean;
  title: string;
  detail: string;
  /** The device not used lately, for Keep and Sign out. */
  stale?: SessionInfo;
}

const lastUse = (session: SessionInfo) => Date.parse(session.last_seen_at ?? session.created_at);

/** Kept, and not used since: Keep holds until the sign-in is used again. */
function isKept(session: SessionInfo, keptHere: Set<string>): boolean {
  if (session.kept_at === undefined) return keptHere.has(session.id);
  return !!session.kept_at && Date.parse(session.kept_at) >= lastUse(session);
}

/** Sign-ins (not this one) not used lately (30 days) that the Carbon didn't keep; empty while loading. */
export function staleSessions(sessions: SessionInfo[] | undefined, now: number, kept: string): SessionInfo[] {
  const keptHere = new Set(kept.split(",").filter(Boolean));
  return (sessions ?? []).filter(item => !item.current && !isKept(item, keptHere) && now - lastUse(item) > STALE_MS);
}

/** Every old sign-in on one device, asked about together. */
export interface StaleDevice {
  /** Its name, as Security names a session ("Chrome on macOS"). */
  name: string;
  /** The old sign-ins, most recently used first. */
  sessions: SessionInfo[];
  /** The most recent use of any of them. */
  lastSeen: number;
  /** True when the sign-in making this request has the same name: these are older sign-ins on this device. */
  here: boolean;
}

/** staleSessions grouped by device name, the most recently used device first. */
export function staleDevices(sessions: SessionInfo[] | undefined, now: number, kept: string): StaleDevice[] {
  const names = new Set((sessions ?? []).filter(item => item.current).map(sessionName));
  const groups = new Map<string, SessionInfo[]>();
  for (const session of staleSessions(sessions, now, kept)) {
    const name = sessionName(session);
    groups.set(name, [...(groups.get(name) ?? []), session]);
  }
  return [...groups].map(([name, list]) => {
    const sorted = [...list].sort((a, b) => lastUse(b) - lastUse(a));
    return { name, sessions: sorted, lastSeen: lastUse(sorted[0]), here: names.has(name) };
  }).sort((a, b) => b.lastSeen - a.lastSeen);
}

/** What a device's question says: "Still using Safari on iOS?", or for older sign-ins on this device, "2 old sign-ins on Chrome on macOS". */
export function staleDeviceText(device: StaleDevice, now: number): { title: string; detail: string } {
  const count = device.sessions.length;
  const ago = `${spanText(now - device.lastSeen)} ago`;
  if (device.here) {
    return { title: count > 1 ? `${count} old sign-ins on ${device.name}` : `An old sign-in on ${device.name}`, detail: `Last active ${ago}` };
  }
  return { title: `Still using ${device.name}?`, detail: count > 1 ? `${count} sign-ins · last active ${ago}` : `Last active ${ago}` };
}

/** The prototype's checkup (Security), in its order: a second way in, a verified email, a recovery phone, devices. */
export function checkupSteps(carbon: CarbonMe, sessions: SessionInfo[] | undefined, now: number, kept: string): Step[] {
  const providers = carbon.identities.map(identity => (identity.provider === "google" ? "Google" : identity.provider === "apple" ? "Apple" : null)).filter(Boolean);
  const email = carbon.emails.find(item => item.verified_at && item.is_primary) ?? carbon.emails.find(item => item.verified_at);
  const phone = carbon.phones.find(item => item.is_primary) ?? carbon.phones[0];
  // Until the sessions load, devices count as fine rather than flash a question.
  const [stale] = staleSessions(sessions, now, kept);
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

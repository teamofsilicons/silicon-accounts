/**
 * The account site's telemetry choice, per browser. Telemetry is on by default (the contract: opted in by default,
 * opted out of from settings).
 *
 * Turning it off does two things, so the service can honour it for every request this browser makes:
 *  - the API client sends `X-Accounts-Telemetry: off` on every call (setApiHeader, merged, never replacing others);
 *  - a first-party cookie `sa_telemetry=off` (Path=/, SameSite=Lax, 400 days) goes with every request the browser
 *    makes on its own, which a header cannot reach: image loads (/v1/photos/…) and the hosted sign-in pages.
 *
 * The stored choice is applied when this module is first evaluated in the browser, which the root providers make
 * happen before any query runs, so even the first GET /v1/session carries the header (a request on the Solid build).
 */
import { setApiHeader } from "./api/http";

export const TELEMETRY_STORAGE_KEY = "silicon-accounts.telemetry";
/** The cookie the service can read on any request (header-less ones included). */
export const TELEMETRY_COOKIE = "sa_telemetry";
export const TELEMETRY_HEADER = "X-Accounts-Telemetry";
/** 400 days, the longest lifetime browsers keep a cookie for. */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

const isBrowser = typeof window !== "undefined";
const listeners = new Set<() => void>();
let enabled = true;

function cookieSaysOff(): boolean {
  try {
    return document.cookie.split(";").some(part => part.trim() === `${TELEMETRY_COOKIE}=off`);
  } catch {
    return false;
  }
}

function writeCookie(on: boolean): void {
  try {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = on
      ? `${TELEMETRY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
      : `${TELEMETRY_COOKIE}=off; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  } catch {
    // Cookies blocked: the header still goes with the API client's calls.
  }
}

/** Off when either store says so: storage may be blocked while cookies are not, or the other way round. */
function readStored(): boolean {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(TELEMETRY_STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, disabled site data): the cookie decides.
  }
  return stored !== "off" && !cookieSaysOff();
}

function apply(on: boolean): void {
  enabled = on;
  setApiHeader(TELEMETRY_HEADER, on ? null : "off");
  // Keep the cookie in step (it may be missing for a choice made before the cookie existed, or cleared on its own).
  if (on === cookieSaysOff()) writeCookie(on);
  for (const listener of listeners) listener();
}

/** Whether this browser shares usage telemetry. */
export function telemetryEnabled(): boolean {
  return enabled;
}

/** Turns telemetry on or off for this browser and remembers the choice. */
export function setTelemetryEnabled(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(TELEMETRY_STORAGE_KEY);
    else window.localStorage.setItem(TELEMETRY_STORAGE_KEY, "off");
  } catch {
    // Not in storage; the cookie still remembers it.
  }
  apply(on);
}

/** Applies the stored choice to the API client and the cookie. Safe to call more than once. */
export function applyStoredTelemetryChoice(): void {
  if (isBrowser) apply(readStored());
}

/** For useSyncExternalStore (see useTelemetryEnabled in lib/query/session.ts). */
export function subscribeTelemetry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (isBrowser) {
  applyStoredTelemetryChoice();
  // Another tab changed the choice: follow it.
  window.addEventListener("storage", event => {
    if (event.key === TELEMETRY_STORAGE_KEY) applyStoredTelemetryChoice();
  });
}

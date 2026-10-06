/**
 * The account site's telemetry choice, per browser. Telemetry is on by default (the contract: opted in by default, opted
 * out of from settings).
 *
 * Turning it off does two things, so the service can honour it for every request this browser makes:
 *  - the API client sends `X-Accounts-Telemetry: off` on every call it makes;
 *  - a first-party cookie `sa_telemetry=off` (Path=/, SameSite=Lax, 400 days) goes with every request the browser makes
 *    on its own, which a header cannot reach: image loads (/v1/photos/…), the first session check before any page code
 *    runs, and the hosted sign-in and developer pages.
 *
 * What the service does with them today (crates/server middleware/observe.rs): the per-request `http.request` event is
 * skipped for requests carrying the header. Events recorded by handlers (`state.telemetry.record`, for example a photo
 * upload or a Silicon created) and requests that only carry the cookie are still recorded, without personal data. The
 * Settings copy says exactly this; making the service honour the header and the cookie for every event is reported to
 * the server and core owners.
 *
 * The stored choice is applied when this module loads (every account page and the landing page import it). The web
 * foundation can apply it before the first request by calling `applyStoredTelemetryChoice()` at boot.
 */
import { createRoot, createSignal } from "solid-js";
import { configureApi } from "../../../api";

export const TELEMETRY_STORAGE_KEY = "silicon-accounts.telemetry";
/** The cookie the service can read on any request (header-less ones included). */
export const TELEMETRY_COOKIE = "sa_telemetry";
/** 400 days, the longest lifetime browsers keep a cookie for. */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

function cookieSaysOff(): boolean {
  try {
    return document.cookie.split(";").some(part => part.trim() === `${TELEMETRY_COOKIE}=off`);
  } catch {
    return false;
  }
}

function writeCookie(enabled: boolean): void {
  try {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = enabled
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

const state = createRoot(() => {
  const [enabled, setEnabled] = createSignal(typeof window === "undefined" ? true : readStored());
  return { enabled, setEnabled };
});

function apply(enabled: boolean): void {
  configureApi({ headers: enabled ? {} : { "X-Accounts-Telemetry": "off" } });
  // Keep the cookie in step (it may be missing for a choice made before the cookie existed, or cleared on its own).
  if (enabled === cookieSaysOff()) writeCookie(enabled);
}

/** Whether this browser shares usage telemetry (reactive). */
export const telemetryEnabled = state.enabled;

/** Turns telemetry on or off for this browser and remembers the choice. */
export function setTelemetryEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(TELEMETRY_STORAGE_KEY);
    else window.localStorage.setItem(TELEMETRY_STORAGE_KEY, "off");
  } catch {
    // Not in storage; the cookie below still remembers it.
  }
  state.setEnabled(enabled);
  apply(enabled);
}

/** Applies the stored choice to the API client and the cookie. Safe to call more than once. */
export function applyStoredTelemetryChoice(): void {
  const enabled = readStored();
  state.setEnabled(enabled);
  apply(enabled);
}

if (typeof window !== "undefined") {
  applyStoredTelemetryChoice();
  // Another tab changed the choice: follow it.
  window.addEventListener("storage", event => {
    if (event.key === TELEMETRY_STORAGE_KEY) applyStoredTelemetryChoice();
  });
}

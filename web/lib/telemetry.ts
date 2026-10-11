/**
 * The account site records no telemetry (2026-10-11). The moment this module is evaluated in the browser (the root
 * providers import it before any query runs), it tells the service not to record anything this browser does:
 *  - the API client sends `X-Accounts-Telemetry: off` on every call (setApiHeader, merged, never replacing others);
 *  - a first-party cookie `sa_telemetry=off` (Path=/, SameSite=Lax, 400 days) goes with every request the browser
 *    makes on its own, which a header cannot reach: image loads (/v1/photos/…) and the hosted sign-in pages.
 * There is no setting: it is always off. (The silicon-accounts CLI has its own switch.)
 */
import { setApiHeader } from "./api/http";

/** The cookie the service reads on any request (header-less ones included). */
export const TELEMETRY_COOKIE = "sa_telemetry";
export const TELEMETRY_HEADER = "X-Accounts-Telemetry";
/** Where an older version of the site kept the choice; cleared, since there is no choice now. */
const OLD_STORAGE_KEY = "silicon-accounts.telemetry";
/** 400 days, the longest lifetime browsers keep a cookie for. */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/** Marks this browser as opted out, for the API client and for every request the browser makes on its own. */
export function optOutOfTelemetry(): void {
  setApiHeader(TELEMETRY_HEADER, "off");
  try {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    if (!document.cookie.split(";").some(part => part.trim() === `${TELEMETRY_COOKIE}=off`)) {
      document.cookie = `${TELEMETRY_COOKIE}=off; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    }
  } catch {
    // Cookies blocked: the header still goes with the API client's calls.
  }
  try {
    window.localStorage.removeItem(OLD_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing to clear.
  }
}

if (typeof window !== "undefined") optOutOfTelemetry();

/**
 * The developer site records no telemetry (2026-10-11). Its server side, the /api/* proxy to both services and the
 * sign-in routes, sends `X-Accounts-Telemetry: off` and `X-Apps-Telemetry: off` on every call it makes, whatever the
 * browser sends. In the browser this module, imported by the root providers before any query runs, also marks the API
 * client's calls `X-Accounts-Telemetry: off` and clears the choice an older version of the site stored. There is no
 * setting: it is always off.
 */
import { setApiHeader } from "./api/http";

export const TELEMETRY_HEADER = "X-Accounts-Telemetry";
/** Where an older version of the site kept the choice; cleared, since there is no choice now. */
const OLD_STORAGE_KEY = "silicon-accounts.telemetry";

if (typeof window !== "undefined") {
  setApiHeader(TELEMETRY_HEADER, "off");
  try {
    window.localStorage.removeItem(OLD_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing to clear.
  }
}

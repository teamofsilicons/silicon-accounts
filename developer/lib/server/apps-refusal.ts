/**
 * What a 401 from Silicon Apps means for the developer site's own sign-in.
 *
 * The Apps proxy (/api/apps/*) sends the same server-held `aud=developer` access token that the Accounts proxy uses.
 * Silicon Apps checks it on its own (its JWKS, the issuer it trusts, a live check at Silicon Accounts), so it can refuse
 * a token that Silicon Accounts still accepts: an Apps deployment set up for another Accounts issuer (a local stack
 * whose Apps upstream belongs to another stack), a key Apps has not fetched yet, an Apps outage. Such a refusal must
 * never read as "signed out": the shell would send the Carbon to /sign-in, the sign-in page would find the session
 * fine and send them back, and the two pages would loop.
 *
 * So the session's truth comes from Silicon Accounts, the service that issued it: on a 401 from Apps the proxy asks
 * `GET /v1/session` with the same token. Ended there: the cookie is cleared and the browser hears `signed_out`.
 * Expired there: one refresh and one retry. Valid there (or unknown): the browser hears 502 `apps_rejected_sign_in`, in
 * words, and stays where it is.
 */
import { accountsApiUrl } from "./config";
import { errorBody, SIGNED_OUT_CODES } from "./session";

/** What Silicon Accounts says about the developer site's access token. */
export type SignInState = "valid" | "expired" | "ended" | "unknown";

/** `GET /v1/session` at Silicon Accounts with the access token: is the sign-in behind it still there? */
export async function signInStateAtAccounts(token: string, headers: Record<string, string>): Promise<SignInState> {
  let response: Response;
  try {
    response = await fetch(`${accountsApiUrl()}/v1/session`, {
      headers: { ...headers, Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return "unknown";
  }
  if (response.ok) return "valid";
  if (response.status !== 401) return "unknown";
  const code = errorCodeOf(await response.text().catch(() => ""));
  return signInStateFor(code);
}

/** The state a 401 code of Silicon Accounts stands for. */
export function signInStateFor(code: string): SignInState {
  if (code === "invalid_token") return "expired";
  if (SIGNED_OUT_CODES.has(code) || code === "session_expired") return "ended";
  return "unknown";
}

/** The `error.code` of a JSON error body, or "". */
export function errorCodeOf(text: string): string {
  try {
    return (JSON.parse(text) as { error?: { code?: unknown } }).error?.code?.toString() ?? "";
  } catch {
    return "";
  }
}

/** The `error.message` of a JSON error body, or "". */
function errorMessageOf(text: string): string {
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" ? message.trim() : "";
  } catch {
    return "";
  }
}

/** What the proxy does with a 401 from Silicon Apps, given what Silicon Accounts says and whether it refreshed already. */
export function actionForAppsRefusal(state: SignInState, refreshed: boolean): "refresh" | "signed_out" | "refused" {
  if (state === "ended") return "signed_out";
  if (state === "expired" && !refreshed) return "refresh";
  return "refused";
}

/**
 * The answer for a refusal by Silicon Apps while the developer site's sign-in is fine: 502, never a signed-out 401.
 * `local`: this developer site runs on a loopback origin (a local stack), where the usual cause is an Apps API that
 * trusts another stack's Silicon Accounts, so the hint says how to point it at this one.
 */
export function appsRefusalBody(upstreamText: string, local = false) {
  const code = errorCodeOf(upstreamText);
  const said = errorMessageOf(upstreamText);
  return errorBody(
    "apps_rejected_sign_in",
    "Silicon Apps did not accept your developer site sign-in. You are still signed in, and everything that comes from Silicon Accounts keeps working.",
    local
      ? "This local developer site and its Apps API trust different Silicon Accounts services. Start the Apps API with APPS_ACCOUNTS_URL set to this stack's accounts site, and give its address to the developer site as APPS_API_URL."
      : "Try again in a moment. If it keeps happening, report it with `silicon-accounts report`.",
    { upstream_status: 401, ...(code ? { upstream_code: code } : {}), ...(said ? { upstream_message: said } : {}) },
  );
}

/** Whether an origin is a loopback one (a local stack). */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

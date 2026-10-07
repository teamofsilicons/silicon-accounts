/**
 * /api/accounts/* → {ACCOUNTS_API_URL}/v1/*: the BFF proxy. The browser calls this origin with its sealed session
 * cookie; this handler unseals it, refreshes the access token when it is about to expire (or the API says it just did),
 * and calls the API with `Authorization: Bearer`. Tokens never reach the browser, and nothing but the API's answer
 * (status, JSON body, Retry-After, X-Request-Id) comes back.
 *
 * Only what the developer site uses is proxied (the developer audience's allowlist, see 06-v2 §2):
 *   GET  meta, apps/{id}/public, .well-known/openid-configuration, .well-known/jwks.json   (public, sent without a token)
 *   GET  me, me/owned-apps
 *   ANY  apps/{id}, apps/{id}/…                                                              (the app's owner routes)
 * Anything else answers 404 `not_proxied`. State-changing requests must come from this site's pages (Origin check).
 */
import { NextResponse, type NextRequest } from "next/server";
import { accountsApiUrl } from "@/lib/server/config";
import { proxyRoute } from "@/lib/server/routes";
import {
  SIGNED_OUT_CODES, clearSession, clientHeaders, errorBody, readSession, refreshSession, sameOriginProblem, writeSession,
  type StoredSession,
} from "@/lib/server/session";

export const dynamic = "force-dynamic";

const PREFIX = "/api/accounts/";
/** Refresh this long before the access token expires. */
const EARLY_REFRESH_MS = 60_000;
/** Request headers passed on to the API (everything else, cookies included, stays here). */
const FORWARD = ["accept", "content-type", "idempotency-key", "x-accounts-telemetry"];
/** Response headers passed back. */
const BACK = ["content-type", "retry-after", "x-request-id", "content-disposition"];

function json(status: number, body: unknown, extra?: (response: NextResponse) => void): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  extra?.(response);
  return response;
}

function signedOut(message: string, clear: boolean): NextResponse {
  return json(401, errorBody("signed_out", message, "Sign in to the developer site again."), clear ? clearSession : undefined);
}

async function call(request: NextRequest, path: string, body: ArrayBuffer | undefined, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { ...clientHeaders(request) };
  for (const name of FORWARD) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${accountsApiUrl()}/${path}${request.nextUrl.search}`, {
    method: request.method,
    headers,
    body: body && body.byteLength ? body : undefined,
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(300_000),
  });
}

async function relay(upstream: Response, session: StoredSession | null, rotated: boolean): Promise<NextResponse> {
  const response = new NextResponse(upstream.status === 204 || upstream.status === 304 ? null : upstream.body, { status: upstream.status });
  for (const name of BACK) {
    const value = upstream.headers.get(name);
    if (value) response.headers.set(name, value);
  }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  if (rotated && session) writeSession(response, session);
  return response;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const method = request.method.toUpperCase();
  const raw = request.nextUrl.pathname.startsWith(PREFIX) ? request.nextUrl.pathname.slice(PREFIX.length) : "";
  const target = proxyRoute(raw, method);
  if (!target) {
    return json(404, errorBody("not_proxied", `${method} /api/accounts/${raw} is not something the developer site forwards to Silicon Accounts.`, "The developer site forwards meta, me, me/owned-apps and the owner routes under apps/{app_id}/."));
  }
  const problem = sameOriginProblem(request);
  if (problem) return json(403, errorBody("cross_site_request", problem, "Use the developer site's own pages."));

  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const unreachable = (error: unknown) => json(502, errorBody(
    "api_unreachable",
    `The developer site could not reach Silicon Accounts: ${error instanceof Error ? error.message : String(error)}.`,
    "Wait a moment and try again.",
  ));

  if (target.kind === "public") {
    try {
      return await relay(await call(request, target.path, body, null), null, false);
    } catch (error) {
      return unreachable(error);
    }
  }

  let session = readSession(request);
  if (!session) return signedOut("This browser is not signed in to the developer site (no session, or it ended).", false);
  let rotated = false;
  const headers = clientHeaders(request);

  const refresh = async (): Promise<NextResponse | null> => {
    const result = await refreshSession(session as StoredSession, headers);
    if (result.ok) {
      session = result.session;
      rotated = true;
      return null;
    }
    if (result.error === "api_unreachable") return json(502, errorBody("api_unreachable", result.description, "Wait a moment and try again."));
    if (result.status >= 500) return json(503, errorBody("refresh_failed", `Refreshing the developer site's sign-in failed: ${result.description}`, "Wait a moment and try again."));
    return signedOut(`Your sign-in to the developer site ended: ${result.description}`, true);
  };

  if (session.ae - Date.now() < EARLY_REFRESH_MS) {
    const failure = await refresh();
    if (failure) return failure;
  }

  try {
    let upstream = await call(request, target.path, body, session.at);
    if (upstream.status === 401) {
      const text = await upstream.text();
      let code = "";
      try {
        code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "";
      } catch {
        code = "";
      }
      if (code === "invalid_token" && !rotated) {
        // Expired in between (or the clock is off): one refresh, one retry.
        const failure = await refresh();
        if (failure) return failure;
        upstream = await call(request, target.path, body, session.at);
      } else if (SIGNED_OUT_CODES.has(code)) {
        const response = new NextResponse(text, { status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        clearSession(response);
        return response;
      } else {
        return relay(new Response(text, { status: 401, headers: upstream.headers }), session, rotated);
      }
    }
    return await relay(upstream, session, rotated);
  } catch (error) {
    return unreachable(error);
  }
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

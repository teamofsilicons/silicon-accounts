/**
 * /api/apps/* → {APPS_API_URL}/v1/*: the sealed developer-session proxy for the explicitly allowed publishing routes
 * (lib/server/apps-routes.ts), with the same server-held `aud=developer` token as /api/accounts/*. A 401 from Silicon
 * Apps never signs the browser out on its own: Silicon Accounts decides whether the sign-in ended
 * (lib/server/apps-refusal.ts); a refusal by Apps alone is 502 `apps_rejected_sign_in`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { appsApiUrl, developerPublicUrl } from "@/lib/server/config";
import { proxyRoute } from "@/lib/server/apps-routes";
import { actionForAppsRefusal, appsRefusalBody, isLoopbackOrigin, signInStateAtAccounts } from "@/lib/server/apps-refusal";
import {
  clearSession, clientHeaders, errorBody, readSession, refreshSession, sameOriginProblem, writeSession,
  type StoredSession,
} from "@/lib/server/session";

export const dynamic = "force-dynamic";

const PREFIX = "/api/apps/";
/** Refresh this long before the access token expires. */
const EARLY_REFRESH_MS = 60_000;
/** Request headers passed on to the API (everything else, cookies included, stays here). */
const FORWARD = ["accept", "content-type", "idempotency-key", "x-apps-telemetry"];
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
  return fetch(`${appsApiUrl()}/${path}${request.nextUrl.search}`, {
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
  const target = proxyRoute(raw, method, request.nextUrl.searchParams);
  if (!target) {
    return json(404, errorBody("not_proxied", `${method} /api/apps/${raw} is not something the developer site forwards to Silicon Apps.`, "Use the publishing controls in the developer portal."));
  }
  const problem = sameOriginProblem(request);
  if (problem) return json(403, errorBody("cross_site_request", problem, "Use the developer site's own pages."));

  let session = readSession(request);
  if (!session) return signedOut("This browser is not signed in to the developer site (no session, or it ended).", false);

  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const maximum = 180 * 1024 * 1024;
    if (Number(request.headers.get("content-length") || 0) > maximum) return json(413, errorBody("body_too_large", "The upload exceeds 180 MiB.", "Choose a smaller package or media file."));
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); return json(413, errorBody("body_too_large", "The upload exceeds 180 MiB.", "Choose a smaller package or media file.")); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    body = bytes.buffer;
  }
  const unreachable = (error: unknown) => json(502, errorBody(
    "api_unreachable",
    `The developer site could not reach Silicon Apps: ${error instanceof Error ? error.message : String(error)}.`,
    "Wait a moment and try again.",
  ));

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
    // A 401 from Silicon Apps is Apps refusing this token, which is not the same as the sign-in having ended: Silicon
    // Accounts, which issued it, says which it is (lib/server/apps-refusal.ts). Never relayed as a signed-out 401.
    for (let attempt = 0; upstream.status === 401; attempt++) {
      const text = await upstream.text();
      const state = attempt === 0 ? await signInStateAtAccounts(session.at, headers) : "valid";
      const action = actionForAppsRefusal(state, rotated);
      if (action === "signed_out") return signedOut("Your sign-in to the developer site ended at Silicon Accounts.", true);
      if (action === "refused") {
        return json(502, appsRefusalBody(text, isLoopbackOrigin(developerPublicUrl())), response => {
          if (rotated && session) writeSession(response, session);
        });
      }
      // Expired at Silicon Accounts too: one refresh, one retry.
      const failure = await refresh();
      if (failure) return failure;
      upstream = await call(request, target.path, body, session.at);
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

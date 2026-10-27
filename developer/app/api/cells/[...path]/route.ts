/** Same-origin author proxy. The sealed Accounts session stays on the server. */
import { NextRequest, NextResponse } from "next/server";
import { cellsApiUrl } from "@/lib/server/config";
import { cellsProxyRoute } from "@/lib/server/cells-routes";
import { actionForAppsRefusal, signInStateAtAccounts } from "@/lib/server/apps-refusal";
import { clearSession, clientHeaders, errorBody, readSession, refreshSession, sameOriginProblem, writeSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";
const MAX_BODY = 1024 * 1024;
function json(status: number, body: unknown): NextResponse {
  const response = NextResponse.json(body, {status});
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}
function signedOut(clear = false): NextResponse {
  const response = json(401, errorBody("signed_out", "Sign in to the developer site to manage cells.", "Use Silicon Accounts to sign in."));
  if (clear) clearSession(response);
  return response;
}
async function handle(request: NextRequest): Promise<NextResponse> {
  const raw = request.nextUrl.pathname.slice("/api/cells/".length);
  const path = cellsProxyRoute(raw, request.method);
  if (!path) return json(404, errorBody("not_proxied", "This Cells route is not part of the developer author interface.", "Use the cell management pages."));
  const problem = sameOriginProblem(request);
  if (problem) return json(403, errorBody("cross_site_request", problem, "Use the developer site's own pages."));
  let session = readSession(request);
  if (!session) return signedOut();
  let rotated = false;
  const finish = (response: NextResponse) => {
    if (rotated && session) writeSession(response, session);
    return response;
  };
  const headers = clientHeaders(request);
  const refresh = async (): Promise<NextResponse | null> => {
    const result = await refreshSession(session!, headers);
    if (result.ok) { session = result.session; rotated = true; return null; }
    if (result.status >= 500 || result.error === "api_unreachable") {
      return json(503, errorBody("refresh_failed", "Silicon Accounts could not refresh this sign-in.", "Try again in a moment."));
    }
    return signedOut(true);
  };
  if (session.ae - Date.now() < 60_000) {
    const failure = await refresh();
    if (failure) return failure;
  }
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (!["GET", "HEAD"].includes(request.method)) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();
    if (reader) for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); return finish(json(413, errorBody("body_too_large", "The request exceeds 1 MiB.", "Split it into smaller batches."))); }
      chunks.push(item.value);
    }
    body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  }
  const call = async () => {
    const outgoing = new Headers(headers);
    outgoing.set("authorization", `Bearer ${session!.at}`);
    for (const name of ["accept", "content-type", "idempotency-key"]) {
      const value = request.headers.get(name);
      if (value) outgoing.set(name, value);
    }
    return fetch(`${cellsApiUrl()}/${path}${request.nextUrl.search}`, {
      method: request.method, headers: outgoing, body,
      redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(120_000),
    });
  };
  try {
    let upstream = await call();
    if (upstream.status === 401) {
      const state = await signInStateAtAccounts(session.at, headers);
      const action = actionForAppsRefusal(state, rotated);
      if (action === "signed_out") return signedOut(true);
      if (action === "refresh") {
        const failure = await refresh();
        if (failure) return failure;
        upstream = await call();
      }
      if (upstream.status === 401) return finish(json(502, errorBody("cells_rejected_sign_in", "Cells could not verify your developer sign-in.", "Your developer sign-in is retained. Try again when Cells is available.")));
    }
    if (upstream.status >= 300 && upstream.status < 400) return finish(json(502, errorBody("unexpected_redirect", "Cells returned an unexpected redirect.", "Check the Cells API address.")));
    const response = new NextResponse(upstream.status === 204 || request.method === "HEAD" ? null : upstream.body, {status: upstream.status});
    for (const name of ["content-type", "retry-after", "x-request-id"]) {
      const value = upstream.headers.get(name);
      if (value) response.headers.set(name, value);
    }
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return finish(response);
  } catch {
    return finish(json(502, errorBody("api_unreachable", "The developer site could not reach Silicon Cells.", "Try again in a moment. Keep the same operation key when retrying a change.")));
  }
}
export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

/** Same-origin author proxy. The sealed Accounts session stays on the server. */
import { NextRequest, NextResponse } from "next/server";
import { cellsApiUrl } from "@/lib/server/config";
import { cellsProxyRoute, cellsUploadPart } from "@/lib/server/cells-routes";
import { actionForAppsRefusal, signInStateAtAccounts } from "@/lib/server/apps-refusal";
import { clearSession, clientHeaders, errorBody, readSession, refreshSession, sameOriginProblem, writeSession } from "@/lib/server/session";

import { cellsBody, CellsBodyLimit } from "@/lib/server/cells-body";

export const dynamic = "force-dynamic";
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
  const streaming = cellsUploadPart(path, request.method);
  const tooLarge = () => finish(json(413, errorBody("body_too_large", streaming ? "The file part exceeds 1 GiB." : "The request exceeds 1 MiB.", "Use the upload’s returned part size, or split a bulk request.")));
  let prepared: Awaited<ReturnType<typeof cellsBody>>;
  try { prepared = await cellsBody(request, streaming); }
  catch (error) {
    return error instanceof CellsBodyLimit ? tooLarge() : finish(json(400, errorBody("body_interrupted", "The request body was interrupted.", "Retry with the same operation key or upload part.")));
  }
  const call = async () => {
    const outgoing = new Headers(headers);
    outgoing.set("authorization", `Bearer ${session!.at}`);
    for (const name of ["accept", "content-type", "idempotency-key", "range", "if-none-match"]) {
      const value = request.headers.get(name);
      if (value) outgoing.set(name, value);
    }
    const init: RequestInit & {duplex?: "half"} = {
      method: request.method, headers: outgoing, body: prepared.body,
      redirect: "manual", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
    };
    if (streaming) init.duplex = "half";
    return fetch(`${cellsApiUrl()}/${path}${request.nextUrl.search}`, init);
  };
  try {
    let upstream = await call();
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      const state = await signInStateAtAccounts(session.at, headers);
      const action = actionForAppsRefusal(state, rotated);
      if (action === "signed_out") return signedOut(true);
      if (action === "refresh") {
        const failure = await refresh();
        if (failure) return failure;
        if (streaming) return finish(json(503, errorBody("upload_retry", "Your sign-in was refreshed. Resume this upload to send the part again.", "Keep the same file and upload reservation.")));
        upstream = await call();
      }
      if (upstream.status === 401) return finish(json(502, errorBody("cells_rejected_sign_in", "Cells could not verify your developer sign-in.", "Your developer sign-in is retained. Try again when Cells is available.")));
    }
    if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) return finish(json(502, errorBody("unexpected_redirect", "Cells returned an unexpected redirect.", "Check the Cells API address.")));
    const response = new NextResponse([204, 304].includes(upstream.status) || request.method === "HEAD" ? null : upstream.body, {status: upstream.status});
    for (const name of ["content-type", "retry-after", "x-request-id", "content-length", "content-range", "accept-ranges", "etag", "content-security-policy", "referrer-policy"]) {
      const value = upstream.headers.get(name);
      if (value && !(name === "content-length" && upstream.headers.has("content-encoding"))) response.headers.set(name, value);
    }
    if (path.includes("/storage-api/object/") && upstream.ok) {
      response.headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(decodeURIComponent(path.split("/").at(-1) ?? "download"))}`);
    }
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    return finish(response);
  } catch {
    if (prepared.oversized()) return tooLarge();
    return finish(json(502, errorBody("api_unreachable", "The developer site could not reach Silicon Cells.", "Try again in a moment. Keep the same operation key when retrying a change.")));
  }
}
export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

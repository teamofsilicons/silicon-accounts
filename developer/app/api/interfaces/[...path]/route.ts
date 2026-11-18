/** Sealed-session author proxy. The browser never receives an Accounts token. */
import {NextRequest, NextResponse} from "next/server";
import {interfacesApiUrl} from "@/lib/server/config";
import {interfacesProxyRoute} from "@/lib/server/interfaces-routes";
import {actionForAppsRefusal, signInStateAtAccounts} from "@/lib/server/apps-refusal";
import {clearSession, clientHeaders, errorBody, readSession, refreshSession, sameOriginProblem, writeSession} from "@/lib/server/session";

export const dynamic = "force-dynamic";
function json(status: number, body: unknown) {const response = NextResponse.json(body, {status}); response.headers.set("cache-control", "no-store"); response.headers.set("x-content-type-options", "nosniff"); return response;}
function signedOut(clear = false) {const response = json(401, errorBody("signed_out", "Sign in to manage interfaces.", "Use Silicon Accounts to sign in.")); if (clear) clearSession(response); return response;}
async function handle(request: NextRequest): Promise<NextResponse> {
  const raw = request.nextUrl.pathname.slice("/api/interfaces/".length);
  const path = interfacesProxyRoute(raw, request.method);
  if (!path) return json(404, errorBody("not_proxied", "This Interfaces route is not part of the developer site.", "Use the interface management pages."));
  const problem = sameOriginProblem(request);
  if (problem) return json(403, errorBody("cross_site_request", problem, "Use the developer site's own pages."));
  let session = readSession(request);
  if (!session) return signedOut();
  let rotated = false;
  const finish = (response: NextResponse) => {if (rotated && session) writeSession(response, session); return response;};
  const headers = clientHeaders(request);
  const refresh = async (force = false): Promise<NextResponse | null> => {
    const result = await refreshSession(session!, headers, force);
    if (result.ok) {rotated = session?.rt !== result.session.rt; session = result.session; return null;}
    if (result.error !== "invalid_grant") return json(503, errorBody("refresh_failed", "Silicon Accounts could not refresh this sign-in.", "Try again in a moment."));
    return signedOut(true);
  };
  const failure = await refresh();
  if (failure) return failure;
  const upload = request.method === "POST" && /^v1\/interfaces\/[^/]+\/uploads$/.test(path);
  const uploadCategory = request.nextUrl.searchParams.get("category");
  if (upload && uploadCategory !== "image" && uploadCategory !== "release") return finish(json(400, errorBody("invalid_category", "Choose an image or release upload.", "Use the interface management pages.")));
  const uploadLimit = uploadCategory === "image" ? 10 * 1024 ** 2 : 512 * 1024 ** 2;
  let oversized = false;
  let body: ArrayBuffer | ReadableStream<Uint8Array> | undefined;
  if (upload) {
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > uploadLimit)) return finish(json(413, errorBody("body_too_large", "This upload exceeds its size limit.", "Choose a smaller file.")));
    let bytes = 0;
    body = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({transform(chunk, controller) {bytes += chunk.byteLength; if (bytes > uploadLimit) {oversized = true; throw new Error("upload too large");} controller.enqueue(chunk);}}));
  } else if (!["GET", "HEAD"].includes(request.method)) {
    const limit = 2 * 1024 * 1024;
    if (Number(request.headers.get("content-length") || 0) > limit) return finish(json(413, errorBody("body_too_large", "The request exceeds 2 MiB.", "Choose a smaller request.")));
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {if (reader) for (;;) {const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > limit) {await reader.cancel(); return finish(json(413, errorBody("body_too_large", "The request exceeds 2 MiB.", "Choose a smaller request.")));} chunks.push(next.value);}}
    catch {return finish(json(400, errorBody("body_interrupted", "The request was interrupted.", "Try again.")));}
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;} body = bytes.buffer;
  }
  const call = () => {
    const outgoing = new Headers(headers); outgoing.set("authorization", `Bearer ${session!.at}`);
    for (const name of ["accept", "content-type", "idempotency-key", "x-filename"]) {const value = request.headers.get(name); if (value) outgoing.set(name, value);}
    const init: RequestInit & {duplex?: "half"} = {method: request.method, headers: outgoing, body, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(upload ? 1_800_000 : 120_000)};
    if (upload) init.duplex = "half";
    return fetch(`${interfacesApiUrl()}/${path}${request.nextUrl.search}`, init);
  };
  try {
    let upstream = await call();
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      const state = await signInStateAtAccounts(session.at, headers);
      const action = actionForAppsRefusal(state, rotated);
      if (action === "signed_out") return signedOut(true);
      if (action === "refresh") {const problem = await refresh(true); if (problem) return problem; if (upload) return finish(json(503, errorBody("upload_retry", "Your sign-in was refreshed.", "Choose the same file and try the upload again."))); upstream = await call();}
      if (upstream.status === 401) return finish(json(502, errorBody("interfaces_rejected_sign_in", "Interfaces could not verify your developer sign-in.", "Your sign-in is retained. Try again when Interfaces is available.")));
    }
    if (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304) return finish(json(502, errorBody("unexpected_redirect", "Interfaces returned an unexpected redirect.", "Check the Interfaces API address.")));
    const response = new NextResponse([204,304].includes(upstream.status) ? null : upstream.body, {status: upstream.status});
    for (const name of ["content-type", "retry-after", "x-request-id", "content-disposition", "content-security-policy"]) {const value = upstream.headers.get(name); if (value) response.headers.set(name, value);}
    response.headers.set("cache-control", "no-store"); response.headers.set("x-content-type-options", "nosniff");
    return finish(response);
  } catch {if (oversized) return finish(json(413, errorBody("body_too_large", "This upload exceeds its size limit.", "Choose a smaller file."))); return finish(json(502, errorBody("api_unreachable", "The developer site could not reach Silicon Interfaces.", "Try again in a moment.")));}
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;

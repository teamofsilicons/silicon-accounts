/** Bounded JSON/response proxy using the portal's server-held session. */
import {NextRequest, NextResponse} from "next/server";
import {actionForAppsRefusal, signInStateAtAccounts} from "./apps-refusal";
import {clearSession, clientHeaders, errorBody, readSession, refreshSession, sameOriginProblem, writeSession} from "./session";

export async function integrationProxy(request: NextRequest, base: string, path: string | null, service: string, authorizationScheme: "Bearer" | "Developer" = "Bearer") {
  const json = (status: number, code: string, message: string) => NextResponse.json(errorBody(code, message, "Retry from the developer portal."), {status, headers:{"cache-control":"no-store","x-content-type-options":"nosniff"}});
  if (!path) return json(404, "not_proxied", "This route is not available in the developer portal.");
  const problem = sameOriginProblem(request);
  if (problem) return json(403, "cross_site_request", problem);
  let session = readSession(request);
  if (!session) return json(401, "signed_out", "Sign in to continue.");
  let rotated = false;
  const headers = clientHeaders(request);
  const finish = (response: NextResponse) => {if (rotated && session) writeSession(response, session); return response;};
  const refresh = async (force = false) => {
    const result = await refreshSession(session!, headers, force);
    if (result.ok) {rotated = rotated || result.session.rt !== session!.rt; session = result.session; return null;}
    if (result.error !== "invalid_grant") return json(503, "refresh_failed", "Your sign-in could not be refreshed. Try again shortly.");
    const response = json(401, "signed_out", "Sign in again to continue."); clearSession(response); return response;
  };
  const failed = await refresh(); if (failed) return failed;
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (!["GET", "HEAD"].includes(request.method)) {
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {if (reader) for (;;) {const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2 * 1024 * 1024) {await reader.cancel(); return finish(json(413, "body_too_large", "Keep the request below 2 MiB."));} chunks.push(next.value);}}
    catch {return finish(json(400, "body_interrupted", "The request was interrupted."));}
    body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) {body.set(chunk, offset); offset += chunk.byteLength;}
  }
  const call = () => {
    const outgoing = new Headers(headers); outgoing.set("authorization", `${authorizationScheme} ${session!.at}`);
    for (const name of ["accept", "content-type", "idempotency-key"]) {const value = request.headers.get(name); if (value) outgoing.set(name, value);}
    return fetch(`${base}/${path}${request.nextUrl.search}`, {method:request.method, headers:outgoing, body, redirect:"manual", cache:"no-store", signal:AbortSignal.timeout(20_000)});
  };
  try {
    let upstream = await call();
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      const action = actionForAppsRefusal(await signInStateAtAccounts(session!.at, headers), rotated);
      if (action === "signed_out") {const response = json(401, "signed_out", "Sign in again to continue."); clearSession(response); return response;}
      if (action === "refresh") {const failed = await refresh(true); if (failed) return failed; upstream = await call();}
      if (upstream.status === 401) return finish(json(502, "integration_rejected_sign_in", `${service} could not verify your developer sign-in.`));
    }
    if (upstream.status >= 300 && upstream.status < 400) return finish(json(502, "unexpected_redirect", `${service} returned an unexpected redirect.`));
    const response = new NextResponse(upstream.status === 204 ? null : upstream.body, {status:upstream.status});
    for (const name of ["content-type", "retry-after", "content-disposition"]) {const value = upstream.headers.get(name); if (value) response.headers.set(name, value);}
    response.headers.set("cache-control", "no-store"); response.headers.set("x-content-type-options", "nosniff");
    return finish(response);
  } catch {return finish(json(502, "integration_unavailable", `${service} could not be reached.`));}
}

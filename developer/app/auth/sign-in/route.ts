/**
 * GET /auth/sign-in?return_to=/apps/briefcase: starts signing a Carbon in to the developer site. A fresh state and PKCE
 * verifier are sealed into a short-lived httpOnly cookie, and the browser goes to the hosted sign-in on the accounts
 * site as the first-party app `developer`:
 *
 *   {ACCOUNTS_PUBLIC_URL}/authorize?app_id=developer&redirect_uri={DEVELOPER_PUBLIC_URL}/auth/callback&state=…
 *     &code_challenge=…&code_challenge_method=S256
 *
 * `prompt=login|select_account` passes through ("Use another account").
 */
import { NextResponse, type NextRequest } from "next/server";
import { DEVELOPER_APP_ID, accountsPublicUrl, callbackUrl } from "@/lib/server/config";
import { randomToken, readPending, s256, safeReturnPath, writePending } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  // A router prefetch must not start a sign-in (it would set a pending cookie nobody uses).
  if (request.headers.get("next-router-prefetch") || request.headers.get("purpose") === "prefetch" || request.headers.get("rsc")) {
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  const params = request.nextUrl.searchParams;
  const state = randomToken(16);
  const verifier = randomToken(32);
  const query = new URLSearchParams({
    app_id: DEVELOPER_APP_ID,
    redirect_uri: callbackUrl(),
    state,
    code_challenge: s256(verifier),
    code_challenge_method: "S256",
  });
  const prompt = params.get("prompt");
  if (prompt === "login" || prompt === "select_account") query.set("prompt", prompt);
  const response = NextResponse.redirect(`${accountsPublicUrl()}/authorize?${query.toString()}`, 303);
  writePending(response, [...readPending(request), { s: state, v: verifier, r: safeReturnPath(params.get("return_to")), t: Date.now() }]);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

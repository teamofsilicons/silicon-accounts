/**
 * POST /auth/sign-out: ends this browser's sign-in to the developer site. The refresh token is revoked at Silicon
 * Accounts (its access tokens die with it) and the session cookie is cleared. Same-origin only (CSRF guard).
 * The account site's own sign-in is untouched.
 */
import { NextResponse, type NextRequest } from "next/server";
import { clearSession, clientHeaders, errorBody, readSession, revokeSession, sameOriginProblem } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const problem = sameOriginProblem(request);
  if (problem) return NextResponse.json(errorBody("cross_site_request", problem, "Sign out from the developer site's own menu."), { status: 403 });
  const session = readSession(request);
  try { if (session) await revokeSession(session, clientHeaders(request)); }
  catch { return NextResponse.json(errorBody("sign_out_unavailable", "Sign-out could not be saved.", "Please retry shortly."), { status: 503 }); }
  const response = new NextResponse(null, { status: 204 });
  clearSession(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

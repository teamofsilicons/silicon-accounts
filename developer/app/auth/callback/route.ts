/**
 * GET /auth/callback?code=…&state=… (or ?error=…&state=…): the end of a sign-in. The state must be one this browser
 * started (the sealed pending cookie); the code is exchanged server side with its PKCE verifier, and the tokens are
 * sealed into the session cookie. The browser then goes back to where it started.
 *
 * Failures land on /sign-in?error=<code>, which shows fixed words per code: the address's own error_description is
 * never shown (anyone could put their words in a link).
 */
import { NextResponse, type NextRequest } from "next/server";
import { developerPublicUrl } from "@/lib/server/config";
import { clientHeaders, exchangeCode, readPending, writePending, writeSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

const ERROR_CODE = /^[a-z_]{1,48}$/;

function to(path: string): string {
  return `${developerPublicUrl()}${path}`;
}

function failed(code: string, pending: ReturnType<typeof readPending>, state: string | null): NextResponse {
  const response = NextResponse.redirect(to(`/sign-in?error=${encodeURIComponent(ERROR_CODE.test(code) ? code : "sign_in_failed")}`), 303);
  writePending(response, pending.filter(entry => entry.s !== state));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const pending = readPending(request);
  const entry = state ? pending.find(item => item.s === state) : undefined;
  if (!entry) return failed("state_mismatch", pending, state);
  const error = params.get("error");
  if (error) return failed(error, pending, state);
  const code = params.get("code");
  if (!code) return failed("missing_code", pending, state);

  const result = await exchangeCode(code, entry.v, clientHeaders(request));
  if (!result.ok) {
    console.warn(`developer site: the sign-in code exchange failed: ${result.status} ${result.error}: ${result.description}`);
    return failed(result.error === "api_unreachable" ? "api_unreachable" : "exchange_failed", pending, state);
  }
  const response = NextResponse.redirect(to(entry.r), 303);
  writeSession(response, result.session);
  writePending(response, pending.filter(item => item.s !== state));
  response.headers.set("Cache-Control", "no-store");
  return response;
}

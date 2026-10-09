/**
 * The developer site's session, held by the Next server (a BFF): the Carbon's Silicon Accounts tokens for the
 * first-party app `developer` live in one sealed, httpOnly, SameSite=Lax cookie (Secure and `__Host-` prefixed over
 * https). The browser never sees a token; route handlers read the cookie, refresh the access token when it is about to
 * expire, and call the API with `Authorization: Bearer`.
 *
 * Refresh tokens rotate on every use and a reused one revokes the whole sign-in, so refreshing is single-flight per
 * refresh token in this process, and the answer is remembered for a minute: requests the browser sent with the old
 * cookie before the new one arrived get the same new tokens instead of presenting the used refresh token again.
 */
import { createHash, randomBytes } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { DEVELOPER_APP_ID, accountsApiUrl, allowedOrigins, callbackUrl, secureCookies } from "./config";
import { seal, unseal } from "./seal";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Cookies                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

const SESSION = "sa_dev_session";
const SIGNIN = "sa_dev_signin";
/** Browsers keep a cookie at most 400 days. */
const MAX_COOKIE_SECONDS = 400 * 24 * 60 * 60;
/** A pending sign-in (state + PKCE verifier) lives 10 minutes; at most three run at once (three browser tabs). */
const SIGNIN_TTL_MS = 10 * 60_000;
const MAX_PENDING = 3;

const cookieName = (base: string) => (secureCookies() ? `__Host-${base}` : base);
export const sessionCookieName = () => cookieName(SESSION);
const signinCookieName = () => cookieName(SIGNIN);

const cookieOptions = (maxAge: number) => ({ httpOnly: true, secure: secureCookies(), sameSite: "lax" as const, path: "/", maxAge });

/** What the session cookie holds (sealed). */
export interface StoredSession {
  v: 1;
  /** Access token (aud=developer, 30 minutes). */
  at: string;
  /** Refresh token (sar_…, rotates on every use). */
  rt: string;
  /** When the access token expires (epoch ms). */
  ae: number;
  /** When the refresh token expires (epoch ms). */
  re: number;
  /** The account's uuid. */
  sub: string;
}

export function readSession(request: NextRequest): StoredSession | null {
  return sessionFromCookie(request.cookies.get(sessionCookieName())?.value);
}

/** The sign-in a session cookie's value holds, or null (also for server components, which read cookies themselves). */
export function sessionFromCookie(cookie: string | undefined): StoredSession | null {
  const value = unseal<StoredSession>(cookie, SESSION);
  if (!value || value.v !== 1 || typeof value.at !== "string" || typeof value.rt !== "string") return null;
  if (typeof value.re === "number" && value.re <= Date.now()) return null;
  return value;
}

export function writeSession(response: NextResponse, session: StoredSession): void {
  const seconds = Math.max(60, Math.min(MAX_COOKIE_SECONDS, Math.floor((session.re - Date.now()) / 1000)));
  response.cookies.set(sessionCookieName(), seal(session, SESSION), cookieOptions(seconds));
}

export function clearSession(response: NextResponse): void {
  response.cookies.set(sessionCookieName(), "", cookieOptions(0));
}

/** One sign-in started in this browser and not finished yet. */
export interface PendingSignIn {
  /** state */
  s: string;
  /** PKCE code verifier */
  v: string;
  /** Where to go afterwards (a same-site path). */
  r: string;
  /** Started at (epoch ms). */
  t: number;
}

export function readPending(request: NextRequest): PendingSignIn[] {
  const list = unseal<PendingSignIn[]>(request.cookies.get(signinCookieName())?.value, SIGNIN);
  if (!Array.isArray(list)) return [];
  return list.filter(entry => entry && typeof entry.s === "string" && typeof entry.v === "string" && Date.now() - entry.t < SIGNIN_TTL_MS);
}

export function writePending(response: NextResponse, list: PendingSignIn[]): void {
  const kept = list.slice(-MAX_PENDING);
  if (!kept.length) response.cookies.set(signinCookieName(), "", cookieOptions(0));
  else response.cookies.set(signinCookieName(), seal(kept, SIGNIN), cookieOptions(SIGNIN_TTL_MS / 1000));
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* PKCE and paths                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Pages a sign-in never returns to. */
const NO_RETURN = ["/sign-in", "/auth", "/api"];

/** A path on this site to come back to, or "/". Anything that could be read as another origin is dropped. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value) return "/";
  let url: URL;
  try {
    url = new URL(value, "http://developer.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "http://developer.invalid") return "/";
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return "/";
  if (NO_RETURN.some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return "/";
  return path;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Requests to the API                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Headers that describe the browser to the API: the client address (the right-most X-Forwarded-For entry this server
 * received, which its own proxy appended; accounts-api trusts the right-most entry), the user agent (sign-in labels and
 * history) and the IP time zone hints some CDNs add.
 */
export function clientHeaders(request: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",").map(part => part.trim()).filter(Boolean).pop();
  if (ip) out["X-Forwarded-For"] = ip;
  const agent = request.headers.get("user-agent");
  if (agent) out["User-Agent"] = agent;
  for (const name of ["cloudfront-viewer-time-zone", "x-vercel-ip-timezone"]) {
    const value = request.headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

/** An OAuth answer from the token endpoint: tokens, or the RFC 6749 error. */
export type TokenResult =
  | { ok: true; session: StoredSession }
  | { ok: false; status: number; error: string; description: string };

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_at?: string;
  account?: { uuid?: string };
  error?: string;
  error_description?: string;
}

async function tokenCall(form: Record<string, string>, headers: Record<string, string>, previous?: StoredSession): Promise<TokenResult> {
  let response: Response;
  try {
    response = await fetch(`${accountsApiUrl()}/v1/oauth/token`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { ok: false, status: 502, error: "api_unreachable", description: `Silicon Accounts could not be reached: ${error instanceof Error ? error.message : String(error)}.` };
  }
  const body = (await response.json().catch(() => ({}))) as TokenBody;
  if (!response.ok || !body.access_token || !body.refresh_token) {
    return {
      ok: false,
      status: response.status,
      error: body.error ?? "token_failed",
      description: body.error_description ?? `The token endpoint answered HTTP ${response.status}.`,
    };
  }
  const now = Date.now();
  const refreshExpires = body.refresh_token_expires_at ? Date.parse(body.refresh_token_expires_at) : NaN;
  return {
    ok: true,
    session: {
      v: 1,
      at: body.access_token,
      rt: body.refresh_token,
      ae: now + Math.max(60, body.expires_in ?? 1800) * 1000,
      re: Number.isFinite(refreshExpires) ? refreshExpires : now + 900 * 24 * 60 * 60 * 1000,
      sub: body.account?.uuid ?? previous?.sub ?? "",
    },
  };
}

/** Exchanges the code from /auth/callback (PKCE: the verifier proves this server started the sign-in). */
export function exchangeCode(code: string, verifier: string, headers: Record<string, string>): Promise<TokenResult> {
  return tokenCall({ grant_type: "authorization_code", code, redirect_uri: callbackUrl(), code_verifier: verifier, client_id: DEVELOPER_APP_ID }, headers);
}

interface RefreshMemo {
  promise: Promise<TokenResult>;
  /** Until when a finished refresh is handed to requests that still carry the old refresh token. */
  until: number;
}

/** One refresh per refresh token per process (on globalThis: every route handler bundle shares it). */
const shared = globalThis as typeof globalThis & { __siliconDeveloperRefreshes?: Map<string, RefreshMemo> };
const memos: Map<string, RefreshMemo> = (shared.__siliconDeveloperRefreshes ??= new Map<string, RefreshMemo>());

/** Rotates the refresh token (single-flight; see the module comment). */
export function refreshSession(session: StoredSession, headers: Record<string, string>): Promise<TokenResult> {
  const now = Date.now();
  for (const [key, memo] of memos) if (memo.until < now) memos.delete(key);
  const existing = memos.get(session.rt);
  if (existing) return existing.promise;
  const promise = tokenCall({ grant_type: "refresh_token", refresh_token: session.rt, client_id: DEVELOPER_APP_ID }, headers, session);
  const memo: RefreshMemo = { promise, until: now + 120_000 };
  memos.set(session.rt, memo);
  void promise.then(result => {
    // A failure is not remembered for long: a network blip must not end the session for a minute.
    memo.until = result.ok ? Date.now() + 60_000 : Date.now() + 2_000;
  });
  return promise;
}

/** Ends the sign-in at Silicon Accounts (best effort: the cookie is cleared either way). */
export async function revokeSession(session: StoredSession, headers: Record<string, string>): Promise<void> {
  try {
    await fetch(`${accountsApiUrl()}/v1/oauth/revoke`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ token: session.rt, client_id: DEVELOPER_APP_ID }).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // The cookie goes anyway; the refresh token then simply expires unused.
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Guards and errors                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The same-origin guard (CSRF): a state-changing request must carry an Origin of this site. Browsers send Origin on
 * every non-GET fetch, so a page on another site can never make one, whatever cookies ride along.
 */
export function sameOriginProblem(request: NextRequest): string | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return `${method} requests to the developer site must come from its own pages, and this one carried no Origin header.`;
  if (!allowedOrigins().has(origin)) return `${method} requests to the developer site must come from its own pages, not from ${origin}.`;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return `${method} requests to the developer site must come from its own pages (Sec-Fetch-Site was ${site}).`;
  return null;
}

/** An error in the API's own shape, so the browser handles every failure the same way. */
export function errorBody(code: string, message: string, hint?: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(hint ? { hint } : {}), ...(details ? { details } : {}) } };
}

/** Codes that mean "this browser is no longer signed in to the developer site". */
export const SIGNED_OUT_CODES = new Set(["signed_out", "token_revoked", "account_deleted", "unauthenticated"]);

/**
 * Helpers of the proofs-perf suite (User verification and App verification proofs end to end, their failure modes, and their latency).
 *
 * Kept in the suite (README: "keep it in the suite (_helpers.ts) and say so"): a Carbon signed into a fake app without
 * a browser (the v2 hosted flow driven through the site's /v1: email code, sign-up, the app's details pages — a missing
 * required email or phone added there with a code, optional details shared only when asked — and the review page; the
 * fake app exchanging the code itself, so the fake app server holds the account's tokens exactly as after a browser
 * sign-in), a sign-in to the first-party `developer` app with PKCE (a developer-platform token, aud=developer), calls
 * made with an app's own credentials, the exact "not valid" body, percentiles, and the server-side duration of a request
 * from the stack's API log.
 *
 * testkit/lib has similar helpers, but it imports with `.ts` extensions that the site's tsconfig refuses, so the walk
 * keeps its own small versions here.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import type { Ctx } from "../../context";
import { REPO_ROOT, api, codeFor, fakeApp, json, lastSeq, randomIp, sleep, sql, tag, type Env, type JsonAnswer } from "../../lib";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Apps                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** `Authorization: Basic base64(app_id:secret)` (client_secret_basic form-encodes both first, a no-op for these ids). */
export function basicAuth(appId: string, secret = fakeApp(appId).secret): string {
  return `Basic ${Buffer.from(`${encodeURIComponent(appId)}:${encodeURIComponent(secret)}`).toString("base64")}`;
}

export interface AppCallOptions {
  /** Idempotency-Key header. */
  key?: string;
  /** Straight at accounts-api instead of through the site (the public origin). */
  direct?: boolean;
  /** Another secret (a wrong one), or null for no Authorization header at all. */
  secret?: string | null;
  headers?: Record<string, string>;
}

/** A call to Silicon Accounts authenticated as an app (HTTP Basic), from the journey's own address. */
export function asApp<T = Record<string, unknown>>(ctx: Ctx, appId: string, method: string, path: string, body?: unknown, options: AppCallOptions = {}): Promise<JsonAnswer<T>> {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (options.secret !== null) headers.authorization = basicAuth(appId, options.secret ?? undefined);
  if (options.key) headers["idempotency-key"] = options.key;
  return api<T>(ctx, path, { method, headers, direct: options.direct, ...(body === undefined ? {} : { json: body }) });
}

export interface ApiErrorBody {
  error: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

/** What POST /v1/proofs/user-verification|app_verification|refresh answers (v2: `receiving_app` names the one app, User verification and App verification alike). */
export interface IssuedProof {
  proof_id: string;
  kind: "user_verification" | "app_verification";
  proof_token: string;
  expires_at: string;
  proof_refresh_token: string;
  refresh_expires_at: string;
  issuing_app: string;
  receiving_app: string;
  user: { uuid: string; id: string | null; kind: string; membership_id: string } | null;
  scopes: string[];
  error?: ApiErrorBody["error"];
}

export interface Verification {
  valid: boolean;
  expires_at: string | null;
  proof_id?: string;
  kind?: string;
  issuing_app?: { app_id: string; name: string };
  receiving_app?: { app_id: string; name: string };
  user?: { uuid: string; id: string | null; kind: string; membership_id: string } | null;
  scopes?: string[];
}

/** The keys of a valid verification (UNDERSTANDING.md: valid, expires_at, issuing app, receiving app, user for User verification). */
export const VALID_KEYS = ["expires_at", "issuing_app", "kind", "proof_id", "receiving_app", "scopes", "user", "valid"];

/** The keys of an issue or refresh answer. */
export const ISSUED_KEYS = ["expires_at", "issuing_app", "kind", "proof_id", "proof_refresh_token", "proof_token", "receiving_app", "refresh_expires_at", "scopes", "user"];

export const issueUserVerification = (ctx: Ctx, appId: string, subjectToken: string, body: { receiving_app: string; scopes?: string[]; access_ttl_seconds?: number }, options: AppCallOptions = {}) =>
  asApp<IssuedProof>(ctx, appId, "POST", "/v1/proofs/user-verification", { subject_token: subjectToken, ...body }, { key: randomUUID(), ...options });

/** POST /v1/proofs/app-verification (or `path`, the App verification page's POST /v1/apps/{app_id}/proofs/app-verification) with any body: for refusals. */
export const issueAppVerificationRaw = (ctx: Ctx, appId: string, body: Record<string, unknown>, options: AppCallOptions & { path?: string } = {}) =>
  asApp<IssuedProof>(ctx, appId, "POST", options.path ?? "/v1/proofs/app-verification", body, { key: randomUUID(), ...options });

/**
 * An app verification proof for exactly one app (UNDERSTANDING.md: "An app verification proof is always for exactly one app; a proof can't be made
 * for several apps at once"): `{"receiving_app": app}`. `path` is POST /v1/proofs/app-verification (default) or the App verification page's
 * POST /v1/apps/{app_id}/proofs/app-verification; `as` calls with another app's credentials.
 */
export function issueAppVerificationFor(
  ctx: Ctx,
  issuer: string,
  receiver: string,
  extra: { scopes?: string[]; access_ttl_seconds?: number } = {},
  options: AppCallOptions & { path?: string; as?: string } = {},
): Promise<JsonAnswer<IssuedProof>> {
  const { path = "/v1/proofs/app-verification", as = issuer, ...call } = options;
  return asApp<IssuedProof>(ctx, as, "POST", path, { receiving_app: receiver, ...extra }, { key: randomUUID(), ...call });
}

/** The apps an issue answer, a listing entry or a verification names as its receiver: `receiving_app` (a string, or {app_id}). */
export function receiversOf(p: unknown): string[] {
  if (!p || typeof p !== "object") return [];
  const record = p as { receiving_apps?: unknown; audiences?: unknown; receiving_app?: unknown };
  const list = record.receiving_apps ?? record.audiences;
  if (Array.isArray(list)) return list.map(String);
  if (typeof record.receiving_app === "string") return [record.receiving_app];
  const named = record.receiving_app as { app_id?: unknown } | null | undefined;
  return named && typeof named === "object" && typeof named.app_id === "string" ? [named.app_id] : [];
}

/** True when an answer or listing entry names exactly `app` as `receiving_app` (a string) and carries no app list. */
export const namesOnly = (p: unknown, app: string) => {
  const record = (p ?? {}) as Record<string, unknown>;
  return record.receiving_app === app && !("audiences" in record) && !("receiving_apps" in record);
};

export const verifyAs = (ctx: Ctx, appId: string, proofToken: string, options: AppCallOptions = {}) => asApp<Verification>(ctx, appId, "POST", "/v1/proofs/verify", { proof_token: proofToken }, options);

export const refreshAs = (ctx: Ctx, appId: string, refreshToken: string, extra: { access_ttl_seconds?: number } = {}, options: AppCallOptions = {}) =>
  asApp<IssuedProof>(ctx, appId, "POST", "/v1/proofs/refresh", { proof_refresh_token: refreshToken, ...extra }, options);

export const revokeAs = (ctx: Ctx, appId: string, body: Record<string, unknown>, options: AppCallOptions = {}) => asApp<ApiErrorBody | null>(ctx, appId, "POST", "/v1/proofs/revoke", body, options);

/** One item of GET /v1/apps/{app_id}/proofs (v2: `receiving_app`, one app). */
export interface AppProofItem {
  proof_id: string;
  kind: string;
  receiving_app: string;
  user: { uuid: string; id: string | null; kind: string } | null;
  scopes: string[];
  status: string;
  access_ttl_seconds: number;
  created_at: string;
  expires_at: string;
  token_expires_at: string | null;
  last_refreshed_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

/** One item of GET /v1/me/proofs. */
export interface MyProofItem {
  proof_id: string;
  issuing_app: { app_id: string; name: string };
  receiving_app: { app_id: string; name: string };
  scopes: string[];
  status: string;
  created_at: string;
  expires_at: string;
  token_expires_at: string | null;
  last_refreshed_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

/** An app's listing entry for one proof (pages through the app's proofs, newest first). */
export async function appListing(ctx: Ctx, appId: string, proofId: string, query = ""): Promise<AppProofItem | null> {
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const answer = await asApp<{ items: AppProofItem[]; next_cursor: string | null }>(ctx, appId, "GET", `/v1/apps/${appId}/proofs?limit=200${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const found = answer.body.items?.find(item => item.proof_id === proofId);
    if (found) return found;
    if (!answer.body.next_cursor) return null;
    cursor = answer.body.next_cursor;
  }
  return null;
}

/** True for exactly `{"valid": false, "expires_at": null}`: those two keys, nothing else. */
export function isExactlyInvalid(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body).sort();
  const record = body as Record<string, unknown>;
  return keys.length === 2 && keys[0] === "expires_at" && keys[1] === "valid" && record.valid === false && record.expires_at === null;
}

export const errorCode = (body: unknown): string | undefined => {
  const error = (body as { error?: unknown } | null)?.error;
  if (error && typeof error === "object") return (error as { code?: string }).code;
  return typeof error === "string" ? error : undefined;
};

export const short = (value: unknown, max = 300) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? String(value)).replace(/sapr?_[A-Za-z0-9_-]{20,}/g, token => `${token.slice(0, 9)}…`).replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, jwt => `${jwt.slice(0, 12)}…`).slice(0, max);
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* A browser stand-in at the site                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Calls the site's /v1 as a browser would: its own cookie jar (sa_flow, sa_signup, sa_session), an Origin header (the
 * CSRF guard of cookie-authenticated mutations) and its own forwarded address (per-network limits of its own).
 */
export class SiteSession {
  readonly jar = new Map<string, string>();
  readonly ip: string;

  constructor(readonly env: Env, ip: string = randomIp()) {
    this.ip = ip;
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<JsonAnswer<T>> {
    const all: Record<string, string> = { accept: "application/json", "x-forwarded-for": this.ip, origin: this.env.site, ...headers };
    if (body !== undefined) all["content-type"] = "application/json";
    if (this.jar.size) all.cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(`${this.env.site}${path}`, { method, headers: all, redirect: "manual", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: keep the text.
    }
    return { status: response.status, body: parsed as T, headers: response.headers };
  }

  /** Puts this session's cookies (the signed-in account site) into a browser context. */
  async into(context: BrowserContext): Promise<void> {
    await context.addCookies([...this.jar].map(([name, value]) => ({ name, value, url: this.env.site, httpOnly: true, sameSite: "Lax" as const })));
  }
}

/**
 * Every request a page makes to a host other than this machine's (README: "Nothing a page loads should leave the
 * machine"): call it before the page navigates; the getter lists them (resource type and address), each once.
 */
export function watchOutside(page: Page): () => string[] {
  const seen = new Set<string>();
  page.on("request", request => {
    const url = request.url();
    if (!/^https?:/i.test(url)) return;
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return;
    seen.add(`${request.resourceType()} ${url}`);
  });
  return () => [...seen];
}

/** The parts of the v2 FlowView this suite reads. */
export interface FlowView {
  id: string;
  step: "choose_method" | "verify_code" | "signup" | "details" | "review" | "complete" | "failed";
  signed_in_as: { uuid: string; id: string } | null;
  signup: { display_name: string; id: string; timezone: string; dob: string } | null;
  details: {
    index: number;
    count: number;
    id: string;
    title: string | null;
    fields: Array<{ field: string; mode: "required" | "optional"; missing: boolean; shared: boolean; previously_granted: boolean }>;
  } | null;
  review: { fields: Array<{ field: string; shared: boolean }> } | null;
  redirect_to: string | null;
  error: { code: string; message: string } | null;
}

export interface AppSignIn {
  appId: string;
  uuid: string;
  id: string;
  membershipId: string;
  email: string;
  phone: string;
  /** Signed in to the account site too (sa_session): the hosted flow signs the browser in. */
  session: SiteSession;
  /** What the fake app received (AccountForApp) and its callback answer. */
  callback: Record<string, unknown>;
  /** The details pages the flow showed (their ids and fields), and whether it showed a review page. */
  pages: Array<{ id: string; fields: string[]; added: string[] }>;
  review: boolean;
  ms: number;
}

export const newEmail = (label: string) => `pp.${label}.${tag()}${tag()}@example.test`;
export const newPhone = () => `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;

async function flowStep(session: SiteSession, path: string, body: unknown, what: string): Promise<FlowView> {
  const answer = await session.call<{ flow?: FlowView; error?: { code: string; message: string } }>("POST", path, body);
  if ((answer.status !== 200 && answer.status !== 201) || !answer.body.flow) throw new Error(`${what}: POST ${path} answered ${answer.status} ${short(answer.body, 500)}`);
  return answer.body.flow;
}

/**
 * Signs a Carbon into a fake app through the v2 hosted flow without a browser: the fake app starts the sign-in (its
 * state, PKCE pair and session cookie), the flow runs through the site's /v1 — an email code (or "Continue as" for a
 * session already signed in), sign-up with the prefill, then the app's details pages: a required email or phone the
 * account lacks is added there with a code (dm requires a phone), the optional details in `share` are ticked (none by
 * default: optional details stay unticked), and a review page is approved — and the fake app's callback exchanges the
 * code, so the fake app server holds the account's tokens (its /_state, /actions/*), just as after a browser sign-in.
 */
export async function signInToApp(ctx: Ctx, appId: string, options: { email?: string; phone?: string; session?: SiteSession; share?: string[] } = {}): Promise<AppSignIn> {
  const started = Date.now();
  const { env } = ctx;
  const session = options.session ?? new SiteSession(env);
  const email = options.email ?? newEmail(appId);
  const phone = options.phone ?? newPhone();
  const start = await json<{ authorize_url: string; session_cookie: string }>(`${env.apps}/${appId}/authorize-url`);
  if (start.status !== 200) throw new Error(`${appId}/authorize-url answered ${start.status} ${short(start.body)}`);
  const params: Record<string, string> = {};
  for (const [key, value] of new URL(start.body.authorize_url).searchParams) params[key] = value;
  delete params.response_type;
  params.timezone = "Asia/Kolkata";
  let flow = await flowStep(session, "/v1/flows", params, `starting the ${appId} sign-in`);
  if (flow.step === "choose_method" && flow.signed_in_as) {
    flow = await flowStep(session, `/v1/flows/${flow.id}/continue`, {}, "continue as");
  } else {
    const after = await lastSeq(env);
    flow = await flowStep(session, `/v1/flows/${flow.id}/email`, { email }, "sending the email code");
    const code = await codeFor(env, email, after);
    flow = await flowStep(session, `/v1/flows/${flow.id}/verify`, { code }, "verifying the email code");
  }
  const pages: AppSignIn["pages"] = [];
  let review = false;
  for (let guard = 0; guard < 16 && flow.step !== "complete"; guard++) {
    if (flow.step === "signup") {
      const prefill = flow.signup;
      if (!prefill) throw new Error(`flow ${flow.id} is at signup without a prefill`);
      flow = await flowStep(session, `/v1/flows/${flow.id}/signup`, { display_name: prefill.display_name, id: prefill.id, timezone: prefill.timezone, dob: prefill.dob }, "signing up");
    } else if (flow.step === "details") {
      const details = flow.details;
      if (!details) throw new Error(`flow ${flow.id} is at details without a details page`);
      const page = { id: details.id, fields: details.fields.map(field => `${field.field}:${field.mode}${field.missing ? ":missing" : ""}`), added: [] as string[] };
      // Every missing required email or phone of the page, added with a code (one at a time).
      for (let i = 0; i < 3; i++) {
        const missing = (flow.details?.fields ?? []).find(field => field.mode === "required" && field.missing);
        if (!missing) break;
        if (missing.field !== "email" && missing.field !== "phone") throw new Error(`flow ${flow.id} requires ${missing.field}, which this helper cannot give`);
        const to = missing.field === "phone" ? phone : email;
        const after = await lastSeq(env);
        flow = await flowStep(session, `/v1/flows/${flow.id}/details/add`, { [missing.field]: to }, `adding the required ${missing.field}`);
        const code = await codeFor(env, to, after);
        flow = await flowStep(session, `/v1/flows/${flow.id}/details/verify`, { code }, `verifying the required ${missing.field}`);
        page.added.push(missing.field);
      }
      const share = (flow.details?.fields ?? []).filter(field => field.mode === "optional" && !field.missing && (options.share ?? []).includes(field.field)).map(field => field.field);
      pages.push(page);
      flow = await flowStep(session, `/v1/flows/${flow.id}/details/continue`, { share }, `continuing from the details page ${details.id}`);
    } else if (flow.step === "review") {
      review = true;
      flow = await flowStep(session, `/v1/flows/${flow.id}/review`, { approve: true }, "approving the review page");
    } else {
      throw new Error(`flow ${flow.id} stopped at ${flow.step}: ${short(flow.error)}`);
    }
  }
  if (flow.step !== "complete" || !flow.redirect_to) throw new Error(`flow ${flow.id} did not complete (${flow.step})`);
  const back = new URL(flow.redirect_to);
  if (back.searchParams.get("error")) throw new Error(`flow ${flow.id} came back to ${appId} with error=${back.searchParams.get("error")}`);
  const callback = await json<Record<string, unknown>>(`${env.apps}/${appId}/callback?${back.searchParams.toString()}&format=json`, { headers: { cookie: start.body.session_cookie, accept: "application/json" } });
  if (callback.status !== 200 || callback.body.ok !== true) throw new Error(`${appId}'s callback answered ${callback.status} ${short(callback.body, 500)}`);
  return {
    appId,
    uuid: String(callback.body.uuid),
    id: String(callback.body.id),
    membershipId: String(callback.body.membership_id),
    email,
    phone,
    session,
    callback: callback.body,
    pages,
    review,
    ms: Date.now() - started,
  };
}

/** The tokens a fake app holds for an account (its /_state with include_tokens). */
export async function appTokens(env: Env, appId: string, uuid: string): Promise<{ access_token: string; refresh_token: string | null }> {
  const state = await json<{ accounts: Array<{ uuid: string; tokens?: { access_token: string; refresh_token: string | null } }> }>(`${env.apps}/${appId}/_state?include_tokens=1`);
  const tokens = state.body.accounts?.find(account => account.uuid === uuid)?.tokens;
  if (!tokens) throw new Error(`${appId} holds no tokens for ${uuid}`);
  return tokens;
}

/** The sign-in (token family) an access token belongs to: its `fid` claim. */
export function familyOf(accessToken: string): string {
  const [, payload = ""] = accessToken.split(".");
  return String((JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { fid?: string }).fid ?? "");
}

/** The audience (`aud`) of an access token. */
export function audienceOf(accessToken: string): string {
  const [, payload = ""] = accessToken.split(".");
  return String((JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { aud?: string }).aud ?? "");
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The developer platform's own sign-in (first-party app `developer`, PKCE)                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface DeveloperTokens {
  access_token: string;
  refresh_token: string | null;
  /** The account site's session of the same sign-in (the hosted flow signs the browser in). */
  session: SiteSession;
}

/**
 * Signs in to the first-party app `developer` the way developers.teamofsilicons.com's server does (06-v2 §2): an
 * authorization-code flow with PKCE S256 and no client secret, redirect URI `{developer}/auth/callback`, the code
 * exchanged at POST /v1/oauth/token with `client_id=developer`. A session already signed in continues as its Carbon;
 * otherwise `email` gets a code. Returns the developer-audience tokens (what the developer site keeps sealed).
 */
export async function developerSignIn(ctx: Ctx, options: { email?: string; session?: SiteSession } = {}): Promise<DeveloperTokens> {
  const { env } = ctx;
  const session = options.session ?? new SiteSession(env);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = `${env.developer}/auth/callback`;
  let flow = await flowStep(session, "/v1/flows", { app_id: "developer", redirect_uri: redirectUri, state: `pp-${tag()}`, code_challenge: challenge, code_challenge_method: "S256", timezone: "Asia/Kolkata" }, "starting the developer platform's sign-in");
  if (flow.step === "choose_method" && flow.signed_in_as) {
    flow = await flowStep(session, `/v1/flows/${flow.id}/continue`, {}, "continue as (developer)");
  } else {
    if (!options.email) throw new Error("developerSignIn: the hosted sign-in asks for an email and none was given");
    const after = await lastSeq(env);
    flow = await flowStep(session, `/v1/flows/${flow.id}/email`, { email: options.email }, "sending the email code (developer)");
    const code = await codeFor(env, options.email.toLowerCase(), after);
    flow = await flowStep(session, `/v1/flows/${flow.id}/verify`, { code }, "verifying the email code (developer)");
  }
  for (let guard = 0; guard < 6 && flow.step !== "complete"; guard++) {
    if (flow.step === "signup" && flow.signup) {
      flow = await flowStep(session, `/v1/flows/${flow.id}/signup`, { display_name: flow.signup.display_name, id: flow.signup.id, timezone: flow.signup.timezone, dob: flow.signup.dob }, "signing up (developer)");
    } else {
      throw new Error(`the developer platform's sign-in stopped at ${flow.step}: ${short(flow.error ?? flow.details)}`);
    }
  }
  const back = new URL(flow.redirect_to ?? "");
  const code = back.searchParams.get("code");
  if (!code) throw new Error(`the developer platform's sign-in came back without a code: ${flow.redirect_to}`);
  const exchange = await api<{ access_token?: string; refresh_token?: string | null; error?: unknown }>(ctx, "/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: "developer", code_verifier: verifier }).toString(),
  });
  if (exchange.status !== 200 || !exchange.body.access_token) throw new Error(`exchanging the developer platform's code answered ${exchange.status} ${short(exchange.body)}`);
  return { access_token: exchange.body.access_token, refresh_token: exchange.body.refresh_token ?? null, session };
}

/** A call with `Authorization: Bearer <token>` (no cookies), from the journey's own address. */
export function asBearer<T = Record<string, unknown>>(ctx: Ctx, token: string, method: string, path: string, body?: unknown, options: { direct?: boolean; key?: string } = {}): Promise<JsonAnswer<T>> {
  const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}` };
  if (options.key) headers["idempotency-key"] = options.key;
  return api<T>(ctx, path, { method, headers, direct: options.direct, ...(body === undefined ? {} : { json: body }) });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Numbers                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentiles. */
export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? Number.NaN, mean: sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1) };
}

export const describeStats = (s: Stats, unit = "ms") => `n=${s.n} p50 ${s.p50.toFixed(2)} p95 ${s.p95.toFixed(2)} p99 ${s.p99.toFixed(2)} max ${s.max.toFixed(2)} mean ${s.mean.toFixed(2)} ${unit}`;

/** The machine's 1-minute load average and core count, for reading timings. */
export function machineLoad(): { load1: number; cores: number } {
  return { load1: Math.round((loadavg()[0] ?? 0) * 100) / 100, cores: availableParallelism() };
}

/** The stack's accounts-api log (scripts/dev.sh writes .dev/logs/<base>/accounts-api.log; the default stack .dev/logs/). */
export const apiLog = (env: Env) => join(REPO_ROOT, ".dev", "logs", ...(env.base === 8590 ? [] : [String(env.base)]), "accounts-api.log");

/**
 * accounts-api's own duration (whole milliseconds, from its `request … duration_ms=… request_id=…` log lines, health
 * probes included: they are logged at debug level) of the requests whose X-Request-Id is in `ids`. Reads only the part
 * of the log written since `fromByte` (a size taken before the requests), and waits up to `waitMs` for lines still being
 * written to arrive.
 */
export async function serverDurations(env: Env, ids: Iterable<string>, options: { fromByte?: number; waitMs?: number } = {}): Promise<Map<string, number>> {
  const wanted = new Set(ids);
  const found = new Map<string, number>();
  const file = apiLog(env);
  const deadline = Date.now() + (options.waitMs ?? 0);
  for (;;) {
    if (existsSync(file)) {
      const all = readFileSync(file);
      const text = all.subarray(Math.min(options.fromByte ?? 0, all.length)).toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.includes("duration_ms=")) continue;
        const id = /request_id=([0-9a-f-]{36})/.exec(line)?.[1];
        if (!id || !wanted.has(id) || found.has(id)) continue;
        const duration = /duration_ms=(\d+)/.exec(line)?.[1];
        if (duration !== undefined) found.set(id, Number(duration));
      }
    }
    if (found.size >= wanted.size || Date.now() >= deadline) return found;
    await sleep(250);
  }
}

/** The accounts-api log's size now (where serverDurations should start reading for requests made after this). */
export const apiLogSize = (env: Env) => {
  try {
    return statSync(apiLog(env)).size;
  } catch {
    return 0;
  }
};

/** One row of the stack's database as a record (sql() returns strings). */
export async function row(env: Env, query: string): Promise<string[] | null> {
  const rows = await sql(env, query);
  return rows[0] ?? null;
}

export const secondsBetween = (later: string, earlier: string) => (Date.parse(later) - Date.parse(earlier)) / 1000;

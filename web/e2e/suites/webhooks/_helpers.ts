/**
 * Helpers of the webhooks suite (web/e2e/suites/webhooks). They play the parties around Silicon Accounts' webhooks
 * the way they really behave, over HTTP only:
 *
 * - a Visitor is a browser at the account site (its own cookie jar, its own X-Forwarded-For address, the site's Origin
 *   on every call, as the CSRF guard wants): it signs a new Carbon up, signs it into fake apps through the hosted flow
 *   and manages the account (/v1/me…);
 * - an app calls with HTTP Basic (its fixed secret from testkit/fake-apps.json): code exchange, refresh, revoke,
 *   webhook settings, deliveries and replays;
 * - a Silicon signs in with its si:id and STK and gets a short-lived token per app;
 * - the fake app server (testkit/src/fake-app-server.ts) receives every app's webhook at /<app>/webhooks and any other
 *   at /hooks/<key>: it checks the v1 signature with the secret it was told, refuses stale timestamps, dedupes by
 *   event_id, records everything and can fail on purpose (/_webhook-faults);
 * - a Receiver is this suite's own raw HTTP endpoint: it records every request byte for byte (so the suite checks the
 *   signature itself, independently of the testkit) and answers what the journey tells it to.
 *
 * Nothing here is shared with other suites; lib.ts stays untouched (README "Adding a suite").
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Ctx } from "../../context";
import { E2E_DIR, codeFor, lastSeq, randomIp, sleep, sql, tag, type Env, type JsonAnswer, type Results } from "../../lib";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Small things                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

export type Json = Record<string, unknown>;

export const b64url = (bytes: Buffer) => bytes.toString("base64url");
export const sha256 = (text: string) => createHash("sha256").update(text).digest();
export const short = (value: unknown, max = 600) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? String(value)).slice(0, max);
};
export const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
/** A unique lowercase tag for ids and addresses (8 characters). */
export const uid = () => `${tag()}${Math.floor(Math.random() * 36 ** 2).toString(36).padStart(2, "0")}`.slice(0, 8);

/** RFC3339 UTC with milliseconds, as the API writes timestamps ("2026-10-06T12:00:00.000Z"). */
export const RFC3339_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A UUIDv7 (event ids and delivery ids are UUIDv7). */
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Runs `probe` until it returns something truthy (or the time is up); returns the last value. */
export async function until<T>(probe: () => Promise<T>, timeoutMs = 20_000, everyMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!value && Date.now() < deadline) {
    await sleep(everyMs);
    value = await probe();
  }
  return value;
}

/** Same JSON (key order ignored). */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(norm);
    if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, norm(value[key])]));
    return value;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** results.check with the actual and expected values in the detail. */
export function checkEq(results: Results, name: string, actual: unknown, expected: unknown, extra = ""): boolean {
  const ok = sameJson(actual, expected);
  return results.check(name, ok, `${ok ? "" : `expected ${short(expected, 400)}; `}got ${short(actual, 700)}${extra ? `; ${extra}` : ""}`);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The fake apps                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface FakeApp {
  app_id: string;
  name: string;
  owner_id: string;
  owner_email: string;
  secret: string;
  webhook_secret?: string | null;
}

let fakeApps: FakeApp[] | null = null;

/** An app of testkit/fake-apps.json (its fixed secret and owner). */
export function fakeApp(appId: string): FakeApp {
  fakeApps ??= (JSON.parse(readFileSync(join(E2E_DIR, "../../testkit/fake-apps.json"), "utf8")) as { apps: FakeApp[] }).apps;
  const app = fakeApps.find(entry => entry.app_id === appId);
  if (!app) throw new Error(`testkit/fake-apps.json has no app "${appId}"`);
  return app;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* HTTP                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface CallInit {
  json?: unknown;
  form?: Record<string, string>;
  /** A raw body (an image upload) with its Content-Type. */
  bytes?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  /** Straight at accounts-api instead of through the site's /v1 proxy. */
  direct?: boolean;
}

async function send<T>(url: string, method: string, headers: Headers, init: CallInit): Promise<JsonAnswer<T> & { text: string; ms: number }> {
  let body: BodyInit | undefined;
  if (init.bytes) {
    headers.set("content-type", init.contentType ?? "application/octet-stream");
    body = new Uint8Array(init.bytes);
  } else if (init.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(init.form).toString();
  } else if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
  for (const [key, value] of Object.entries(init.headers ?? {})) headers.set(key, value);
  const started = performance.now();
  const response = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status, body: parsed as T, headers: response.headers, text, ms: performance.now() - started };
}

/** A call as an app (HTTP Basic app_id:secret; the fixed secret of testkit/fake-apps.json unless `secret`). */
export function appCall<T = Json>(env: Env, appId: string, method: string, path: string, init: CallInit & { secret?: string; ip?: string } = {}) {
  const headers = new Headers({ accept: "application/json", authorization: `Basic ${Buffer.from(`${appId}:${init.secret ?? fakeApp(appId).secret}`).toString("base64")}` });
  if (init.ip) headers.set("x-forwarded-for", init.ip);
  return send<T>(`${init.direct ? env.api : env.site}${path}`, method, headers, init);
}

/** A call with a bearer token (a Silicon's or the CLI's first-party access token). */
export function bearerCall<T = Json>(env: Env, token: string, method: string, path: string, init: CallInit & { ip?: string } = {}) {
  const headers = new Headers({ accept: "application/json", authorization: `Bearer ${token}` });
  if (init.ip) headers.set("x-forwarded-for", init.ip);
  return send<T>(`${init.direct ? env.api : env.site}${path}`, method, headers, init);
}

/** An anonymous call (public endpoints), from `ip`. */
export function publicCall<T = Json>(env: Env, method: string, path: string, init: CallInit & { ip?: string } = {}) {
  const headers = new Headers({ accept: "application/json" });
  if (init.ip) headers.set("x-forwarded-for", init.ip);
  return send<T>(`${init.direct ? env.api : env.site}${path}`, method, headers, init);
}

/** A browser at the account site: its own cookies and address, the site's Origin on every call. */
export class Visitor {
  readonly cookies = new Map<string, string>();
  constructor(
    readonly env: Env,
    readonly ip: string = randomIp(),
  ) {}

  async call<T = Json>(method: string, path: string, init: CallInit & { origin?: string | null } = {}): Promise<JsonAnswer<T> & { text: string; ms: number }> {
    const headers = new Headers({ accept: "application/json", "x-forwarded-for": this.ip });
    if (init.origin !== null) headers.set("origin", init.origin ?? this.env.site);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    const answer = await send<T>(`${init.direct ? this.env.api : this.env.site}${path}`, method, headers, init);
    for (const line of answer.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const at = pair.indexOf("=");
      if (at < 1) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return answer;
  }
}

/** Throws with the answer when the status is not one of `ok` (setup steps: a journey can't go on without them). */
export function must<A extends JsonAnswer<unknown>>(what: string, answer: A, ok: number | number[] = [200, 201, 202, 204]): A {
  const wanted = Array.isArray(ok) ? ok : [ok];
  if (!wanted.includes(answer.status)) throw new Error(`${what}: HTTP ${answer.status} ${short(answer.body, 500)}`);
  return answer;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Carbons, apps and Silicons                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** One detail of a details page (FlowView.details.fields). */
export interface FlowDetailField {
  field: string;
  mode: "required" | "optional";
  label: string;
  value: string | null;
  missing: boolean;
  shared: boolean;
  previously_granted: boolean;
}

/** The hosted flow as the API describes it (v2: details pages and a review page replace requirements and consent). */
export interface FlowView {
  id: string;
  step: string;
  redirect_to?: string | null;
  signup?: { display_name: string; id: string; timezone: string; dob: string } | null;
  details?: { index: number; count: number; id: string; title: string | null; continue_label: string | null; review_next?: boolean; fields: FlowDetailField[] } | null;
  review?: { fields: Array<{ field: string; mode: string; label: string; value: string | null; shared: boolean }> } | null;
  error?: { code: string; message: string } | null;
}

export interface Carbon {
  visitor: Visitor;
  email: string;
  uuid: string;
  id: string;
  displayName: string;
}

const flowStep = async (visitor: Visitor, what: string, path: string, json?: unknown) =>
  must(what, await visitor.call<{ flow: FlowView }>("POST", path, json === undefined ? {} : { json })).body.flow;

/** A new Carbon, signed up through the account site's own hosted flow with an email code (fresh random address). */
export async function newCarbon(ctx: Ctx, label: string, options: { email?: string; visitor?: Visitor } = {}): Promise<Carbon> {
  const visitor = options.visitor ?? new Visitor(ctx.env);
  const t = uid();
  const email = options.email ?? `wh.${label}+${t}@example.test`;
  const created = must("create the account site's flow", await visitor.call<{ flow: FlowView }>("POST", "/v1/flows", { json: { app_id: "silicon-accounts", redirect_uri: `${ctx.env.site}/`, state: b64url(randomBytes(12)), timezone: "Asia/Kolkata" } }));
  const flowId = created.body.flow.id;
  const after = await lastSeq(ctx.env);
  await flowStep(visitor, "send the sign-up code", `/v1/flows/${flowId}/email`, { email });
  const code = await codeFor(ctx.env, email, after);
  const verified = await flowStep(visitor, "verify the sign-up code", `/v1/flows/${flowId}/verify`, { code });
  if (verified.step !== "signup" || !verified.signup) throw new Error(`a new address should reach the sign-up step, got ${verified.step}`);
  const displayName = `WH ${label} ${t}`;
  const handle = `c:wh-${label.replace(/[^a-z0-9]/g, "").slice(0, 10)}-${t}`;
  const done = await flowStep(visitor, "finish the sign-up", `/v1/flows/${flowId}/signup`, { display_name: displayName, id: handle, timezone: verified.signup.timezone, dob: verified.signup.dob });
  if (done.step !== "complete") throw new Error(`sign-up should complete the account site's flow, got ${done.step} ${short(done.error)}`);
  const me = must("GET /v1/me", await visitor.call<{ uuid: string; id: string }>("GET", "/v1/me")).body;
  return { visitor, email, uuid: me.uuid, id: me.id, displayName };
}

/** An existing Carbon signs in on the account site with an email code (e.g. a fake app's seeded owner). */
export async function signInCarbon(ctx: Ctx, email: string): Promise<Visitor> {
  const visitor = new Visitor(ctx.env);
  const created = must("create the account site's flow", await visitor.call<{ flow: FlowView }>("POST", "/v1/flows", { json: { app_id: "silicon-accounts", redirect_uri: `${ctx.env.site}/`, state: b64url(randomBytes(12)), timezone: "Asia/Kolkata" } }));
  const after = await lastSeq(ctx.env);
  await flowStep(visitor, "send the sign-in code", `/v1/flows/${created.body.flow.id}/email`, { email });
  const code = await codeFor(ctx.env, email, after);
  const done = await flowStep(visitor, "verify the sign-in code", `/v1/flows/${created.body.flow.id}/verify`, { code });
  if (done.step !== "complete") throw new Error(`an existing account should be signed in, got ${done.step}`);
  return visitor;
}

export interface AppSession {
  appId: string;
  accessToken: string;
  refreshToken: string;
  membershipId: string;
  scope: string;
  account: Json;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  /** The details pages the hosted flow showed (none for a returning Carbon with nothing new). */
  pages: DetailsPage[];
  /** The review page's rows (profile first), or null when the app's flow has none. */
  review: string[] | null;
}

/** A details page as the API showed it, and what the walk answered on it. */
export interface DetailsPage {
  id: string;
  index: number;
  count: number;
  title: string | null;
  fields: Array<{ field: string; mode: "required" | "optional"; missing: boolean; shared: boolean; previouslyGranted: boolean }>;
  /** Details added on the page with a code. */
  added: string[];
  /** The `share` list sent with Continue: the optional details ticked. */
  ticked: string[];
}

export interface SignInOptions {
  /**
   * Optional details to tick, wherever the app's flow shows them (every other optional detail on a page shown is left
   * unticked, which ends a grant made before). An optional email or phone the account lacks is added with a code first.
   */
  optionalScopes?: string[];
  /** The phone (or email) to add on a details page when the account lacks one the app asks for (default: a new one). */
  phone?: string;
  email?: string;
  /** `prompt` of the authorize request (e.g. "consent": every page again, so optional details can be changed). */
  prompt?: string;
  /** `scope` of the authorize request (e.g. "timezone": an optional detail the app asks for this time). */
  scope?: string;
  /** Cancel on the details page with this index (0-based) or on the review page, instead of sharing. */
  cancelAt?: number | "review";
}

export interface FlowWalk {
  flow: FlowView;
  pages: DetailsPage[];
  review: string[] | null;
  redirectUri: string;
  codeVerifier: string;
  /** The redirect the flow ended with (`?code=…` or `?error=access_denied`). */
  redirect: URL;
}

/**
 * Walks a fake app's hosted flow over HTTP the way the hosted pages do (UNDERSTANDING.md v2 "What's shared with the
 * app", "Flows"): continue as the browser's Carbon (or an email code when the app doesn't remember browsers), then every
 * details page (a missing required email/phone added with a code; optional details ticked only when listed in
 * `optionalScopes`), the review page when the app's flow has one, until the flow completes. Returns where it ended.
 */
export async function walkFlow(ctx: Ctx, carbon: Carbon, appId: string, options: SignInOptions = {}): Promise<FlowWalk> {
  const visitor = carbon.visitor;
  const wanted = new Set(options.optionalScopes ?? []);
  const redirectUri = `${ctx.env.apps}/${appId}/callback`;
  const codeVerifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(12));
  const request = { app_id: appId, redirect_uri: redirectUri, state, code_challenge: b64url(sha256(codeVerifier)), code_challenge_method: "S256", timezone: "Asia/Kolkata", ...(options.prompt ? { prompt: options.prompt } : {}), ...(options.scope ? { scope: options.scope } : {}) };
  let flow = must(`create ${appId}'s flow`, await visitor.call<{ flow: FlowView }>("POST", "/v1/flows", { json: request })).body.flow;
  const pages: DetailsPage[] = [];
  let review: string[] | null = null;
  for (let guard = 0; guard < 16 && flow.step !== "complete"; guard++) {
    if (flow.step === "choose_method") {
      const continued = await visitor.call<{ flow: FlowView; error?: { code?: string } }>("POST", `/v1/flows/${flow.id}/continue`, {});
      if (continued.status === 200 || continued.status === 201) {
        flow = continued.body.flow;
        continue;
      }
      // An app without remember_browser asks every Carbon to sign in again: the email code it is.
      if (continued.status !== 403) must("continue as the signed-in Carbon", continued);
      const after = await lastSeq(ctx.env);
      await flowStep(visitor, "send the sign-in code", `/v1/flows/${flow.id}/email`, { email: carbon.email });
      flow = await flowStep(visitor, "verify the sign-in code", `/v1/flows/${flow.id}/verify`, { code: await codeFor(ctx.env, carbon.email, after) });
    } else if (flow.step === "details" && flow.details) {
      const details = flow.details;
      const page: DetailsPage = {
        id: details.id,
        index: details.index,
        count: details.count,
        title: details.title,
        fields: details.fields.map(f => ({ field: f.field, mode: f.mode, missing: f.missing, shared: f.shared, previouslyGranted: f.previously_granted })),
        added: [],
        ticked: [],
      };
      pages.push(page);
      // Cancel the page as it is shown (nothing added on it).
      if (options.cancelAt === details.index) {
        flow = await flowStep(visitor, `cancel on ${appId}'s page ${details.id}`, `/v1/flows/${flow.id}/review`, { approve: false });
        break;
      }
      for (const field of details.fields) {
        if (!field.missing || (field.field !== "email" && field.field !== "phone")) continue;
        if (field.mode === "optional" && !wanted.has(field.field)) continue;
        const value = field.field === "phone" ? (options.phone ?? randomPhone()) : (options.email ?? `wh.add+${uid()}@example.test`);
        const after = await lastSeq(ctx.env);
        await flowStep(visitor, `add the ${field.mode} ${field.field} on ${appId}'s page ${details.id}`, `/v1/flows/${flow.id}/details/add`, { [field.field]: value });
        flow = await flowStep(visitor, `verify the ${field.field} added on ${appId}'s page`, `/v1/flows/${flow.id}/details/verify`, { code: await codeFor(ctx.env, field.field === "email" ? value.toLowerCase() : value, after) });
        page.added.push(field.field);
      }
      const shown = flow.details?.fields ?? details.fields;
      page.ticked = shown.filter(f => f.mode === "optional" && !f.missing && wanted.has(f.field)).map(f => f.field);
      flow = await flowStep(visitor, `continue on ${appId}'s page ${details.id}`, `/v1/flows/${flow.id}/details/continue`, { share: page.ticked });
    } else if (flow.step === "review" && flow.review) {
      review = flow.review.fields.map(f => f.field);
      flow = await flowStep(visitor, `${options.cancelAt === "review" ? "cancel" : "approve"} on ${appId}'s review page`, `/v1/flows/${flow.id}/review`, { approve: options.cancelAt !== "review" });
    } else throw new Error(`${appId}'s flow stopped at ${flow.step} ${short(flow.error)}`);
  }
  if (flow.step !== "complete" || !flow.redirect_to) throw new Error(`${appId}'s flow did not complete (${flow.step}) ${short(flow.error)}`);
  return { flow, pages, review, redirectUri, codeVerifier, redirect: new URL(flow.redirect_to) };
}

/**
 * Signs a Carbon into a fake app through the hosted flow (walkFlow: continue as the signed-in account, the app's
 * details pages with `optionalScopes` ticked, a missing required email or phone added with a code, the review page),
 * then exchanges the code as the app would.
 */
export async function signIntoApp(ctx: Ctx, carbon: Carbon, appId: string, options: SignInOptions = {}): Promise<AppSession> {
  const walk = await walkFlow(ctx, carbon, appId, options);
  const code = walk.redirect.searchParams.get("code");
  if (!code) throw new Error(`${appId}'s flow ended without a code: ${walk.redirect.href}`);
  const tokens = must(
    `${appId} exchanges the code`,
    await appCall<{ access_token: string; refresh_token: string; membership_id: string; scope: string; account: Json }>(ctx.env, appId, "POST", "/v1/oauth/token", { form: { grant_type: "authorization_code", code, redirect_uri: walk.redirectUri, code_verifier: walk.codeVerifier } }),
    200,
  ).body;
  return { appId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, membershipId: tokens.membership_id, scope: tokens.scope, account: tokens.account, code, redirectUri: walk.redirectUri, codeVerifier: walk.codeVerifier, pages: walk.pages, review: walk.review };
}

/**
 * A token of the developer platform (aud=developer) for a Carbon signed in on the account site, the way the developer
 * site's BFF gets one: the hosted flow as the first-party public client `developer` (PKCE S256, its redirect URI
 * `{developer}/auth/callback`), then the code exchanged with client_id=developer and no secret.
 */
export async function developerToken(ctx: Ctx, visitor: Visitor): Promise<{ accessToken: string; refreshToken: string; scope: string }> {
  const redirectUri = `${ctx.env.developer}/auth/callback`;
  const codeVerifier = b64url(randomBytes(32));
  let flow = must("create the developer platform's flow", await visitor.call<{ flow: FlowView }>("POST", "/v1/flows", { json: { app_id: "developer", redirect_uri: redirectUri, state: b64url(randomBytes(12)), code_challenge: b64url(sha256(codeVerifier)), code_challenge_method: "S256" } })).body.flow;
  if (flow.step === "choose_method") flow = await flowStep(visitor, "continue as the signed-in Carbon (developer)", `/v1/flows/${flow.id}/continue`, {});
  if (flow.step !== "complete" || !flow.redirect_to) throw new Error(`the developer platform's flow did not complete (${flow.step}) ${short(flow.error)}`);
  const code = new URL(flow.redirect_to).searchParams.get("code");
  if (!code) throw new Error(`the developer platform's flow ended without a code: ${flow.redirect_to}`);
  const tokens = must(
    "the developer platform exchanges its code (public client, PKCE)",
    await publicCall<{ access_token: string; refresh_token: string; scope: string }>(ctx.env, "POST", "/v1/oauth/token", { form: { grant_type: "authorization_code", client_id: "developer", code, redirect_uri: redirectUri, code_verifier: codeVerifier } }),
    200,
  ).body;
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, scope: tokens.scope };
}

// US numbers every phone library accepts (testkit/lib/mocks.ts randomPhone): +1 <area> 555 XXXX.
const AREAS = ["201", "202", "206", "212", "213", "305", "312", "415", "503", "617", "646", "702", "718", "917", "972"];
export function randomPhone(): string {
  const bytes = randomBytes(4);
  return `+1${AREAS[bytes.readUInt16BE(0) % AREAS.length]}555${String(bytes.readUInt16BE(2) % 10_000).padStart(4, "0")}`;
}

export interface Silicon {
  uuid: string;
  id: string;
  stk: string;
  webhookSecret: string | null;
}

/** A Silicon its custodian creates on the account site's API (active at once). */
export async function createSilicon(custodian: Carbon, label: string, options: { webhookUrl?: string } = {}): Promise<Silicon> {
  const id = `si:wh-${label.replace(/[^a-z0-9]/g, "").slice(0, 10)}-${uid()}`;
  const created = must(
    "create a Silicon",
    await custodian.visitor.call<{ silicon: { uuid: string; id: string }; stk: string; webhook_secret: string | null }>("POST", "/v1/me/silicons", {
      json: { id, display_name: `WH ${label}`, timezone: "Asia/Kolkata", ...(options.webhookUrl ? { webhook_url: options.webhookUrl } : {}) },
      idempotencyKey: randomUUID(),
    }),
    201,
  ).body;
  return { uuid: created.silicon.uuid, id: created.silicon.id, stk: created.stk, webhookSecret: created.webhook_secret };
}

/** A Silicon signs in with its si:id and STK: a first-party access token (aud=silicon-accounts). */
export async function siliconLogin(env: Env, id: string, stk: string): Promise<string> {
  return must(`${id} signs in`, await publicCall<{ access_token: string }>(env, "POST", "/v1/silicons/login", { json: { id, stk, client_label: "webhooks suite" }, ip: randomIp() }), 200).body.access_token;
}

/** A signed-in Silicon gets a short-lived token for an app, which the app exchanges (the Silicon's way into apps). */
export async function siliconIntoApp(env: Env, siliconToken: string, appId: string): Promise<{ accessToken: string; refreshToken: string; membershipId: string; account: Json; scope: string }> {
  const slt = must(`SLT for ${appId}`, await bearerCall<{ slt: string }>(env, siliconToken, "POST", "/v1/me/short-lived-tokens", { json: { app_id: appId } }), [200, 201]).body.slt;
  const tokens = must(`${appId} exchanges the SLT`, await appCall<{ access_token: string; refresh_token: string; membership_id: string; account: Json; scope: string }>(env, appId, "POST", "/v1/oauth/token", { form: { grant_type: "urn:silicon:params:oauth:grant-type:slt", slt } }), 200).body;
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, membershipId: tokens.membership_id, account: tokens.account, scope: tokens.scope };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The fake app server's webhook inboxes                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface WebhookBody {
  event_id: string;
  type: string;
  occurred_at: string;
  app_id: string | null;
  silicon: string | null;
  data: Json;
}

export interface InboxEvent {
  seq: number;
  event_id: string;
  type: string;
  delivery_id: string | null;
  received_at: string;
  timestamp: number;
  deliveries: number;
  duplicate_count: number;
  recovered: boolean;
  payload: WebhookBody;
}

export interface InboxRejection {
  seq: number;
  at: string;
  status: number;
  reason: string;
  message: string;
  event_id: string | null;
  type: string | null;
  delivery_id: string | null;
  recovered: boolean;
}

export interface InboxList {
  items: InboxEvent[];
  count: number;
  duplicates: number;
  deliveries: number;
  last_seq: number;
  rejected?: InboxRejection[];
}

/**
 * An inbox of the fake app server: an app's own webhook (`inbox = "briefcase"`, URL /briefcase/webhooks) or a generic
 * sink (`inbox = "hooks/<key>"`, URL /hooks/<key>).
 */
export const inboxUrl = (env: Env, inbox: string) => (inbox.startsWith("hooks/") ? `${env.apps}/${inbox}` : `${env.apps}/${inbox}/webhooks`);

async function inboxCall<T>(env: Env, inbox: string, method: string, suffix: string, body?: unknown): Promise<JsonAnswer<T>> {
  const response = await fetch(`${env.apps}/${inbox}${suffix}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(130_000) });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep the text
  }
  return { status: response.status, body: parsed as T, headers: response.headers };
}

export interface InboxFilter {
  type?: string;
  uuid?: string;
  event_id?: string;
  after?: number;
}

const query = (filter: InboxFilter & { include_rejected?: boolean; timeout_ms?: number }) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== false) params.set(key, value === true ? "1" : String(value));
  return params.toString() ? `?${params}` : "";
};

/** What an inbox accepted (newest first), with its refusals. */
export async function inboxEvents(env: Env, inbox: string, filter: InboxFilter = {}): Promise<InboxList> {
  return must(`list ${inbox}'s events`, await inboxCall<InboxList>(env, inbox, "GET", `/_events${query({ ...filter, include_rejected: true })}`), 200).body;
}

/** The first event the inbox accepted (signature verified) that matches, waiting up to `timeoutMs`; null if none came. */
export async function waitEvent(env: Env, inbox: string, filter: InboxFilter, timeoutMs = 25_000): Promise<InboxEvent | null> {
  const answer = await inboxCall<InboxEvent>(env, inbox, "GET", `/_events/wait${query({ ...filter, timeout_ms: timeoutMs })}`);
  return answer.status === 200 ? answer.body : null;
}

/** The fake app fails its next `failNext` deliveries with `status` (after `delayMs`); 0 clears it. */
export async function setFaults(env: Env, inbox: string, failNext: number, status = 500, delayMs = 0): Promise<void> {
  must(`faults on ${inbox}`, await inboxCall(env, inbox, "POST", "/_webhook-faults", { fail_next: failNext, status, delay_ms: delayMs }), 200);
}

/** Tells the inbox the signing secret (keepPrevious: accept the old one too, as a receiver does while rotating). */
export async function setInboxSecret(env: Env, inbox: string, secret: string | null, keepPrevious = false): Promise<{ recovered: number }> {
  return must(`secret of ${inbox}`, await inboxCall<{ recovered: number }>(env, inbox, "POST", "/_webhook-secret", { secret, keep_previous: keepPrevious }), 200).body;
}

/** The fake app registers its own webhook URL again (PUT /v1/apps/{app}/webhook) and keeps the new secret. */
export async function reconnectAppWebhook(env: Env, appId: string): Promise<void> {
  must(`${appId} reconnects its webhook`, await inboxCall(env, appId, "POST", "/_connect-webhook", {}), 200);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Deliveries: the API and the database                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Delivery {
  id: string;
  event_id: string;
  type: string;
  account_uuid: string | null;
  url: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
  manual_replays: number;
}

export interface DeliveryDetail extends Omit<Delivery, "attempts"> {
  attempt_count: number;
  attempts: Array<{ attempted_at: string; status_code: number | null; error: string | null; duration_ms: number }>;
  payload: WebhookBody;
  payload_redacted: boolean;
  payload_redacted_reason?: string;
}

export async function getDelivery(env: Env, appId: string, deliveryId: string): Promise<DeliveryDetail> {
  return must(`delivery ${deliveryId} of ${appId}`, await appCall<DeliveryDetail>(env, appId, "GET", `/v1/apps/${appId}/webhook/deliveries/${deliveryId}`), 200).body;
}

/** Polls a delivery until `done` holds (null when it never did). */
export async function waitDelivery(env: Env, appId: string, deliveryId: string, done: (d: DeliveryDetail) => boolean, timeoutMs = 25_000): Promise<DeliveryDetail | null> {
  let last: DeliveryDetail | null = null;
  const ok = await until(async () => {
    last = await getDelivery(env, appId, deliveryId);
    return done(last);
  }, timeoutMs, 300);
  return ok ? last : null;
}

/** Runs SQL whose rows are JSON objects (`select … as x` columns), returned as an array; values the journey made only. */
export async function sqlRows<T = Json>(env: Env, select: string): Promise<T[]> {
  const rows = await sql(env, `select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb)::text from (${select}) t`);
  return JSON.parse(rows.map(row => row.join("|")).join("\n") || "[]") as T[];
}

export interface EventRow {
  event_id: string;
  type: string;
  target_kind: string;
  target_id: string;
  account_uuid: string | null;
  payload: WebhookBody;
  delivery_id: string;
  status: string;
  attempts: number;
  url: string;
  last_error: string | null;
  occurred_at: string;
}

/** The webhook events (and their delivery) stored for an account or a target, oldest first. */
export async function storedEvents(env: Env, where: { account?: string; target?: string; type?: string; afterMs?: number }): Promise<EventRow[]> {
  const conditions = ["true"];
  if (where.account) conditions.push(`e.account_uuid = '${where.account.replace(/'/g, "")}'`);
  if (where.target) conditions.push(`e.target_id = '${where.target.replace(/'/g, "")}'`);
  if (where.type) conditions.push(`e.type = '${where.type.replace(/'/g, "")}'`);
  if (where.afterMs) conditions.push(`e.occurred_at > to_timestamp(${where.afterMs / 1000})`);
  return sqlRows<EventRow>(
    env,
    `select e.event_id::text, e.type, e.target_kind, e.target_id, e.account_uuid, e.payload, d.id::text as delivery_id, d.status, d.attempts, d.url, d.last_error, e.occurred_at
       from webhook_events e join webhook_deliveries d on d.event_id = e.event_id
      where ${conditions.join(" and ")} order by e.occurred_at, e.event_id`,
  );
}

/** Waits until the worker recorded at least `attempts` attempts of a delivery and holds no lease on it. */
export async function waitAttempts(env: Env, deliveryId: string, attempts: number, timeoutMs = 30_000): Promise<{ attempts: number; status: string; next_attempt_at: string; last_status: number | null } | null> {
  const id = deliveryId.replace(/'/g, "");
  return until(async () => {
    const [row] = await sqlRows<{ attempts: number; status: string; next_attempt_at: string; last_status: number | null; leased: boolean }>(
      env,
      `select attempts, status, next_attempt_at, last_status, coalesce(locked_until > now(), false) as leased from webhook_deliveries where id = '${id}'`,
    );
    return row && row.attempts >= attempts && !row.leased ? row : null;
  }, timeoutMs, 250);
}

/**
 * Time travel for one delivery: it was created `hours` ago (its 72-hour retry window counts from then) and its next
 * attempt is due now. Only call it while no attempt is in flight (waitAttempts first).
 */
export async function ageDelivery(env: Env, deliveryId: string, hours: number): Promise<void> {
  await sql(env, `update webhook_deliveries set created_at = now() - make_interval(secs => ${hours * 3600}), next_attempt_at = now() where id = '${deliveryId.replace(/'/g, "")}'`);
}

/** The next attempt of a pending delivery is due now (skips the backoff wait). */
export async function retryNow(env: Env, deliveryId: string): Promise<void> {
  await sql(env, `update webhook_deliveries set next_attempt_at = now() where id = '${deliveryId.replace(/'/g, "")}' and status = 'pending'`);
}

/** Pending deliveries of an app right now. */
export async function pendingCount(env: Env, appId: string): Promise<number> {
  const [row] = await sqlRows<{ n: number }>(env, `select count(*)::int as n from webhook_deliveries where target_kind = 'app' and target_id = '${appId.replace(/'/g, "")}' and status = 'pending'`);
  return row?.n ?? 0;
}

/** Waits until an app has no pending delivery (so faults injected next hit only the journey's own events); returns how many are left. */
export async function drainApp(env: Env, appId: string, timeoutMs = 60_000): Promise<number> {
  await until(async () => (await pendingCount(env, appId)) === 0, timeoutMs, 500);
  return pendingCount(env, appId);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Payload checks                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What is wrong with an event's envelope (empty when it is right). */
export function envelopeProblems(body: WebhookBody | undefined | null, expected: { type: string; app_id: string | null; silicon: string | null }): string[] {
  if (!body) return ["no event"];
  const problems: string[] = [];
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "app_id,data,event_id,occurred_at,silicon,type") problems.push(`keys ${keys}`);
  if (!UUID_V7.test(body.event_id)) problems.push(`event_id ${body.event_id} is not a UUIDv7`);
  if (body.type !== expected.type) problems.push(`type ${body.type}`);
  if (!RFC3339_MS.test(body.occurred_at)) problems.push(`occurred_at ${body.occurred_at}`);
  if (body.app_id !== expected.app_id) problems.push(`app_id ${body.app_id}`);
  if (body.silicon !== expected.silicon) problems.push(`silicon ${body.silicon}`);
  if (!isObject(body.data)) problems.push("data is not an object");
  return problems;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Signatures                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** `v1=<hex HMAC-SHA256(secret, "{timestamp}.{raw body}")>`, the key being the whole whsec_ string. */
export function signatureFor(secret: string, timestamp: string, raw: Buffer): string {
  return `v1=${createHmac("sha256", Buffer.from(secret, "utf8")).update(`${timestamp}.`, "utf8").update(raw).digest("hex")}`;
}

/** True when the header carries a v1 signature of exactly this timestamp and body under `secret` (constant time). */
export function verifySignature(secret: string, timestamp: string | undefined, raw: Buffer, header: string | undefined): boolean {
  if (!timestamp || !header) return false;
  const expected = Buffer.from(signatureFor(secret, timestamp, raw));
  return header
    .split(/[,\s]+/)
    .filter(part => part.startsWith("v1="))
    .some(part => {
      const given = Buffer.from(part);
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A raw receiver of the suite's own                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Received {
  at: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  raw: Buffer;
  body: WebhookBody | null;
  /** What it answered. */
  status: number;
}

export interface Answer {
  status: number;
  delayMs?: number;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * An HTTP endpoint on 127.0.0.1 (ACCOUNTS_WEBHOOK_ALLOW_PRIVATE is true in development stacks) that records every
 * request exactly as it came (raw bytes, headers) and answers by the rules the journey sets: a rule matches a request
 * (by default any) and is used `times` times; with no rule left it answers 200.
 */
export class Receiver {
  readonly received: Received[] = [];
  private rules: Array<{ match: (request: Received) => boolean; answer: Answer; times: number }> = [];
  private constructor(
    private readonly server: Server,
    readonly port: number,
  ) {}

  static async start(): Promise<Receiver> {
    let receiver: Receiver | null = null;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => void receiver?.handle(request, Buffer.concat(chunks), response));
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
    receiver = new Receiver(server, (server.address() as AddressInfo).port);
    return receiver;
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /** Answer the next `times` matching requests with `answer`. */
  answer(answer: Answer, times = 1, match: (request: Received) => boolean = () => true): void {
    this.rules.push({ match, answer, times });
  }

  clearRules(): void {
    this.rules = [];
  }

  private async handle(request: IncomingMessage, raw: Buffer, response: ServerResponse): Promise<void> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers[key] = value;
    let body: WebhookBody | null = null;
    try {
      body = JSON.parse(raw.toString("utf8")) as WebhookBody;
    } catch {
      body = null;
    }
    const entry: Received = { at: Date.now(), method: request.method ?? "", path: request.url ?? "", headers, raw, body, status: 200 };
    const rule = this.rules.find(candidate => candidate.times > 0 && candidate.match(entry));
    const answer: Answer = rule?.answer ?? { status: 200 };
    if (rule) rule.times -= 1;
    entry.status = answer.status;
    this.received.push(entry);
    if (answer.delayMs) await sleep(answer.delayMs);
    response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    response.end(answer.body ?? JSON.stringify({ ok: answer.status < 300 }));
  }

  /** The requests on `path` (all when omitted). */
  on(path?: string): Received[] {
    return path ? this.received.filter(entry => entry.path === path) : [...this.received];
  }

  async waitFor(match: (request: Received) => boolean, timeoutMs = 25_000): Promise<Received | null> {
    return until(async () => this.received.find(match) ?? null, timeoutMs, 100);
  }

  async waitCount(match: (request: Received) => boolean, count: number, timeoutMs = 25_000): Promise<Received[]> {
    await until(async () => this.received.filter(match).length >= count, timeoutMs, 100);
    return this.received.filter(match);
  }

  close(): Promise<void> {
    return new Promise(done => {
      this.server.closeAllConnections();
      this.server.close(() => done());
    });
  }
}

/** Seconds between two RFC3339 timestamps. */
export const secondsBetween = (a: string | null | undefined, b: string | null | undefined) => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : Number.NaN);

/** A width×height PNG of one colour (8-bit RGB), built here so the suite needs no image files. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

/** Percentile of a list of numbers (nearest rank). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/**
 * Helpers of the auth-flows suite (files starting with "_" are never journeys). Kept inside the suite on purpose
 * (README: a suite never edits lib.ts); the harness owner may move what proves generally useful into lib.ts.
 *
 * Written for UNDERSTANDING.md v2 (build spec 06-v2.md): the hosted flow goes choose_method → verify_code → signup →
 * details (one page per step of the app's flow: required details shared, a missing email or phone added there with a
 * code, optional details unticked until the Carbon ticks them) → review (when the app's flow has one) → complete. The
 * v1 `requirements` and `consent` steps are gone, and so is `login_hint` (an app never hands us an email or phone).
 *
 * - `Browserish`: a cookie-jar HTTP client that plays a browser at the site's /v1 (sa_flow, sa_session and sa_signup
 *   cookies, the site's Origin on POSTs, its own X-Forwarded-For), so the deep cases (limits, lockouts, time travel,
 *   PKCE, token reuse…) run as fast API journeys next to the real-browser ones.
 * - flow drivers: start an app's sign-in (`startSignIn`, with intent, method, prompt…), send and type a code, and
 *   `drive` a flow through sign-up, the details pages (adding a missing email or phone with a code, ticking optional
 *   details) and the review page, keeping every page it saw;
 * - app calls with the fake apps' fixed credentials (testkit/fake-apps.json), including a temporary change of an app's
 *   sign-in setup (`withSigninConfig`, always put back);
 * - the mock Google/Apple (authorize as a browser would, its request log), JWT decoding, small formatting helpers.
 *
 * Nothing here imports the testkit's TypeScript (its `.ts` import paths do not type-check under web's tsconfig).
 */
import { createHash, randomBytes } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { codeFor, fakeApp, json, lastSeq, sql, type Env } from "../../lib";

export { fakeApp };

/** Gives a Playwright context the browser session (sa_session) of an API-made Carbon, on the site's origin. */
export async function adoptSession(context: BrowserContext, site: string, b: { jar: { get(name: string): string | undefined } }): Promise<void> {
  const value = b.jar.get("sa_session");
  if (!value) throw new Error("the API browser has no sa_session cookie to hand over");
  await context.addCookies([{ name: "sa_session", value, url: site, httpOnly: true, sameSite: "Lax" }]);
}

/** Every address of a fake app's own pages, as a RegExp (callback, error page…). */
export const appPage = (env: Env, app: string, path = "") => new RegExp(`^${literally(env.apps)}/${literally(app)}/${path}`);

/** The scope of the token the fake app shows after its callback (`<pre id="token">`), sorted. */
export async function shownScope(page: Page): Promise<string> {
  const raw = await page.locator("#token").innerText().catch(() => "{}");
  try {
    return scopeSet((JSON.parse(raw || "{}") as { scope?: string }).scope);
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The fake apps                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The redirect URI the stack registered for a fake app (the seed rewrites 127.0.0.1:8593 to this stack's port). */
export const redirectUriOf = (env: Env, appId: string) => `${env.apps}/${appId}/callback`;

/** The managed and bring-your-own client ids the mock providers know (testkit/dev-credentials.json). */
export const CLIENT_IDS = {
  managedGoogle: "mock-google-managed.invalid",
  acmeGoogle: "mock-google-byo.invalid",
  managedApple: "com.teamofsilicons.accounts.dev",
  orbitApple: "test.orbit-games.signin",
} as const;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Shapes                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface ApiErrorBody {
  error?: { code?: string; message?: string; hint?: string | null; details?: Record<string, unknown> } | string;
  error_description?: string;
}

export interface Challenge {
  channel: string;
  destination: string;
  expires_at: string;
  resend_available_at: string;
}

/** One detail on a details page (FlowView.details.fields). */
export interface DetailFieldView {
  field: string;
  mode: "required" | "optional";
  label: string;
  value: string | null;
  missing: boolean;
  shared: boolean;
  previously_granted: boolean;
}

/** FlowView.details: the page of the app's flow on screen (step `details`). */
export interface DetailsView {
  index: number;
  count: number;
  id: string;
  title: string | null;
  subtitle: string | null;
  continue_label: string | null;
  layout: string | null;
  fields: DetailFieldView[];
  challenge: Challenge | null;
  review_next: boolean;
}

/** FlowView.review: everything that will be shared (step `review`), profile first. */
export interface ReviewView {
  fields: Array<{ field: string; mode: string; label: string; value: string | null; shared: boolean }>;
}

export interface FlowView {
  id: string;
  step: string;
  expires_at: string;
  app: { app_id: string; name: string; first_party: boolean; copy?: Record<string, unknown>; branding?: Record<string, unknown> };
  methods: string[];
  signed_in_as: { uuid: string; id: string; display_name: string; kind: string; pfp_url?: string } | null;
  challenge: Challenge | null;
  signup: {
    display_name: string;
    id: string;
    timezone: string;
    dob: string;
    pfp_url: string | null;
    provider_pfp_url: string | null;
    email: string | null;
    phone: string | null;
    provider: string | null;
    finishing_import: boolean;
    imported_by?: { app_id: string; name: string } | null;
    expires_at: string;
  } | null;
  details: DetailsView | null;
  review: ReviewView | null;
  redirect_to: string | null;
  error: { code: string; message: string; hint: string | null } | null;
  prompt: string | null;
  intent: "signin" | "signup";
  method_hint: string | null;
}

export interface AccountForApp {
  uuid: string;
  membership_id: string;
  kind: string;
  id: string | null;
  display_name: string;
  pfp_url: string;
  email?: string;
  email_verified?: boolean;
  phone?: string;
  phone_verified?: boolean;
  dob?: string;
  timezone?: string;
  updated_at: string;
  version: number;
}

export interface Tokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_at: string;
  scope: string;
  id_token?: string;
  membership_id: string;
  account: AccountForApp;
}

export interface Reply<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  location: string | null;
  ms: number;
  text: string;
}

export type FlowReply = Reply<{ flow: FlowView } & ApiErrorBody>;

/* ------------------------------------------------------------------------------------------------------------------ */
/* A browser stand-in                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

interface StoredCookie {
  value: string;
  expires: number | null;
}

/** One origin's cookies, the way a browser keeps them for the site (path / only, which is all Accounts sets). */
export class Jar {
  readonly cookies = new Map<string, StoredCookie>();

  take(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let expires: number | null = null;
      for (const attribute of attributes) {
        const [rawKey = "", ...rest] = attribute.split("=");
        const key = rawKey.trim().toLowerCase();
        const v = rest.join("=").trim();
        if (key === "max-age" && Number.isFinite(Number(v))) expires = Date.now() + Number(v) * 1000;
        if (key === "expires" && expires === null && Number.isFinite(Date.parse(v))) expires = Date.parse(v);
      }
      if (!value || (expires !== null && expires <= Date.now())) this.cookies.delete(name);
      else this.cookies.set(name, { value, expires });
    }
  }

  get(name: string): string | undefined {
    const cookie = this.cookies.get(name);
    return cookie && (cookie.expires === null || cookie.expires > Date.now()) ? cookie.value : undefined;
  }

  set(name: string, value: string): void {
    this.cookies.set(name, { value, expires: null });
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  header(): string | undefined {
    const parts = [...this.cookies.entries()].filter(([, c]) => c.expires === null || c.expires > Date.now()).map(([name, c]) => `${name}=${c.value}`);
    return parts.length ? parts.join("; ") : undefined;
  }
}

export interface CallOptions {
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /** Origin header (default: the site's own origin on everything but GET/HEAD; null: none). */
  origin?: string | null;
  /** Send this jar's cookies (default true). */
  cookies?: boolean;
  basic?: [string, string];
  bearer?: string;
}

/**
 * A browser at the site's /v1: its cookies, the site's Origin on mutations (the CSRF guard wants it), and its own
 * client address (X-Forwarded-For through the site, so its per-network limits are its own).
 */
export class Browserish {
  readonly jar = new Jar();
  constructor(
    readonly env: Env,
    readonly ip: string,
  ) {}

  async call<T = unknown>(method: string, pathOrUrl: string, options: CallOptions = {}): Promise<Reply<T>> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.env.site}${pathOrUrl}`;
    const headers: Record<string, string> = { accept: "application/json", "x-forwarded-for": this.ip, ...options.headers };
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(options.form).toString();
    }
    const origin = options.origin === undefined ? (method === "GET" || method === "HEAD" ? null : this.env.site) : options.origin;
    if (origin) headers.origin = origin;
    if (options.cookies !== false && url.startsWith(this.env.site)) {
      const cookie = this.jar.header();
      if (cookie) headers.cookie = cookie;
    }
    if (options.basic) headers.authorization = `Basic ${Buffer.from(`${options.basic[0]}:${options.basic[1]}`).toString("base64")}`;
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
    const started = performance.now();
    const response = await fetch(url, { method, headers, body, redirect: "manual" });
    const text = await response.text();
    const ms = performance.now() - started;
    if (url.startsWith(this.env.site)) this.jar.take(response.headers);
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (an HTML page): keep the text.
    }
    const location = response.headers.get("location");
    return { status: response.status, body: parsed as T, headers: response.headers, location: location ? new URL(location, url).toString() : null, ms, text };
  }

  get<T = unknown>(path: string, options: CallOptions = {}) {
    return this.call<T>("GET", path, options);
  }

  post<T = unknown>(path: string, payload?: unknown, options: CallOptions = {}) {
    return this.call<T>("POST", path, { ...options, json: payload ?? {} });
  }

  /* -- the hosted flow -- */

  createFlow(params: Record<string, string | undefined>): Promise<FlowReply> {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
    return this.post<{ flow: FlowView } & ApiErrorBody>("/v1/flows", clean);
  }

  flow(id: string): Promise<FlowReply> {
    return this.get<{ flow: FlowView } & ApiErrorBody>(`/v1/flows/${id}`);
  }

  act(id: string, action: string, payload?: unknown): Promise<FlowReply> {
    return this.post<{ flow: FlowView } & ApiErrorBody>(`/v1/flows/${id}/${action}`, payload);
  }

  /** POST …/details/add: a code to add a missing email or phone of the page on screen. */
  detailsAdd(id: string, contact: { email: string } | { phone: string; country?: string }): Promise<FlowReply> {
    return this.act(id, "details/add", contact);
  }

  detailsVerify(id: string, code: string): Promise<FlowReply> {
    return this.act(id, "details/verify", { code });
  }

  /** POST …/details/continue: `share` = the optional details of this page the Carbon ticked. */
  detailsContinue(id: string, share: string[] = []): Promise<FlowReply> {
    return this.act(id, "details/continue", { share });
  }

  detailsBack(id: string): Promise<FlowReply> {
    return this.act(id, "details/back");
  }

  /** POST …/review: approve on the review page; `false` cancels from any details page or the review. */
  review(id: string, approve: boolean): Promise<FlowReply> {
    return this.act(id, "review", { approve });
  }

  async session(): Promise<{ account: { uuid: string; id: string; display_name: string } } | null> {
    const reply = await this.get<{ account: { uuid: string; id: string; display_name: string } }>("/v1/session");
    return reply.status === 200 ? reply.body : null;
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Random values                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

export const rand = (bytes = 4) => randomBytes(bytes).toString("hex");
export const randomState = () => randomBytes(24).toString("base64url");
export const randomNonce = () => randomBytes(24).toString("base64url");

export function pkcePair(method: "S256" | "plain" = "S256"): { verifier: string; challenge: string; method: "S256" | "plain" } {
  // A verifier that never starts with "-" (harmless here, but keeps logs and CLIs readable).
  let verifier = randomBytes(32).toString("base64url");
  while (verifier.startsWith("-")) verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: method === "S256" ? createHash("sha256").update(verifier, "ascii").digest("base64url") : verifier, method };
}

/** A US 555 number nobody can receive (the testkit's rule): +1 <area> 555 XXXX. */
export function randomPhone(): string {
  const areas = ["201", "202", "206", "212", "213", "305", "312", "404", "415", "512", "617", "646", "702", "718", "917"];
  return `+1${areas[randomBytes(1)[0]! % areas.length]}555${String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, "0")}`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Starting and driving sign-ins                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface StartOptions {
  scope?: string;
  prompt?: string;
  pkce?: "S256" | "plain" | "none";
  /** null: send no nonce. */
  nonce?: string | null;
  /** Sent on purpose by journeys that check it is ignored (apps never hand us an email or phone). */
  loginHint?: string;
  /** A direct method button: google | apple | email | phone. */
  method?: string;
  /** signin (default) | signup: which version of the hosted pages. */
  intent?: string;
  redirectUri?: string;
  timezone?: string;
  state?: string;
  extra?: Record<string, string>;
}

export interface Started {
  reply: FlowReply;
  flow: FlowView;
  appId: string;
  state: string;
  verifier: string | null;
  challenge: string | null;
  nonce: string | null;
  redirectUri: string;
}

/** POST /v1/flows the way /authorize does, with a fresh state, PKCE S256 and nonce (unless told otherwise). */
export async function startSignIn(b: Browserish, appId: string, options: StartOptions = {}): Promise<Started> {
  const state = options.state ?? randomState();
  const pkce = options.pkce === "none" ? null : pkcePair(options.pkce ?? "S256");
  const nonce = options.nonce === undefined ? randomNonce() : options.nonce;
  const redirectUri = options.redirectUri ?? (appId === "silicon-accounts" ? `${b.env.site}/sign-in` : redirectUriOf(b.env, appId));
  const reply = await b.createFlow({
    app_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
    code_challenge: pkce?.challenge,
    code_challenge_method: pkce?.method,
    scope: options.scope,
    nonce: nonce ?? undefined,
    prompt: options.prompt,
    login_hint: options.loginHint,
    method: options.method,
    intent: options.intent,
    timezone: options.timezone ?? "Asia/Kolkata",
    ...options.extra,
  });
  return { reply, flow: reply.body?.flow, appId, state, verifier: pkce?.verifier ?? null, challenge: pkce?.challenge ?? null, nonce, redirectUri };
}

/** Sends a sign-in code (email or phone) in the flow and reads it from the mock email/SMS server. */
export async function sendCode(b: Browserish, flowId: string, contact: { email: string } | { phone: string; country?: string }): Promise<{ reply: FlowReply; code: string | null; to: string }> {
  // The server sends to the normalized address: trimmed and lowercased (phones: pass them in E.164).
  const to = "email" in contact ? contact.email.trim().toLowerCase() : contact.phone;
  const after = await lastSeq(b.env);
  const reply = "email" in contact ? await b.act(flowId, "email", { email: contact.email }) : await b.act(flowId, "phone", { phone: contact.phone, ...(contact.country ? { country: contact.country } : {}) });
  if (reply.status !== 200) return { reply, code: null, to };
  const code = await codeFor(b.env, to, after).catch(() => null);
  return { reply, code, to };
}

/** The 6-digit code of the next message to `to` after `after` (null when none arrived in time). */
export async function nextCode(env: Env, to: string, after: number, timeoutMs = 15_000): Promise<string | null> {
  return codeFor(env, to, after, timeoutMs).catch(() => null);
}

/** Adds a missing email or phone on the details page on screen: …/details/add, the code, …/details/verify. */
export async function addDetail(b: Browserish, flowId: string, contact: { email: string } | { phone: string; country?: string }): Promise<{ sent: FlowReply; verified: FlowReply | null; code: string | null }> {
  const to = "email" in contact ? contact.email.trim().toLowerCase() : contact.phone;
  const after = await lastSeq(b.env);
  const sent = await b.detailsAdd(flowId, contact);
  if (sent.status !== 200 || !sent.body.flow.details?.challenge) return { sent, verified: null, code: null };
  const code = await nextCode(b.env, to, after);
  if (!code) return { sent, verified: null, code: null };
  return { sent, verified: await b.detailsVerify(flowId, code), code };
}

export interface DriveOptions {
  /** Sign-up fields to send instead of the prefill. */
  signup?: Record<string, unknown>;
  /**
   * The optional details to tick on whichever details page shows them (exactly these; unset keeps what each page shows:
   * ticked only when shared with the app before, as a Carbon who changes nothing would).
   */
  share?: string[];
  /** Missing emails and phones to add with a code (a missing required one gets a fresh value when not given). */
  email?: string;
  phone?: string;
  /** Also add these missing optional details (with `email` / `phone`, or fresh values). */
  addOptional?: Array<"email" | "phone">;
  /** false: cancel (POST …/review {approve:false}) on the first details page or the review page. */
  approve?: boolean;
  /** On choose_method with a signed-in browser: continue as it (default true). */
  continueAs?: boolean;
  /** Every view the drive saw (after each answer), for checks. */
  trace?: FlowView[];
}

/**
 * Moves a flow on (signup → details pages → review) until complete or failed; throws with the step's reason. On a
 * details page it adds a missing required email or phone with a code, ticks the optional details of `share`, and
 * continues; on the review page it approves (or cancels with `approve: false`).
 */
export async function drive(b: Browserish, start: FlowView, options: DriveOptions = {}): Promise<FlowView> {
  let flow = start;
  for (let guard = 0; guard < 16; guard++) {
    options.trace?.push(flow);
    if (flow.step === "complete" || flow.step === "failed") return flow;
    let reply: FlowReply;
    if (flow.step === "signup") {
      reply = await b.act(flow.id, "signup", options.signup ?? {});
    } else if (flow.step === "details") {
      const details = flow.details;
      if (!details) throw new Error(`flow ${flow.id} is at details without FlowView.details`);
      if (options.approve === false) {
        reply = await b.review(flow.id, false);
      } else {
        const wanted = (field: string) => (field === "email" ? (options.email ?? `added.${rand()}@example.test`) : (options.phone ?? randomPhone()));
        const toAdd = details.fields.find(f => f.missing && (f.field === "email" || f.field === "phone") && (f.mode === "required" || options.addOptional?.includes(f.field as "email" | "phone")));
        if (toAdd) {
          const value = wanted(toAdd.field);
          const added = await addDetail(b, flow.id, toAdd.field === "email" ? { email: value } : { phone: value });
          if (added.sent.status !== 200) throw new Error(`details/add ${toAdd.field} ${value} answered ${brief(added.sent)}`);
          if (!added.verified) {
            // Added meanwhile (no code needed): the page already shows it.
            flow = added.sent.body.flow;
            continue;
          }
          if (added.verified.status !== 200) throw new Error(`details/verify for ${value} answered ${brief(added.verified)}`);
          flow = added.verified.body.flow;
          continue;
        }
        const optional = details.fields.filter(f => f.mode === "optional" && !f.missing);
        const share = optional.filter(f => (options.share ? options.share.includes(f.field) : f.shared)).map(f => f.field);
        reply = await b.detailsContinue(flow.id, share);
      }
    } else if (flow.step === "review") {
      reply = await b.review(flow.id, options.approve ?? true);
    } else if (flow.step === "choose_method" && flow.signed_in_as && options.continueAs !== false) {
      reply = await b.act(flow.id, "continue");
    } else {
      throw new Error(`flow ${flow.id} waits at ${flow.step}${flow.error ? ` (${flow.error.code}: ${flow.error.message})` : ""}`);
    }
    if (reply.status !== 200) throw new Error(`flow ${flow.id} at ${flow.step}: ${brief(reply)}`);
    flow = reply.body.flow;
  }
  throw new Error(`flow ${flow.id} did not finish (stuck at ${flow.step})`);
}

/** The query of a flow's redirect_to (code, state, error…). */
export function redirectParams(flow: Pick<FlowView, "redirect_to"> | null | undefined): URLSearchParams {
  return new URL(flow?.redirect_to ?? "http://invalid.invalid/").searchParams;
}

/**
 * A whole new Carbon through `appId`'s hosted flow with an email code: sign-up with the prefill, the details pages
 * (required details shared, `share` ticked), the review approved. Returns the finished flow, its code and the prefill.
 */
export async function signUpVia(b: Browserish, appId: string, email: string, options: StartOptions & DriveOptions = {}): Promise<{ started: Started; flow: FlowView; code: string; signupPrefill: FlowView["signup"] }> {
  const started = await startSignIn(b, appId, options);
  if (started.reply.status !== 201) throw new Error(`POST /v1/flows for ${appId}: ${brief(started.reply)}`);
  const sent = await sendCode(b, started.flow.id, { email });
  if (!sent.code) throw new Error(`no sign-in code reached ${email}: ${brief(sent.reply)}`);
  const verified = await b.act(started.flow.id, "verify", { code: sent.code });
  if (verified.status !== 200) throw new Error(`verify for ${email}: ${brief(verified)}`);
  const signupPrefill = verified.body.flow.signup;
  const flow = await drive(b, verified.body.flow, options);
  const code = redirectParams(flow).get("code");
  if (!code) throw new Error(`flow ${flow.id} ended without a code: ${flow.redirect_to}`);
  return { started, flow, code, signupPrefill };
}

/** Signs the browser in again through `appId` (continue as, or a code when told), and returns the finished flow. */
export async function signInAgain(b: Browserish, appId: string, options: StartOptions & DriveOptions = {}): Promise<{ started: Started; flow: FlowView; code: string | null }> {
  const started = await startSignIn(b, appId, options);
  if (started.reply.status !== 201) throw new Error(`POST /v1/flows for ${appId}: ${brief(started.reply)}`);
  const flow = await drive(b, started.flow, options);
  return { started, flow, code: redirectParams(flow).get("code") };
}

/** A new Carbon signed up on spacestation (email only, no consent beyond its one page): its browser and uuid. */
export async function newCarbon(env: Env, ip: string, email: string, options: StartOptions & DriveOptions = {}): Promise<{ b: Browserish; uuid: string; id: string }> {
  const b = new Browserish(env, ip);
  await signUpVia(b, "spacestation", email, options);
  const me = (await b.session())?.account;
  if (!me) throw new Error(`the new Carbon ${email} has no browser session`);
  return { b, uuid: me.uuid, id: me.id };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* App calls (server to server, with the fake apps' fixed credentials)                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface AppCallOptions {
  secret?: string;
  /** Credentials in the form (client_secret_post) instead of HTTP Basic. */
  post?: boolean;
  /** Straight at accounts-api instead of through the site. */
  direct?: boolean;
  /** No client authentication at all (a public client: client_id in the form only). */
  publicClient?: boolean;
}

function parseBody(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** POST a form to an OAuth endpoint as `appId`. */
export async function appForm<T = unknown>(env: Env, appId: string, path: string, form: Record<string, string>, options: AppCallOptions = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  let fields = form;
  if (options.publicClient) {
    fields = { ...form, client_id: appId };
  } else {
    const secret = options.secret ?? fakeApp(appId).secret;
    if (options.post) fields = { ...form, client_id: appId, client_secret: secret };
    else headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(appId)}:${encodeURIComponent(secret)}`).toString("base64")}`;
  }
  const started = performance.now();
  const response = await fetch(`${options.direct ? env.api : env.site}${path}`, { method: "POST", headers, body: new URLSearchParams(fields).toString(), redirect: "manual" });
  const text = await response.text();
  return { status: response.status, body: parseBody(text) as T, headers: response.headers, location: response.headers.get("location"), ms: performance.now() - started, text };
}

export const exchangeCode = (env: Env, appId: string, code: string, redirectUri: string, verifier: string | null, options: AppCallOptions = {}) =>
  appForm<Tokens & ApiErrorBody>(env, appId, "/v1/oauth/token", { grant_type: "authorization_code", code, redirect_uri: redirectUri, ...(verifier ? { code_verifier: verifier } : {}) }, options);

export const refresh = (env: Env, appId: string, refreshToken: string, extra: Record<string, string> = {}, options: AppCallOptions = {}) =>
  appForm<Tokens & ApiErrorBody>(env, appId, "/v1/oauth/token", { grant_type: "refresh_token", refresh_token: refreshToken, ...extra }, options);

export const introspect = (env: Env, appId: string, token: string, options: AppCallOptions = {}) => appForm<Record<string, unknown> & ApiErrorBody>(env, appId, "/v1/oauth/introspect", { token }, options);

export const revoke = (env: Env, appId: string, token: string, options: AppCallOptions = {}) => appForm<{ revoked?: boolean; message?: string } & ApiErrorBody>(env, appId, "/v1/oauth/revoke", { token }, options);

export async function userinfo(env: Env, accessToken: string): Promise<Reply<Record<string, unknown> & ApiErrorBody>> {
  const started = performance.now();
  const response = await fetch(`${env.site}/v1/userinfo`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  const text = await response.text();
  return { status: response.status, body: parseBody(text) as Record<string, unknown> & ApiErrorBody, headers: response.headers, location: null, ms: performance.now() - started, text };
}

/** A JSON call to accounts-api /v1 as the fake app (HTTP Basic with its fixed secret), through the site. */
export async function asApp<T = unknown>(env: Env, appId: string, method: string, path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
  const started = performance.now();
  const response = await fetch(`${env.site}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${appId}:${fakeApp(appId).secret}`).toString("base64")}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  return { status: response.status, body: parseBody(text) as T, headers: response.headers, location: null, ms: performance.now() - started, text };
}

/** PATCH /v1/apps/{app}/signin-config as the app itself (deep merge; arrays replace), with an Idempotency-Key. */
export const patchSigninConfig = (env: Env, appId: string, patch: Record<string, unknown>) =>
  asApp<Record<string, unknown> & ApiErrorBody>(env, appId, "PATCH", `/v1/apps/${appId}/signin-config`, patch, { "idempotency-key": `auth-flows-${Date.now()}-${rand()}` });

/**
 * Runs `body` with a temporary change of an app's sign-in setup, and always puts it back with `restore` (journeys of
 * a suite share the stack, so a change must never outlive the journey that made it). Throws when either PATCH fails.
 */
export async function withSigninConfig<T>(env: Env, appId: string, change: Record<string, unknown>, restore: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const changed = await patchSigninConfig(env, appId, change);
  if (changed.status !== 200) throw new Error(`PATCH ${appId} signin-config ${JSON.stringify(change)} answered ${brief(changed)}`);
  try {
    return await body();
  } finally {
    const back = await patchSigninConfig(env, appId, restore);
    if (back.status !== 200) throw new Error(`putting ${appId}'s sign-in setup back (${JSON.stringify(restore)}) answered ${brief(back)}`);
  }
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The mock Google and Apple                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ProviderOutcome =
  | { kind: "redirect"; location: string }
  | { kind: "form_post"; action: string; fields: Record<string, string> }
  | { kind: "chooser" }
  | { kind: "error"; status: number; error: string | null; description: string | null };

const decodeEntities = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** Plays the browser at the mock provider: picks (or creates) `email` with `_auto` (and `_name`), or answers `error`. */
export async function providerAuthorize(authorizeUrl: string, select: { email?: string; name?: string; error?: string } = {}): Promise<ProviderOutcome> {
  const url = new URL(authorizeUrl);
  if (select.email) url.searchParams.set("_auto", select.email);
  if (select.name) url.searchParams.set("_name", select.name);
  if (select.error) url.searchParams.set("_error", select.error);
  const response = await fetch(url, { redirect: "manual", headers: { accept: "text/html" } });
  const html = await response.text();
  if (response.status >= 300 && response.status < 400) return { kind: "redirect", location: new URL(response.headers.get("location") ?? "", url).toString() };
  if (response.status === 200 && html.includes('id="apple-form-post"')) {
    const form = /<form[^>]*\baction="([^"]*)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
    const fields: Record<string, string> = {};
    for (const input of (form?.[2] ?? "").matchAll(/<input[^>]*>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(input[0])?.[1];
      const value = /\bvalue="([^"]*)"/i.exec(input[0])?.[1] ?? "";
      if (name) fields[decodeEntities(name)] = decodeEntities(value);
    }
    return { kind: "form_post", action: decodeEntities(form?.[1] ?? ""), fields };
  }
  if (response.status === 200 && html.includes('id="chooser"')) return { kind: "chooser" };
  return { kind: "error", status: response.status, error: /data-error="([^"]*)"/.exec(html)?.[1] ?? null, description: /<p id="error-description">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? null };
}

/**
 * Brings a provider's answer back to Silicon Accounts the way a browser does: Google's redirect is a same-site GET
 * with the cookies; Apple's form_post is a cross-site POST that carries no SameSite=Lax cookies, which the server parks
 * and continues with a 303 to a same-site GET (that carries them). Returns the flow id it lands on (or the reply).
 */
export async function deliverAnswer(b: Browserish, outcome: ProviderOutcome): Promise<{ flowId: string | null; hops: Array<Reply<unknown>> }> {
  const hops: Array<Reply<unknown>> = [];
  let reply: Reply<unknown>;
  if (outcome.kind === "redirect") {
    reply = await b.call("GET", outcome.location, { headers: { accept: "text/html" } });
  } else if (outcome.kind === "form_post") {
    reply = await b.call("POST", outcome.action, { form: outcome.fields, origin: b.env.oidc, cookies: false, headers: { accept: "text/html" } });
    hops.push(reply);
    if (reply.status === 303 && reply.location) reply = await b.call("GET", reply.location, { headers: { accept: "text/html" } });
  } else {
    throw new Error(`the mock provider answered ${outcome.kind}`);
  }
  hops.push(reply);
  const match = /\/authorize\/flow\/([^/?#]+)/.exec(reply.location ?? "");
  return { flowId: match?.[1] ?? null, hops };
}

/** Starts the provider leg of a flow at the API and plays the browser at the mock provider and back. */
export async function providerLeg(b: Browserish, flowId: string, provider: "google" | "apple", select: { email?: string; name?: string; error?: string }) {
  const go = await b.post<{ authorize_url?: string } & ApiErrorBody>(`/v1/flows/${flowId}/oauth/${provider}`);
  const authorizeUrl = go.body?.authorize_url ?? "";
  const outcome = authorizeUrl ? await providerAuthorize(authorizeUrl, select) : null;
  const delivered = outcome && outcome.kind !== "chooser" && outcome.kind !== "error" ? await deliverAnswer(b, outcome) : null;
  const after: FlowReply | null = delivered?.flowId ? await b.flow(delivered.flowId) : null;
  return { go, authorizeUrl, outcome, delivered, flow: after?.body?.flow ?? null, after };
}

export interface OidcLogEntry {
  provider: string;
  endpoint: string;
  client_id: string | null;
  outcome: string;
  params: Record<string, string | boolean | null>;
  identity: { sub: string; email: string } | null;
  client_secret_jwt: { kid: string | null; iss: string | null; sub: string | null; aud: unknown } | null;
}

/** The mock provider's request log, newest first. */
export async function providerLog(env: Env, filter: { provider?: string; endpoint?: string; client_id?: string } = {}): Promise<OidcLogEntry[]> {
  const query = new URLSearchParams(Object.entries(filter).filter((entry): entry is [string, string] => !!entry[1]));
  return (await json<{ items?: OidcLogEntry[] }>(`${env.oidc}/_requests?${query.toString()}`)).body.items ?? [];
}

export async function registerIdentity(env: Env, identity: Record<string, unknown>): Promise<{ sub: string; email: string }> {
  const reply = await json<{ identity: { sub: string; email: string } }>(`${env.oidc}/_identities`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(identity) });
  if (reply.status !== 201) throw new Error(`mock-oidc refused the identity: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body.identity;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Small things                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** "422 invalid_code: That code is wrong…" (or the OAuth error), for check details. */
export function brief(reply: Reply<unknown>): string {
  const body = reply.body as ApiErrorBody | null;
  if (body && typeof body === "object") {
    if (body.error && typeof body.error === "object") return `${reply.status} ${body.error.code}: ${body.error.message ?? ""}${body.error.details ? ` ${JSON.stringify(body.error.details)}` : ""}`.slice(0, 600);
    if (typeof body.error === "string") return `${reply.status} ${body.error}: ${body.error_description ?? ""}`.slice(0, 600);
    const flow = (body as { flow?: FlowView }).flow;
    if (flow && typeof flow === "object") return `${reply.status} step=${flow.step}${flow.error ? ` error=${flow.error.code}` : ""}${flow.details ? ` page=${flow.details.id} ${flow.details.index + 1}/${flow.details.count}` : ""}`;
  }
  return `${reply.status} ${typeof reply.body === "string" ? reply.body.slice(0, 200) : JSON.stringify(reply.body).slice(0, 300)}`;
}

/** The API error code of a reply (`{"error":{"code"}}`), or the OAuth `error`. */
export function errorCode(reply: Reply<unknown>): string | null {
  const body = reply.body as ApiErrorBody | null;
  if (!body || typeof body !== "object") return null;
  if (body.error && typeof body.error === "object") return body.error.code ?? null;
  return typeof body.error === "string" ? body.error : null;
}

export function errorDetails(reply: Reply<unknown>): Record<string, unknown> {
  const body = reply.body as ApiErrorBody | null;
  return body && typeof body === "object" && body.error && typeof body.error === "object" ? (body.error.details ?? {}) : {};
}

export function errorMessage(reply: Reply<unknown>): string {
  const body = reply.body as ApiErrorBody | null;
  if (!body || typeof body !== "object") return "";
  if (body.error && typeof body.error === "object") return `${body.error.message ?? ""} ${body.error.hint ?? ""}`;
  return body.error_description ?? "";
}

/** The field errors of a 422 (`details.fields`). */
export const fieldErrors = (reply: Reply<unknown>) => (errorDetails(reply).fields ?? {}) as Record<string, string>;

/** A JWT's payload (no verification). */
export function jwtClaims(token: string | undefined | null): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from((token ?? "").split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function jwtHeader(token: string | undefined | null): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from((token ?? "").split(".")[0] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The date exactly 18 years before today in `timeZone` (Feb 29 → Feb 28), as YYYY-MM-DD. */
export function eighteenYearsAgo(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => Number(parts.find(entry => entry.type === type)?.value ?? "0");
  const year = part("year") - 18;
  const month = part("month");
  let day = part("day");
  if (month === 2 && day === 29) day = 28;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Times an async step. */
export async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
}

/** Median and p95 of a list of numbers. */
export function stats(values: number[]): { p50: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
}

/** The webhook events Silicon Accounts queued for an app about an account (type and data), oldest first. */
export async function appEvents(env: Env, appId: string, uuid: string): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const rows = await sql(env, `select type, payload->'data' from webhook_events where target_kind = 'app' and target_id = '${appId}' and account_uuid = '${uuid}' order by occurred_at, event_id`);
  return rows.map(([type, data]) => ({ type: type ?? "", data: JSON.parse(data ?? "{}") as Record<string, unknown> }));
}

/** The account uuid behind a verified email (or null). */
export async function uuidOfEmail(env: Env, email: string): Promise<string | null> {
  const rows = await sql(env, `select account_uuid from account_emails where email = '${email.toLowerCase().replace(/'/g, "")}'`);
  return rows[0]?.[0] ?? null;
}

/** The scopes a membership grants (sorted, space-separated), or null without one. */
export async function grantOf(env: Env, appId: string, uuid: string): Promise<string | null> {
  const rows = await sql(env, `select array_to_string(granted_scopes, ' ') from memberships where app_id = '${appId}' and account_uuid = '${uuid}'`);
  return rows[0] ? (rows[0][0] ?? "").split(" ").filter(Boolean).sort().join(" ") : null;
}

/** How many emails or texts the mock email/SMS server received for `to` after message `after`. */
export async function messagesTo(env: Env, to: string, after: number): Promise<number> {
  const reply = await json<{ count?: number }>(`${env.messaging}/_messages?to=${encodeURIComponent(to)}&after=${after}&limit=1000`);
  return reply.body.count ?? 0;
}

/** How many emails and texts the mock email/SMS server received (for anyone) after message `after`. */
export async function messagesAfter(env: Env, after: number): Promise<number> {
  const reply = await json<{ count?: number }>(`${env.messaging}/_messages?after=${after}&limit=1000`);
  return reply.body.count ?? 0;
}

/** Puts a regex-special string into a RegExp literally. */
export const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\/:]/g, "\\$&");

/** Sorted, space-separated scope list of a token response or introspection. */
export const scopeSet = (scope: string | undefined | null) => (scope ?? "").split(" ").filter(Boolean).sort().join(" ");

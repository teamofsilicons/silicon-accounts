/**
 * More helpers of the developer-site suite (a helper file: its name starts with "_"), for the journeys that need app
 * members to look at: fresh Carbons signed into an app through its hosted pages, a Silicon brought in with a short-lived
 * token, users imported by the app itself, calls on the account site as a signed-in Carbon, the fake apps' webhook
 * inboxes (and generic sinks) of the testkit, and waiting for something to become true.
 */
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import type { Ctx } from "../../context";
import { api, appAccount, completeDetails, json, newContext, signInWithCode, sleep, startAtApp, type ContextOptions, type DetailsAnswers, type Env, type HostedWalk, type JsonAnswer } from "../../lib";
import { appBasic, freshEmail } from "./_helpers";

/** Polls `probe` until it gives a value (not null, undefined or false), or gives null after `timeoutMs`. */
export async function until<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 300): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) return null;
    await sleep(everyMs);
  }
}

/** A call on the account site's /v1 as the Carbon signed in there in this page's browser context (its session, its Origin). */
export async function siteCall<T = unknown>(page: Page, env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<JsonAnswer<T>> {
  const response = await page.request.fetch(`${env.site}${path}`, {
    method,
    headers: { origin: env.site, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { data: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status(), body: parsed as T, headers: new Headers(response.headers()) };
}

export interface Member {
  context: BrowserContext;
  page: Page;
  email: string;
  /** What the app received (the fake app's AccountForApp). */
  account: Record<string, unknown>;
  uuid: string;
  walk: HostedWalk;
}

/**
 * A fresh Carbon signs up into `app` from the app's own "Sign in with Silicon Accounts" link, in a browser context of
 * its own: an email code, Create account, then the app's details pages as `answers` says (by default: required details
 * shared, optional ones left unticked), and back at the app.
 */
export async function joinApp(ctx: Ctx, app: string, label: string, answers: DetailsAnswers = {}, options: ContextOptions & { expected?: RegExp[] } = {}): Promise<Member> {
  const email = freshEmail(label);
  const context = await newContext(ctx.browser, options);
  const page = await context.newPage();
  ctx.results.watch(page, label, options.expected ?? []);
  await startAtApp(ctx.env, page, app);
  await signInWithCode(ctx.env, page, { email });
  const create = page.getByRole("button", { name: /^(Create account|Finish setup)$/ });
  await create.waitFor({ timeout: 25_000 });
  await sleep(300);
  await create.click();
  const walk = await completeDetails(ctx.env, page, app, answers);
  const account = (await appAccount(page)) ?? {};
  return { context, page, email, account, uuid: String(account.uuid ?? ""), walk };
}

export interface SiliconMember {
  uuid: string;
  id: string;
  stk: string;
  /** The fake app's answer to its exchange of the short-lived token. */
  exchange: JsonAnswer<Record<string, unknown>>;
}

/**
 * A Silicon made by the Carbon signed in on `custodianPage` (POST /v1/me/silicons, so the Carbon is its custodian), signed
 * in with its si:id and STK, which then gets a short-lived token for `app` that the app's server exchanges for its
 * tokens (the fake app's POST /<app>/slt-login): how a Silicon joins an app (it never sees a sign-in page).
 */
export async function siliconJoins(ctx: Ctx, custodianPage: Page, app: string, handle: string): Promise<SiliconMember> {
  const id = `si:${handle}`;
  const created = await siteCall<{ silicon?: { uuid: string; id: string }; stk?: string }>(custodianPage, ctx.env, "POST", "/v1/me/silicons", { id, display_name: `Silicon ${handle}`, timezone: "Asia/Kolkata" }, { "idempotency-key": randomUUID() });
  if (created.status !== 201 || !created.body.silicon || !created.body.stk) throw new Error(`creating ${id} answered ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
  const login = await api<{ access_token?: string }>(ctx, "/v1/silicons/login", { method: "POST", direct: true, json: { id, stk: created.body.stk, client_label: "developer-site suite" } });
  if (login.status !== 200 || !login.body.access_token) throw new Error(`${id} signing in answered ${login.status}: ${JSON.stringify(login.body).slice(0, 300)}`);
  const slt = await api<{ slt?: string }>(ctx, "/v1/me/short-lived-tokens", { method: "POST", direct: true, headers: { authorization: `Bearer ${login.body.access_token}` }, json: { app_id: app } });
  if (![200, 201].includes(slt.status) || !slt.body.slt) throw new Error(`${id}'s short-lived token for ${app} answered ${slt.status}: ${JSON.stringify(slt.body).slice(0, 300)}`);
  const exchange = await json<Record<string, unknown>>(`${ctx.env.apps}/${app}/slt-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slt: slt.body.slt }) });
  return { uuid: created.body.silicon.uuid, id: created.body.silicon.id, stk: created.body.stk, exchange };
}

export interface ImportJobView {
  id: string;
  status: string;
  dry_run: boolean;
  total_rows: number;
  processed_rows: number;
  counts: { created: number; matched: number; updated: number; skipped: number; error: number; warnings: number };
  options?: Record<string, unknown>;
  error: string | null;
}

/** An import the app's own server starts (POST /v1/apps/{app}/imports, its credentials), followed until it finishes. */
export async function importAsApp(ctx: Ctx, app: string, rows: Array<Record<string, unknown>>, options: Record<string, unknown> = {}): Promise<ImportJobView> {
  const started = await api<{ job?: ImportJobView }>(ctx, `/v1/apps/${app}/imports`, { method: "POST", direct: true, headers: { authorization: appBasic(app), "idempotency-key": randomUUID() }, json: { rows, options } });
  if (![200, 201, 202].includes(started.status) || !started.body.job) throw new Error(`starting an import into ${app} answered ${started.status}: ${JSON.stringify(started.body).slice(0, 300)}`);
  const id = started.body.job.id;
  const done = await until(async () => {
    const job = (await api<{ job?: ImportJobView }>(ctx, `/v1/apps/${app}/imports/${id}`, { direct: true, headers: { authorization: appBasic(app) } })).body.job;
    return job && (job.status === "completed" || job.status === "failed") ? job : null;
  }, 60_000, 400);
  if (!done) throw new Error(`the import ${id} into ${app} did not finish within 60 s`);
  return done;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The testkit's webhook inboxes: a fake app's (<apps>/<app>) or a generic sink (<apps>/hooks/<key>)                  */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface InboxEvent {
  seq: number;
  event_id: string;
  type: string;
  delivery_id: string | null;
  received_at: string;
  deliveries: number;
  duplicate_count: number;
  recovered: boolean;
  payload: Record<string, unknown>;
}

export interface InboxRejection {
  seq: number;
  status: number;
  reason: string;
  message: string;
  event_id: string | null;
  type: string | null;
  delivery_id: string | null;
}

/** What an inbox received (accepted events, and refused deliveries with why). */
export async function readInbox(inbox: string): Promise<{ items: InboxEvent[]; rejected: InboxRejection[] }> {
  const answer = await json<{ items?: InboxEvent[]; events?: InboxEvent[]; rejected?: InboxRejection[] }>(`${inbox}/_events?include_rejected=1&limit=500`);
  return { items: answer.body.items ?? answer.body.events ?? [], rejected: answer.body.rejected ?? [] };
}

/** The inbox answers the next `failNext` deliveries with `status` (0 clears it). */
export async function inboxFaults(inbox: string, failNext: number, status = 500): Promise<void> {
  const answer = await json(`${inbox}/_webhook-faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fail_next: failNext, status }) });
  if (answer.status !== 200) throw new Error(`${inbox}/_webhook-faults answered ${answer.status}: ${JSON.stringify(answer.body)}`);
}

/** The signing secret the inbox verifies deliveries with (null forgets it). */
export async function inboxSecret(inbox: string, secret: string | null): Promise<void> {
  const answer = await json(`${inbox}/_webhook-secret`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) });
  if (answer.status !== 200) throw new Error(`${inbox}/_webhook-secret answered ${answer.status}: ${JSON.stringify(answer.body)}`);
}

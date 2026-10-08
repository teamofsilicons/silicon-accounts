/**
 * Helpers of the "imports" suite (user imports: POST /v1/apps/{app_id}/imports and what it creates). Kept in the suite
 * (README: a shared helper the harness lacks lives in the suite's `_helpers.ts` until the harness owner moves it).
 *
 * Every journey imports a *tagged* copy of a fixture (testkit/fixtures/imports): its new emails move to a sub-domain
 * of their own (`ada.byron@<tag>.legacy-crm.test`), usernames and external ids get the tag as a suffix and phone
 * numbers a fresh exchange, while everything the fixture is about stays byte for byte (the BOM, CRLF line ends,
 * quoting, padding, ragged rows, invalid values) and so do the rows that point at seeded accounts (c:saket's email,
 * dev@acme-notes.test, the precondition phone…). So journeys never collide with each other or with an earlier walk
 * of a kept stack, and expected.json still describes every row.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { DEVELOPER_SIGNED_OUT, E2E_DIR, api, codeFor, json, lastSeq, newContext, signInOnDeveloper, signInWithCode, sleep, type ApiInit, type CliRun, type Env, type JsonAnswer, type Results } from "../../lib";

export const ROOT = resolve(E2E_DIR, "../..");
export const FIXTURES = join(ROOT, "testkit/fixtures/imports");

/* ------------------------------------------------------------------------------------------------------------------ */
/* Fake apps and app calls                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface FakeApp {
  app_id: string;
  name: string;
  secret: string;
  owner_id: string;
  owner_email: string;
}

let appsCache: FakeApp[] | null = null;
export function fakeApp(appId: string): FakeApp {
  appsCache ??= (JSON.parse(readFileSync(join(ROOT, "testkit/fake-apps.json"), "utf8")) as { apps: FakeApp[] }).apps;
  const app = appsCache.find(entry => entry.app_id === appId);
  if (!app) throw new Error(`testkit/fake-apps.json has no app ${appId}`);
  return app;
}

/** HTTP Basic with the app's own credentials (client_secret_basic: both parts form-encoded). */
export const basicAuth = (app: { app_id: string; secret: string }) =>
  `Basic ${Buffer.from(`${encodeURIComponent(app.app_id)}:${encodeURIComponent(app.secret)}`).toString("base64")}`;

type Caller = { env: Env; ip: string };

/** A call as the app (its credentials), through the site's /v1 unless `direct`. `auth: null` sends none. */
export function appCall<T = unknown>(ctx: Caller, app: FakeApp | null, path: string, init: ApiInit & { auth?: string | null } = {}): Promise<JsonAnswer<T>> {
  const { auth, ...rest } = init;
  const headers = new Headers(rest.headers);
  const authorization = auth === undefined ? (app ? basicAuth(app) : null) : auth;
  if (authorization) headers.set("authorization", authorization);
  return api<T>(ctx, path, { ...rest, headers });
}

export interface ImportCounts {
  created: number;
  matched: number;
  updated: number;
  skipped: number;
  error: number;
  warnings: number;
}

export interface ImportJob {
  id: string;
  app_id: string;
  status: "queued" | "running" | "completed" | "failed";
  format: "csv" | "json";
  options: { default_country?: string | null; ignore_unknown_columns?: boolean; dry_run?: boolean; update_existing?: boolean };
  dry_run: boolean;
  total_rows: number;
  processed_rows: number;
  counts: ImportCounts;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface RowMessage {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  field?: string;
}

export interface RowResult {
  row_number: number;
  outcome: "pending" | "created" | "matched" | "updated" | "skipped" | "error";
  account_uuid: string | null;
  id: string | null;
  messages: RowMessage[];
  input: Record<string, unknown>;
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> };
}

export type ImportOptionsQuery = Record<string, string | boolean | undefined>;

const query = (options: ImportOptionsQuery) => {
  const entries = Object.entries(options).filter(([, value]) => value !== undefined) as Array<[string, string | boolean]>;
  return entries.length ? `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}` : "";
};

/** POST …/imports with a CSV body (options as query parameters). */
export function postCsv(ctx: Caller, app: FakeApp | null, body: string | Buffer, options: ImportOptionsQuery = {}, extra: { key?: string | null; direct?: boolean; auth?: string | null; contentType?: string | null; appId?: string } = {}) {
  const headers: Record<string, string> = {};
  if (extra.contentType !== null) headers["content-type"] = extra.contentType ?? "text/csv";
  if (extra.key) headers["idempotency-key"] = extra.key;
  const appId = extra.appId ?? app?.app_id ?? "legacy-crm";
  return appCall<{ job?: ImportJob } & ApiErrorBody>(ctx, app, `/v1/apps/${appId}/imports${query(options)}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : new Uint8Array(body),
    direct: extra.direct,
    ...(extra.auth !== undefined ? { auth: extra.auth } : {}),
  });
}

/** POST …/imports with a JSON body `{"rows":[…],"options":{…}}`. */
export function postJson(ctx: Caller, app: FakeApp, payload: unknown, extra: { key?: string | null; direct?: boolean; query?: ImportOptionsQuery } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (extra.key) headers["idempotency-key"] = extra.key;
  return appCall<{ job?: ImportJob } & ApiErrorBody>(ctx, app, `/v1/apps/${app.app_id}/imports${query(extra.query ?? {})}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    direct: extra.direct,
  });
}

/**
 * POST with `Expect: 100-continue`, the way an HTTP client should send a body that may be refused for its size: the
 * server can answer (413) from the headers alone, before any of the body is sent. (fetch can't: it streams the body at
 * once, and when the server answers early and closes the connection it reports a bare "fetch failed".) Resolves with
 * the first response; whether the body went out at all is in `sent`.
 */
export function postExpectContinue(url: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined>; sent: boolean }> {
  return new Promise((resolveAnswer, fail) => {
    const target = new URL(url);
    let sent = false;
    let answered = false;
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: "POST", headers: { ...headers, "content-length": String(body.length), expect: "100-continue" } });
    // A socket the server closed mid-upload errors (EPIPE / ECONNRESET) after the request let go of it: never crash.
    req.on("socket", socket => socket.on("error", () => undefined));
    req.on("continue", () => {
      sent = true;
      req.end(body);
    });
    req.on("response", response => {
      answered = true;
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => (text += chunk));
      response.on("end", () => resolveAnswer({ status: response.statusCode ?? 0, text, headers: response.headers, sent }));
      response.on("error", () => resolveAnswer({ status: response.statusCode ?? 0, text, headers: response.headers, sent }));
    });
    // Once the server answered, a broken upload (it closed the connection) is expected, not a failure; before that,
    // a reset is the answer (status 0 with the error's code).
    req.on("error", error => {
      if (!answered) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code) resolveAnswer({ status: 0, text: `connection error ${code}: ${error.message}`, headers: {}, sent });
        else fail(error);
      }
    });
    req.flushHeaders();
  });
}

export async function getJob(ctx: Caller, app: FakeApp, jobId: string): Promise<ImportJob> {
  const answer = await appCall<{ job: ImportJob }>(ctx, app, `/v1/apps/${app.app_id}/imports/${jobId}`);
  if (answer.status !== 200) throw new Error(`GET import ${jobId}: ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
  return answer.body.job;
}

/** Polls the job until it is completed or failed; returns it and when that was first seen. */
export async function waitJob(ctx: Caller, app: FakeApp, jobId: string, timeoutMs = 120_000, intervalMs = 150): Promise<ImportJob & { seen_done_at: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob(ctx, app, jobId);
    if (job.status === "completed" || job.status === "failed") return { ...job, seen_done_at: Date.now() };
    if (Date.now() > deadline) throw new Error(`import ${jobId} is still ${job.status} (${job.processed_rows}/${job.total_rows}) after ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

/** Every row result of a job (follows the cursors, 200 at a time), or a filtered list. */
export async function allRows(ctx: Caller, app: FakeApp, jobId: string, filter: Record<string, string> = {}): Promise<RowResult[]> {
  const rows: RowResult[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "200", ...filter, ...(cursor ? { cursor } : {}) });
    const page: JsonAnswer<{ items: RowResult[]; next_cursor: string | null }> = await appCall(ctx, app, `/v1/apps/${app.app_id}/imports/${jobId}/rows?${params.toString()}`);
    if (page.status !== 200) throw new Error(`GET rows of ${jobId}: ${page.status} ${JSON.stringify(page.body).slice(0, 300)}`);
    rows.push(...page.body.items);
    cursor = page.body.next_cursor;
  } while (cursor);
  return rows;
}

export async function listJobs(ctx: Caller, app: FakeApp): Promise<ImportJob[]> {
  const answer = await appCall<{ items: ImportJob[] }>(ctx, app, `/v1/apps/${app.app_id}/imports?limit=200`);
  if (answer.status !== 200) throw new Error(`GET imports: ${answer.status}`);
  return answer.body.items;
}

export const countsText = (c: Partial<ImportCounts> | undefined) => (c ? `created ${c.created}, matched ${c.matched}, updated ${c.updated}, skipped ${c.skipped}, error ${c.error}, warnings ${c.warnings}` : "no counts");
export const sameCounts = (c: Partial<ImportCounts> | undefined, want: { created: number; matched: number; updated: number; skipped: number; error: number }) =>
  !!c && c.created === want.created && c.matched === want.matched && c.updated === want.updated && c.skipped === want.skipped && c.error === want.error;

/* ------------------------------------------------------------------------------------------------------------------ */
/* The stack's database                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Runs a query on the stack's database and returns psql's whole output (one value: use it for JSON). */
export function psql(env: Env, text: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile(join(env.pgBin, "psql"), [env.db, "-v", "ON_ERROR_STOP=1", "-At", "-c", text], { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PGOPTIONS: "--client-min-messages=warning" } }, (error, stdout, stderr) => {
      if (error) fail(new Error(`psql failed: ${stderr.trim() || error.message}\n${text.slice(0, 400)}`));
      else done(stdout.replace(/\n$/, ""));
    });
  });
}

/** `select json_agg(…)` of a query as parsed rows ([] when none). */
export async function rowsOf<T = Record<string, unknown>>(env: Env, select: string): Promise<T[]> {
  const out = await psql(env, `select coalesce(json_agg(t), '[]'::json) from (${select}) t`);
  return JSON.parse(out || "[]") as T[];
}

export async function scalar(env: Env, select: string): Promise<string> {
  return psql(env, select);
}

/** SQL string literal. */
export const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;
export const litArray = (values: string[]) => `array[${values.map(lit).join(",") || "''"}]::text[]`;

export interface AccountRow {
  uuid: string;
  handle: string | null;
  status: string;
  display_name: string;
  dob: string;
  timezone: string;
  pfp_url: string;
  emails: Array<{ email: string; primary: boolean; verified: boolean }>;
  phones: Array<{ phone: string; primary: boolean; verified: boolean }>;
  membership: { status: string; source: string; external_id: string | null; imported_profile: Record<string, unknown> | null } | null;
}

/** Accounts by uuid with their contacts and their membership of `appId`. */
export async function accountsByUuid(env: Env, uuids: string[], appId = "legacy-crm"): Promise<Map<string, AccountRow>> {
  if (!uuids.length) return new Map();
  const rows = await rowsOf<AccountRow>(env, `
    select a.uuid, a.handle, a.status, a.display_name, a.dob::text as dob, a.timezone, a.pfp_url,
      coalesce((select json_agg(json_build_object('email', e.email, 'primary', e.is_primary, 'verified', e.verified_at is not null) order by e.is_primary desc, e.email)
                from account_emails e where e.account_uuid = a.uuid), '[]'::json) as emails,
      coalesce((select json_agg(json_build_object('phone', p.phone, 'primary', p.is_primary, 'verified', p.verified_at is not null) order by p.is_primary desc, p.phone)
                from account_phones p where p.account_uuid = a.uuid), '[]'::json) as phones,
      (select json_build_object('status', m.status, 'source', m.source, 'external_id', m.external_id, 'imported_profile', m.imported_profile)
         from memberships m where m.account_uuid = a.uuid and m.app_id = ${lit(appId)}) as membership
    from accounts a where a.uuid = any(${litArray(uuids)})`);
  return new Map(rows.map(row => [row.uuid, row]));
}

/** The account that owns an email or phone (any status), or null. */
export async function ownerOf(env: Env, contact: string): Promise<{ uuid: string; handle: string | null; status: string; verified: boolean } | null> {
  const table = contact.includes("@") ? "account_emails" : "account_phones";
  const column = contact.includes("@") ? "email" : "phone";
  const [row] = await rowsOf<{ uuid: string; handle: string | null; status: string; verified: boolean }>(env,
    `select a.uuid, a.handle, a.status, c.verified_at is not null as verified from ${table} c join accounts a on a.uuid = c.account_uuid where c.${column} = ${lit(contact.toLowerCase())}`);
  return row ?? null;
}

export async function accountById(env: Env, id: string): Promise<{ uuid: string; handle: string; status: string; display_name: string; dob: string; timezone: string; pfp_url: string; version: number } | null> {
  const [row] = await rowsOf<{ uuid: string; handle: string; status: string; display_name: string; dob: string; timezone: string; pfp_url: string; version: number }>(env,
    `select uuid, handle, status, display_name, dob::text as dob, timezone, pfp_url, version from accounts where handle = ${lit(id)}`);
  return row ?? null;
}

/** Row counts of the tables an import writes (a dry run must leave every one of them as it was). */
export async function writeCounts(env: Env): Promise<Record<string, number>> {
  const [row] = await rowsOf<Record<string, number>>(env, `select
    (select count(*) from accounts) as accounts, (select count(*) from account_emails) as account_emails,
    (select count(*) from account_phones) as account_phones, (select count(*) from memberships) as memberships,
    (select count(*) from handle_history) as handle_history, (select count(*) from handle_reservations) as handle_reservations,
    (select count(*) from identities) as identities, (select coalesce(max(version), 0) + count(*) from accounts) as account_versions`);
  return row ?? {};
}

/** Forgets the app's import budgets (the hourly submissions and daily rows windows passing: time travel). */
export async function forgetImportBudgets(env: Env, appId: string): Promise<void> {
  await psql(env, `delete from rate_limits where bucket in (${lit(`import_submissions:app:${appId}`)}, ${lit(`import_rows:app:${appId}`)})`);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Mock email/SMS                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Messages captured after `after` (to anyone), newest first. */
export async function messagesAfter(env: Env, after: number): Promise<Array<{ to: string; channel: string; subject?: string }>> {
  const { body } = await json<{ items?: Array<{ to: string; channel: string; subject?: string }> }>(`${env.messaging}/_messages?after=${after}&limit=500`);
  return body.items ?? [];
}

export { codeFor, lastSeq };

/* ------------------------------------------------------------------------------------------------------------------ */
/* Preconditions                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** dirty.csv row 40's precondition: the phone number belongs to an account of its own (signed up with it). */
export const PRECONDITION_PHONE = "+12025550142";

/**
 * Makes sure `phone` belongs to an active Carbon with that phone verified: signs a fresh Carbon up with it on the
 * account site (phone code) unless one already has it. Returns the owner.
 */
export async function ensurePhoneOwned(ctx: { env: Env; browser: Browser; results: Results }, phone: string): Promise<{ uuid: string; handle: string | null }> {
  const { env, browser, results } = ctx;
  const existing = await ownerOf(env, phone);
  if (existing && existing.verified && existing.status === "active") return existing;
  const context = await newContext(browser);
  const page = await context.newPage();
  results.watch(page, "imports-precondition");
  await page.goto(`${env.site}/sign-in`);
  await signInWithCode(env, page, { phone });
  const create = page.getByRole("button", { name: "Create account" });
  const home = page.waitForURL(`${env.site}/`, { timeout: 30_000 }).then(() => "home" as const);
  if ((await Promise.race([home, create.waitFor({ timeout: 30_000 }).then(() => "signup" as const)])) === "signup") await create.click();
  await page.waitForURL(`${env.site}/`, { timeout: 30_000 });
  await context.close();
  const owner = await ownerOf(env, phone);
  if (!owner || !owner.verified) throw new Error(`signing up with ${phone} did not leave it on an account (${JSON.stringify(owner)})`);
  return owner;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* CSV with spans, and tagging fixtures                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Cell {
  /** Offsets in the text: [start, end). */
  start: number;
  end: number;
  raw: string;
  /** The value as a CSV reader returns it (quotes removed, "" unescaped; not trimmed). */
  value: string;
  quoted: boolean;
}

/**
 * Splits CSV text into records of cells (RFC 4180: quoted cells may hold commas, quotes and line ends; CR, LF and CRLF
 * end a record). A record that is one empty cell is a blank line and left out, as the server does.
 */
export function csvRecords(text: string): Cell[][] {
  const records: Cell[][] = [];
  const n = text.length;
  let record: Cell[] = [];
  let i = 0;
  for (;;) {
    const start = i;
    let value = "";
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += text[i];
        i++;
      }
    }
    while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
      value += text[i];
      i++;
    }
    record.push({ start, end: i, raw: text.slice(start, i), value, quoted });
    if (i >= n) {
      records.push(record);
      break;
    }
    if (text[i] === ",") {
      i++;
      continue;
    }
    i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
    records.push(record);
    record = [];
    if (i >= n) break;
  }
  return records.filter(cells => !(cells.length === 1 && cells[0]!.value.trim() === ""));
}

export const normalizeColumn = (name: string) => name.replace(/^\uFEFF/, "").trim().toLowerCase();

/** The data rows of a CSV as objects (normalized column → value as read), 1-based like the import's row numbers. */
export function csvRows(text: string): Array<Record<string, string>> {
  const [header, ...data] = csvRecords(text);
  const names = (header ?? []).map(cell => normalizeColumn(cell.value));
  return data.map(cells => Object.fromEntries(names.map((name, index) => [name, cells[index]?.value ?? ""])));
}

/**
 * Rewrites chosen cells and keeps every other byte: `change` gets each data cell (its 1-based data row, its column's
 * normalized name, its value trimmed) and returns a new value or undefined. Unquoted cells keep their padding.
 */
export function rewriteCsv(text: string, change: (row: number, column: string | undefined, value: string) => string | undefined): string {
  const [header, ...data] = csvRecords(text);
  const names = (header ?? []).map(cell => normalizeColumn(cell.value));
  const edits: Array<{ start: number; end: number; raw: string }> = [];
  data.forEach((cells, index) => {
    cells.forEach((cell, position) => {
      const trimmed = cell.value.trim();
      const next = change(index + 1, names[position], trimmed);
      if (next === undefined || next === trimmed) return;
      const raw = cell.quoted ? `"${cell.value.replace(trimmed, next).replace(/"/g, '""')}"` : cell.raw.replace(trimmed, next);
      edits.push({ start: cell.start, end: cell.end, raw });
    });
  });
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.raw + out.slice(edit.end);
  return out;
}

/** Exchanges (the 3 digits after a US area code) already handed out in this process. */
const usedExchanges = new Set<string>();

/**
 * A US exchange no account's phone in these areas uses yet (and not used by another journey of this run), so
 * `+1<area><exchange><line>` numbers are new. Never 555, N11 or the special 950/958/959/976.
 */
export async function freshExchange(env: Env, areas: string[]): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = String(200 + Math.floor(Math.random() * 800));
    if (/^\d11$/.test(candidate) || ["555", "950", "958", "959", "976"].includes(candidate) || usedExchanges.has(candidate)) continue;
    const taken = await scalar(env, `select count(*) from account_phones where ${areas.map(area => `phone like ${lit(`+1${area}${candidate}%`)}`).join(" or ")}`);
    if (taken === "0") {
      usedExchanges.add(candidate);
      return candidate;
    }
  }
  throw new Error("no free US exchange found");
}

/** 555-01xx numbers (any format) with another exchange: `(415) 555-0123` → `(415) 734-0123`. */
export const swapExchange = (value: string, exchange: string) => value.replace(/555([-. ]?)(01\d\d)/g, `${exchange}$1$2`);

/** Emails at legacy-crm.test (any case) move to `<tag>.legacy-crm.test`; every other address stays. */
export const tagEmails = (value: string, t: string) => value.replace(/@(legacy-crm\.test)\b/gi, (_match, domain: string) => `@${t}.${domain}`);

/** Usernames that must stay as written: the seeded ids they collide with, and the invalid or reserved ones. */
const KEEP_USERNAMES = new Set(["saket", "c:saket", "shubham", "c:shubham", "admin", "support", "ab", "this_username_is_much_too_long_for_accounts", "saket_crm"]);

export interface TaggedFixture {
  text: string;
  tag: string;
  exchange: string;
  /** Rows whose username got the tag: row → the username as written in the tagged file. */
  usernames: Map<number, string>;
  /** Rows → external id as written in the tagged file. */
  externalIds: Map<number, string>;
}

/** Tags a username the way it is written (`ADA_L` → `ADA_L_X7K2QZ`, `c:grace_h` → `c:grace_h_x7k2qz`). */
function tagUsername(value: string, t: string): string | undefined {
  if (!/^(c:)?[A-Za-z0-9_]+$/i.test(value) || KEEP_USERNAMES.has(value.toLowerCase())) return undefined;
  const upper = value.replace(/^c:/i, "") === value.replace(/^c:/i, "").toUpperCase() && /[A-Z]/.test(value);
  return `${value}_${upper ? t.toUpperCase() : t}`;
}

/**
 * A tagged copy of a CSV fixture. `keepRows`: data rows left exactly as written (they point at seeded accounts).
 * `extraPhones`: other phone numbers to replace (value → replacement).
 */
export function tagCsv(text: string, t: string, exchange: string, options: { keepRows?: (row: Record<string, string>) => boolean; extraPhones?: Record<string, string> } = {}): TaggedFixture {
  const rows = csvRows(text);
  const usernames = new Map<number, string>();
  const externalIds = new Map<number, string>();
  const tagged = rewriteCsv(text, (row, column, value) => {
    const original = rows[row - 1] ?? {};
    if (options.keepRows?.(original)) return undefined;
    if (!value) return undefined;
    switch (column) {
      case "email":
      case "emails":
        return tagEmails(value, t);
      case "phone":
      case "phones": {
        let next = swapExchange(value, exchange);
        for (const [from, to] of Object.entries(options.extraPhones ?? {})) next = next.split(from).join(to);
        return next;
      }
      case "username": {
        const next = tagUsername(value, t);
        if (next) usernames.set(row, next);
        return next;
      }
      case "external_id": {
        const next = `${value}-${t}`;
        externalIds.set(row, next);
        return next;
      }
      default:
        return undefined;
    }
  });
  return { text: tagged, tag: t, exchange, usernames, externalIds };
}

/**
 * A tagged copy of clean.csv: its 303-555-01xx numbers get a fresh exchange, and its Indian and German mobiles new
 * last four digits (same length, same prefix, so still valid numbers).
 */
export async function taggedClean(env: Env, t: string): Promise<TaggedFixture> {
  const exchange = await freshExchange(env, ["303"]);
  const last4 = String(1000 + Math.floor(Math.random() * 9000));
  return tagCsv(readFileSync(join(FIXTURES, "clean.csv"), "utf8"), t, exchange, {
    extraPhones: { "+919876543210": `+91987654${last4}`, "+4915123456789": `+491512345${last4}` },
  });
}

/** A tagged copy of a JSON fixture's rows (same rules as tagCsv). */
export function tagJsonRows(rows: Array<Record<string, unknown>>, t: string, exchange: string, keepRow: (row: Record<string, unknown>) => boolean): { rows: Array<Record<string, unknown>>; usernames: Map<number, string>; externalIds: Map<number, string> } {
  const usernames = new Map<number, string>();
  const externalIds = new Map<number, string>();
  const mapValue = (value: unknown, f: (s: string) => string): unknown => (typeof value === "string" ? f(value) : Array.isArray(value) ? value.map(item => mapValue(item, f)) : value);
  const out = rows.map((row, index) => {
    if (keepRow(row)) return { ...row };
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const column = key.trim().toLowerCase();
      if (column === "email" || column === "emails") next[key] = mapValue(value, s => tagEmails(s, t));
      else if (column === "phone" || column === "phones") next[key] = mapValue(value, s => swapExchange(s, exchange));
      else if (column === "username" && typeof value === "string") {
        const padded = value.match(/^(\s*)(.*?)(\s*)$/)!;
        const tagged = tagUsername(padded[2]!, t);
        if (tagged) usernames.set(index + 1, tagged);
        next[key] = tagged ? `${padded[1]}${tagged}${padded[3]}` : value;
      } else if (column === "external_id" && typeof value === "string" && value.trim()) {
        const tagged = `${value.trim()}-${t}`;
        externalIds.set(index + 1, tagged);
        next[key] = value.replace(value.trim(), tagged);
      } else next[key] = value;
    }
    return next;
  });
  return { rows: out, usernames, externalIds };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* expected.json                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface ExpectedMessage {
  level: "error" | "warning" | "info";
  code: string;
  field?: string;
  spec_code?: boolean;
}

export interface ExpectedRow {
  row_number: number;
  case: string;
  outcome: RowResult["outcome"];
  id?: string | null;
  id_exact?: boolean;
  matches?: string;
  messages: ExpectedMessage[];
  notes?: string;
  precondition?: string;
}

export interface ExpectedFile {
  file: string;
  options: Record<string, unknown>;
  rows: ExpectedRow[];
  counts: { created: number; matched: number; updated: number; skipped: number; error: number };
}

export function expectedFor(file: string): ExpectedFile {
  const all = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8")) as { files: ExpectedFile[] };
  const found = all.files.find(entry => entry.file === file);
  if (!found) throw new Error(`expected.json has no ${file}`);
  return found;
}

export const VALID_ID = /^c:[a-z0-9_-]{3,30}$/;

/**
 * What differs between a row result and its expectation (empty when it matches). Exact ids are compared with the
 * tagged username (`c:ada_byron` → `c:ada_byron_<tag>`); suggested ids must be valid ids; message codes the spec names
 * must match exactly, the others by level and field (fixtures README).
 */
export function rowProblems(expected: ExpectedRow, got: RowResult | undefined, usernames: Map<number, string>, options: { dryRun?: boolean } = {}): string[] {
  if (!got) return ["no result"];
  const problems: string[] = [];
  if (got.outcome !== expected.outcome) problems.push(`outcome ${got.outcome}, expected ${expected.outcome}`);
  if (expected.outcome === "created") {
    const tagged = usernames.get(expected.row_number);
    const exact = expected.id_exact && expected.id ? (tagged ? `c:${tagged.replace(/^c:/i, "").toLowerCase()}` : expected.id) : null;
    if (exact && got.id !== exact) problems.push(`id ${got.id}, expected ${exact}`);
    if (!VALID_ID.test(got.id ?? "")) problems.push(`invalid id ${got.id}`);
    if (!options.dryRun && !got.account_uuid) problems.push("no account_uuid");
  }
  if (expected.outcome === "matched" && expected.matches) {
    if (options.dryRun) {
      if (got.id !== null || got.account_uuid !== null) problems.push(`a dry run names the matched account (${got.id} ${got.account_uuid})`);
    } else if (got.id !== expected.matches) problems.push(`matched ${got.id}, expected ${expected.matches}`);
  }
  if (expected.outcome === "error" || expected.outcome === "skipped") {
    if (got.account_uuid) problems.push(`an ${expected.outcome} row names account ${got.account_uuid}`);
  }
  for (const message of expected.messages) {
    const hit = got.messages.find(m => (message.spec_code ? m.code === message.code : true) && m.level === message.level && (!message.field || m.field === message.field));
    if (!hit) problems.push(`no ${message.level} ${message.code}${message.field ? ` (${message.field})` : ""}`);
  }
  if (expected.outcome === "error" && !got.messages.some(m => m.level === "error")) problems.push("an error row without an error message");
  if (expected.outcome !== "error" && got.messages.some(m => m.level === "error")) problems.push(`error messages on a ${got.outcome} row`);
  for (const m of got.messages) if (!m.message || m.message.length < 10) problems.push(`message ${m.code} says nothing ("${m.message}")`);
  return problems;
}

export const describeRow = (row: RowResult | undefined) =>
  row ? `${row.outcome} ${row.id ?? ""} [${row.messages.map(m => `${m.level} ${m.code}${m.field ? `(${m.field})` : ""}: ${m.message}`).join(" | ")}]` : "missing";

/** Today's date in UTC minus 18 years (Feb 29 → Feb 28): the dob a new account gets by default. */
export function defaultDob(now = new Date()): string {
  const year = now.getUTCFullYear() - 18;
  const month = now.getUTCMonth() + 1;
  let day = now.getUTCDate();
  if (month === 2 && day === 29) day = 28;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A display name as the importer cleans it: control characters and runs of whitespace become one space, trimmed. */
export const cleanName = (raw: string) => raw.replace(/[\s\p{Cc}]+/gu, " ").trim();

/* ------------------------------------------------------------------------------------------------------------------ */
/* Raw uploads: no Expect, chunked, slow                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface RawAnswer {
  /** 0 when the connection broke before any answer (then `error` says how). */
  status: number;
  text: string;
  headers: IncomingHttpHeaders;
  ms: number;
  /** Bytes of the body handed to the socket before the answer (or the break). */
  wrote: number;
  error?: string;
}

/**
 * POSTs `body` the way fetch, browsers, proxies and the CLI do: no `Expect: 100-continue`, the body written right after
 * the headers (1 MB at a time, following backpressure), with a Content-Length, or chunked when `chunked` (no length
 * declared, so only the body stream can be refused). Resolves with the first answer; a connection that broke before
 * any answer resolves with status 0 and the socket error (ECONNRESET, EPIPE…), never a throw.
 */
export function postPlain(url: string, headers: Record<string, string>, body: Buffer, options: { chunked?: boolean; timeoutMs?: number } = {}): Promise<RawAnswer> {
  return new Promise(done => {
    const target = new URL(url);
    const started = Date.now();
    let wrote = 0;
    let settled = false;
    const finish = (answer: Omit<RawAnswer, "ms" | "wrote">) => {
      if (settled) return;
      settled = true;
      done({ ...answer, ms: Date.now() - started, wrote });
    };
    const head: Record<string, string> = { ...headers };
    if (options.chunked) head["transfer-encoding"] = "chunked";
    else head["content-length"] = String(body.length);
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: "POST", headers: head });
    req.on("socket", socket => socket.on("error", () => undefined));
    req.setTimeout(options.timeoutMs ?? 120_000, () => req.destroy(new Error("no answer within the timeout")));
    req.on("response", response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => (text += chunk));
      const end = () => finish({ status: response.statusCode ?? 0, text, headers: response.headers });
      response.on("end", end);
      response.on("error", end);
      response.on("close", end);
    });
    req.on("error", error => finish({ status: 0, text: "", headers: {}, error: `${(error as NodeJS.ErrnoException).code ?? "error"}: ${error.message}` }));
    const step = 1024 * 1024;
    const pump = () => {
      while (wrote < body.length && !settled) {
        const piece = body.subarray(wrote, Math.min(body.length, wrote + step));
        wrote += piece.length;
        if (!req.write(piece)) {
          req.once("drain", pump);
          return;
        }
      }
      if (wrote >= body.length) req.end();
    };
    pump();
  });
}

/**
 * An upload that declares `declaredBytes` and then trickles: `bytesPerTick` every `tickMs`. It holds whatever the
 * server gives a request while it reads the body (an import slot) until `abort()` (the connection is destroyed, as a
 * client that went away). `answered` resolves when the server answers (or the connection breaks).
 */
export function postTrickle(url: string, headers: Record<string, string>, declaredBytes: number, options: { tickMs?: number; bytesPerTick?: number } = {}): { answered: Promise<RawAnswer>; abort: () => void } {
  const target = new URL(url);
  const started = Date.now();
  let wrote = 0;
  let timer: NodeJS.Timeout | null = null;
  let settle: (answer: RawAnswer) => void = () => undefined;
  const answered = new Promise<RawAnswer>(done => (settle = done));
  let settled = false;
  const finish = (answer: Omit<RawAnswer, "ms" | "wrote">) => {
    if (timer) clearInterval(timer);
    if (settled) return;
    settled = true;
    settle({ ...answer, ms: Date.now() - started, wrote });
  };
  const req = httpRequest({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: "POST", headers: { ...headers, "content-length": String(declaredBytes) } });
  req.on("socket", socket => socket.on("error", () => undefined));
  req.on("response", response => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", chunk => (text += chunk));
    response.on("end", () => finish({ status: response.statusCode ?? 0, text, headers: response.headers }));
    response.on("error", () => finish({ status: response.statusCode ?? 0, text, headers: response.headers }));
  });
  req.on("error", error => finish({ status: 0, text: "", headers: {}, error: `${(error as NodeJS.ErrnoException).code ?? "error"}: ${error.message}` }));
  req.flushHeaders();
  const bytesPerTick = options.bytesPerTick ?? 16;
  timer = setInterval(() => {
    if (settled || wrote + bytesPerTick >= declaredBytes) return;
    req.write(Buffer.alloc(bytesPerTick, 0x61));
    wrote += bytesPerTick;
  }, options.tickMs ?? 1000);
  return {
    answered,
    abort: () => {
      if (timer) clearInterval(timer);
      req.destroy();
      finish({ status: 0, text: "", headers: {}, error: "aborted by the test" });
    },
  };
}

/** The error object of a raw answer body, or null when it is not a Silicon Accounts error (a proxy's own page). */
export function errorOfText(text: string): ApiErrorBody["error"] | null {
  try {
    return (JSON.parse(text) as ApiErrorBody).error ?? null;
  } catch {
    return null;
  }
}

/** `413 payload_too_large` in a raw answer, else what came back instead. */
export function describeRaw(answer: RawAnswer): string {
  const error = errorOfText(answer.text);
  if (answer.status === 0) return `no answer (${answer.error}) after ${answer.ms} ms, ${answer.wrote} bytes written`;
  return `${answer.status} ${error?.code ?? answer.text.replace(/\s+/g, " ").slice(0, 80)} after ${answer.ms} ms`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The CLI with a binary stdin and its own environment, and the stack's API log                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Runs the `silicon-accounts` CLI like lib's cli(), but `stdin` may be a Buffer (a file piped in) and `extraEnv` is added to
 * its environment (ACCOUNTS_APP_ID / ACCOUNTS_APP_SECRET, so stdin stays free for the file). A CLI that stops reading
 * stdin early (it refused the input) is fine: the broken pipe is ignored.
 */
export function cliRaw(env: Env, home: string, args: string[], options: { stdin?: Buffer | string; extraEnv?: Record<string, string> } = {}): Promise<CliRun> {
  return new Promise(done => {
    const started = Date.now();
    const child = spawn(env.cli, ["--url", env.site, "--home", home, ...args], { env: { ...process.env, NO_COLOR: "1", ...options.extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
    child.on("close", code => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      done({ code, stdout, stderr, ms: Date.now() - started, json: parsed });
    });
  });
}

/** The stack's accounts-api log (scripts/dev.sh writes .dev/logs/<base>/accounts-api.log), or null when absent. */
export function apiLogPath(env: Env): string {
  return join(ROOT, ".dev", "logs", String(env.base), "accounts-api.log");
}

/** How many lines of the stack's accounts-api log match `pattern` (null when the log isn't there). */
export function countApiLog(env: Env, pattern: RegExp): number | null {
  const path = apiLogPath(env);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").split("\n").filter(line => pattern.test(line)).length;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A second accounts-api on the same database (another API node), for worker failure modes                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Instance {
  /** http://127.0.0.1:<port> */
  url: string;
  port: number;
  pid: number;
  logPath: string;
  /** SIGKILL, as a crash or an OOM kill would: no shutdown, no cleanup. Resolves once it is gone. */
  kill(): Promise<void>;
  alive(): boolean;
}

const instances = new Set<ChildProcess>();
// A journey that throws must never leave a second API node running behind the stack.
process.once("exit", () => {
  for (const child of instances) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

function portBusy(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

/**
 * Starts another accounts-api process on the stack's own database with the stack's own environment
 * (.dev/run/<base>/accounts-api.env, written by scripts/dev.sh) on a free port between base+5 and base+8 (the gap
 * between two stacks' bases), with its own import worker, as a second API node in production would be. Its log goes
 * to .dev/logs/<base>/accounts-api-<label>.log, which scripts/e2e.sh copies into the artifacts.
 */
export async function startInstance(env: Env, label: string): Promise<Instance> {
  const envFile = join(ROOT, ".dev", "run", String(env.base), "accounts-api.env");
  const bin = join(dirname(env.cli), "accounts-api");
  if (!existsSync(envFile)) throw new Error(`${envFile} is missing: the stack must have been started by scripts/dev.sh (scripts/e2e.sh)`);
  if (!existsSync(bin)) throw new Error(`${bin} is missing (E2E_CLI points at ${env.cli})`);
  let port = 0;
  for (let offset = 5; offset <= 8; offset++) {
    if (!(await portBusy(env.base + offset))) {
      port = env.base + offset;
      break;
    }
  }
  if (!port) throw new Error(`ports ${env.base + 5}–${env.base + 8} are all in use`);
  const logDir = join(ROOT, ".dev", "logs", String(env.base));
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `accounts-api-${label}.log`);
  const fd = openSync(logPath, "w");
  const child = spawn("bash", ["-c", 'set -a; . "$1"; set +a; export ACCOUNTS_BIND_ADDR="127.0.0.1:$3"; exec "$2"', `accounts-api-${label}`, envFile, bin, String(port)], { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  instances.add(child);
  let exited = false;
  const gone = new Promise<void>(done => child.once("exit", () => {
    exited = true;
    instances.delete(child);
    done();
  }));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited) throw new Error(`the second accounts-api exited during start-up (log: ${logPath})`);
    const ready = await fetch(`${url}/readyz`).then(answer => answer.status === 200, () => false);
    if (ready) break;
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`the second accounts-api was not ready within 90 s (log: ${logPath})`);
    }
    await sleep(250);
  }
  return {
    url,
    port,
    pid: child.pid ?? 0,
    logPath,
    alive: () => !exited,
    kill: async () => {
      if (!exited) child.kill("SIGKILL");
      await gone;
    },
  };
}

/** The pid of the process listening on `port` (lsof), or null. */
export function listenerPid(port: number): Promise<number | null> {
  return new Promise(done => {
    execFile("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], (_error, stdout) => {
      const pid = Number(stdout.trim().split("\n")[0]);
      done(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

/** Local ports of `pid`'s TCP connections to the database (lsof), to tell which process a backend serves. */
export function databasePortsOf(pid: number, dbPort = 5444): Promise<Set<number>> {
  return new Promise(done => {
    execFile("lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${dbPort}`, "-F", "n"], (_error, stdout) => {
      const ports = new Set<number>();
      for (const line of stdout.split("\n")) {
        const match = /^n(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)->/.exec(line);
        if (match) ports.add(Number(match[1]));
      }
      done(ports);
    });
  });
}

/**
 * The client port of the database session that holds an import job's worker lock (the session-level advisory lock
 * `hashtextextended('import_job:' || id, 0)`, see crates/apps/src/imports/worker.rs), or null when nobody holds it.
 */
export async function jobLockPort(env: Env, jobId: string): Promise<number | null> {
  const out = await psql(env, `select a.client_port from pg_locks l join pg_stat_activity a on a.pid = l.pid
    where l.locktype = 'advisory' and l.granted and l.objsubid = 1 and l.database = (select oid from pg_database where datname = current_database())
      and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('import_job:' || ${lit(jobId)}, 0) limit 1`);
  const port = Number(out.trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** Which process works on a job right now: its pid (from the lock's session), or null when no one does. */
export async function jobWorkerPid(env: Env, jobId: string, candidates: number[]): Promise<number | null> {
  const port = await jobLockPort(env, jobId);
  if (port === null) return null;
  for (const pid of candidates) if ((await databasePortsOf(pid)).has(port)) return pid;
  return null;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Hosted flows and one-off imports                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface FlowView {
  step?: string;
  app?: { app_id?: string; name?: string };
  signup?: {
    finishing_import?: boolean;
    imported_by?: { app_id: string; name: string } | null;
    id?: string;
    display_name?: string;
    timezone?: string;
    dob?: string;
    email?: string | null;
    phone?: string | null;
  };
}

/** The hosted flow's own view (GET /v1/flows/{id}) of the page's current flow, read with the page's cookies. */
export async function flowView(page: import("@playwright/test").Page): Promise<FlowView | null> {
  const id = /\/authorize\/flow\/([^/?#]+)/.exec(page.url())?.[1];
  if (!id) return null;
  const view: unknown = await page.evaluate(async flow => ((await (await fetch(`/v1/flows/${flow}`)).json()) as { flow?: unknown }).flow ?? null, id);
  return (view ?? null) as FlowView | null;
}

/** Imports `rows` as JSON (a fresh Idempotency-Key), waits for the job and returns it with its row results. */
export async function importRows(ctx: Caller, app: FakeApp, rows: Array<Record<string, unknown>>, options: Record<string, unknown> = {}): Promise<{ job: ImportJob; rows: RowResult[] }> {
  const answer = await postJson(ctx, app, { rows, options }, { key: crypto.randomUUID() });
  if (!answer.body.job) throw new Error(`the import was refused: ${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`);
  const job = await waitJob(ctx, app, answer.body.job.id);
  return { job, rows: await allRows(ctx, app, job.id) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The hosted pages: an email code on an app that may open on its phone field                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * lib's signInWithCode for an email, on an app whose methods page may open on its phone field first (dm's order is
 * phone, email): picks "Email" in the "Email | Phone" choice when the email field isn't the one shown.
 */
export async function signInWithEmailCode(env: Env, page: Page, email: string): Promise<string> {
  await page.getByRole("textbox", { name: /^(Email|Phone number)$/ }).first().waitFor({ timeout: 30_000 });
  const field = page.getByRole("textbox", { name: "Email" });
  if (!(await field.isVisible().catch(() => false))) await page.getByRole("button", { name: "Email", exact: true }).click({ timeout: 10_000 });
  return signInWithCode(env, page, { email });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The developer site (developers.teamofsilicons.com: a BFF in front of the API)                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * A browser context signed in to the developer site as `email` (lib's signInOnDeveloper: the account site's hosted
 * sign-in as the app `developer`, the code exchanged by the developer site's server), its page on `returnTo`, watched
 * with the developer site's signed-out probe allowed (and `expected`).
 */
export async function developerSession(ctx: { env: Env; browser: Browser; results: Results }, email: string, label: string, options: { returnTo?: string; expected?: RegExp[] } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newContext(ctx.browser);
  const page = await context.newPage();
  ctx.results.watch(page, label, [DEVELOPER_SIGNED_OUT, ...(options.expected ?? [])]);
  await signInOnDeveloper(ctx.env, page, email, { returnTo: options.returnTo ?? "/" });
  return { context, page };
}

export interface DeveloperAnswer<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string>;
  ms: number;
}

/**
 * A raw call to the developer site's BFF (`{developer}/api/accounts<path>` → accounts-api `/v1<path>`) with the
 * context's sealed session cookie: any body (CSV text, a 51 MB buffer…), any content type, and the Origin the caller
 * chooses (default: the developer site's own; null: none). lib's developerApi only sends JSON.
 */
export async function developerFetch<T = unknown>(env: Env, page: Page, path: string, init: { method?: string; body?: string | Buffer; contentType?: string | null; origin?: string | null; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<DeveloperAnswer<T>> {
  const headers: Record<string, string> = { ...init.headers };
  const origin = init.origin === undefined ? env.developer : init.origin;
  if (origin) headers.origin = origin;
  if (init.body !== undefined && init.contentType !== null) headers["content-type"] = init.contentType ?? "text/csv";
  const started = Date.now();
  const response = await page.request.fetch(`${env.developer}/api/accounts${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    ...(init.body === undefined ? {} : { data: init.body }),
    timeout: init.timeoutMs ?? 120_000,
    maxRedirects: 0,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: keep the text.
  }
  return { status: response.status(), body: body as T, headers: response.headers(), ms: Date.now() - started };
}

/** Polls a job through the developer site's BFF until it is completed or failed. */
export async function waitJobViaDeveloper(env: Env, page: Page, appId: string, jobId: string, timeoutMs = 120_000): Promise<ImportJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await developerFetch<{ job?: ImportJob }>(env, page, `/apps/${appId}/imports/${jobId}`);
    const job = answer.body?.job;
    if (answer.status !== 200 || !job) throw new Error(`GET import ${jobId} through the developer site: ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
    if (job.status === "completed" || job.status === "failed") return job;
    if (Date.now() > deadline) throw new Error(`import ${jobId} is still ${job.status} after ${timeoutMs} ms`);
    await sleep(200);
  }
}

/** The text of a page region, whitespace collapsed. */
export const textOf = async (page: Page, selector = "main") => (await page.locator(selector).first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();

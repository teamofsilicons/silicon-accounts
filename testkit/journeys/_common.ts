// Shared helpers for the journeys: non-browser walks through a running Silicon Accounts stack
// (scripts/dev.sh or scripts/journeys.sh) with the testkit helpers and the real `silicon-accounts` CLI.
//
// Environment (defaults = scripts/dev.sh's ports):
//   ACCOUNTS_URL         where these calls go: accounts-api   (http://127.0.0.1:8589), or the public
//                        site/proxy in front of it (scripts/journeys.sh --proxy / --next)
//   ACCOUNTS_PUBLIC_URL  browser-facing URL (CLI --url)       (/v1/meta public_url)
//   MOCK_OIDC_URL / MOCK_MESSAGING_URL / FAKE_APPS_URL       (127.0.0.1:8591 / 8592 / 8593)
//   ACCOUNTS_CLI         the `silicon-accounts` binary                ($CARGO_TARGET_DIR or target)/debug/silicon-accounts
//   TESTKIT_FORWARDED_FOR=random  per-process X-Forwarded-For (needs ACCOUNTS_TRUST_FORWARDED_FOR=true)

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AccountsClient,
  CookieJar,
  FakeAppsClient,
  MockMessagingClient,
  MockOidcClient,
  type BrowserSession,
  type CreateFlowParams,
  type FlowView,
} from '../lib/index.ts';

export * from '../lib/index.ts';

export const accounts = new AccountsClient(process.env.ACCOUNTS_URL ?? 'http://127.0.0.1:8589');
export const messaging = new MockMessagingClient(process.env.MOCK_MESSAGING_URL ?? 'http://127.0.0.1:8592');
export const oidc = new MockOidcClient(process.env.MOCK_OIDC_URL ?? 'http://127.0.0.1:8591');
export const fakeAppsUrl = process.env.FAKE_APPS_URL ?? 'http://127.0.0.1:8593';

let failures = 0;
let checks = 0;

/** Records one expectation; failures are listed and make the journey exit 1. */
export function check(cond: unknown, msg: string, extra?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${msg}`);
    return;
  }
  failures++;
  let detail = '';
  if (extra !== undefined) {
    try {
      detail = ` :: ${(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 1500)}`;
    } catch {
      detail = ` :: ${String(extra)}`;
    }
  }
  console.log(`  FAIL ${msg}${detail}`);
}

export function section(name: string): void {
  console.log(`\n== ${name}`);
}

/** Ends the journey: prints the tally and sets the exit code. */
export function done(): void {
  console.log(failures ? `\n${failures} of ${checks} check(s) FAILED` : `\nall ${checks} checks passed`);
  process.exitCode = failures ? 1 : 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short random tag for ids and webhook sink keys. */
export function rid(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** A browser stand-in at Silicon Accounts with its own cookie jar. */
export function newBrowser(): Promise<BrowserSession> {
  return accounts.browser(new CookieJar());
}

/** Turns a fake app's hosted /authorize URL into the POST /v1/flows body the sign-in pages send. */
export function flowParamsFromAuthorizeUrl(authorizeUrl: string): CreateFlowParams {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(authorizeUrl).searchParams) out[k] = v;
  if (!out.app_id && out.client_id) out.app_id = out.client_id;
  delete out.client_id;
  delete out.response_type;
  out.timezone ??= 'Asia/Kolkata';
  return out as unknown as CreateFlowParams;
}

/** Starts a fake app's hosted sign-in (its own cookie jar holds state + PKCE) in `browser`. */
export async function startAppSignIn(appId: string, browser: BrowserSession, params: Record<string, string> = {}) {
  const fake = new FakeAppsClient(fakeAppsUrl, new CookieJar());
  const az = await fake.authorizeUrl(appId, params);
  const flow = await browser.createFlow(flowParamsFromAuthorizeUrl(az.authorize_url));
  return { fake, az, flow };
}

/** Sends an email/phone code in the flow, reads it from mock-messaging and verifies it. */
export async function codeStep(browser: BrowserSession, flow: FlowView, contact: { email: string } | { phone: string; country?: string }): Promise<FlowView> {
  const to = 'email' in contact ? contact.email : contact.phone;
  const after = await messaging.lastSeq();
  const sent = 'email' in contact ? await browser.email(flow.id, contact.email) : await browser.phone(flow.id, contact.phone, contact.country);
  const code = await messaging.waitForCode({ to, after });
  return browser.verify(sent.id, code);
}

/** The code from a flow's final redirect_to. */
export function codeFrom(flow: FlowView): string {
  const code = new URL(flow.redirect_to ?? 'http://x/').searchParams.get('code');
  if (!code) throw new Error(`Flow ${flow.id} ended without a code: ${flow.redirect_to}`);
  return code;
}

// ------------------------------------------------------------------ the real CLI

const REPO = fileURLToPath(new URL('../../', import.meta.url));

function cliBinary(): string {
  if (process.env.ACCOUNTS_CLI) return process.env.ACCOUNTS_CLI;
  const target = process.env.CARGO_TARGET_DIR ? (process.env.CARGO_TARGET_DIR.startsWith('/') ? process.env.CARGO_TARGET_DIR : join(REPO, process.env.CARGO_TARGET_DIR)) : join(REPO, 'target');
  return join(target, 'debug', 'silicon-accounts');
}

export const CLI = cliBinary();
if (!existsSync(CLI)) {
  console.error(`error: the silicon-accounts CLI is not at ${CLI}\nhint: build it (cargo build -p silicon-accounts-cli) or set ACCOUNTS_CLI`);
  process.exit(2);
}

let publicUrlCache: string | null = process.env.ACCOUNTS_PUBLIC_URL ?? null;
async function publicUrl(): Promise<string> {
  publicUrlCache ??= await accounts.publicUrl();
  return publicUrlCache;
}

const homes: string[] = [];
process.on('exit', () => {
  // CLI homes hold (dev-only) sessions and app secrets: remove them unless asked to keep them.
  if (process.env.JOURNEYS_KEEP_HOMES === '1') return;
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** A fresh, empty CLI home (`--home`), deleted when the journey ends (JOURNEYS_KEEP_HOMES=1 keeps it). */
export function newHome(tag: string): string {
  const home = mkdtempSync(join(tmpdir(), `accounts-journey-${tag}-`));
  homes.push(home);
  return home;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON (null when it isn't). */
  json: any;
  ms: number;
}

/** Starts `silicon-accounts --url <public> --home <home> …args` and returns the child and its result. */
export async function cliSpawn(home: string, args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const url = await publicUrl();
  const child = spawn(CLI, ['--url', url, '--home', home, ...args], {
    env: { ...process.env, ACCOUNTS_TELEMETRY: '0', ACCOUNTS_NO_BROWSER: '1', ...(opts.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(opts.stdin ?? '');
  const started = performance.now();
  const done = new Promise<CliResult>((resolve) => {
    child.on('close', (code) => {
      let json: any = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json, ms: Math.round(performance.now() - started) });
    });
  });
  return { child, done, stderrSoFar: () => stderr, stdoutSoFar: () => stdout };
}

export async function cli(home: string, args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<CliResult> {
  return (await cliSpawn(home, args, opts)).done;
}

export function show(r: CliResult): string {
  return `exit=${r.code} stdout=${r.stdout.slice(0, 700)} stderr=${r.stderr.slice(0, 500)}`;
}

/** Runs a CLI command with --json and checks it. */
export async function run(desc: string, home: string, args: string[], expect: (r: CliResult) => boolean = (r) => r.code === 0, opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<CliResult> {
  const r = await cli(home, [...args, '--json'], opts);
  check(expect(r), `${desc}  [accounts ${args.join(' ')}]`, show(r));
  return r;
}

/** Signs a Carbon in on the CLI with an email code (two non-interactive steps). */
export async function cliLoginEmail(home: string, email: string): Promise<CliResult> {
  const seq = await messaging.lastSeq();
  await run('login --email (code sent)', home, ['login', '--email', email], (r) => r.code === 0 && r.json?.status === 'code_sent');
  const code = await messaging.waitForCode({ to: email, after: seq });
  return run('login --email --code', home, ['login', '--email', email, '--code', code], (r) => r.code === 0 && r.json?.authenticated === true);
}

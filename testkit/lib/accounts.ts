// Helpers that talk to Silicon Accounts the way apps, browsers and the CLI do, for e2e
// tests that run without a real browser:
//
//   const accounts = new AccountsClient();                       // $ACCOUNTS_URL
//   const messaging = new MockMessagingClient();                  // $MOCK_MESSAGING_URL
//   const signIn = await signInWithCode({ accounts, messaging, appId: 'briefcase', email: randomEmail() });
//   const tokens = await accounts.app('briefcase').exchangeCode(signIn.code!, signIn.redirectUri, signIn.codeVerifier!);
//
// Methods that return bodies throw HttpExpectationError (with .response) on an unexpected
// status; use `.request()` to assert on error responses yourself.

import { randomUUID } from 'node:crypto';
import { fakeApp, redirectUri as fakeRedirectUri } from './fake-apps.ts';
import { CookieJar, expectStatus, HttpClient, HttpExpectationError, type HttpResponse, type RequestOptions } from './http.ts';
import { MockMessagingClient, MockOidcClient, randomEmail, randomPhone, type Provider } from './mocks.ts';
import { createPkcePair, randomNonce, randomState } from './pkce.ts';
import type {
  AccountSummary,
  FlowView,
  ImportJob,
  ImportOptions,
  ImportRow,
  ImportRowResult,
  Meta,
  OAuthErrorBody,
  Page,
  ProofIssued,
  ProofVerification,
  TokenResponse,
} from './types.ts';

/** accounts-api in a local stack (scripts/dev.sh); the public site on :8590 proxies to it too. */
export const DEFAULT_ACCOUNTS_URL = 'http://127.0.0.1:8589';

/** An RFC 6749 error from /v1/oauth/token (or revoke/introspect). */
export class OAuthError extends Error {
  readonly status: number;
  readonly error: string;
  readonly errorDescription: string | null;
  readonly response: HttpResponse;
  constructor(response: HttpResponse) {
    const body = (response.body ?? {}) as Partial<OAuthErrorBody>;
    const error = typeof body.error === 'string' ? body.error : `http_${response.status}`;
    super(`${response.method} ${response.url} failed with ${error}${body.error_description ? `: ${body.error_description}` : ''} (HTTP ${response.status})`);
    this.name = 'OAuthError';
    this.status = response.status;
    this.error = error;
    this.errorDescription = body.error_description ?? null;
    this.response = response;
  }
}

function tokenOrThrow(res: HttpResponse<unknown>): TokenResponse {
  if (res.status !== 200) throw new OAuthError(res as HttpResponse);
  return res.body as TokenResponse;
}

export interface AccountsClientOptions {
  /** Extra headers on every request this client (and its browsers, sessions and apps) sends. */
  headers?: Record<string, string>;
  /**
   * Sends `X-Forwarded-For: <ip>` so Silicon Accounts (run with ACCOUNTS_TRUST_FORWARDED_FOR=true)
   * counts its per-network limits (e.g. 30 codes per 10 minutes) per test instead of for all of
   * 127.0.0.1. `'random'` picks a private address for this client. Default: $TESTKIT_FORWARDED_FOR.
   */
  forwardedFor?: string | null;
}

/** A random address in 10.0.0.0/8 (for X-Forwarded-For in tests). */
export function randomPrivateIp(): string {
  const b = randomUUID().replaceAll('-', '');
  return `10.${parseInt(b.slice(0, 2), 16)}.${parseInt(b.slice(2, 4), 16)}.${(parseInt(b.slice(4, 6), 16) % 254) + 1}`;
}

export class AccountsClient {
  readonly url: string;
  readonly http: HttpClient;
  /** Headers every request carries (see AccountsClientOptions). */
  readonly headers: Record<string, string>;
  private metaCache: Meta | null = null;

  constructor(url: string = process.env.ACCOUNTS_URL ?? DEFAULT_ACCOUNTS_URL, options: AccountsClientOptions = {}) {
    this.url = url.replace(/\/+$/, '');
    const forwardedFor = options.forwardedFor === undefined ? (process.env.TESTKIT_FORWARDED_FOR ?? null) : options.forwardedFor;
    this.headers = {
      ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor === 'random' ? randomPrivateIp() : forwardedFor } : {}),
      ...options.headers,
    };
    this.http = new HttpClient({ baseUrl: this.url, headers: this.headers });
  }

  /** Polls /readyz until Silicon Accounts answers 200. */
  async waitUntilReady(options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    let last = 'no answer yet';
    while (Date.now() < deadline) {
      try {
        const res = await this.http.get('/readyz', { timeoutMs: 2_000 });
        if (res.status === 200) return;
        last = `HTTP ${res.status} ${res.text.slice(0, 200)}`;
      } catch (error) {
        last = (error as Error).message;
      }
      await new Promise((r) => setTimeout(r, options.intervalMs ?? 250));
    }
    throw new Error(`Silicon Accounts at ${this.url} was not ready within ${options.timeoutMs ?? 60_000} ms (last: ${last}).`);
  }

  async meta(refresh = false): Promise<Meta> {
    if (!refresh && this.metaCache) return this.metaCache;
    this.metaCache = expectStatus(await this.http.get<Meta>('/v1/meta'), 200).body;
    return this.metaCache;
  }

  /** Browser-facing origin (ACCOUNTS_PUBLIC_URL) as reported by /v1/meta. */
  async publicUrl(): Promise<string> {
    return (await this.meta()).public_url.replace(/\/+$/, '');
  }

  /** Rewrites a URL on the public origin onto the server URL this client talks to. */
  async toServerUrl(url: string): Promise<string> {
    const publicUrl = await this.publicUrl();
    return url.startsWith(publicUrl) ? `${this.url}${url.slice(publicUrl.length)}` : url;
  }

  async discovery(): Promise<Record<string, unknown>> {
    return expectStatus(await this.http.get<Record<string, unknown>>('/.well-known/openid-configuration'), 200).body;
  }

  async jwks(): Promise<{ keys: Array<Record<string, unknown>> }> {
    return expectStatus(await this.http.get<{ keys: Array<Record<string, unknown>> }>('/.well-known/jwks.json'), 200).body;
  }

  async idAvailable(id: string): Promise<{ id: string; available: boolean; reason: string | null; message: string; reclaimable: boolean }> {
    return expectStatus(await this.http.get<{ id: string; available: boolean; reason: string | null; message: string; reclaimable: boolean }>('/v1/ids/available', { query: { id } }), 200).body;
  }

  /** Calls as an app (HTTP Basic app_id:secret). The secret defaults to the fake app's fixed one. */
  app(appId: string, secret?: string): AppApi {
    return new AppApi(this, appId, secret ?? fakeApp(appId).secret);
  }

  /** A browser stand-in (cookie jar + Origin header) for the hosted flow and the account site. */
  async browser(jar: CookieJar = new CookieJar()): Promise<BrowserSession> {
    return new BrowserSession(this, await this.publicUrl(), jar);
  }

  /** A first-party session from an access token with aud=accounts (CLI / Silicon login). */
  withToken(accessToken: string): AccountSession {
    return new AccountSession(new HttpClient({ baseUrl: this.url, headers: { ...this.headers, Authorization: `Bearer ${accessToken}` } }));
  }

  async siliconLogin(id: string, stk: string, clientLabel?: string): Promise<TokenResponse> {
    const res = await this.http.post('/v1/silicons/login', { json: { id, stk, ...(clientLabel ? { client_label: clientLabel } : {}) } });
    if (res.status !== 200) throw new HttpExpectationError(res, '200');
    return res.body as TokenResponse;
  }

  /** POST /v1/silicons — a Silicon creates its own account naming a custodian. */
  async siliconSelfCreate(body: Record<string, unknown>, idempotencyKey: string = randomUUID()): Promise<HttpResponse<Record<string, unknown>>> {
    return this.http.post<Record<string, unknown>>('/v1/silicons', { json: body, idempotencyKey });
  }

  async siliconRequestStatus(requestId: string, requestToken: string): Promise<HttpResponse<Record<string, unknown>>> {
    return this.http.get<Record<string, unknown>>(`/v1/silicons/requests/${encodeURIComponent(requestId)}`, { bearer: requestToken });
  }

  async cliLoginStart(contact: { email: string } | { phone: string; country?: string }): Promise<{ challenge_id: string; destination: string; expires_at: string }> {
    return expectStatus(await this.http.post<{ challenge_id: string; destination: string; expires_at: string }>('/v1/cli/login/start', { json: contact }), [200, 201]).body;
  }

  async cliLoginVerify(challengeId: string, code: string, clientLabel = 'testkit'): Promise<TokenResponse> {
    return tokenOrThrow(await this.http.post('/v1/cli/login/verify', { json: { challenge_id: challengeId, code, client_label: clientLabel } }));
  }

  /** Signs an existing Carbon in headlessly (code login) and returns a first-party session. */
  async cliLogin(messaging: MockMessagingClient, contact: { email: string } | { phone: string; country?: string }): Promise<{ tokens: TokenResponse; session: AccountSession }> {
    const after = await messaging.lastSeq();
    const challenge = await this.cliLoginStart(contact);
    const code = await messaging.waitForCode({ to: 'email' in contact ? contact.email : contact.phone, after });
    const tokens = await this.cliLoginVerify(challenge.challenge_id, code);
    return { tokens, session: this.withToken(tokens.access_token) };
  }

  /** The dev outbox (only when ACCOUNTS_EXPOSE_DEV_OUTBOX=true). */
  async devOutbox(query: { to?: string; purpose?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
    return expectStatus(await this.http.get<{ items: Array<Record<string, unknown>> }>('/v1/dev/outbox', { query }), 200).body.items;
  }
}

/** Calls made with an app's own credentials. */
export class AppApi {
  readonly accounts: AccountsClient;
  readonly appId: string;
  readonly secret: string;

  constructor(accounts: AccountsClient, appId: string, secret: string) {
    this.accounts = accounts;
    this.appId = appId;
    this.secret = secret;
  }

  /** Any request authenticated as this app; returns the raw response. */
  request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.accounts.http.request<T>(method, path, { basic: [this.appId, this.secret], ...options });
  }

  private path(suffix = ''): string {
    return `/v1/apps/${encodeURIComponent(this.appId)}${suffix}`;
  }

  // -- tokens

  tokenRaw(form: Record<string, string>): Promise<HttpResponse<TokenResponse | OAuthErrorBody>> {
    return this.request<TokenResponse | OAuthErrorBody>('POST', '/v1/oauth/token', { form });
  }

  async exchangeCode(code: string, redirectUri: string, codeVerifier?: string | null): Promise<TokenResponse> {
    return tokenOrThrow(await this.tokenRaw({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }));
  }

  async exchangeSlt(slt: string): Promise<TokenResponse> {
    return tokenOrThrow(await this.tokenRaw({ grant_type: 'urn:silicon:params:oauth:grant-type:slt', slt }));
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    return tokenOrThrow(await this.tokenRaw({ grant_type: 'refresh_token', refresh_token: refreshToken }));
  }

  revoke(token: string): Promise<HttpResponse> {
    return this.request('POST', '/v1/oauth/revoke', { form: { token } });
  }

  async introspect(token: string): Promise<Record<string, unknown>> {
    return expectStatus(await this.request<Record<string, unknown>>('POST', '/v1/oauth/introspect', { form: { token } }), 200).body;
  }

  userinfo(accessToken: string): Promise<HttpResponse<Record<string, unknown>>> {
    return this.accounts.http.get<Record<string, unknown>>('/v1/userinfo', { bearer: accessToken });
  }

  // -- proofs

  issueObo(body: { subject_token: string; receiving_app: string; scopes?: string[]; access_ttl_seconds?: number }, idempotencyKey: string = randomUUID()): Promise<HttpResponse<ProofIssued>> {
    return this.request<ProofIssued>('POST', '/v1/proofs/obo', { json: body, idempotencyKey });
  }

  issueAta(body: { audiences: string[]; scopes?: string[]; access_ttl_seconds?: number }, idempotencyKey: string = randomUUID()): Promise<HttpResponse<ProofIssued>> {
    return this.request<ProofIssued>('POST', '/v1/proofs/ata', { json: body, idempotencyKey });
  }

  refreshProof(proofRefreshToken: string, accessTtlSeconds?: number): Promise<HttpResponse<ProofIssued>> {
    return this.request<ProofIssued>('POST', '/v1/proofs/refresh', { json: { proof_refresh_token: proofRefreshToken, ...(accessTtlSeconds ? { access_ttl_seconds: accessTtlSeconds } : {}) } });
  }

  async verifyProof(proofToken: string): Promise<ProofVerification> {
    return expectStatus(await this.request<ProofVerification>('POST', '/v1/proofs/verify', { json: { proof_token: proofToken } }), 200).body;
  }

  revokeProof(body: { proof_id: string } | { proof_token: string } | { proof_refresh_token: string }): Promise<HttpResponse> {
    return this.request('POST', '/v1/proofs/revoke', { json: body });
  }

  async proofs(query: { kind?: 'obo' | 'ata'; status?: 'active' | 'revoked'; limit?: number; cursor?: string } = {}): Promise<Page<Record<string, unknown>>> {
    return expectStatus(await this.request<Page<Record<string, unknown>>>('GET', this.path('/proofs'), { query }), 200).body;
  }

  // -- app + sign-in config

  async details(): Promise<Record<string, unknown>> {
    return expectStatus(await this.request<Record<string, unknown>>('GET', this.path()), 200).body;
  }

  patchSigninConfig(patch: Record<string, unknown>, options: { expectedVersion?: number; idempotencyKey?: string } = {}): Promise<HttpResponse<Record<string, unknown>>> {
    return this.request<Record<string, unknown>>('PATCH', this.path('/signin-config'), {
      json: options.expectedVersion === undefined ? patch : { ...patch, expected_version: options.expectedVersion },
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }

  async configHistory(): Promise<Page<Record<string, unknown>>> {
    return expectStatus(await this.request<Page<Record<string, unknown>>>('GET', this.path('/signin-config/history')), 200).body;
  }

  // -- user base

  async users(query: { q?: string; status?: string; kind?: string; source?: string; limit?: number; cursor?: string } = {}): Promise<Page<Record<string, unknown>>> {
    return expectStatus(await this.request<Page<Record<string, unknown>>>('GET', this.path('/users'), { query }), 200).body;
  }

  async user(uuid: string): Promise<Record<string, unknown>> {
    return expectStatus(await this.request<Record<string, unknown>>('GET', this.path(`/users/${encodeURIComponent(uuid)}`)), 200).body;
  }

  // -- imports

  startImportJson(rows: ImportRow[] | Array<Record<string, unknown>>, options: ImportOptions = {}, idempotencyKey: string = randomUUID()): Promise<HttpResponse<{ job: ImportJob }>> {
    return this.request<{ job: ImportJob }>('POST', this.path('/imports'), { json: { rows, options }, idempotencyKey });
  }

  startImportCsv(csv: string | Uint8Array, options: ImportOptions = {}, idempotencyKey: string = randomUUID()): Promise<HttpResponse<{ job: ImportJob }>> {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(options)) if (value !== undefined) query[key] = String(value);
    return this.request<{ job: ImportJob }>('POST', this.path('/imports'), { body: csv, contentType: 'text/csv', query, idempotencyKey, timeoutMs: 300_000 });
  }

  async importJob(jobId: string): Promise<ImportJob> {
    const res = expectStatus(await this.request<{ job: ImportJob } | ImportJob>('GET', this.path(`/imports/${encodeURIComponent(jobId)}`)), 200);
    const body = res.body as { job?: ImportJob } & ImportJob;
    return body.job ?? body;
  }

  async importRows(jobId: string, query: { outcome?: string; limit?: number; cursor?: string } = {}): Promise<Page<ImportRowResult>> {
    return expectStatus(await this.request<Page<ImportRowResult>>('GET', this.path(`/imports/${encodeURIComponent(jobId)}/rows`), { query }), 200).body;
  }

  /** Every row result of a job (follows cursors). */
  async allImportRows(jobId: string, outcome?: string): Promise<ImportRowResult[]> {
    const out: ImportRowResult[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.importRows(jobId, { limit: 200, ...(outcome ? { outcome } : {}), ...(cursor ? { cursor } : {}) });
      out.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return out.sort((a, b) => a.row_number - b.row_number);
  }

  /** Polls until the job is completed or failed. */
  async waitForImport(jobId: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<ImportJob> {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    for (;;) {
      const job = await this.importJob(jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
      if (Date.now() > deadline) throw new Error(`Import ${jobId} for ${this.appId} is still ${job.status} (${job.processed_rows}/${job.total_rows} rows) after ${options.timeoutMs ?? 120_000} ms.`);
      await new Promise((r) => setTimeout(r, options.intervalMs ?? 200));
    }
  }

  // -- webhooks

  async setWebhook(url: string): Promise<{ url: string; secret: string }> {
    return expectStatus(await this.request<{ url: string; secret: string }>('PUT', this.path('/webhook'), { json: { url } }), 200).body;
  }

  removeWebhook(): Promise<HttpResponse> {
    return this.request('DELETE', this.path('/webhook'));
  }

  async rotateWebhookSecret(): Promise<{ secret: string }> {
    return expectStatus(await this.request<{ secret: string }>('POST', this.path('/webhook/rotate-secret')), 200).body;
  }

  async testWebhook(): Promise<{ event_id: string }> {
    return expectStatus(await this.request<{ event_id: string }>('POST', this.path('/webhook/test')), [200, 201, 202]).body;
  }

  async deliveries(query: { status?: 'pending' | 'delivered' | 'failed'; limit?: number; cursor?: string } = {}): Promise<Page<Record<string, unknown>>> {
    return expectStatus(await this.request<Page<Record<string, unknown>>>('GET', this.path('/webhook/deliveries'), { query }), 200).body;
  }

  replay(body: { delivery_ids: string[] } | { status: 'failed'; since?: string }, idempotencyKey: string = randomUUID()): Promise<HttpResponse<Record<string, unknown>>> {
    return this.request<Record<string, unknown>>('POST', this.path('/webhook/replay'), { json: body, idempotencyKey });
  }

  // -- lookup

  async lookup(uuid: string): Promise<AccountSummary> {
    return expectStatus(await this.request<AccountSummary>('GET', `/v1/accounts/${encodeURIComponent(uuid)}`), 200).body;
  }

  async lookupById(id: string): Promise<AccountSummary> {
    return expectStatus(await this.request<AccountSummary>('GET', `/v1/accounts/by-id/${encodeURIComponent(id)}`), 200).body;
  }
}

/** Account-site calls (GET/PATCH /v1/me …) with either a bearer token or a browser cookie session. */
export class AccountSession {
  readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.http.request<T>(method, path, options);
  }

  private async ok<T>(statuses: number | number[], method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.http.expect<T>(statuses, method, path, options)).body;
  }

  me(): Promise<Record<string, unknown> & { uuid: string; id: string; kind: string }> {
    return this.ok(200, 'GET', '/v1/me');
  }

  updateMe(patch: { display_name?: string; timezone?: string; dob?: string; pfp_url?: string | null }): Promise<Record<string, unknown>> {
    return this.ok(200, 'PATCH', '/v1/me', { json: patch });
  }

  changeId(id: string): Promise<Record<string, unknown>> {
    return this.ok(200, 'POST', '/v1/me/id', { json: { id } });
  }

  addEmail(email: string): Promise<{ challenge_id: string; expires_at: string }> {
    return this.ok([200, 201], 'POST', '/v1/me/emails', { json: { email } });
  }

  verifyEmail(challengeId: string, code: string): Promise<unknown> {
    return this.ok(200, 'POST', '/v1/me/emails/verify', { json: { challenge_id: challengeId, code } });
  }

  addPhone(phone: string, country?: string): Promise<{ challenge_id: string; expires_at: string }> {
    return this.ok([200, 201], 'POST', '/v1/me/phones', { json: { phone, ...(country ? { country } : {}) } });
  }

  verifyPhone(challengeId: string, code: string): Promise<unknown> {
    return this.ok(200, 'POST', '/v1/me/phones/verify', { json: { challenge_id: challengeId, code } });
  }

  apps(): Promise<Page<Record<string, unknown>>> {
    return this.ok(200, 'GET', '/v1/me/apps');
  }

  removeApp(appId: string): Promise<unknown> {
    return this.ok([200, 204], 'DELETE', `/v1/me/apps/${encodeURIComponent(appId)}`);
  }

  shortLivedToken(appId: string): Promise<{ slt: string; app_id: string; expires_at: string }> {
    return this.ok([200, 201], 'POST', '/v1/me/short-lived-tokens', { json: { app_id: appId } });
  }

  proofs(): Promise<Page<Record<string, unknown>>> {
    return this.ok(200, 'GET', '/v1/me/proofs');
  }

  revokeProof(proofId: string): Promise<unknown> {
    return this.ok([200, 204], 'DELETE', `/v1/me/proofs/${encodeURIComponent(proofId)}`);
  }

  silicons(): Promise<Page<Record<string, unknown>>> {
    return this.ok(200, 'GET', '/v1/me/silicons');
  }

  createSilicon(body: { id: string; display_name: string; timezone?: string; pfp_url?: string; stk?: string; webhook_url?: string }, idempotencyKey: string = randomUUID()): Promise<{ silicon: Record<string, unknown> & { uuid: string; id: string }; stk: string | null; webhook_secret: string | null }> {
    return this.ok(201, 'POST', '/v1/me/silicons', { json: body, idempotencyKey });
  }

  rotateStk(siliconUuid: string, stk?: string): Promise<{ stk: string | null; rotated_at: string }> {
    return this.ok(200, 'POST', `/v1/me/silicons/${encodeURIComponent(siliconUuid)}/stk`, { json: stk ? { stk } : {} });
  }

  transferSilicon(siliconUuid: string, to: string): Promise<Record<string, unknown>> {
    return this.ok([200, 201], 'POST', `/v1/me/silicons/${encodeURIComponent(siliconUuid)}/transfer`, { json: { to } });
  }

  custodianRequests(): Promise<Page<Record<string, unknown>>> {
    return this.ok(200, 'GET', '/v1/me/custodian-requests');
  }

  acceptCustodianRequest(requestId: string): Promise<unknown> {
    return this.ok([200, 204], 'POST', `/v1/me/custodian-requests/${encodeURIComponent(requestId)}/accept`);
  }

  declineCustodianRequest(requestId: string): Promise<unknown> {
    return this.ok([200, 204], 'POST', `/v1/me/custodian-requests/${encodeURIComponent(requestId)}/decline`);
  }

  history(kind?: string): Promise<Page<Record<string, unknown>>> {
    return this.ok(200, 'GET', '/v1/me/history', { query: { kind } });
  }

  ownedApps(): Promise<Page<Record<string, unknown>>> {
    return this.ok(200, 'GET', '/v1/me/owned-apps');
  }

  deleteAccount(confirm: string): Promise<unknown> {
    return this.ok([200, 204], 'DELETE', '/v1/me', { json: { confirm } });
  }
}

export interface CreateFlowParams {
  app_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: 'S256' | 'plain';
  scope?: string;
  nonce?: string;
  prompt?: string;
  login_hint?: string;
  method?: string;
  /** Browser Intl timezone (signup suggestion fallback). */
  timezone?: string;
}

/** Plays the browser at Silicon Accounts: keeps sa_flow/sa_session/sa_signup cookies and sends Origin. */
export class BrowserSession {
  readonly accounts: AccountsClient;
  readonly publicUrl: string;
  readonly http: HttpClient;

  constructor(accounts: AccountsClient, publicUrl: string, jar: CookieJar = new CookieJar()) {
    this.accounts = accounts;
    this.publicUrl = publicUrl;
    this.http = new HttpClient({ baseUrl: accounts.url, jar, origin: publicUrl, headers: accounts.headers });
  }

  get jar(): CookieJar {
    return this.http.jar;
  }

  /** Account-site calls with this browser's session cookie. */
  account(): AccountSession {
    return new AccountSession(this.http);
  }

  request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.http.request<T>(method, path, options);
  }

  createFlowRaw(params: CreateFlowParams): Promise<HttpResponse<{ flow: FlowView }>> {
    return this.http.post<{ flow: FlowView }>('/v1/flows', { json: params });
  }

  async createFlow(params: CreateFlowParams): Promise<FlowView> {
    return expectStatus(await this.createFlowRaw(params), [200, 201]).body.flow;
  }

  private async step(path: string, body?: unknown, statuses: number[] = [200, 201]): Promise<FlowView> {
    const res = await this.http.post<{ flow: FlowView }>(path, body === undefined ? {} : { json: body });
    return expectStatus(res, statuses).body.flow;
  }

  async flow(id: string): Promise<FlowView> {
    return expectStatus(await this.http.get<{ flow: FlowView }>(`/v1/flows/${encodeURIComponent(id)}`), 200).body.flow;
  }

  email(id: string, email: string): Promise<FlowView> {
    return this.step(`/v1/flows/${encodeURIComponent(id)}/email`, { email });
  }

  phone(id: string, phone: string, country?: string): Promise<FlowView> {
    return this.step(`/v1/flows/${encodeURIComponent(id)}/phone`, { phone, ...(country ? { country } : {}) });
  }

  resend(id: string): Promise<FlowView> {
    return this.step(`/v1/flows/${encodeURIComponent(id)}/resend`);
  }

  verifyRaw(id: string, code: string): Promise<HttpResponse<{ flow: FlowView }>> {
    return this.http.post<{ flow: FlowView }>(`/v1/flows/${encodeURIComponent(id)}/verify`, { json: { code } });
  }

  verify(id: string, code: string): Promise<FlowView> {
    return this.step(`/v1/flows/${encodeURIComponent(id)}/verify`, { code });
  }

  signup(id: string, fields: { display_name: string; id: string; timezone: string; dob: string; pfp_url?: string | null }): Promise<FlowView> {
    return this.step(`/v1/flows/${encodeURIComponent(id)}/signup`, fields);
  }

  /** POST /v1/flows/{id}/signup/photo — the sign-up page uploads the chosen photo (raw image) before the account exists. */
  async signupPhotoRaw(id: string, bytes: Uint8Array, contentType = 'image/png'): Promise<HttpResponse<{ pfp_url: string; photo: { id: string; content_type: string; bytes: number; width: number; height: number } }>> {
    return this.http.post(`/v1/flows/${encodeURIComponent(id)}/signup/photo`, { body: bytes, contentType });
  }

  async signupPhoto(id: string, bytes: Uint8Array, contentType = 'image/png'): Promise<{ pfp_url: string; photo: { id: string; content_type: string; bytes: number; width: number; height: number } }> {
    return expectStatus(await this.signupPhotoRaw(id, bytes, contentType), 201).body;
  }

  requirement(id: string, kind: 'email' | 'phone', value: string, country?: string): Promise<FlowView> {
    return this.step(`/v1/flows/${encodeURIComponent(id)}/requirements/${kind}`, { [kind]: value, ...(country ? { country } : {}) });
  }

  requirementVerify(id: string, code: string): Promise<FlowView> {
    return this.step(`/v1/flows/${encodeURIComponent(id)}/requirements/verify`, { code });
  }

  consent(id: string, approve = true, optionalScopes: string[] = []): Promise<FlowView> {
    return this.step(`/v1/flows/${encodeURIComponent(id)}/consent`, { approve, optional_scopes: optionalScopes });
  }

  continueAs(id: string): Promise<FlowView> {
    return this.step(`/v1/flows/${encodeURIComponent(id)}/continue`);
  }

  switchAccount(id: string): Promise<FlowView> {
    return this.step(`/v1/flows/${encodeURIComponent(id)}/switch`);
  }

  async oauthStart(id: string, provider: Provider): Promise<string> {
    const res = expectStatus(await this.http.post<{ authorize_url: string }>(`/v1/flows/${encodeURIComponent(id)}/oauth/${provider}`, {}), 200);
    return res.body.authorize_url;
  }

  /**
   * The account site's "Connect Google/Apple": POST /v1/me/identities/{provider}, the provider (mock-oidc) picks
   * `identityEmail`, and its answer goes to the callback in this browser. Returns where the callback sent the browser
   * (`return_to?linked=…&email_added=…` or `?link_error=…&provider=…&flow=…`).
   */
  async connectProvider(provider: Provider, oidc: MockOidcClient, identityEmail: string, returnTo?: string): Promise<{ flow_id: string; location: string }> {
    const started = expectStatus(
      await this.http.post<{ authorize_url: string; flow_id: string }>(`/v1/me/identities/${provider}`, { json: returnTo ? { return_to: returnTo } : {} }),
      201,
    ).body;
    const outcome = await oidc.authorize(started.authorize_url, { email: identityEmail });
    let res: HttpResponse;
    if (outcome.kind === 'redirect') {
      res = await this.http.get(await this.accounts.toServerUrl(outcome.location), { headers: { Accept: 'text/html' } });
    } else if (outcome.kind === 'form_post') {
      const posted = await this.http.post(await this.accounts.toServerUrl(outcome.action), { form: outcome.fields, headers: { Accept: 'text/html' }, origin: new URL(started.authorize_url).origin });
      res = posted.status === 303 && posted.location ? await this.http.get(await this.accounts.toServerUrl(posted.location), { headers: { Accept: 'text/html' } }) : posted;
    } else {
      throw new Error(`mock-oidc answered ${outcome.kind} instead of an identity: ${JSON.stringify(outcome).slice(0, 300)}`);
    }
    if (res.status !== 302 || !res.location) throw new HttpExpectationError(res, '302 back to the account site');
    return { flow_id: started.flow_id, location: res.location };
  }

  /** Delivers the provider's answer (redirect or form_post) to Silicon Accounts' callback and returns the flow id it sends the browser to. */
  async deliverProviderCallback(target: { method: 'GET'; url: string } | { method: 'POST'; url: string; fields: Record<string, string>; origin?: string }): Promise<string> {
    const url = await this.accounts.toServerUrl(target.url);
    // A provider's form_post is a cross-site POST navigation: the browser sends the provider's Origin.
    const res =
      target.method === 'GET'
        ? await this.http.get(url, { headers: { Accept: 'text/html' } })
        : await this.http.post(url, { form: target.fields, headers: { Accept: 'text/html' }, origin: target.origin ?? null });
    if (res.status < 300 || res.status >= 400 || !res.location) throw new HttpExpectationError(res, '302 to /authorize/flow/{id}');
    const match = /\/authorize\/flow\/([^/?#]+)/.exec(res.location);
    if (!match?.[1]) throw new Error(`Silicon Accounts' provider callback redirected to ${res.location}, not to /authorize/flow/{id}.`);
    return decodeURIComponent(match[1]);
  }

  async session(): Promise<{ account: AccountSummary; session: Record<string, unknown> } | null> {
    const res = await this.http.get<{ account: AccountSummary; session: Record<string, unknown> }>('/v1/session');
    if (res.status === 401) return null;
    return expectStatus(res, 200).body;
  }

  async signout(): Promise<void> {
    expectStatus(await this.http.post('/v1/session/signout'), [200, 204]);
  }
}

// ------------------------------------------------------------ sign-in drivers

export interface SignupFields {
  display_name?: string;
  id?: string;
  timezone?: string;
  dob?: string;
  pfp_url?: string | null;
}

export interface DriveOptions {
  messaging: MockMessagingClient;
  /** Override prefilled signup fields (default: accept the prefill as-is). */
  signup?: SignupFields;
  /** Values for the requirements step (default: fresh random ones). */
  requirements?: { email?: string; phone?: string; country?: string };
  /** Consent answer (default approve with no optional scopes). */
  approve?: boolean;
  optionalScopes?: string[];
  /** On choose_method with a signed-in browser: continue as that account (default true). */
  continueAs?: boolean;
  codeTimeoutMs?: number;
}

/** Advances a flow through signup → requirements → consent until it completes (or fails). */
export async function driveFlow(browser: BrowserSession, start: FlowView, options: DriveOptions): Promise<FlowView> {
  let flow = start;
  for (let guard = 0; guard < 12; guard++) {
    if (flow.step === 'complete' || flow.step === 'failed') return flow;
    switch (flow.step) {
      case 'signup': {
        const prefill = flow.signup;
        if (!prefill) throw new Error(`Flow ${flow.id} is at signup but has no signup prefill.`);
        flow = await browser.signup(flow.id, {
          display_name: options.signup?.display_name ?? prefill.display_name,
          id: options.signup?.id ?? prefill.id,
          timezone: options.signup?.timezone ?? prefill.timezone,
          dob: options.signup?.dob ?? prefill.dob,
          ...(options.signup?.pfp_url !== undefined ? { pfp_url: options.signup.pfp_url } : {}),
        });
        break;
      }
      case 'requirements': {
        const missing = flow.requirements?.missing ?? [];
        const kind = missing.find((m): m is 'email' | 'phone' => m === 'email' || m === 'phone');
        if (!kind) throw new Error(`Flow ${flow.id} requires ${missing.join(', ')}, which the helper cannot fill (only email and phone are collected in the flow).`);
        const value = kind === 'email' ? (options.requirements?.email ?? randomEmail('requirement')) : (options.requirements?.phone ?? randomPhone());
        const after = await options.messaging.lastSeq();
        await browser.requirement(flow.id, kind, value, options.requirements?.country);
        const code = await options.messaging.waitForCode({ to: value, after, ...(options.codeTimeoutMs ? { timeoutMs: options.codeTimeoutMs } : {}) });
        flow = await browser.requirementVerify(flow.id, code);
        break;
      }
      case 'consent':
        flow = await browser.consent(flow.id, options.approve ?? true, options.optionalScopes ?? []);
        break;
      case 'choose_method':
        if (flow.signed_in_as && options.continueAs !== false) {
          flow = await browser.continueAs(flow.id);
          break;
        }
        throw new Error(`Flow ${flow.id} is waiting at choose_method; start a method (email/phone/oauth) first.`);
      case 'verify_code':
        throw new Error(`Flow ${flow.id} is waiting for a verification code.`);
      default:
        throw new Error(`Flow ${flow.id} is at an unknown step "${String(flow.step)}".`);
    }
  }
  throw new Error(`Flow ${flow.id} did not complete after 12 steps (stuck at ${flow.step}).`);
}

export interface SignInOptions extends Omit<DriveOptions, 'messaging'> {
  accounts: AccountsClient;
  messaging: MockMessagingClient;
  appId: string;
  /** Default: the fake app's callback on $FAKE_APPS_URL (or 127.0.0.1:8593). */
  redirectUri?: string;
  scope?: string;
  prompt?: string;
  loginHint?: string;
  /** Use PKCE S256 (default true). */
  pkce?: boolean;
  /** Nonce to send (default random; null = none). */
  nonce?: string | null;
  timezone?: string;
  /** Reuse a browser (e.g. to test "continue as"); default a fresh one. */
  browser?: BrowserSession;
}

export interface SignInResult {
  browser: BrowserSession;
  flow: FlowView;
  redirectUri: string;
  /** Final redirect_to of the flow. */
  redirectTo: string;
  /** Authorization code from redirect_to (null when the flow ended with an error). */
  code: string | null;
  /** error= from redirect_to (e.g. access_denied). */
  error: string | null;
  state: string;
  codeVerifier: string | null;
  nonce: string | null;
}

function finish(browser: BrowserSession, flow: FlowView, base: { redirectUri: string; state: string; codeVerifier: string | null; nonce: string | null }): SignInResult {
  if (flow.step !== 'complete' || !flow.redirect_to) {
    throw new Error(`Flow ${flow.id} ended at ${flow.step}${flow.error ? ` with ${flow.error.code}: ${flow.error.message}` : ''} instead of completing.`);
  }
  const url = new URL(flow.redirect_to);
  if (url.searchParams.get('state') !== base.state) {
    throw new Error(`redirect_to carries state "${url.searchParams.get('state')}" but the app sent "${base.state}".`);
  }
  return { browser, flow, redirectTo: flow.redirect_to, code: url.searchParams.get('code'), error: url.searchParams.get('error'), ...base };
}

async function beginFlow(options: SignInOptions): Promise<{ browser: BrowserSession; flow: FlowView; base: { redirectUri: string; state: string; codeVerifier: string | null; nonce: string | null } }> {
  const browser = options.browser ?? (await options.accounts.browser());
  const redirectUri = options.redirectUri ?? fakeRedirectUri(options.appId);
  const state = randomState();
  const pkce = options.pkce === false ? null : createPkcePair('S256');
  const nonce = options.nonce === undefined ? randomNonce() : options.nonce;
  const flow = await browser.createFlow({
    app_id: options.appId,
    redirect_uri: redirectUri,
    state,
    ...(pkce ? { code_challenge: pkce.code_challenge, code_challenge_method: 'S256' as const } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(nonce ? { nonce } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
    timezone: options.timezone ?? 'UTC',
  });
  return { browser, flow, base: { redirectUri, state, codeVerifier: pkce?.code_verifier ?? null, nonce } };
}

/**
 * Signs in to `appId` with an email or phone code read from mock-messaging, accepting the
 * signup prefill and approving consent, and returns the authorization code.
 */
export async function signInWithCode(options: SignInOptions & ({ email: string } | { phone: string; country?: string })): Promise<SignInResult> {
  const { browser, flow: created, base } = await beginFlow(options);
  let flow = created;
  if (flow.step === 'choose_method' && flow.signed_in_as && options.continueAs !== false && options.prompt !== 'login') {
    flow = await driveFlow(browser, flow, options);
    return finish(browser, flow, base);
  }
  const to = 'email' in options ? options.email : options.phone;
  const after = await options.messaging.lastSeq();
  flow = 'email' in options ? await browser.email(flow.id, options.email) : await browser.phone(flow.id, options.phone, options.country);
  const code = await options.messaging.waitForCode({ to, after, ...(options.codeTimeoutMs ? { timeoutMs: options.codeTimeoutMs } : {}) });
  flow = await browser.verify(flow.id, code);
  flow = await driveFlow(browser, flow, options);
  return finish(browser, flow, base);
}

/**
 * Signs in to `appId` with Google or Apple through mock-oidc: the mock is told which
 * identity to pick, the provider answer (redirect or form_post) is delivered to
 * Silicon Accounts' callback, and the flow is driven to completion.
 */
export async function signInWithProvider(options: SignInOptions & { provider: Provider; oidc: MockOidcClient; identityEmail: string }): Promise<SignInResult> {
  const { browser, flow: created, base } = await beginFlow(options);
  const authorizeUrl = await browser.oauthStart(created.id, options.provider);
  const outcome = await options.oidc.authorize(authorizeUrl, { email: options.identityEmail });
  let flowId: string;
  if (outcome.kind === 'redirect') flowId = await browser.deliverProviderCallback({ method: 'GET', url: outcome.location });
  else if (outcome.kind === 'form_post') flowId = await browser.deliverProviderCallback({ method: 'POST', url: outcome.action, fields: outcome.fields, origin: new URL(authorizeUrl).origin });
  else if (outcome.kind === 'error') throw new Error(`mock-oidc refused the authorize request from Silicon Accounts: ${outcome.error}: ${outcome.description}`);
  else throw new Error('mock-oidc showed its chooser instead of picking the identity.');
  const flow = await driveFlow(browser, await browser.flow(flowId), options);
  return finish(browser, flow, base);
}

/** Creates a brand-new Carbon via the account site's own sign-in (app `accounts`) and returns its signed-in browser. */
export async function signUpCarbon(options: { accounts: AccountsClient; messaging: MockMessagingClient; email?: string; phone?: string; country?: string; signup?: SignupFields }): Promise<{ browser: BrowserSession; account: AccountSession; email: string | null; phone: string | null; me: Record<string, unknown> & { uuid: string; id: string } }> {
  const publicUrl = await options.accounts.publicUrl();
  const email = options.phone ? null : (options.email ?? randomEmail());
  const common = { accounts: options.accounts, messaging: options.messaging, appId: 'accounts', redirectUri: `${publicUrl}/`, ...(options.signup ? { signup: options.signup } : {}) };
  const result = email ? await signInWithCode({ ...common, email }) : await signInWithCode({ ...common, phone: options.phone ?? '', ...(options.country ? { country: options.country } : {}) });
  const account = result.browser.account();
  const me = await account.me();
  return { browser: result.browser, account, email, phone: options.phone ?? null, me };
}

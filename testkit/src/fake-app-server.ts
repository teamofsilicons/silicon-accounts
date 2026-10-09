// fake-app-server — one Node server hosting the server side of every fake app by path
// prefix (/<app_id>/…), driven by fake-apps.json. Each fake app behaves like a real
// app using Silicon Accounts:
//
//  - GET  /<app>/            demo page with the three integrations: hosted link,
//                            iframe (/embed/v1/buttons) and the SDK snippet; each sign-in
//                            starts with a server-side state + PKCE pair bound to a cookie.
//  - GET  /<app>/callback    checks state, exchanges the code (client_secret_basic + PKCE
//                            verifier), verifies the id_token when present, renders
//                            "Signed in as …" with the AccountForApp JSON in <pre id="account">.
//  - POST /<app>/slt-login   a Silicon's short-lived token → tokens.
//  - POST /<app>/webhooks    verifies X-Accounts-Signature, dedupes by event_id, records.
//  - POST /hooks/<key>       the same receiver for any other webhook (e.g. a Silicon's own).
//  - User verification demo (dm → briefcase) and App verification demo (commit → remind + waveform) with timings.
//  - /<app>/_state, /_events, /_webhook-secret, /_webhook-faults … for test assertions.
//
// Silicon Accounts is reached at ACCOUNTS_URL (server to server, default accounts-api at
// http://127.0.0.1:8589; the public site, which proxies /v1/*, works too); browser links use
// ACCOUNTS_PUBLIC_URL, else /v1/meta's public_url, else ACCOUNTS_URL.

import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { createPkcePair, randomNonce, randomState } from '../lib/pkce.ts';
import { loadFakeApps } from './fake-apps/load.ts';
import { appPage, clientCallbackPage, errorPage, indexPage, signedInPage, type SignedInView } from './fake-apps/pages.ts';
import type { SiliconAppsApp } from './fake-apps/types.ts';
import { WebhookInbox } from './fake-apps/webhook-inbox.ts';
import { apiError, jsonObject, Router, serializeCookie, serve, type Ctx } from './shared/http.ts';
import { basicAuthHeader, isRecord, nowIso, randomToken, roundMs, str, uuid } from './shared/util.ts';

export const DEFAULT_FAKE_APPS_PORT = 8593;
export const DEFAULT_ACCOUNTS_URL = 'http://127.0.0.1:8589';
export const SESSION_COOKIE = 'fakeapp_sid';
const PENDING_TTL_MS = 60 * 60_000;
const MAX_RECORDS = 500;

type Integration = 'hosted' | 'iframe' | 'sdk' | 'api';

interface PendingAuth {
  state: string;
  sid: string;
  integration: Integration;
  code_verifier: string | null;
  code_challenge: string | null;
  code_challenge_method: 'S256' | 'plain' | null;
  nonce: string | null;
  redirect_uri: string;
  tamper: string | null;
  created_ms: number;
}

interface StoredAccount {
  uuid: string;
  id: string | null;
  kind: string | null;
  membership_id: string | null;
  account: Record<string, unknown> | null;
  access_token: string;
  refresh_token: string | null;
  previous_refresh_token: string | null;
  access_expires_ms: number;
  refresh_token_expires_at: string | null;
  id_token: string | null;
  id_token_claims: JWTPayload | null;
  id_token_verified: boolean | null;
  id_token_error: string | null;
  scope: string | null;
  via: Integration | 'slt';
  signed_in_at: string;
  refreshed_at: string | null;
  refresh_count: number;
}

interface CallbackRecord {
  id: string;
  at: string;
  integration: Integration | null;
  outcome: 'signed_in' | 'error';
  error: { code: string; message: string; stage: string; status?: number; response?: unknown } | null;
  account_uuid: string | null;
  account_id: string | null;
  membership_id: string | null;
  exchange_ms: number | null;
}

interface ProofCheck {
  at: string;
  endpoint: string;
  valid: boolean;
  kind: string | null;
  issuing_app: string | null;
  user_uuid: string | null;
  verify_ms: number;
}

interface AppRuntime {
  app: SiliconAppsApp;
  sessions: Map<string, { sid: string; created_at: string; account_uuid: string | null }>;
  pending: Map<string, PendingAuth>;
  accounts: Map<string, StoredAccount>;
  callbacks: CallbackRecord[];
  lastCode: { code: string; redirect_uri: string; code_verifier: string | null } | null;
  inbox: WebhookInbox;
  files: Array<Record<string, unknown>>;
  pings: Array<Record<string, unknown>>;
  proofChecks: ProofCheck[];
  errors: Array<{ at: string; message: string }>;
}

export interface FakeAppServerOptions {
  /** Port to listen on (default 8593; 0 = any free port). */
  port?: number;
  host?: string;
  /** This server's browser-facing base URL (default http://<host>:<port>); redirect URIs derive from it. */
  publicUrl?: string;
  /** Silicon Accounts for server-to-server calls (default $ACCOUNTS_URL or http://127.0.0.1:8589). */
  accountsUrl?: string;
  /** Silicon Accounts as the browser sees it (default $ACCOUNTS_PUBLIC_URL, else /v1/meta public_url, else accountsUrl). */
  accountsPublicUrl?: string;
  /** Apps to host (default: testkit/fake-apps.json). */
  apps?: SiliconAppsApp[];
  /** Allowed webhook timestamp skew in seconds (default 300). */
  webhookToleranceSeconds?: number;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
  log?: boolean | ((line: string) => void);
}

export interface FakeAppServer {
  url: string;
  port: number;
  accountsUrl: string;
  apps: string[];
  /** The same JSON GET /<app>/_state returns. */
  state(appId: string, includeTokens?: boolean): Record<string, unknown>;
  setWebhookSecret(appId: string, secret: string | null): void;
  reset(appId?: string): void;
  stop(): Promise<void>;
}

interface AccountsResponse {
  status: number;
  ok: boolean;
  body: unknown;
  ms: number;
  error: string | null;
}

interface TokenBody {
  access_token?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_at?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  id_token?: unknown;
  membership_id?: unknown;
  account?: unknown;
}

function trimRecords<T>(list: T[]): void {
  if (list.length > MAX_RECORDS) list.splice(0, list.length - MAX_RECORDS);
}

function describeAuthorizeError(code: string): string {
  switch (code) {
    case 'access_denied':
      return 'The sign-in was cancelled at Silicon Accounts (the Carbon pressed Cancel or declined to share).';
    case 'login_required':
      return 'prompt=none was used but nobody is signed in to Silicon Accounts in this browser.';
    case 'consent_required':
      return 'prompt=none was used but the Carbon still has to approve what is shared with this app.';
    case 'interaction_required':
      return 'prompt=none was used but Silicon Accounts needs to show a page.';
    default:
      return `Silicon Accounts redirected back with error=${code}.`;
  }
}

function wantsJson(ctx: Ctx): boolean {
  if (ctx.query.get('format') === 'json') return true;
  const accept = ctx.header('accept') ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

export async function start(options: FakeAppServerOptions = {}): Promise<FakeAppServer> {
  const apps = options.apps ?? loadFakeApps();
  const accountsUrl = (options.accountsUrl ?? process.env.ACCOUNTS_URL ?? DEFAULT_ACCOUNTS_URL).replace(/\/+$/, '');
  let publicAccountsCache: string | null = (options.accountsPublicUrl ?? process.env.ACCOUNTS_PUBLIC_URL ?? '').replace(/\/+$/, '') || null;
  const fetchImpl = options.fetch ?? fetch;
  const tolerance = options.webhookToleranceSeconds ?? 300;
  const router = new Router();

  const runtimes = new Map<string, AppRuntime>();
  /** Generic webhook receivers (e.g. for Silicons' own webhooks), created on first use. */
  const sinks = new Map<string, WebhookInbox>();

  function freshRuntime(app: SiliconAppsApp): AppRuntime {
    return {
      app,
      sessions: new Map(),
      pending: new Map(),
      accounts: new Map(),
      callbacks: [],
      lastCode: null,
      inbox: new WebhookInbox({ name: `${app.app_id} webhook`, secret: app.webhook_secret ?? null, expectedAppId: app.app_id, toleranceSeconds: tolerance }),
      files: [],
      pings: [],
      proofChecks: [],
      errors: [],
    };
  }
  for (const app of apps) runtimes.set(app.app_id, freshRuntime(app));

  // Resolved once listening.
  let selfUrl = '';
  let internalUrl = '';

  function runtime(appId: string | undefined): AppRuntime {
    const rt = appId ? runtimes.get(appId) : undefined;
    if (!rt) {
      throw apiError(404, 'unknown_app', `No fake app "${appId ?? ''}" is hosted here.`, `Known apps: ${[...runtimes.keys()].join(', ')}.`);
    }
    return rt;
  }

  function noteError(rt: AppRuntime, message: string): void {
    rt.errors.push({ at: nowIso(), message });
    trimRecords(rt.errors);
  }

  // ------------------------------------------------------------ Accounts calls

  async function callAccounts(
    path: string,
    init: { method?: string; app?: { app_id: string; secret: string }; bearer?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<AccountsResponse> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'silicon-accounts-testkit-fake-app/1', ...init.headers };
    let body: string | undefined;
    if (init.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    } else if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    // client_secret_basic: RFC 6749 §2.3.1 form-encodes id and secret before base64 (a no-op for our ids).
    if (init.app) headers.Authorization = basicAuthHeader(encodeURIComponent(init.app.app_id), encodeURIComponent(init.app.secret));
    if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
    const started = performance.now();
    try {
      const res = await fetchImpl(`${accountsUrl}${path}`, { method: init.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(20_000) });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, ok: res.ok, body: parsed, ms: roundMs(performance.now() - started), error: null };
    } catch (error) {
      return {
        status: 0,
        ok: false,
        body: null,
        ms: roundMs(performance.now() - started),
        error: `Could not reach Silicon Accounts at ${accountsUrl}${path}: ${(error as Error).message}. Is accounts-api running (or ACCOUNTS_URL wrong)?`,
      };
    }
  }

  async function accountsPublicUrl(): Promise<string> {
    if (publicAccountsCache) return publicAccountsCache;
    const meta = await callAccounts('/v1/meta');
    if (meta.ok && isRecord(meta.body) && typeof meta.body.public_url === 'string' && meta.body.public_url) {
      publicAccountsCache = meta.body.public_url.replace(/\/+$/, '');
      return publicAccountsCache;
    }
    return accountsUrl;
  }

  let jwksCache: { set: ReturnType<typeof createLocalJWKSet>; at: number } | null = null;
  let issuerCache: string | null = null;

  async function accountsJwks(force: boolean): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (!force && jwksCache && Date.now() - jwksCache.at < 60_000) return jwksCache.set;
    const res = await callAccounts('/.well-known/jwks.json');
    if (!res.ok || !isRecord(res.body) || !Array.isArray(res.body.keys)) {
      throw new Error(`GET ${accountsUrl}/.well-known/jwks.json answered ${res.status || res.error}`);
    }
    jwksCache = { set: createLocalJWKSet(res.body as unknown as JSONWebKeySet), at: Date.now() };
    return jwksCache.set;
  }

  async function accountsIssuer(): Promise<string> {
    if (issuerCache) return issuerCache;
    const res = await callAccounts('/.well-known/openid-configuration');
    if (res.ok && isRecord(res.body) && typeof res.body.issuer === 'string') {
      issuerCache = res.body.issuer;
      return issuerCache;
    }
    return accountsPublicUrl();
  }

  async function verifyIdToken(app: SiliconAppsApp, idToken: string, nonce: string | null): Promise<{ claims: JWTPayload | null; verified: boolean; error: string | null }> {
    let decoded: { claims: JWTPayload } | { error: string };
    try {
      decoded = { claims: decodeJwt(idToken) };
    } catch (error) {
      decoded = { error: (error as Error).message };
    }
    if ('error' in decoded) return { claims: null, verified: false, error: `id_token is not a JWT: ${decoded.error}` };
    const claims = decoded.claims;
    try {
      const issuer = await accountsIssuer();
      const verifyWith = async (force: boolean): Promise<void> => {
        await jwtVerify(idToken, await accountsJwks(force), { issuer, audience: app.app_id, algorithms: ['EdDSA', 'Ed25519'] });
      };
      try {
        await verifyWith(false);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error;
        await verifyWith(true);
      }
      if (nonce && claims.nonce !== nonce) return { claims, verified: false, error: `nonce mismatch: sent ${nonce}, id_token has ${String(claims.nonce)}` };
      return { claims, verified: true, error: null };
    } catch (error) {
      return { claims, verified: false, error: (error as Error).message };
    }
  }

  // ---------------------------------------------------------------- sessions

  function ensureSession(rt: AppRuntime, ctx: Ctx): string {
    let sid = ctx.cookies()[SESSION_COOKIE];
    if (!sid || !rt.sessions.has(sid)) {
      sid = randomToken(24);
      rt.sessions.set(sid, { sid, created_at: nowIso(), account_uuid: null });
      ctx.addHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, sid, { path: `/${rt.app.app_id}`, httpOnly: true, sameSite: 'Lax', maxAge: 86_400 }));
    }
    return sid;
  }

  function sessionAccount(rt: AppRuntime, ctx: Ctx): StoredAccount | null {
    const sid = ctx.cookies()[SESSION_COOKIE];
    const session = sid ? rt.sessions.get(sid) : undefined;
    if (!session?.account_uuid) return null;
    return rt.accounts.get(session.account_uuid) ?? null;
  }

  interface SigninParams {
    scope: string | null;
    prompt: string | null;
    /** signin | signup: which version of the hosted pages (the app's own "Sign up" button sends signup). */
    intent: string | null;
    /** A direct method button: google | apple | email | phone. Apps never send a Carbon's email or phone. */
    method: string | null;
    nonce: boolean;
    pkce: 'S256' | 'plain' | 'none';
    tamper: string | null;
    redirect_uri: string;
    theme: string | null;
  }

  function signinParams(rt: AppRuntime, query: URLSearchParams): SigninParams {
    const defaults = rt.app.testkit?.authorize_params ?? {};
    const get = (key: string): string | null => (query.has(key) ? query.get(key) : (defaults[key] ?? null));
    const pkce = get('pkce') ?? 'S256';
    if (pkce !== 'S256' && pkce !== 'plain' && pkce !== 'none') throw apiError(422, 'invalid_pkce', `pkce must be S256, plain or none, got "${pkce}".`);
    const tamper = get('tamper');
    if (tamper && !['verifier', 'redirect_uri', 'secret'].includes(tamper)) {
      throw apiError(422, 'invalid_tamper', `tamper must be verifier, redirect_uri or secret, got "${tamper}".`);
    }
    return {
      scope: get('scope'),
      prompt: get('prompt'),
      intent: get('intent'),
      method: get('method'),
      nonce: get('nonce') !== '0',
      pkce,
      tamper,
      redirect_uri: query.get('redirect_uri') ?? `${selfUrl}/${rt.app.app_id}/callback`,
      theme: get('theme'),
    };
  }

  function newPending(rt: AppRuntime, sid: string, integration: Integration, params: SigninParams): PendingAuth {
    const now = Date.now();
    for (const [state, p] of rt.pending) if (now - p.created_ms > PENDING_TTL_MS) rt.pending.delete(state);
    const pkce = params.pkce === 'none' ? null : createPkcePair(params.pkce);
    const pending: PendingAuth = {
      state: randomState(),
      sid,
      integration,
      code_verifier: pkce?.code_verifier ?? null,
      code_challenge: pkce?.code_challenge ?? null,
      code_challenge_method: pkce?.code_challenge_method ?? null,
      nonce: params.nonce ? randomNonce() : null,
      redirect_uri: params.redirect_uri,
      tamper: params.tamper,
      created_ms: now,
    };
    rt.pending.set(pending.state, pending);
    return pending;
  }

  function authorizeQuery(rt: AppRuntime, pending: PendingAuth, params: SigninParams): URLSearchParams {
    const q = new URLSearchParams();
    q.set('app_id', rt.app.app_id);
    q.set('redirect_uri', pending.redirect_uri);
    q.set('response_type', 'code');
    q.set('state', pending.state);
    if (pending.code_challenge && pending.code_challenge_method) {
      q.set('code_challenge', pending.code_challenge);
      q.set('code_challenge_method', pending.code_challenge_method);
    }
    if (params.scope) q.set('scope', params.scope);
    if (pending.nonce) q.set('nonce', pending.nonce);
    if (params.prompt) q.set('prompt', params.prompt);
    if (params.intent) q.set('intent', params.intent);
    if (params.method) q.set('method', params.method);
    return q;
  }

  function sdkAttributes(rt: AppRuntime, pending: PendingAuth, params: SigninParams): Record<string, string> {
    const attrs: Record<string, string> = {
      'data-app-id': rt.app.app_id,
      'data-redirect-uri': pending.redirect_uri,
      'data-target': '#silicon-accounts',
      'data-state': pending.state,
    };
    if (pending.code_challenge && pending.code_challenge_method) {
      attrs['data-code-challenge'] = pending.code_challenge;
      attrs['data-code-challenge-method'] = pending.code_challenge_method;
    }
    if (params.scope) attrs['data-scope'] = params.scope;
    if (pending.nonce) attrs['data-nonce'] = pending.nonce;
    if (params.prompt) attrs['data-prompt'] = params.prompt;
    if (params.intent) attrs['data-intent'] = params.intent;
    if (params.method) attrs['data-method'] = params.method;
    if (params.theme) attrs['data-theme'] = params.theme;
    return attrs;
  }

  // ------------------------------------------------------------------ tokens

  function storeTokens(rt: AppRuntime, body: unknown, via: StoredAccount['via']): StoredAccount {
    if (!isRecord(body) || typeof body.access_token !== 'string') {
      throw new Error('The token response has no access_token.');
    }
    const tokenBody = body as TokenBody;
    let claims: JWTPayload = {};
    try {
      claims = decodeJwt(body.access_token as string);
    } catch {
      // opaque access token: fall back to the account object
    }
    const account = isRecord(tokenBody.account) ? tokenBody.account : null;
    const uuidValue = str(account?.uuid) ?? str(claims.sub);
    if (!uuidValue) throw new Error('The token response identifies no account (no account.uuid and no sub claim).');
    const expiresIn = typeof tokenBody.expires_in === 'number' ? tokenBody.expires_in : 1800;
    const previous = rt.accounts.get(uuidValue);
    const stored: StoredAccount = {
      uuid: uuidValue,
      id: str(account?.id) ?? str(claims.id) ?? null,
      kind: str(account?.kind) ?? str(claims.kind) ?? null,
      membership_id: str(tokenBody.membership_id) ?? str(account?.membership_id) ?? str(claims.mid) ?? null,
      account,
      access_token: body.access_token as string,
      refresh_token: str(tokenBody.refresh_token) ?? null,
      previous_refresh_token: null,
      access_expires_ms: Date.now() + expiresIn * 1000,
      refresh_token_expires_at: str(tokenBody.refresh_token_expires_at) ?? null,
      id_token: str(tokenBody.id_token) ?? null,
      id_token_claims: null,
      id_token_verified: null,
      id_token_error: null,
      scope: str(tokenBody.scope) ?? null,
      via,
      signed_in_at: nowIso(),
      refreshed_at: null,
      refresh_count: 0,
    };
    if (previous && previous.refresh_token && previous.refresh_token !== stored.refresh_token) stored.previous_refresh_token = previous.refresh_token;
    rt.accounts.set(uuidValue, stored);
    return stored;
  }

  async function refreshAccount(rt: AppRuntime, stored: StoredAccount, useToken?: string): Promise<AccountsResponse> {
    const token = useToken ?? stored.refresh_token;
    if (!token) return { status: 0, ok: false, body: null, ms: 0, error: 'No refresh token is stored for this account.' };
    const res = await callAccounts('/v1/oauth/token', { app: rt.app, form: { grant_type: 'refresh_token', refresh_token: token } });
    if (res.ok && isRecord(res.body) && typeof res.body.access_token === 'string') {
      const body = res.body as TokenBody;
      stored.previous_refresh_token = token;
      stored.access_token = res.body.access_token;
      stored.refresh_token = str(body.refresh_token) ?? stored.refresh_token;
      stored.access_expires_ms = Date.now() + (typeof body.expires_in === 'number' ? body.expires_in : 1800) * 1000;
      stored.refresh_token_expires_at = str(body.refresh_token_expires_at) ?? stored.refresh_token_expires_at;
      if (isRecord(body.account)) stored.account = body.account;
      stored.scope = str(body.scope) ?? stored.scope;
      stored.refreshed_at = nowIso();
      stored.refresh_count += 1;
    }
    return res;
  }

  async function ensureFresh(rt: AppRuntime, stored: StoredAccount): Promise<void> {
    if (stored.access_expires_ms - Date.now() > 60_000) return;
    const res = await refreshAccount(rt, stored);
    if (!res.ok) noteError(rt, `refresh for ${stored.uuid} failed: ${res.status} ${JSON.stringify(res.body ?? res.error)}`);
  }

  function view(stored: StoredAccount): SignedInView {
    return {
      uuid: stored.uuid,
      id: stored.id ?? stored.uuid,
      kind: stored.kind ?? 'unknown',
      membership_id: stored.membership_id ?? '(none)',
      account: stored.account ?? { note: 'The token response had no account object.' },
      token: {
        token_type: 'Bearer',
        scope: stored.scope,
        membership_id: stored.membership_id,
        access_token_expires_at: new Date(stored.access_expires_ms).toISOString(),
        has_refresh_token: stored.refresh_token !== null,
        refresh_token_expires_at: stored.refresh_token_expires_at,
        has_id_token: stored.id_token !== null,
        refresh_count: stored.refresh_count,
      },
      id_token: stored.id_token ? { claims: stored.id_token_claims, verified: stored.id_token_verified, error: stored.id_token_error } : null,
      via: stored.via,
    };
  }

  function accountSummary(stored: StoredAccount, includeTokens: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {
      uuid: stored.uuid,
      id: stored.id,
      kind: stored.kind,
      membership_id: stored.membership_id,
      via: stored.via,
      scope: stored.scope,
      signed_in_at: stored.signed_in_at,
      refreshed_at: stored.refreshed_at,
      refresh_count: stored.refresh_count,
      access_token_expires_at: new Date(stored.access_expires_ms).toISOString(),
      has_refresh_token: stored.refresh_token !== null,
      refresh_token_expires_at: stored.refresh_token_expires_at,
      id_token_verified: stored.id_token_verified,
      id_token_error: stored.id_token_error,
      id_token_claims: stored.id_token_claims,
      account: stored.account,
    };
    if (includeTokens) {
      out.tokens = { access_token: stored.access_token, refresh_token: stored.refresh_token, previous_refresh_token: stored.previous_refresh_token, id_token: stored.id_token };
    }
    return out;
  }

  function stateSnapshot(rt: AppRuntime, includeTokens: boolean): Record<string, unknown> {
    return {
      app_id: rt.app.app_id,
      accounts_url: accountsUrl,
      accounts_public_url: publicAccountsCache,
      redirect_uri: `${selfUrl}/${rt.app.app_id}/callback`,
      sessions: rt.sessions.size,
      pending_states: rt.pending.size,
      accounts: [...rt.accounts.values()].map((s) => accountSummary(s, includeTokens)),
      callbacks: [...rt.callbacks].reverse(),
      webhook: { url: `${selfUrl}/${rt.app.app_id}/webhooks`, ...rt.inbox.stats() },
      files: [...rt.files].reverse(),
      pings: [...rt.pings].reverse(),
      proof_checks: [...rt.proofChecks].reverse(),
      errors: [...rt.errors].reverse(),
    };
  }

  // ------------------------------------------------------------- page + flow

  async function renderAppPage(rt: AppRuntime, ctx: Ctx): Promise<void> {
    const sid = ensureSession(rt, ctx);
    const params = signinParams(rt, ctx.query);
    const only = ctx.query.get('only');
    if (only && !['hosted', 'iframe', 'sdk'].includes(only)) throw apiError(422, 'invalid_only', `only must be hosted, iframe or sdk, got "${only}".`);
    const publicUrl = await accountsPublicUrl();
    const hostedPending = !only || only === 'hosted' ? newPending(rt, sid, 'hosted', params) : null;
    const iframePending = !only || only === 'iframe' ? newPending(rt, sid, 'iframe', params) : null;
    const sdkPending = !only || only === 'sdk' ? newPending(rt, sid, 'sdk', params) : null;
    const embedQuery = (p: PendingAuth): string => {
      const q = authorizeQuery(rt, p, params);
      if (params.theme) q.set('theme', params.theme);
      return q.toString();
    };
    const signed = sessionAccount(rt, ctx);
    // The app's own buttons (UNDERSTANDING.md "Adding sign-in to an app"): a Sign up button
    // (intent=signup) and direct "Continue with …" buttons (method=…), each its own sign-in.
    const hostedLink = (extra: Partial<SigninParams>): { url: string; state: string } => {
      const linkParams = { ...params, ...extra };
      const pending = newPending(rt, sid, 'hosted', linkParams);
      return { url: `${publicUrl}/authorize?${authorizeQuery(rt, pending, linkParams).toString()}`, state: pending.state };
    };
    const methods = rt.app.signin_defaults.methods ?? {};
    const order = rt.app.signin_defaults.method_order ?? ['google', 'apple', 'email', 'phone'];
    const direct = hostedPending ? order.filter((m) => methods[m]).map((method) => ({ method, ...hostedLink({ method }) })) : [];
    ctx.sendHtml(
      200,
      appPage({
        app: rt.app,
        accountsPublicUrl: publicUrl,
        signedIn: signed ? view(signed) : null,
        hosted: hostedPending ? { url: `${publicUrl}/authorize?${authorizeQuery(rt, hostedPending, params).toString()}`, state: hostedPending.state, signup: hostedLink({ intent: 'signup' }), direct } : null,
        iframe: iframePending ? { url: `${publicUrl}/embed/v1/buttons?${embedQuery(iframePending)}`, state: iframePending.state } : null,
        sdk: sdkPending ? { attributes: sdkAttributes(rt, sdkPending, params), state: sdkPending.state } : null,
        redirectUri: params.redirect_uri,
      }),
    );
  }

  async function exchangeCode(rt: AppRuntime, code: string, redirectUri: string, verifier: string | null, tamper: string | null): Promise<AccountsResponse> {
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: tamper === 'redirect_uri' ? `${redirectUri}-tampered` : redirectUri,
    };
    if (verifier) form.code_verifier = tamper === 'verifier' ? createPkcePair().code_verifier : verifier;
    rt.lastCode = { code, redirect_uri: redirectUri, code_verifier: verifier };
    const credentials = tamper === 'secret' ? { app_id: rt.app.app_id, secret: `${rt.app.secret}-wrong` } : rt.app;
    return callAccounts('/v1/oauth/token', { app: credentials, form });
  }

  async function completeSignIn(
    rt: AppRuntime,
    input: { code: string; redirect_uri: string; code_verifier: string | null; nonce: string | null; integration: Integration; tamper: string | null; sid: string },
  ): Promise<{ ok: true; stored: StoredAccount; record: CallbackRecord } | { ok: false; status: number; code: string; message: string; details: Record<string, unknown>; record: CallbackRecord }> {
    const res = await exchangeCode(rt, input.code, input.redirect_uri, input.code_verifier, input.tamper);
    const record: CallbackRecord = {
      id: uuid(),
      at: nowIso(),
      integration: input.integration,
      outcome: 'error',
      error: null,
      account_uuid: null,
      account_id: null,
      membership_id: null,
      exchange_ms: res.ms,
    };
    rt.callbacks.push(record);
    trimRecords(rt.callbacks);
    if (!res.ok) {
      const body = isRecord(res.body) ? res.body : {};
      const code = res.status === 0 ? 'accounts_unreachable' : (str(body.error) ?? (isRecord(body.error) ? (str(body.error.code) ?? 'token_exchange_failed') : 'token_exchange_failed'));
      const message =
        res.error ??
        str(body.error_description) ??
        (isRecord(body.error) ? str(body.error.message) : undefined) ??
        `The token endpoint answered HTTP ${res.status} without an error description.`;
      record.error = { code, message, stage: 'token_exchange', status: res.status, response: res.body };
      return { ok: false, status: res.status === 0 ? 502 : 400, code, message, details: { stage: 'token_exchange', token_endpoint_status: res.status, response: res.body }, record };
    }
    let stored: StoredAccount;
    try {
      stored = storeTokens(rt, res.body, input.integration);
    } catch (error) {
      record.error = { code: 'bad_token_response', message: (error as Error).message, stage: 'token_exchange', status: res.status, response: res.body };
      return { ok: false, status: 502, code: 'bad_token_response', message: (error as Error).message, details: { response: res.body }, record };
    }
    if (stored.id_token) {
      const verdict = await verifyIdToken(rt.app, stored.id_token, input.nonce);
      stored.id_token_claims = verdict.claims;
      stored.id_token_verified = verdict.verified;
      stored.id_token_error = verdict.error;
    }
    const session = rt.sessions.get(input.sid);
    if (session) session.account_uuid = stored.uuid;
    record.outcome = 'signed_in';
    record.account_uuid = stored.uuid;
    record.account_id = stored.id;
    record.membership_id = stored.membership_id;
    return { ok: true, stored, record };
  }

  async function callback(rt: AppRuntime, ctx: Ctx): Promise<void> {
    const json = wantsJson(ctx);
    const q = ctx.query;
    const state = q.get('state');
    const code = q.get('code');
    const error = q.get('error');
    const fail = (status: number, codeName: string, message: string, details: Record<string, unknown> = {}): void => {
      if (json) ctx.sendJson(status, { ok: false, error: { code: codeName, message, ...details } });
      else ctx.sendHtml(status, errorPage(rt.app, status, codeName, message, details));
    };
    if (!state) return fail(400, 'missing_state', 'The callback URL has no state parameter, so this sign-in cannot be tied to the browser that started it.');
    const pending = rt.pending.get(state);
    if (!pending) {
      if ((code || error) && !json) {
        // Possibly an SDK-generated state kept in sessionStorage: let the page finish it.
        ensureSession(rt, ctx);
        ctx.sendHtml(200, clientCallbackPage(rt.app));
        return;
      }
      return fail(400, 'unknown_state', `state "${state.slice(0, 12)}…" was not issued by ${rt.app.name} (expired, already used, or forged).`, { stage: 'state_check' });
    }
    const sid = ctx.cookies()[SESSION_COOKIE];
    if (pending.sid !== sid) {
      return fail(
        400,
        'state_session_mismatch',
        `state was issued to another browser session (the ${SESSION_COOKIE} cookie is missing or different). This is exactly what a login-CSRF attempt looks like, so the code is not exchanged.`,
        { stage: 'state_check' },
      );
    }
    rt.pending.delete(state);
    if (error) {
      const record: CallbackRecord = {
        id: uuid(),
        at: nowIso(),
        integration: pending.integration,
        outcome: 'error',
        error: { code: error, message: q.get('error_description') ?? describeAuthorizeError(error), stage: 'authorize' },
        account_uuid: null,
        account_id: null,
        membership_id: null,
        exchange_ms: null,
      };
      rt.callbacks.push(record);
      trimRecords(rt.callbacks);
      return fail(400, error, record.error?.message ?? error, { stage: 'authorize' });
    }
    if (!code) return fail(400, 'missing_code', 'The callback has neither a code nor an error.', { stage: 'callback' });
    const result = await completeSignIn(rt, {
      code,
      redirect_uri: pending.redirect_uri,
      code_verifier: pending.code_verifier,
      nonce: pending.nonce,
      integration: pending.integration,
      tamper: pending.tamper,
      sid: pending.sid,
    });
    if (!result.ok) return fail(result.status, result.code, result.message, result.details);
    if (json) ctx.sendJson(200, { ok: true, callback_id: result.record.id, ...view(result.stored) });
    else ctx.sendHtml(200, signedInPage(rt.app, view(result.stored)));
  }

  async function clientCallback(rt: AppRuntime, ctx: Ctx): Promise<void> {
    const body = await jsonObject(ctx);
    const sid = ensureSession(rt, ctx);
    if (str(body.error)) {
      ctx.sendJson(400, { error: { code: str(body.error), message: str(body.error_description) ?? describeAuthorizeError(str(body.error) ?? ''), stage: 'authorize' } });
      return;
    }
    if (body.found !== true) {
      ctx.sendJson(400, {
        error: {
          code: 'unknown_state',
          message: `The state in the callback was neither issued by ${rt.app.name}'s server nor found in this browser's sessionStorage, so the sign-in cannot be tied to this browser.`,
          stage: 'state_check',
        },
      });
      return;
    }
    const code = str(body.code);
    if (!code) {
      ctx.sendJson(400, { error: { code: 'missing_code', message: 'The callback has no code.', stage: 'callback' } });
      return;
    }
    const result = await completeSignIn(rt, {
      code,
      redirect_uri: str(body.redirect_uri) ?? `${selfUrl}/${rt.app.app_id}/callback`,
      code_verifier: str(body.code_verifier) ?? null,
      nonce: str(body.nonce) ?? null,
      integration: 'sdk',
      tamper: null,
      sid,
    });
    if (!result.ok) {
      ctx.sendJson(result.status, { error: { code: result.code, message: result.message, ...result.details } });
      return;
    }
    ctx.sendJson(200, { ok: true, redirect: `/${rt.app.app_id}/signed-in?callback=${result.record.id}` });
  }

  // ---------------------------------------------------------------- webhooks

  function sink(key: string | undefined): WebhookInbox {
    if (!key || !/^[A-Za-z0-9._:-]{1,100}$/.test(key)) {
      throw apiError(422, 'invalid_hook_key', `Webhook sink keys are 1-100 characters of [A-Za-z0-9._:-], got "${key ?? ''}".`);
    }
    let inbox = sinks.get(key);
    if (!inbox) {
      inbox = new WebhookInbox({ name: `hook ${key}`, secret: null, toleranceSeconds: tolerance });
      sinks.set(key, inbox);
    }
    return inbox;
  }

  /** Shared inspection/control routes for an app's webhook and for generic sinks. */
  function inboxRoutes(prefix: string, resolve: (ctx: Ctx) => WebhookInbox, describe: (ctx: Ctx) => string): void {
    router.post(`${prefix}/_webhook-secret`, async (ctx) => {
      const inbox = resolve(ctx);
      const body = await jsonObject(ctx);
      const secret = body.secret === null ? null : str(body.secret);
      if (secret === undefined) throw apiError(422, 'invalid_secret', 'Send {"secret":"whsec_…"} (or null to forget it).');
      const { recovered } = inbox.setSecret(secret, body.keep_previous === true);
      ctx.sendJson(200, { ok: true, secret_set: secret !== null, previous_secret_set: inbox.previous !== null, recovered });
    });
    router.post(`${prefix}/_webhook-faults`, async (ctx) => {
      const inbox = resolve(ctx);
      const body = await jsonObject(ctx);
      const failNext = typeof body.fail_next === 'number' ? Math.floor(body.fail_next) : 1;
      const status = typeof body.status === 'number' ? body.status : 500;
      if (status < 200 || status > 599) throw apiError(422, 'invalid_status', `status must be an HTTP status, got ${status}.`);
      inbox.setFault(failNext, status, typeof body.delay_ms === 'number' ? Math.max(0, body.delay_ms) : 0);
      ctx.sendJson(200, { ok: true, fail_next: Math.max(0, failNext), status });
    });
    router.get(`${prefix}/_events`, (ctx) => ctx.sendJson(200, resolve(ctx).list(ctx.query)));
    router.get(`${prefix}/_events/wait`, async (ctx) => {
      const inbox = resolve(ctx);
      const timeoutMs = Math.max(0, Math.min(120_000, Number.parseInt(ctx.query.get('timeout_ms') ?? '15000', 10) || 15_000));
      const found = await inbox.wait(ctx.query, timeoutMs, ctx.signal);
      if (ctx.signal.aborted) return;
      if (!found) {
        throw apiError(
          408,
          'timeout',
          `No webhook event matching ${ctx.url.search || '(no filter)'} reached ${describe(ctx)} within ${timeoutMs} ms.`,
          `GET ${ctx.path.replace(/\/wait$/, '')}?include_rejected=1 shows deliveries that were refused (bad signature, faults).`,
        );
      }
      ctx.sendJson(200, found);
    });
    router.delete(`${prefix}/_events`, (ctx) => {
      resolve(ctx).clear();
      ctx.noContent();
    });
  }

  // ------------------------------------------------------------------ proofs

  function proofFromHeader(ctx: Ctx): string | null {
    return /^Proof\s+(\S+)\s*$/i.exec(ctx.header('authorization') ?? '')?.[1] ?? null;
  }

  async function checkProof(rt: AppRuntime, ctx: Ctx, endpoint: string): Promise<{ verification: Record<string, unknown>; verify_ms: number } | null> {
    const token = proofFromHeader(ctx);
    if (!token) {
      ctx.sendJson(401, { error: { code: 'missing_proof', message: `${rt.app.name} needs "Authorization: Proof <proof_token>" on ${endpoint}.` } });
      return null;
    }
    const res = await callAccounts('/v1/proofs/verify', { app: rt.app, json: { proof_token: token } });
    if (!res.ok || !isRecord(res.body)) {
      ctx.sendJson(502, { error: { code: 'verify_failed', message: res.error ?? `POST /v1/proofs/verify answered HTTP ${res.status}.`, status: res.status, response: res.body }, verify_ms: res.ms });
      return null;
    }
    const verification = res.body;
    const issuing = isRecord(verification.issuing_app) ? str(verification.issuing_app.app_id) : undefined;
    const user = isRecord(verification.user) ? str(verification.user.uuid) : undefined;
    rt.proofChecks.push({ at: nowIso(), endpoint, valid: verification.valid === true, kind: str(verification.kind) ?? null, issuing_app: issuing ?? null, user_uuid: user ?? null, verify_ms: res.ms });
    trimRecords(rt.proofChecks);
    if (verification.valid !== true) {
      ctx.sendJson(403, { error: { code: 'invalid_proof', message: `Silicon Accounts says this proof is not valid for ${rt.app.app_id}.` }, verification, verify_ms: res.ms });
      return null;
    }
    return { verification, verify_ms: res.ms };
  }

  function proofSummary(body: unknown): Record<string, unknown> | null {
    if (!isRecord(body)) return null;
    const { proof_token: _a, proof_refresh_token: _b, ...rest } = body;
    return rest;
  }

  async function selfPost(path: string, proofToken: string, payload: unknown): Promise<{ status: number; body: unknown; ms: number }> {
    const started = performance.now();
    const res = await fetchImpl(`${internalUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Proof ${proofToken}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, ms: roundMs(performance.now() - started) };
  }

  // ------------------------------------------------------------------ routes

  router.get('/_health', (ctx) => ctx.sendJson(200, { ok: true, service: 'fake-app-server', apps: [...runtimes.keys()], accounts_url: accountsUrl }));

  router.get('/', async (ctx) => {
    if (wantsJson(ctx)) {
      ctx.sendJson(200, {
        service: 'fake-app-server',
        accounts_url: accountsUrl,
        apps: apps.map((a) => ({ app_id: a.app_id, name: a.name, url: `${selfUrl}/${a.app_id}/`, callback: `${selfUrl}/${a.app_id}/callback`, webhooks: `${selfUrl}/${a.app_id}/webhooks` })),
      });
      return;
    }
    ctx.sendHtml(200, indexPage(apps, await accountsPublicUrl()));
  });

  router.get('/_apps', (ctx) =>
    ctx.sendJson(200, {
      items: apps.map((a) => ({ app_id: a.app_id, name: a.name, owner_id: a.owner_id, redirect_uri: `${selfUrl}/${a.app_id}/callback`, webhook_url: `${selfUrl}/${a.app_id}/webhooks`, testkit: a.testkit })),
    }),
  );

  router.get('/_config', async (ctx) => ctx.sendJson(200, { url: selfUrl, accounts_url: accountsUrl, accounts_public_url: await accountsPublicUrl(), webhook_tolerance_seconds: tolerance }));

  router.delete('/_state', (ctx) => {
    server.reset();
    ctx.noContent();
  });

  router.get('/hooks', (ctx) => ctx.sendJson(200, { items: [...sinks.entries()].map(([key, inbox]) => ({ key, url: `${selfUrl}/hooks/${key}`, ...inbox.stats() })) }));
  router.post('/hooks/:key', (ctx) => sink(ctx.params.key).receive(ctx), { bodyLimit: 1024 * 1024 });
  inboxRoutes('/hooks/:key', (ctx) => sink(ctx.params.key), (ctx) => `hook ${ctx.params.key}`);
  router.delete('/hooks', (ctx) => {
    sinks.clear();
    ctx.noContent();
  });

  router.get('/:app/', (ctx) => renderAppPage(runtime(ctx.params.app), ctx));

  router.get('/:app/authorize-url', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const sid = ensureSession(rt, ctx);
    const params = signinParams(rt, ctx.query);
    const integration = (ctx.query.get('integration') ?? 'api') as Integration;
    if (!['hosted', 'iframe', 'sdk', 'api'].includes(integration)) throw apiError(422, 'invalid_integration', 'integration must be hosted, iframe, sdk or api.');
    const pending = newPending(rt, sid, integration, params);
    const publicUrl = await accountsPublicUrl();
    const q = authorizeQuery(rt, pending, params);
    ctx.sendJson(200, {
      authorize_url: `${publicUrl}/authorize?${q.toString()}`,
      embed_url: `${publicUrl}/embed/v1/buttons?${q.toString()}`,
      state: pending.state,
      code_verifier: pending.code_verifier,
      code_challenge: pending.code_challenge,
      nonce: pending.nonce,
      redirect_uri: pending.redirect_uri,
      session_cookie: `${SESSION_COOKIE}=${sid}`,
    });
  });

  router.get('/:app/callback', (ctx) => callback(runtime(ctx.params.app), ctx));
  router.post('/:app/callback/client', (ctx) => clientCallback(runtime(ctx.params.app), ctx));

  router.get('/:app/signed-in', (ctx) => {
    const rt = runtime(ctx.params.app);
    const callbackId = ctx.query.get('callback');
    let stored = sessionAccount(rt, ctx);
    if (callbackId) {
      const record = rt.callbacks.find((c) => c.id === callbackId);
      if (record?.account_uuid) stored = rt.accounts.get(record.account_uuid) ?? stored;
    }
    if (!stored) {
      ctx.sendHtml(401, errorPage(rt.app, 401, 'not_signed_in', `Nobody is signed in to ${rt.app.name} in this browser.`));
      return;
    }
    if (wantsJson(ctx)) ctx.sendJson(200, view(stored));
    else ctx.sendHtml(200, signedInPage(rt.app, view(stored)));
  });

  router.get('/:app/me', (ctx) => {
    const rt = runtime(ctx.params.app);
    const stored = sessionAccount(rt, ctx);
    if (!stored) throw apiError(401, 'not_signed_in', `Nobody is signed in to ${rt.app.name} in this browser session.`);
    ctx.sendJson(200, view(stored));
  });

  router.post('/:app/logout', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const stored = sessionAccount(rt, ctx);
    let revoke: AccountsResponse | null = null;
    if (stored) {
      revoke = await callAccounts('/v1/oauth/revoke', { app: rt.app, form: { token: stored.refresh_token ?? stored.access_token } });
      rt.accounts.delete(stored.uuid);
    }
    const sid = ctx.cookies()[SESSION_COOKIE];
    const session = sid ? rt.sessions.get(sid) : undefined;
    if (session) session.account_uuid = null;
    if (wantsJson(ctx) || ctx.contentType() === 'application/json') {
      ctx.sendJson(200, { ok: true, signed_out: stored?.uuid ?? null, revoke_status: revoke?.status ?? null });
    } else {
      ctx.redirect(`/${rt.app.app_id}/`, 303);
    }
  });

  router.post('/:app/slt-login', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const params = ctx.contentType() === 'application/x-www-form-urlencoded' ? Object.fromEntries(await ctx.form()) : await jsonObject(ctx);
    const slt = str(params.slt);
    if (!slt) throw apiError(422, 'missing_slt', 'Send {"slt":"slt_…"} — the short-lived token from `silicon-accounts login --app <app_id>`.');
    const res = await callAccounts('/v1/oauth/token', { app: rt.app, form: { grant_type: 'urn:silicon:params:oauth:grant-type:slt', slt } });
    if (!res.ok) {
      ctx.sendJson(res.status === 0 ? 502 : res.status, { ok: false, status: res.status, error: res.body ?? res.error });
      return;
    }
    const stored = storeTokens(rt, res.body, 'slt');
    ctx.sendJson(200, { ok: true, exchange_ms: res.ms, ...view(stored), ...(ctx.query.get('include_tokens') === '1' ? { tokens: { access_token: stored.access_token, refresh_token: stored.refresh_token } } : {}) });
  });

  router.post('/:app/refresh', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const body = await jsonObject(ctx);
    const target = str(body.uuid) ?? sessionAccount(rt, ctx)?.uuid;
    const stored = target ? rt.accounts.get(target) : undefined;
    if (!stored) throw apiError(404, 'not_signed_in', `${rt.app.name} holds no tokens for account ${target ?? '(none)'}.`);
    const reuse = body.reuse_previous === true;
    if (reuse && !stored.previous_refresh_token) throw apiError(409, 'no_previous_token', 'There is no already-used refresh token to replay yet; refresh once first.');
    const res = await refreshAccount(rt, stored, reuse ? (stored.previous_refresh_token ?? undefined) : undefined);
    ctx.sendJson(res.ok ? 200 : res.status === 0 ? 502 : res.status, { ok: res.ok, status: res.status, reused_previous: reuse, ...(res.ok ? { account: accountSummary(stored, false) } : { error: res.body ?? res.error }) });
  });

  router.get('/:app/userinfo', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const target = ctx.query.get('uuid') ?? sessionAccount(rt, ctx)?.uuid;
    const stored = target ? rt.accounts.get(target) : undefined;
    if (!stored) throw apiError(404, 'not_signed_in', `${rt.app.name} holds no tokens for account ${target ?? '(none)'}.`);
    await ensureFresh(rt, stored);
    const res = await callAccounts('/v1/userinfo', { bearer: stored.access_token });
    ctx.sendJson(res.status === 0 ? 502 : 200, { status: res.status, body: res.body ?? res.error, ms: res.ms });
  });

  router.post('/:app/webhooks', (ctx) => runtime(ctx.params.app).inbox.receive(ctx), { bodyLimit: 1024 * 1024 });
  inboxRoutes('/:app', (ctx) => runtime(ctx.params.app).inbox, (ctx) => `${ctx.params.app}'s webhook`);

  router.post('/:app/_connect-webhook', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const body = ctx.contentType() === 'application/json' ? await jsonObject(ctx) : {};
    const url = str(body.url) ?? `${selfUrl}/${rt.app.app_id}/webhooks`;
    const res = await callAccounts(`/v1/apps/${encodeURIComponent(rt.app.app_id)}/webhook`, { method: 'PUT', app: rt.app, json: { url } });
    if (!res.ok || !isRecord(res.body)) {
      ctx.sendJson(res.status === 0 ? 502 : res.ok ? 502 : res.status, { ok: false, status: res.status, error: res.body ?? res.error });
      return;
    }
    // Setting the URL keeps a stored secret (secret null); a fresh one comes from a rotation.
    let secret = typeof res.body.secret === 'string' ? res.body.secret : null;
    if (secret === null) {
      const rotated = await callAccounts(`/v1/apps/${encodeURIComponent(rt.app.app_id)}/webhook/rotate-secret`, { method: 'POST', app: rt.app, json: {} });
      if (!rotated.ok || !isRecord(rotated.body) || typeof rotated.body.secret !== 'string') {
        ctx.sendJson(rotated.status === 0 ? 502 : rotated.ok ? 502 : rotated.status, { ok: false, status: rotated.status, error: rotated.body ?? rotated.error });
        return;
      }
      secret = rotated.body.secret;
    }
    const { recovered } = rt.inbox.setSecret(secret);
    ctx.sendJson(200, { ok: true, url: res.body.url ?? url, secret_set: true, recovered });
  });

  router.get('/:app/_state', (ctx) => ctx.sendJson(200, stateSnapshot(runtime(ctx.params.app), ctx.query.get('include_tokens') === '1')));
  router.delete('/:app/_state', (ctx) => {
    server.reset(runtime(ctx.params.app).app.app_id);
    ctx.noContent();
  });

  router.post('/:app/_replay-last-code', async (ctx) => {
    const rt = runtime(ctx.params.app);
    if (!rt.lastCode) throw apiError(409, 'no_code_yet', `${rt.app.name} has not exchanged a code yet.`);
    const res = await callAccounts('/v1/oauth/token', {
      app: rt.app,
      form: { grant_type: 'authorization_code', code: rt.lastCode.code, redirect_uri: rt.lastCode.redirect_uri, ...(rt.lastCode.code_verifier ? { code_verifier: rt.lastCode.code_verifier } : {}) },
    });
    ctx.sendJson(200, { status: res.status, body: res.body ?? res.error });
  });

  router.post('/:app/api/files', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const checked = await checkProof(rt, ctx, `POST /${rt.app.app_id}/api/files`);
    if (!checked) return;
    const body = await jsonObject(ctx).catch(() => ({}) as Record<string, unknown>);
    const user = isRecord(checked.verification.user) ? checked.verification.user : null;
    const issuing = isRecord(checked.verification.issuing_app) ? checked.verification.issuing_app : null;
    const file = {
      id: uuid(),
      filename: str(body.filename) ?? 'untitled.txt',
      owner: user ? { uuid: user.uuid, id: user.id, membership_id: user.membership_id } : null,
      uploaded_by_app: issuing?.app_id ?? null,
      proof_id: checked.verification.proof_id ?? null,
      scopes: checked.verification.scopes ?? [],
      created_at: nowIso(),
    };
    rt.files.push(file);
    trimRecords(rt.files);
    ctx.sendJson(201, { file, verification: checked.verification, verify_ms: checked.verify_ms });
  });

  router.get('/:app/api/files', (ctx) => {
    const rt = runtime(ctx.params.app);
    const owner = ctx.query.get('owner');
    ctx.sendJson(200, { items: rt.files.filter((f) => !owner || (isRecord(f.owner) && f.owner.uuid === owner)).reverse() });
  });

  router.post('/:app/api/ping', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const checked = await checkProof(rt, ctx, `POST /${rt.app.app_id}/api/ping`);
    if (!checked) return;
    const body = await jsonObject(ctx).catch(() => ({}) as Record<string, unknown>);
    const issuing = isRecord(checked.verification.issuing_app) ? str(checked.verification.issuing_app.app_id) : undefined;
    const ping = { id: uuid(), at: nowIso(), from: issuing ?? null, kind: checked.verification.kind ?? null, message: str(body.message) ?? null, proof_id: checked.verification.proof_id ?? null };
    rt.pings.push(ping);
    trimRecords(rt.pings);
    ctx.sendJson(200, { ok: true, app: rt.app.app_id, ping, verification: checked.verification, verify_ms: checked.verify_ms });
  });

  router.post('/:app/api/verify-proof', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const body = await jsonObject(ctx);
    const token = str(body.proof_token);
    if (!token) throw apiError(422, 'missing_proof_token', 'Send {"proof_token":"sap_…"}.');
    const res = await callAccounts('/v1/proofs/verify', { app: rt.app, json: { proof_token: token } });
    ctx.sendJson(res.status === 0 ? 502 : 200, { status: res.status, verification: res.body ?? res.error, verify_ms: res.ms });
  });

  router.post('/:app/actions/issue-user_verification', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const body = await jsonObject(ctx);
    const stored = rt.accounts.get(str(body.uuid) ?? '');
    if (!stored) throw apiError(404, 'not_signed_in', `${rt.app.name} holds no tokens for account ${str(body.uuid) ?? '(none)'}; sign in to ${rt.app.app_id} first.`);
    await ensureFresh(rt, stored);
    const res = await callAccounts('/v1/proofs/user-verification', {
      app: rt.app,
      json: { subject_token: stored.access_token, receiving_app: str(body.receiving_app) ?? 'briefcase', ...(Array.isArray(body.scopes) ? { scopes: body.scopes } : {}), ...(typeof body.access_ttl_seconds === 'number' ? { access_ttl_seconds: body.access_ttl_seconds } : {}) },
      headers: { 'Idempotency-Key': str(body.idempotency_key) ?? uuid() },
    });
    ctx.sendJson(res.status === 0 ? 502 : res.status, { status: res.status, body: res.body ?? res.error, issue_ms: res.ms });
  });

  // An app verification proof is for exactly one app: {"receiving_app": "remind"} (default: the app's first App verification receiver).
  router.post('/:app/actions/issue-app_verification', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const body = await jsonObject(ctx);
    const receiving = str(body.receiving_app) ?? rt.app.testkit?.proofs.app_verification_issuer_to[0];
    if (!receiving) throw apiError(422, 'no_receiving_app', `${rt.app.name} has no App verification receiver configured; send {"receiving_app":"remind"}.`);
    const res = await callAccounts('/v1/proofs/app-verification', {
      app: rt.app,
      json: { receiving_app: receiving, ...(Array.isArray(body.scopes) ? { scopes: body.scopes } : {}), ...(typeof body.access_ttl_seconds === 'number' ? { access_ttl_seconds: body.access_ttl_seconds } : {}) },
      headers: { 'Idempotency-Key': str(body.idempotency_key) ?? uuid() },
    });
    ctx.sendJson(res.status === 0 ? 502 : res.status, { status: res.status, body: res.body ?? res.error, issue_ms: res.ms });
  });

  // User verification demo: dm saves a file into Briefcase on behalf of a Carbon or Silicon signed in to dm.
  router.post('/:app/actions/save-to-briefcase', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const started = performance.now();
    const body = await jsonObject(ctx);
    const target = str(body.uuid) ?? sessionAccount(rt, ctx)?.uuid;
    const stored = target ? rt.accounts.get(target) : undefined;
    if (!stored) {
      throw apiError(404, 'not_signed_in', `${rt.app.name} holds no tokens for account ${target ?? '(none)'}.`, `Sign in to ${rt.app.app_id} first (hosted flow, or POST /${rt.app.app_id}/slt-login for a Silicon).`);
    }
    const receiving = str(body.receiving_app) ?? 'briefcase';
    await ensureFresh(rt, stored);
    const issue = await callAccounts('/v1/proofs/user-verification', {
      app: rt.app,
      json: {
        subject_token: stored.access_token,
        receiving_app: receiving,
        scopes: Array.isArray(body.scopes) ? body.scopes : ['files.write'],
        access_ttl_seconds: typeof body.access_ttl_seconds === 'number' ? body.access_ttl_seconds : 600,
      },
      headers: { 'Idempotency-Key': uuid() },
    });
    if (issue.status !== 201 && issue.status !== 200) {
      ctx.sendJson(502, { ok: false, stage: 'issue', status: issue.status, error: issue.body ?? issue.error, timings: { issue_ms: issue.ms, total_ms: roundMs(performance.now() - started) } });
      return;
    }
    const proofToken = isRecord(issue.body) ? str(issue.body.proof_token) : undefined;
    if (!proofToken) {
      ctx.sendJson(502, { ok: false, stage: 'issue', error: 'POST /v1/proofs/user-verification returned no proof_token.', response: issue.body });
      return;
    }
    if (!runtimes.has(receiving)) {
      ctx.sendJson(422, { ok: false, stage: 'deliver', error: `${receiving} is not hosted by this fake app server, so the proof cannot be presented to it.`, proof: proofSummary(issue.body) });
      return;
    }
    const call = await selfPost(`/${receiving}/api/files`, proofToken, { filename: str(body.filename) ?? 'notes.txt' });
    const callBody = isRecord(call.body) ? call.body : {};
    const verifyMs = typeof callBody.verify_ms === 'number' ? callBody.verify_ms : null;
    ctx.sendJson(call.status === 201 ? 200 : 502, {
      ok: call.status === 201,
      file: callBody.file ?? null,
      proof: proofSummary(issue.body),
      verification: callBody.verification ?? null,
      receiver_response: call.status === 201 ? undefined : callBody,
      timings: { issue_ms: issue.ms, verify_ms: verifyMs, call_ms: call.ms, total_ms: roundMs(performance.now() - started) },
    });
  });

  // App verification demo: an app verification proof is for exactly one app, so commit gets one proof for remind and
  // another for waveform (issued in parallel), then pings each app with its own proof.
  router.post('/:app/actions/notify', async (ctx) => {
    const rt = runtime(ctx.params.app);
    const started = performance.now();
    const body = ctx.contentType() === 'application/json' ? await jsonObject(ctx) : {};
    const audiences = (Array.isArray(body.audiences) ? body.audiences.filter((a): a is string => typeof a === 'string') : rt.app.testkit?.proofs.app_verification_issuer_to) ?? [];
    if (audiences.length === 0) throw apiError(422, 'no_audiences', `${rt.app.name} has no App verification receivers configured; send {"audiences":["remind","waveform"]} (one proof is made per app).`);
    const message = str(body.message) ?? `${rt.app.name}: something is due`;
    const proofs: Record<string, unknown> = {};
    const results: Record<string, unknown> = {};
    const issueTimes: Record<string, number | null> = {};
    const verifyTimes: Record<string, number | null> = {};
    await Promise.all(
      audiences.map(async (audience) => {
        const issue = await callAccounts('/v1/proofs/app-verification', {
          app: rt.app,
          json: {
            receiving_app: audience,
            scopes: Array.isArray(body.scopes) ? body.scopes : ['notifications.send'],
            access_ttl_seconds: typeof body.access_ttl_seconds === 'number' ? body.access_ttl_seconds : 300,
          },
          headers: { 'Idempotency-Key': uuid() },
        });
        issueTimes[audience] = issue.ms;
        const proofToken = isRecord(issue.body) ? str(issue.body.proof_token) : undefined;
        if ((issue.status !== 201 && issue.status !== 200) || !proofToken) {
          results[audience] = { ok: false, stage: 'issue', status: issue.status, error: issue.body ?? issue.error };
          verifyTimes[audience] = null;
          return;
        }
        proofs[audience] = proofSummary(issue.body);
        if (!runtimes.has(audience)) {
          results[audience] = { ok: false, stage: 'deliver', error: `${audience} is not hosted by this fake app server.` };
          verifyTimes[audience] = null;
          return;
        }
        const call = await selfPost(`/${audience}/api/ping`, proofToken, { message });
        const callBody = isRecord(call.body) ? call.body : {};
        verifyTimes[audience] = typeof callBody.verify_ms === 'number' ? callBody.verify_ms : null;
        results[audience] = { ok: call.status === 200, status: call.status, verification: callBody.verification ?? null, verify_ms: verifyTimes[audience], ...(call.status === 200 ? {} : { response: callBody }) };
      }),
    );
    const allOk = Object.values(results).every((r) => isRecord(r) && r.ok === true);
    ctx.sendJson(allOk ? 200 : 502, {
      ok: allOk,
      proofs,
      results,
      timings: { issue_ms: issueTimes, verify_ms: verifyTimes, total_ms: roundMs(performance.now() - started) },
    });
  });

  const running = await serve(router, { name: 'fake-app-server', port: options.port ?? DEFAULT_FAKE_APPS_PORT, host: options.host ?? '127.0.0.1', log: options.log ?? false });
  internalUrl = running.url;
  selfUrl = (options.publicUrl ?? process.env.FAKE_APPS_PUBLIC_URL ?? running.url).replace(/\/+$/, '');

  const server: FakeAppServer = {
    url: selfUrl,
    port: running.port,
    accountsUrl,
    apps: [...runtimes.keys()],
    state(appId: string, includeTokens = false) {
      return stateSnapshot(runtime(appId), includeTokens);
    },
    setWebhookSecret(appId: string, secret: string | null) {
      runtime(appId).inbox.setSecret(secret);
    },
    reset(appId?: string) {
      for (const app of apps) {
        if (appId && app.app_id !== appId) continue;
        runtimes.set(app.app_id, freshRuntime(app));
      }
      if (!appId) sinks.clear();
    },
    stop: () => running.stop(),
  };
  return server;
}

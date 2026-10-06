// mock-oidc — a local stand-in for "Sign in with Google" (under /google) and
// "Sign in with Apple" (under /apple). It behaves like the real providers in the
// ways Silicon Accounts depends on, and is strict where the real ones are strict,
// so protocol mistakes in Accounts fail loudly here instead of in production:
//
//  - authorize validates the client, redirect_uri, response_type, scope, state,
//    nonce and (Google) PKCE S256; Apple answers with response_mode=form_post and
//    sends the `user` JSON only on the identity's first authorization of a client.
//  - token checks client_secret (Google, form or HTTP Basic) or verifies Apple's
//    ES256 client_secret JWT against the registered p8 public key
//    (iss=team_id, sub=client_id, aud=<this mock's Apple issuer>, exp), the code,
//    redirect_uri and PKCE verifier, then returns an RS256 id_token.
//  - every authorize/token call is logged (GET /_requests) so tests can assert
//    which client id Accounts used (managed vs bring-your-own).
//  - test controls: identity registry, client registry, queued selections,
//    fault injection (errors, delays, tampered id_tokens) and key rotation.

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { SignJWT, decodeProtectedHeader, errors as joseErrors, exportJWK, jwtVerify, type JWK, type JWTPayload } from 'jose';
import { apiError, jsonObject, Router, serve, type Ctx } from './shared/http.ts';
import { page } from './shared/page.ts';
import {
  b64url,
  escapeHtml,
  isRecord,
  nowIso,
  nowSeconds,
  parseBasicAuth,
  randomDigits,
  randomHex,
  randomToken,
  safeEqual,
  sha256,
  sleep,
  str,
  uuid,
} from './shared/util.ts';

export type Provider = 'google' | 'apple';
export const PROVIDERS: readonly Provider[] = ['google', 'apple'];
export const DEFAULT_MOCK_OIDC_PORT = 8591;

export interface OidcIdentity {
  provider: Provider;
  sub: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  given_name: string | null;
  family_name: string | null;
  /** Google only: https URL of the profile picture. */
  picture: string | null;
  /** Apple only: the email is a private relay address. */
  is_private_email: boolean;
  /** Google only: hosted (Workspace) domain claim. */
  hd: string | null;
  locale: string | null;
  created_at: string;
}

export type OidcIdentityInput = Partial<Omit<OidcIdentity, 'provider' | 'email' | 'created_at'>> & {
  provider: Provider;
  email: string;
};

export interface OidcClientInput {
  provider: Provider;
  client_id: string;
  /** Google: the client secret. */
  client_secret?: string | null;
  /** Apple: 10-character team id (iss of the client_secret JWT). */
  team_id?: string | null;
  /** Apple: key id of the p8 key (kid of the client_secret JWT). */
  key_id?: string | null;
  /** Apple: SPKI PEM of the p8 key. `private_key_pem` is also accepted and the public key derived. */
  public_key_pem?: string | null;
  private_key_pem?: string | null;
  /** Optional allow-list; when empty any absolute http(s) redirect_uri is accepted. */
  redirect_uris?: string[] | null;
  /** Name shown on the consent screen ("to continue to …"). BYO clients show the app's own name. */
  display_name?: string | null;
  logo_url?: string | null;
  /** Free-form tag shown in the request log, e.g. "managed" or "byo:acme-notes". */
  label?: string | null;
}

interface StoredClient {
  provider: Provider;
  client_id: string;
  client_secret: string | null;
  team_id: string | null;
  key_id: string | null;
  public_key: KeyObject | null;
  public_key_pem: string | null;
  redirect_uris: string[];
  display_name: string | null;
  logo_url: string | null;
  label: string | null;
  created_at: string;
}

export interface SigningKeyInput {
  kid: string;
  private_key_pem: string;
}

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: JWK;
}

interface AuthCode {
  provider: Provider;
  client_id: string;
  redirect_uri: string;
  sub: string;
  nonce: string | null;
  scopes: string[];
  code_challenge: string | null;
  code_challenge_method: string | null;
  first_authorization: boolean;
  created_ms: number;
  expires_ms: number;
  used_ms: number | null;
}

interface AccessTokenRecord {
  provider: Provider;
  client_id: string;
  sub: string;
  scopes: string[];
  expires_ms: number;
}

export type FaultEndpoint = 'authorize' | 'token' | 'jwks' | 'userinfo';

export interface IdTokenTamper {
  /** Claims merged over the real ones, e.g. {"nonce":"wrong"} or {"aud":"someone-else"}. */
  claims?: Record<string, unknown>;
  /** Claims removed from the id_token, e.g. ["nonce"]. */
  remove_claims?: string[];
  /** Issue an already-expired id_token. */
  expired?: boolean;
  /** "unknown_key" signs with a key that is not in the JWKS; "none" produces an unsigned alg=none token. */
  sign_with?: 'unknown_key' | 'none';
}

export interface OidcFault {
  id: string;
  provider: Provider | null;
  endpoint: FaultEndpoint;
  remaining: number;
  status: number | null;
  error: string | null;
  error_description: string | null;
  delay_ms: number;
  id_token: IdTokenTamper | null;
  created_at: string;
}

export interface OidcRequestLogEntry {
  seq: number;
  id: string;
  at: string;
  provider: Provider;
  endpoint: 'authorize' | 'token' | 'jwks' | 'userinfo' | 'revoke' | 'discovery';
  method: string;
  client_id: string | null;
  client_label: string | null;
  status: number;
  outcome: string;
  error: string | null;
  error_description: string | null;
  identity: { sub: string; email: string } | null;
  selected_by: string | null;
  auth_method: string | null;
  /** Apple only: non-secret header/claims of the client_secret JWT that was presented. */
  client_secret_jwt: { kid: string | null; iss: string | null; sub: string | null; aud: unknown } | null;
  params: Record<string, string | boolean | null>;
  fault_id: string | null;
}

interface NextSelection {
  email: string | null;
  sub: string | null;
  name: string | null;
  error: string | null;
}

export interface MockOidcOptions {
  /** Port to listen on (default 8591; 0 = any free port). */
  port?: number;
  host?: string;
  /** Public base URL used for issuers and endpoints (default http://<host>:<port>). */
  publicUrl?: string;
  /** Clients registered at startup (and restored by POST /_reset). */
  clients?: OidcClientInput[];
  /** Identities registered at startup in addition to (or instead of) the defaults. */
  identities?: OidcIdentityInput[];
  /** Include the built-in identities (default true). */
  includeDefaultIdentities?: boolean;
  /** Stable signing keys so restarts keep the same `kid`; generated when absent. */
  signingKeys?: Partial<Record<Provider, SigningKeyInput>>;
  /**
   * Strict mode (default true) requires what Silicon Accounts always sends: state and
   * nonce on both providers, PKCE S256 and the openid scope for Google.
   */
  strict?: boolean;
  log?: boolean | ((line: string) => void);
}

export interface MockOidc {
  url: string;
  port: number;
  issuer: Record<Provider, string>;
  endpoints(provider: Provider): { issuer: string; authorize: string; token: string; jwks: string; userinfo: string | null; discovery: string };
  registerClient(client: OidcClientInput): void;
  registerIdentity(identity: OidcIdentityInput): OidcIdentity;
  identities(provider?: Provider): OidcIdentity[];
  requests(filter?: { provider?: Provider; endpoint?: string; client_id?: string }): OidcRequestLogEntry[];
  reset(): void;
  stop(): Promise<void>;
}

/** The identities every fresh mock knows about. E2E tests should register their own random ones. */
export const DEFAULT_IDENTITIES: OidcIdentityInput[] = [
  {
    provider: 'google',
    sub: '104729573829461530001',
    email: 'ada.lovelace@example.test',
    name: 'Ada Lovelace',
    given_name: 'Ada',
    family_name: 'Lovelace',
    picture: 'https://lh3.googleusercontent.com/a/default-user=s96-c',
    locale: 'en-GB',
  },
  {
    provider: 'google',
    sub: '104729573829461530002',
    email: 'grace.hopper@university.test',
    name: 'Grace Hopper',
    given_name: 'Grace',
    family_name: 'Hopper',
    hd: 'university.test',
  },
  {
    provider: 'google',
    sub: '104729573829461530003',
    email: 'alan.turing@example.test',
    name: 'Alan Turing',
    given_name: 'Alan',
    family_name: 'Turing',
  },
  {
    provider: 'google',
    sub: '104729573829461530004',
    email: 'unverified.person@example.test',
    email_verified: false,
    name: 'Unverified Person',
    given_name: 'Unverified',
    family_name: 'Person',
  },
  {
    provider: 'apple',
    sub: '001024.4a1f2c3e5b6d47a8b9c0d1e2f3a4b5c6.0001',
    email: 'katherine.johnson@example.test',
    name: 'Katherine Johnson',
    given_name: 'Katherine',
    family_name: 'Johnson',
  },
  {
    provider: 'apple',
    sub: '001024.4a1f2c3e5b6d47a8b9c0d1e2f3a4b5c7.0002',
    email: 'q7x2m9k4p1@privaterelay.appleid.com',
    is_private_email: true,
    name: 'Dorothy Vaughan',
    given_name: 'Dorothy',
    family_name: 'Vaughan',
  },
  {
    provider: 'apple',
    sub: '001024.4a1f2c3e5b6d47a8b9c0d1e2f3a4b5c8.0003',
    email: 'grace.hopper@university.test',
    name: 'Grace Hopper',
    given_name: 'Grace',
    family_name: 'Hopper',
  },
];

const GOOGLE_SCOPES = new Set(['openid', 'email', 'profile']);
const APPLE_SCOPES = new Set(['openid', 'email', 'name']);
const GOOGLE_CODE_TTL_MS = 10 * 60_000;
const APPLE_CODE_TTL_MS = 5 * 60_000;
/** Apple's documented maximum client_secret lifetime (6 months). */
const APPLE_MAX_CLIENT_SECRET_LIFETIME = 15_777_000;
const MAX_LOG = 5_000;

function isProvider(value: unknown): value is Provider {
  return value === 'google' || value === 'apple';
}

function titleCase(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

/** "ada.lovelace+x1@…" → "Ada Lovelace X1" */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._+-]+/)
    .filter(Boolean)
    .map(titleCase)
    .join(' ');
}

function generateSub(provider: Provider): string {
  if (provider === 'google') return `1${randomDigits(20)}`;
  return `00${randomDigits(4)}.${randomHex(32)}.${randomDigits(4)}`;
}

function generateCode(provider: Provider): string {
  // Real Google codes start with "4/" — Accounts must URL-decode the callback query correctly.
  if (provider === 'google') return `4/0A${randomToken(48)}`;
  return `c${randomHex(31)}.0.${randomToken(8).replaceAll('_', 'x').replaceAll('-', 'y').toLowerCase()}.${randomToken(24)}`;
}

function atHash(accessToken: string): string {
  return b64url(sha256(accessToken).subarray(0, 16));
}

function pkceS256(verifier: string): string {
  return b64url(sha256(verifier));
}

async function loadSigningKey(input: SigningKeyInput | undefined, provider: Provider): Promise<SigningKey> {
  let privateKey: KeyObject;
  let kid: string;
  if (input) {
    privateKey = createPrivateKey(input.private_key_pem);
    kid = input.kid;
  } else {
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    kid = `mock-${provider}-${randomHex(12)}`;
  }
  const jwk = await exportJWK(createPublicKey(privateKey));
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

function normalizeIdentity(input: OidcIdentityInput): OidcIdentity {
  if (!isProvider(input.provider)) throw apiError(422, 'invalid_identity', `provider must be "google" or "apple", got ${JSON.stringify(input.provider)}.`);
  if (typeof input.email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(input.email.trim())) {
    throw apiError(422, 'invalid_identity', `email must look like local@domain, got ${JSON.stringify(input.email)}.`);
  }
  const email = input.email.trim();
  let name = input.name ?? null;
  let given = input.given_name ?? null;
  let family = input.family_name ?? null;
  if (!name && (given || family)) name = [given, family].filter(Boolean).join(' ');
  if (!name) name = nameFromEmail(email);
  if (!given && !family && name) {
    const parts = name.split(/\s+/);
    given = parts[0] ?? null;
    family = parts.length > 1 ? parts.slice(1).join(' ') : null;
  }
  return {
    provider: input.provider,
    sub: input.sub?.trim() || generateSub(input.provider),
    email,
    email_verified: input.email_verified ?? true,
    name,
    given_name: given,
    family_name: family,
    picture: input.provider === 'google' ? (input.picture ?? null) : null,
    is_private_email: input.provider === 'apple' ? (input.is_private_email ?? email.endsWith('@privaterelay.appleid.com')) : false,
    hd: input.provider === 'google' ? (input.hd ?? null) : null,
    locale: input.locale ?? null,
    created_at: nowIso(),
  };
}

function storeClient(input: OidcClientInput): StoredClient {
  if (!isRecord(input)) throw apiError(422, 'invalid_client_registration', 'Each client must be a JSON object.');
  if (!isProvider(input.provider)) throw apiError(422, 'invalid_client_registration', `provider must be "google" or "apple", got ${JSON.stringify(input.provider)}.`);
  if (typeof input.client_id !== 'string' || input.client_id.trim() === '') {
    throw apiError(422, 'invalid_client_registration', 'client_id is required.');
  }
  const base = {
    provider: input.provider,
    client_id: input.client_id.trim(),
    redirect_uris: Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === 'string') : [],
    display_name: input.display_name ?? null,
    logo_url: input.logo_url ?? null,
    label: input.label ?? null,
    created_at: nowIso(),
  };
  if (input.provider === 'google') {
    if (typeof input.client_secret !== 'string' || input.client_secret === '') {
      throw apiError(422, 'invalid_client_registration', `Google client ${base.client_id} needs a client_secret.`);
    }
    return { ...base, client_secret: input.client_secret, team_id: null, key_id: null, public_key: null, public_key_pem: null };
  }
  if (typeof input.team_id !== 'string' || typeof input.key_id !== 'string' || !input.team_id || !input.key_id) {
    throw apiError(422, 'invalid_client_registration', `Apple client ${base.client_id} needs team_id and key_id.`);
  }
  let publicKey: KeyObject;
  try {
    if (input.public_key_pem) publicKey = createPublicKey(input.public_key_pem);
    else if (input.private_key_pem) publicKey = createPublicKey(createPrivateKey(input.private_key_pem));
    else throw new Error('missing');
  } catch {
    throw apiError(
      422,
      'invalid_client_registration',
      `Apple client ${base.client_id} needs public_key_pem (SPKI PEM) or private_key_pem (the p8 PKCS#8 PEM) of an EC P-256 key.`,
    );
  }
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw apiError(422, 'invalid_client_registration', `Apple client ${base.client_id}: the key must be EC P-256 (ES256), like an Apple p8 key.`);
  }
  return {
    ...base,
    client_secret: null,
    team_id: input.team_id,
    key_id: input.key_id,
    public_key: publicKey,
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function maskClient(client: StoredClient): Record<string, unknown> {
  return {
    provider: client.provider,
    client_id: client.client_id,
    has_client_secret: client.client_secret !== null,
    team_id: client.team_id,
    key_id: client.key_id,
    public_key_pem: client.public_key_pem,
    redirect_uris: client.redirect_uris,
    display_name: client.display_name,
    label: client.label,
    created_at: client.created_at,
  };
}

export async function start(options: MockOidcOptions = {}): Promise<MockOidc> {
  const strict = options.strict ?? true;
  const router = new Router();

  const keys: Record<Provider, SigningKey[]> = {
    google: [await loadSigningKey(options.signingKeys?.google, 'google')],
    apple: [await loadSigningKey(options.signingKeys?.apple, 'apple')],
  };
  let unknownKey: SigningKey | null = null;

  const clients = new Map<string, StoredClient>();
  const identities = new Map<string, OidcIdentity>();
  const codes = new Map<string, AuthCode>();
  const accessTokens = new Map<string, AccessTokenRecord>();
  const authorized = new Set<string>();
  const next: Record<Provider, NextSelection[]> = { google: [], apple: [] };
  let faults: OidcFault[] = [];
  let log: OidcRequestLogEntry[] = [];
  let seq = 0;

  const ckey = (p: Provider, clientId: string): string => `${p}|${clientId}`;
  const ikey = (p: Provider, sub: string): string => `${p}|${sub}`;

  function seed(): void {
    clients.clear();
    identities.clear();
    for (const client of options.clients ?? []) {
      const stored = storeClient(client);
      clients.set(ckey(stored.provider, stored.client_id), stored);
    }
    const initial = [...((options.includeDefaultIdentities ?? true) ? DEFAULT_IDENTITIES : []), ...(options.identities ?? [])];
    for (const input of initial) {
      const identity = normalizeIdentity(input);
      identities.set(ikey(identity.provider, identity.sub), identity);
    }
  }
  seed();

  // Filled in once the server is listening (port 0 resolves to a real port).
  let baseUrl = '';
  const issuerOf = (p: Provider): string => `${baseUrl}/${p}`;

  /** Matches by sub or (case-insensitive) email; when several share an email the newest wins. */
  function findIdentity(p: Provider, hint: string): OidcIdentity | undefined {
    const needle = hint.trim().toLowerCase();
    let found: OidcIdentity | undefined;
    for (const identity of identities.values()) {
      if (identity.provider !== p) continue;
      if (identity.sub === hint.trim()) return identity;
      if (identity.email.toLowerCase() === needle) found = identity;
    }
    return found;
  }

  function findOrCreateIdentity(p: Provider, sel: { email: string | null; sub: string | null; name: string | null }): OidcIdentity {
    if (sel.sub) {
      const bySub = identities.get(ikey(p, sel.sub));
      if (bySub) return bySub;
    }
    if (sel.email) {
      const byEmail = findIdentity(p, sel.email);
      if (byEmail) return byEmail;
    }
    if (!sel.email) throw apiError(400, 'unknown_identity', `No ${p} identity with sub ${sel.sub ?? '(none)'} and no email to create one.`);
    const created = normalizeIdentity({ provider: p, email: sel.email, ...(sel.sub ? { sub: sel.sub } : {}), ...(sel.name ? { name: sel.name } : {}) });
    identities.set(ikey(p, created.sub), created);
    return created;
  }

  function takeFault(p: Provider, endpoint: FaultEndpoint): OidcFault | null {
    const index = faults.findIndex((f) => f.endpoint === endpoint && (f.provider === null || f.provider === p) && f.remaining > 0);
    if (index < 0) return null;
    const fault = faults[index]!;
    fault.remaining -= 1;
    if (fault.remaining <= 0) faults.splice(index, 1);
    return fault;
  }

  function record(entry: Omit<OidcRequestLogEntry, 'seq' | 'id' | 'at'>): OidcRequestLogEntry {
    seq += 1;
    const full: OidcRequestLogEntry = { seq, id: uuid(), at: nowIso(), ...entry };
    log.push(full);
    if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
    return full;
  }

  function baseEntry(p: Provider, endpoint: OidcRequestLogEntry['endpoint'], ctx: Ctx): Omit<OidcRequestLogEntry, 'seq' | 'id' | 'at'> {
    return {
      provider: p,
      endpoint,
      method: ctx.method,
      client_id: null,
      client_label: null,
      status: 200,
      outcome: 'ok',
      error: null,
      error_description: null,
      identity: null,
      selected_by: null,
      auth_method: null,
      client_secret_jwt: null,
      params: {},
      fault_id: null,
    };
  }

  // ---------------------------------------------------------------- pages

  function providerTitle(p: Provider): string {
    return p === 'google' ? 'Sign in with Google' : 'Sign in with Apple';
  }

  function errorPage(p: Provider, status: number, error: string, description: string): string {
    return page({
      title: `${providerTitle(p)} (mock) — error`,
      accent: p === 'google' ? '#1A73E8' : '#000000',
      body: `<main id="error" data-error="${escapeHtml(error)}" data-provider="${p}">
<div class="card error">
<h1>Error ${status}: ${escapeHtml(error)}</h1>
<p id="error-description">${escapeHtml(description)}</p>
<p class="muted">This is the testkit's mock ${p === 'google' ? 'Google' : 'Apple'} provider. The real provider would also refuse this request, so the sign-in request sent by Silicon Accounts needs fixing.</p>
</div>
</main>`,
    });
  }

  function chooserPage(p: Provider, client: StoredClient, query: URLSearchParams): string {
    const hidden = [...query.entries()]
      .filter(([k]) => k !== '_auto' && k !== '_error' && k !== '_name')
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
      .join('\n');
    const hd = query.get('hd');
    const list = [...identities.values()].filter((i) => i.provider === p);
    const buttons = list
      .map((identity) => {
        const badges = [
          identity.email_verified ? '' : '<span class="badge">email not verified</span>',
          identity.is_private_email ? '<span class="badge">private relay</span>' : '',
          identity.hd ? `<span class="badge">${escapeHtml(identity.hd)}</span>` : '',
          hd && identity.email.toLowerCase().endsWith(`@${hd.toLowerCase()}`) ? '<span class="badge">matches hd</span>' : '',
        ].join(' ');
        return `<li><button type="submit" class="identity secondary" name="_auto" value="${escapeHtml(identity.email)}" data-email="${escapeHtml(identity.email)}" data-sub="${escapeHtml(identity.sub)}">
<span><strong>${escapeHtml(identity.name ?? identity.email)}</strong><br><span class="muted">${escapeHtml(identity.email)}</span></span></button> ${badges}</li>`;
      })
      .join('\n');
    const appName = client.display_name ?? client.client_id;
    const logo = client.logo_url ? `<img class="logo" src="${escapeHtml(client.logo_url)}" alt="">` : '';
    return page({
      title: `${providerTitle(p)} (mock)`,
      accent: p === 'google' ? '#1A73E8' : '#000000',
      css: `ul.identities { list-style: none; padding: 0; margin: 16px 0; } ul.identities li { margin: 8px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } button.identity { text-align: left; min-width: 280px; justify-content: flex-start; }`,
      body: `<main id="chooser" data-provider="${p}" data-client-id="${escapeHtml(client.client_id)}" data-client-name="${escapeHtml(appName)}">
<div class="card">
<p class="muted">${p === 'google' ? 'Google' : 'Apple'} · mock provider</p>
<div class="row">${logo}<div><h1>Choose an account</h1><p>to continue to <strong id="client-name">${escapeHtml(appName)}</strong></p></div></div>
<form method="get" action="${escapeHtml(new URL(`/${p}/authorize`, baseUrl).pathname)}">
${hidden}
<ul class="identities">
${buttons || '<li class="muted">No identities registered for this provider yet.</li>'}
</ul>
<div class="row" style="margin-top:16px">
<button type="submit" class="ghost" name="_error" value="access_denied" data-action="cancel">Cancel</button>
</div>
</form>
<form id="new-identity" method="get" action="${escapeHtml(new URL(`/${p}/authorize`, baseUrl).pathname)}" class="row" style="margin-top:12px">
${hidden}
<input type="email" name="_auto" placeholder="new.identity@example.test" aria-label="Use another account (email)" required>
<input type="text" name="_name" placeholder="Display name (optional)" aria-label="Name">
<button type="submit" class="secondary" data-action="use-another">Use another account</button>
</form>
</div>
</main>`,
    });
  }

  function formPostPage(action: string, fields: Record<string, string>): string {
    const inputs = Object.entries(fields)
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
      .join('\n');
    return page({
      title: 'Sign in with Apple (mock) — returning to the app',
      accent: '#000000',
      body: `<main id="form-post" data-provider="apple">
<form id="apple-form-post" method="post" action="${escapeHtml(action)}">
${inputs}
<noscript><button type="submit">Continue</button></noscript>
</form>
<p class="muted">Returning to the app…</p>
</main>
<script>document.getElementById('apple-form-post').submit();</script>`,
    });
  }

  // ------------------------------------------------------------- authorize

  function redirectWith(redirectUri: string, params: Record<string, string>, fragment = false): string {
    const url = new URL(redirectUri);
    if (fragment) {
      url.hash = new URLSearchParams(params).toString();
    } else {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  async function authorize(p: Provider, ctx: Ctx): Promise<void> {
    const q = ctx.query;
    const entry = baseEntry(p, 'authorize', ctx);
    entry.params = {
      redirect_uri: q.get('redirect_uri'),
      response_type: q.get('response_type'),
      response_mode: q.get('response_mode'),
      scope: q.get('scope'),
      prompt: q.get('prompt'),
      login_hint: q.get('login_hint'),
      hd: q.get('hd'),
      state_present: q.has('state'),
      nonce_present: q.has('nonce'),
      code_challenge_method: q.has('code_challenge') ? (q.get('code_challenge_method') ?? 'plain') : null,
    };
    entry.client_id = q.get('client_id');

    const fail = (status: number, error: string, description: string): void => {
      record({ ...entry, status, outcome: 'error_page', error, error_description: description });
      ctx.sendHtml(status, errorPage(p, status, error, description));
    };

    const fault = takeFault(p, 'authorize');
    if (fault) {
      entry.fault_id = fault.id;
      if (fault.delay_ms > 0) await sleep(fault.delay_ms, ctx.signal);
      if (fault.status) {
        fail(fault.status, fault.error ?? 'server_error', fault.error_description ?? 'Simulated provider failure (mock fault injection).');
        return;
      }
    }

    const clientId = q.get('client_id');
    const client = clientId ? clients.get(ckey(p, clientId)) : undefined;
    if (!clientId) return fail(400, 'invalid_request', 'Missing required parameter: client_id.');
    if (!client) {
      return fail(
        401,
        'invalid_client',
        `The OAuth client "${clientId}" was not found. Register it with POST /_clients on the mock (the e2e harness registers the managed and bring-your-own clients from testkit/dev-credentials.json).`,
      );
    }
    entry.client_label = client.label;

    const redirectUri = q.get('redirect_uri');
    if (!redirectUri) return fail(400, 'invalid_request', 'Missing required parameter: redirect_uri.');
    let parsedRedirect: URL;
    try {
      parsedRedirect = new URL(redirectUri);
    } catch {
      return fail(400, 'redirect_uri_mismatch', `redirect_uri "${redirectUri}" is not an absolute URL.`);
    }
    if (parsedRedirect.protocol !== 'https:' && parsedRedirect.protocol !== 'http:') {
      return fail(400, 'redirect_uri_mismatch', `redirect_uri must use http or https, got ${parsedRedirect.protocol}.`);
    }
    if (parsedRedirect.hash) return fail(400, 'redirect_uri_mismatch', 'redirect_uri must not contain a fragment.');
    if (client.redirect_uris.length > 0 && !client.redirect_uris.includes(redirectUri)) {
      return fail(
        400,
        'redirect_uri_mismatch',
        `redirect_uri "${redirectUri}" is not registered for client ${client.client_id}. Registered: ${client.redirect_uris.join(', ')}.`,
      );
    }

    const responseType = q.get('response_type');
    const allowedResponseTypes = p === 'google' ? ['code'] : ['code', 'code id_token'];
    if (!responseType) return fail(400, 'invalid_request', 'Missing required parameter: response_type (expected "code").');
    if (!allowedResponseTypes.includes(responseType)) {
      return fail(400, 'unsupported_response_type', `response_type "${responseType}" is not supported; use ${allowedResponseTypes.map((t) => `"${t}"`).join(' or ')}.`);
    }

    const scopes = (q.get('scope') ?? '').split(/[\s+]+/).filter(Boolean);
    const allowedScopes = p === 'google' ? GOOGLE_SCOPES : APPLE_SCOPES;
    const unknownScopes = scopes.filter((s) => !allowedScopes.has(s));
    if (unknownScopes.length > 0) {
      return fail(400, 'invalid_scope', `Unknown scope(s): ${unknownScopes.join(', ')}. ${p === 'google' ? 'Google' : 'Apple'} sign-in accepts: ${[...allowedScopes].join(', ')}.`);
    }
    if (p === 'google' && strict && !scopes.includes('openid')) {
      return fail(400, 'invalid_scope', 'scope must include "openid" to receive an id_token (Silicon Accounts asks for "openid email profile").');
    }

    const responseMode = q.get('response_mode') ?? 'query';
    if (p === 'apple') {
      if (!['query', 'fragment', 'form_post'].includes(responseMode)) {
        return fail(400, 'invalid_request', `response_mode "${responseMode}" is not supported; use form_post.`);
      }
      if ((scopes.includes('name') || scopes.includes('email')) && responseMode !== 'form_post') {
        return fail(400, 'invalid_request', 'response_mode must be form_post when the name or email scope is requested.');
      }
      if (responseType.includes('id_token') && responseMode === 'query') {
        return fail(400, 'invalid_request', 'response_mode=query is not allowed when response_type includes id_token.');
      }
    }

    const state = q.get('state');
    if (strict && !state) return fail(400, 'invalid_request', 'Missing required parameter: state (Silicon Accounts must bind every provider redirect to its flow).');
    const nonce = q.get('nonce');
    if (strict && !nonce) return fail(400, 'invalid_request', 'Missing required parameter: nonce (Silicon Accounts must bind the id_token to its flow).');

    const challenge = q.get('code_challenge');
    const challengeMethod = challenge ? (q.get('code_challenge_method') ?? 'plain') : null;
    if (challenge) {
      if (challengeMethod !== 'S256' && challengeMethod !== 'plain') {
        return fail(400, 'invalid_request', `code_challenge_method "${challengeMethod}" is not supported; use S256.`);
      }
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) {
        return fail(400, 'invalid_request', 'code_challenge must be 43-128 characters of [A-Za-z0-9._~-] (base64url SHA-256 of the verifier for S256).');
      }
    }
    if (p === 'google' && strict) {
      if (!challenge) return fail(400, 'invalid_request', 'Missing required parameter: code_challenge (Silicon Accounts uses PKCE S256 with Google).');
      if (challengeMethod !== 'S256') return fail(400, 'invalid_request', 'code_challenge_method must be S256 (plain PKCE is not accepted from Silicon Accounts).');
    }

    const prompts = (q.get('prompt') ?? '').split(/\s+/).filter(Boolean);
    if (p === 'google') {
      const bad = prompts.filter((x) => !['none', 'consent', 'select_account'].includes(x));
      if (bad.length > 0) return fail(400, 'invalid_request', `Invalid prompt value(s): ${bad.join(', ')}.`);
      if (prompts.includes('none') && prompts.length > 1) return fail(400, 'invalid_request', 'prompt=none cannot be combined with other prompt values.');
    }

    // Past this point the request is valid: errors go back to the redirect_uri like the real providers do.
    const sendError = (error: string, selectedBy: string): void => {
      const providerError = p === 'apple' && error === 'access_denied' ? 'user_cancelled_authorize' : error;
      const fields: Record<string, string> = { error: providerError };
      if (state) fields.state = state;
      record({ ...entry, status: p === 'apple' && responseMode === 'form_post' ? 200 : 302, outcome: 'error_redirect', error: providerError, selected_by: selectedBy });
      if (p === 'apple' && responseMode === 'form_post') {
        ctx.sendHtml(200, formPostPage(redirectUri, fields));
      } else {
        ctx.redirect(redirectWith(redirectUri, fields, p === 'apple' && responseMode === 'fragment'));
      }
    };

    const forcedError = q.get('_error');
    if (forcedError) return sendError(forcedError, '_error');

    let identity: OidcIdentity | undefined;
    let selectedBy: string | null = null;
    const queued = next[p].shift();
    if (queued) {
      if (queued.error) return sendError(queued.error, '_next');
      identity = findOrCreateIdentity(p, queued);
      selectedBy = '_next';
    } else if (q.get('_auto')) {
      identity = findOrCreateIdentity(p, { email: q.get('_auto'), sub: null, name: q.get('_name') });
      selectedBy = '_auto';
    } else if (q.get('login_hint')) {
      identity = findIdentity(p, q.get('login_hint') ?? '');
      if (identity) selectedBy = 'login_hint';
    }

    if (!identity) {
      if (prompts.includes('none')) return sendError('login_required', 'prompt_none');
      record({ ...entry, status: 200, outcome: 'chooser_shown' });
      ctx.sendHtml(200, chooserPage(p, client, q));
      return;
    }

    const firstKey = `${p}|${client.client_id}|${identity.sub}`;
    const first = !authorized.has(firstKey);
    authorized.add(firstKey);
    const code = generateCode(p);
    const nowMs = Date.now();
    codes.set(code, {
      provider: p,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      sub: identity.sub,
      nonce,
      scopes,
      code_challenge: challenge,
      code_challenge_method: challengeMethod,
      first_authorization: first,
      created_ms: nowMs,
      expires_ms: nowMs + (p === 'google' ? GOOGLE_CODE_TTL_MS : APPLE_CODE_TTL_MS),
      used_ms: null,
    });

    const logged = { ...entry, outcome: 'code_issued', identity: { sub: identity.sub, email: identity.email }, selected_by: selectedBy };
    if (p === 'google') {
      const params: Record<string, string> = { code };
      if (state) params.state = state;
      params.scope = googleScopeString(scopes);
      params.authuser = '0';
      if (identity.hd) params.hd = identity.hd;
      params.prompt = first ? 'consent' : 'none';
      record({ ...logged, status: 302 });
      ctx.redirect(redirectWith(redirectUri, params));
      return;
    }

    const fields: Record<string, string> = { code };
    if (state) fields.state = state;
    if (responseType.includes('id_token')) {
      fields.id_token = await signIdToken(p, buildClaims(p, client.client_id, identity, scopes, nonce, null), null);
    }
    if (first && (scopes.includes('name') || scopes.includes('email'))) {
      const user: Record<string, unknown> = {};
      if (scopes.includes('name') && (identity.given_name || identity.family_name)) {
        user.name = { firstName: identity.given_name ?? '', lastName: identity.family_name ?? '' };
      }
      if (scopes.includes('email')) user.email = identity.email;
      fields.user = JSON.stringify(user);
    }
    if (responseMode === 'form_post') {
      record({ ...logged, status: 200 });
      ctx.sendHtml(200, formPostPage(redirectUri, fields));
    } else {
      record({ ...logged, status: 302 });
      ctx.redirect(redirectWith(redirectUri, fields, responseMode === 'fragment'));
    }
  }

  function googleScopeString(scopes: string[]): string {
    const out: string[] = [];
    if (scopes.includes('email')) out.push('email');
    if (scopes.includes('profile')) out.push('profile');
    if (scopes.includes('openid')) out.push('openid');
    if (scopes.includes('email')) out.push('https://www.googleapis.com/auth/userinfo.email');
    if (scopes.includes('profile')) out.push('https://www.googleapis.com/auth/userinfo.profile');
    return out.join(' ');
  }

  // ----------------------------------------------------------------- tokens

  function buildClaims(p: Provider, clientId: string, identity: OidcIdentity, scopes: string[], nonce: string | null, accessToken: string | null): JWTPayload {
    const iat = nowSeconds();
    if (p === 'google') {
      const claims: JWTPayload = {
        iss: issuerOf('google'),
        azp: clientId,
        aud: clientId,
        sub: identity.sub,
        iat,
        exp: iat + 3600,
      };
      if (scopes.includes('email')) {
        claims.email = identity.email;
        claims.email_verified = identity.email_verified;
      }
      if (identity.hd) claims.hd = identity.hd;
      if (accessToken) claims.at_hash = atHash(accessToken);
      if (scopes.includes('profile')) {
        if (identity.name) claims.name = identity.name;
        if (identity.picture) claims.picture = identity.picture;
        if (identity.given_name) claims.given_name = identity.given_name;
        if (identity.family_name) claims.family_name = identity.family_name;
        if (identity.locale) claims.locale = identity.locale;
      }
      if (nonce) claims.nonce = nonce;
      return claims;
    }
    const claims: JWTPayload = {
      iss: issuerOf('apple'),
      aud: clientId,
      exp: iat + 600,
      iat,
      sub: identity.sub,
      auth_time: iat,
      nonce_supported: true,
      real_user_status: 2,
    };
    if (accessToken) claims.at_hash = atHash(accessToken);
    if (scopes.includes('email')) {
      claims.email = identity.email;
      // Apple sends these as strings; Accounts must accept "true".
      claims.email_verified = identity.email_verified ? 'true' : 'false';
      claims.is_private_email = identity.is_private_email ? 'true' : 'false';
    }
    if (nonce) claims.nonce = nonce;
    return claims;
  }

  async function signIdToken(p: Provider, claims: JWTPayload, tamper: IdTokenTamper | null): Promise<string> {
    let payload: JWTPayload = { ...claims };
    if (tamper?.expired) {
      payload.iat = nowSeconds() - 7200;
      payload.exp = nowSeconds() - 3600;
    }
    if (tamper?.claims) payload = { ...payload, ...(tamper.claims as JWTPayload) };
    for (const claim of tamper?.remove_claims ?? []) delete payload[claim];
    if (tamper?.sign_with === 'none') {
      return `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.`;
    }
    let key = keys[p][0]!;
    if (tamper?.sign_with === 'unknown_key') {
      unknownKey ??= await loadSigningKey(undefined, p);
      key = { ...unknownKey, kid: 'mock-unknown-key' };
    }
    const header = p === 'google' ? { alg: 'RS256', kid: key.kid, typ: 'JWT' } : { alg: 'RS256', kid: key.kid };
    return new SignJWT(payload).setProtectedHeader(header).sign(key.privateKey);
  }

  async function verifyAppleClientSecret(
    client: StoredClient,
    jwt: string | null,
    entry: Omit<OidcRequestLogEntry, 'seq' | 'id' | 'at'>,
  ): Promise<string | null> {
    if (!jwt) return 'client_secret is missing: Sign in with Apple expects an ES256 JWT signed with your p8 key.';
    let header: Record<string, unknown>;
    try {
      header = decodeProtectedHeader(jwt) as Record<string, unknown>;
    } catch {
      return 'client_secret is not a JWT (expected three base64url segments: header.payload.signature).';
    }
    try {
      const parts = jwt.split('.');
      const claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
      entry.client_secret_jwt = { kid: str(header.kid) ?? null, iss: str(claims.iss) ?? null, sub: str(claims.sub) ?? null, aud: claims.aud ?? null };
    } catch {
      entry.client_secret_jwt = { kid: str(header.kid) ?? null, iss: null, sub: null, aud: null };
    }
    if (header.alg !== 'ES256') return `client_secret must be signed with ES256; got alg=${String(header.alg)}.`;
    if (header.kid !== client.key_id) {
      return `client_secret header kid "${String(header.kid)}" does not match the key id "${client.key_id}" registered for ${client.client_id}.`;
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(jwt, client.public_key as KeyObject, {
        algorithms: ['ES256'],
        issuer: client.team_id ?? undefined,
        subject: client.client_id,
        audience: issuerOf('apple'),
        clockTolerance: 30,
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp'],
      }));
    } catch (error) {
      if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
        return `client_secret signature does not verify with the public key registered for key id ${client.key_id} (was it signed with a different p8 key?).`;
      }
      if (error instanceof joseErrors.JWTExpired) return 'client_secret has expired (its exp is in the past).';
      if (error instanceof joseErrors.JWTClaimValidationFailed) {
        return `client_secret claim "${error.claim}" is invalid (${error.reason}): expected iss=${client.team_id}, sub=${client.client_id}, aud=${issuerOf('apple')}.`;
      }
      return `client_secret could not be verified: ${(error as Error).message}.`;
    }
    const iat = typeof payload.iat === 'number' ? payload.iat : 0;
    const exp = typeof payload.exp === 'number' ? payload.exp : 0;
    if (iat > nowSeconds() + 60) return 'client_secret iat is in the future.';
    if (exp - iat > APPLE_MAX_CLIENT_SECRET_LIFETIME) {
      return `client_secret lifetime is ${exp - iat} s; Apple allows at most ${APPLE_MAX_CLIENT_SECRET_LIFETIME} s (6 months).`;
    }
    return null;
  }

  async function token(p: Provider, ctx: Ctx): Promise<void> {
    const entry = baseEntry(p, 'token', ctx);
    const fault = takeFault(p, 'token');
    const respondError = (status: number, error: string, description: string): void => {
      record({ ...entry, status, outcome: 'error', error, error_description: description });
      ctx.sendJson(status, { error, error_description: description }, { Pragma: 'no-cache' });
    };
    if (fault) {
      entry.fault_id = fault.id;
      if (fault.delay_ms > 0) await sleep(fault.delay_ms, ctx.signal);
      if (fault.status) return respondError(fault.status, fault.error ?? 'server_error', fault.error_description ?? 'Simulated provider failure (mock fault injection).');
    }

    const contentType = ctx.contentType();
    let params: URLSearchParams;
    if (contentType === 'application/x-www-form-urlencoded') {
      params = await ctx.form();
    } else if (contentType === 'application/json' && p === 'google') {
      const body = await jsonObject(ctx);
      params = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
    } else {
      return respondError(400, 'invalid_request', `Token requests must be application/x-www-form-urlencoded; got "${contentType || 'no content type'}".`);
    }
    entry.params = {
      grant_type: params.get('grant_type'),
      redirect_uri: params.get('redirect_uri'),
      has_code: params.has('code'),
      has_code_verifier: params.has('code_verifier'),
    };

    const grantType = params.get('grant_type');
    if (!grantType) return respondError(400, 'invalid_request', 'Missing required parameter: grant_type.');
    if (grantType !== 'authorization_code') {
      return respondError(400, 'unsupported_grant_type', `grant_type "${grantType}" is not supported by the mock; Silicon Accounts only needs authorization_code.`);
    }

    // Client authentication.
    const basic = parseBasicAuth(ctx.header('authorization'));
    let client: StoredClient | undefined;
    if (p === 'google') {
      const bodyId = params.get('client_id');
      const bodySecret = params.get('client_secret');
      if (basic && bodySecret) return respondError(400, 'invalid_request', 'Use exactly one client authentication method: HTTP Basic or client_secret in the body, not both (RFC 6749 §2.3).');
      if (basic && bodyId && bodyId !== basic.user) return respondError(401, 'invalid_client', 'client_id in the body does not match the HTTP Basic user.');
      const clientId = basic?.user ?? bodyId;
      const secret = basic?.pass ?? bodySecret;
      entry.client_id = clientId;
      entry.auth_method = basic ? 'client_secret_basic' : 'client_secret_post';
      if (!clientId) return respondError(401, 'invalid_client', 'Missing client_id (send it with HTTP Basic or in the form body).');
      client = clients.get(ckey('google', clientId));
      if (!client) return respondError(401, 'invalid_client', `The OAuth client "${clientId}" was not found.`);
      entry.client_label = client.label;
      if (!secret) return respondError(401, 'invalid_client', `client_secret is missing for ${clientId}.`);
      if (!safeEqual(secret, client.client_secret ?? '')) return respondError(401, 'invalid_client', `Unauthorized: client_secret does not match the secret registered for ${clientId}.`);
    } else {
      const clientId = params.get('client_id');
      entry.client_id = clientId;
      entry.auth_method = 'client_secret_post_jwt';
      if (basic && !params.get('client_secret')) {
        return respondError(400, 'invalid_client', 'Sign in with Apple expects client_id and client_secret in the form body (client_secret_post); HTTP Basic is not supported.');
      }
      if (!clientId) return respondError(400, 'invalid_client', 'Missing client_id (your Services ID).');
      client = clients.get(ckey('apple', clientId));
      if (!client) return respondError(400, 'invalid_client', `Unknown client_id "${clientId}": no Apple Services ID with that id is registered on the mock.`);
      entry.client_label = client.label;
      const problem = await verifyAppleClientSecret(client, params.get('client_secret'), entry);
      if (problem) return respondError(400, 'invalid_client', problem);
    }

    const code = params.get('code');
    if (!code) return respondError(400, 'invalid_request', 'Missing required parameter: code.');
    const record_ = codes.get(code);
    if (!record_ || record_.provider !== p) return respondError(400, 'invalid_grant', 'Malformed or unknown authorization code.');
    if (record_.client_id !== client.client_id) return respondError(400, 'invalid_grant', `The authorization code was issued to a different client (${record_.client_id}).`);
    if (record_.used_ms !== null) return respondError(400, 'invalid_grant', 'The authorization code was already redeemed.');
    if (Date.now() > record_.expires_ms) return respondError(400, 'invalid_grant', 'The authorization code has expired.');

    const redirectUri = params.get('redirect_uri');
    if (!redirectUri) return respondError(400, 'invalid_request', 'Missing required parameter: redirect_uri.');
    if (redirectUri !== record_.redirect_uri) {
      return respondError(400, p === 'google' ? 'redirect_uri_mismatch' : 'invalid_grant', `redirect_uri "${redirectUri}" does not match the one used at authorize ("${record_.redirect_uri}").`);
    }

    const verifier = params.get('code_verifier');
    if (record_.code_challenge) {
      if (!verifier) return respondError(400, 'invalid_grant', 'Missing code_verifier: the authorize request carried a PKCE code_challenge.');
      const expected = record_.code_challenge_method === 'S256' ? pkceS256(verifier) : verifier;
      if (!safeEqual(expected, record_.code_challenge)) return respondError(400, 'invalid_grant', 'Invalid code_verifier: it does not match the code_challenge sent at authorize.');
    } else if (verifier && p === 'google') {
      return respondError(400, 'invalid_request', 'code_verifier was sent but the authorize request had no code_challenge.');
    }

    record_.used_ms = Date.now();
    const identity = identities.get(ikey(p, record_.sub));
    if (!identity) return respondError(400, 'invalid_grant', 'The identity behind this code was deleted from the mock (DELETE /_identities).');

    const accessToken = p === 'google' ? `ya29.mock-${randomToken(48)}` : `a${randomHex(31)}.0.mock.${randomToken(32)}`;
    accessTokens.set(accessToken, { provider: p, client_id: client.client_id, sub: identity.sub, scopes: record_.scopes, expires_ms: Date.now() + 3600_000 });
    const idToken = await signIdToken(p, buildClaims(p, client.client_id, identity, record_.scopes, record_.nonce, accessToken), fault?.id_token ?? null);

    record({ ...entry, status: 200, outcome: 'tokens_issued', identity: { sub: identity.sub, email: identity.email } });
    if (p === 'google') {
      ctx.sendJson(
        200,
        { access_token: accessToken, expires_in: 3599, scope: googleScopeString(record_.scopes), token_type: 'Bearer', id_token: idToken },
        { Pragma: 'no-cache' },
      );
    } else {
      ctx.sendJson(
        200,
        { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: `r${randomHex(31)}.0.mock.${randomToken(32)}`, id_token: idToken },
        { Pragma: 'no-cache' },
      );
    }
  }

  async function jwks(p: Provider, ctx: Ctx): Promise<void> {
    const entry = baseEntry(p, 'jwks', ctx);
    const fault = takeFault(p, 'jwks');
    if (fault) {
      entry.fault_id = fault.id;
      if (fault.delay_ms > 0) await sleep(fault.delay_ms, ctx.signal);
      if (fault.status) {
        record({ ...entry, status: fault.status, outcome: 'error', error: fault.error ?? 'server_error' });
        ctx.sendJson(fault.status, { error: fault.error ?? 'server_error' });
        return;
      }
    }
    record({ ...entry, status: 200, outcome: 'ok' });
    ctx.sendJson(200, { keys: keys[p].map((k) => k.jwk) }, { 'Cache-Control': 'public, max-age=60' });
  }

  async function userinfo(ctx: Ctx): Promise<void> {
    const entry = baseEntry('google', 'userinfo', ctx);
    const fault = takeFault('google', 'userinfo');
    if (fault?.status) {
      record({ ...entry, status: fault.status, outcome: 'error', fault_id: fault.id });
      ctx.sendJson(fault.status, { error: fault.error ?? 'server_error' });
      return;
    }
    const auth = ctx.header('authorization') ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
    const tokenRecord = bearer ? accessTokens.get(bearer) : undefined;
    if (!tokenRecord || tokenRecord.expires_ms < Date.now() || tokenRecord.provider !== 'google') {
      record({ ...entry, status: 401, outcome: 'error', error: 'invalid_token' });
      ctx.sendJson(401, { error: 'invalid_token', error_description: 'Invalid Credentials' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      return;
    }
    const identity = identities.get(ikey('google', tokenRecord.sub));
    if (!identity) {
      ctx.sendJson(401, { error: 'invalid_token', error_description: 'The identity was deleted.' });
      return;
    }
    entry.client_id = tokenRecord.client_id;
    record({ ...entry, status: 200, outcome: 'ok', identity: { sub: identity.sub, email: identity.email } });
    const body: Record<string, unknown> = { sub: identity.sub };
    if (tokenRecord.scopes.includes('profile')) Object.assign(body, { name: identity.name, given_name: identity.given_name, family_name: identity.family_name, picture: identity.picture, locale: identity.locale });
    if (tokenRecord.scopes.includes('email')) Object.assign(body, { email: identity.email, email_verified: identity.email_verified });
    if (identity.hd) body.hd = identity.hd;
    ctx.sendJson(200, body);
  }

  async function revoke(p: Provider, ctx: Ctx): Promise<void> {
    const entry = baseEntry(p, 'revoke', ctx);
    const params = ctx.contentType() === 'application/x-www-form-urlencoded' ? await ctx.form() : ctx.query;
    const tokenValue = params.get('token');
    if (tokenValue) accessTokens.delete(tokenValue);
    entry.client_id = params.get('client_id');
    record({ ...entry, status: 200, outcome: tokenValue ? 'revoked' : 'no_token' });
    ctx.sendJson(200, {});
  }

  function discovery(p: Provider, ctx: Ctx): void {
    const issuer = issuerOf(p);
    record({ ...baseEntry(p, 'discovery', ctx), status: 200 });
    if (p === 'google') {
      ctx.sendJson(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        revocation_endpoint: `${issuer}/revoke`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email', 'profile'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        claims_supported: ['aud', 'email', 'email_verified', 'exp', 'family_name', 'given_name', 'hd', 'iat', 'iss', 'locale', 'name', 'nonce', 'picture', 'sub', 'at_hash', 'azp'],
        code_challenge_methods_supported: ['plain', 'S256'],
        grant_types_supported: ['authorization_code'],
      });
      return;
    }
    ctx.sendJson(200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      revocation_endpoint: `${issuer}/revoke`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code', 'code id_token'],
      response_modes_supported: ['query', 'fragment', 'form_post'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'name'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      claims_supported: ['aud', 'email', 'email_verified', 'exp', 'iat', 'is_private_email', 'iss', 'nonce', 'nonce_supported', 'real_user_status', 'sub', 'at_hash', 'auth_time'],
    });
  }

  // ------------------------------------------------------------------ routes

  for (const p of PROVIDERS) {
    router.get(`/${p}/.well-known/openid-configuration`, (ctx) => discovery(p, ctx));
    router.on(['GET', 'POST'], `/${p}/authorize`, async (ctx) => {
      if (ctx.method === 'POST' && ctx.contentType() === 'application/x-www-form-urlencoded') {
        for (const [k, v] of await ctx.form()) ctx.query.set(k, v);
      }
      await authorize(p, ctx);
    });
    router.post(`/${p}/token`, (ctx) => token(p, ctx));
    router.get(`/${p}/jwks`, (ctx) => jwks(p, ctx));
    router.post(`/${p}/revoke`, (ctx) => revoke(p, ctx));
  }
  // Aliases matching the real providers' paths, for configs that keep the original path shape.
  router.get('/google/o/oauth2/v2/auth', (ctx) => authorize('google', ctx));
  router.get('/google/oauth2/v3/certs', (ctx) => jwks('google', ctx));
  router.get('/google/userinfo', (ctx) => userinfo(ctx));
  router.get('/google/oauth2/v3/userinfo', (ctx) => userinfo(ctx));
  router.get('/apple/auth/authorize', (ctx) => authorize('apple', ctx));
  router.post('/apple/auth/token', (ctx) => token('apple', ctx));
  router.get('/apple/auth/keys', (ctx) => jwks('apple', ctx));
  router.post('/apple/auth/revoke', (ctx) => revoke('apple', ctx));

  router.get('/_health', (ctx) => ctx.sendJson(200, { ok: true, service: 'mock-oidc', providers: PROVIDERS, issuer: { google: issuerOf('google'), apple: issuerOf('apple') } }));

  router.get('/', (ctx) =>
    ctx.sendJson(200, {
      service: 'mock-oidc',
      description: 'Mock Sign in with Google (/google) and Sign in with Apple (/apple) for Silicon Accounts development and e2e tests.',
      issuers: { google: issuerOf('google'), apple: issuerOf('apple') },
      endpoints: Object.fromEntries(PROVIDERS.map((p) => [p, mock.endpoints(p)])),
      controls: {
        'POST /_identities': 'register identities {provider, sub?, email, email_verified?, name?, given_name?, family_name?, picture?, is_private_email?, hd?}',
        'GET /_identities?provider=': 'list identities',
        'DELETE /_identities?provider=&email=&sub=': 'remove identities (all when no filter)',
        'POST /_clients': 'register a client {provider, client_id, client_secret? | team_id, key_id, public_key_pem|private_key_pem, redirect_uris?, display_name?, label?}',
        'GET /_clients': 'list clients (secrets masked)',
        'DELETE /_clients?provider=&client_id=': 'remove clients',
        'POST /_next': 'queue the identity (or error) the next authorize for {provider} picks: {provider, email?|sub?, name?, error?}',
        'GET /_requests?provider=&endpoint=&client_id=&outcome=': 'request log, newest first',
        'DELETE /_requests': 'clear the request log',
        'POST /_faults': 'inject failures {provider?, endpoint, count?, status?, error?, error_description?, delay_ms?, id_token?: {claims?, remove_claims?, expired?, sign_with?}}',
        'POST /_keys/rotate': 'rotate a provider signing key {provider, keep_previous?}',
        'POST /_reset': 'restore startup clients/identities and clear codes, logs, faults',
      },
      authorize_test_params: {
        _auto: 'email of the identity to sign in as without the chooser (created when unknown)',
        _name: 'display name for an identity created via _auto',
        _error: 'answer with this error instead (access_denied → Apple user_cancelled_authorize)',
      },
    }),
  );

  router.post('/_identities', async (ctx) => {
    const body = await ctx.json<unknown>();
    const inputs = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.identities) ? body.identities : [body];
    const stored: OidcIdentity[] = [];
    for (const input of inputs) {
      if (!isRecord(input)) throw apiError(422, 'invalid_identity', 'Each identity must be a JSON object.');
      const identity = normalizeIdentity(input as OidcIdentityInput);
      // Re-registering a sub replaces it and forgets its past authorizations (Apple sends `user` again).
      for (const k of [...authorized]) if (k.startsWith(`${identity.provider}|`) && k.endsWith(`|${identity.sub}`)) authorized.delete(k);
      // Delete first so a re-registered identity moves to the end (newest wins on email matches).
      identities.delete(ikey(identity.provider, identity.sub));
      identities.set(ikey(identity.provider, identity.sub), identity);
      stored.push(identity);
    }
    ctx.sendJson(201, Array.isArray(body) || (isRecord(body) && Array.isArray(body.identities)) ? { identities: stored } : { identity: stored[0] });
  });
  router.get('/_identities', (ctx) => {
    const p = ctx.query.get('provider');
    ctx.sendJson(200, { items: [...identities.values()].filter((i) => !p || i.provider === p) });
  });
  router.delete('/_identities', (ctx) => {
    const p = ctx.query.get('provider');
    const email = ctx.query.get('email')?.toLowerCase();
    const sub = ctx.query.get('sub');
    let deleted = 0;
    for (const [k, identity] of identities) {
      if (p && identity.provider !== p) continue;
      if (email && identity.email.toLowerCase() !== email) continue;
      if (sub && identity.sub !== sub) continue;
      identities.delete(k);
      deleted += 1;
    }
    if (!p && !email && !sub) authorized.clear();
    ctx.sendJson(200, { deleted });
  });

  router.post('/_clients', async (ctx) => {
    const body = await ctx.json<unknown>();
    const inputs = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.clients) ? body.clients : [body];
    const stored = inputs.map((input) => {
      const client = storeClient(input as OidcClientInput);
      clients.set(ckey(client.provider, client.client_id), client);
      return maskClient(client);
    });
    ctx.sendJson(201, stored.length === 1 && !Array.isArray(body) ? { client: stored[0] } : { clients: stored });
  });
  router.get('/_clients', (ctx) => ctx.sendJson(200, { items: [...clients.values()].map(maskClient) }));
  router.delete('/_clients', (ctx) => {
    const p = ctx.query.get('provider');
    const clientId = ctx.query.get('client_id');
    let deleted = 0;
    for (const [k, client] of clients) {
      if (p && client.provider !== p) continue;
      if (clientId && client.client_id !== clientId) continue;
      clients.delete(k);
      deleted += 1;
    }
    ctx.sendJson(200, { deleted });
  });

  router.post('/_next', async (ctx) => {
    const body = await jsonObject(ctx);
    if (!isProvider(body.provider)) throw apiError(422, 'invalid_next', 'provider must be "google" or "apple".');
    const selection: NextSelection = { email: str(body.email) ?? null, sub: str(body.sub) ?? null, name: str(body.name) ?? null, error: str(body.error) ?? null };
    if (!selection.email && !selection.sub && !selection.error) throw apiError(422, 'invalid_next', 'Give email or sub (the identity to pick) or error (to answer with).');
    next[body.provider].push(selection);
    ctx.sendJson(201, { queued: selection, pending: next[body.provider].length });
  });
  router.get('/_next', (ctx) => ctx.sendJson(200, { google: next.google, apple: next.apple }));
  router.delete('/_next', (ctx) => {
    next.google = [];
    next.apple = [];
    ctx.noContent();
  });

  router.get('/_requests', (ctx) => {
    const p = ctx.query.get('provider');
    const endpoint = ctx.query.get('endpoint');
    const clientId = ctx.query.get('client_id');
    const outcome = ctx.query.get('outcome');
    const items = log
      .filter((e) => (!p || e.provider === p) && (!endpoint || e.endpoint === endpoint) && (!clientId || e.client_id === clientId) && (!outcome || e.outcome === outcome))
      .reverse();
    ctx.sendJson(200, { items });
  });
  router.delete('/_requests', (ctx) => {
    log = [];
    ctx.noContent();
  });

  router.post('/_faults', async (ctx) => {
    const body = await jsonObject(ctx);
    const endpoint = body.endpoint;
    if (endpoint !== 'authorize' && endpoint !== 'token' && endpoint !== 'jwks' && endpoint !== 'userinfo') {
      throw apiError(422, 'invalid_fault', 'endpoint must be one of authorize, token, jwks, userinfo.');
    }
    if (body.provider !== undefined && body.provider !== null && !isProvider(body.provider)) throw apiError(422, 'invalid_fault', 'provider must be "google", "apple" or omitted.');
    const status = typeof body.status === 'number' ? body.status : null;
    const tamper = isRecord(body.id_token) ? (body.id_token as IdTokenTamper) : null;
    if (status === null && tamper === null && typeof body.delay_ms !== 'number') {
      throw apiError(422, 'invalid_fault', 'A fault needs status (an error answer), id_token (a tampered token) or delay_ms.');
    }
    const fault: OidcFault = {
      id: uuid(),
      provider: isProvider(body.provider) ? body.provider : null,
      endpoint,
      remaining: typeof body.count === 'number' && body.count > 0 ? Math.floor(body.count) : 1,
      status,
      error: str(body.error) ?? null,
      error_description: str(body.error_description) ?? null,
      delay_ms: typeof body.delay_ms === 'number' ? body.delay_ms : 0,
      id_token: tamper,
      created_at: nowIso(),
    };
    faults.push(fault);
    ctx.sendJson(201, { fault });
  });
  router.get('/_faults', (ctx) => ctx.sendJson(200, { items: faults }));
  router.delete('/_faults', (ctx) => {
    faults = [];
    ctx.noContent();
  });

  router.post('/_keys/rotate', async (ctx) => {
    const body = await jsonObject(ctx);
    if (!isProvider(body.provider)) throw apiError(422, 'invalid_rotation', 'provider must be "google" or "apple".');
    const fresh = await loadSigningKey(undefined, body.provider);
    keys[body.provider] = body.keep_previous === false ? [fresh] : [fresh, ...keys[body.provider]].slice(0, 3);
    ctx.sendJson(200, { provider: body.provider, kid: fresh.kid, published: keys[body.provider].map((k) => k.kid) });
  });

  router.post('/_reset', (ctx) => {
    mock.reset();
    ctx.sendJson(200, { ok: true });
  });

  const running = await serve(router, { name: 'mock-oidc', port: options.port ?? DEFAULT_MOCK_OIDC_PORT, host: options.host ?? '127.0.0.1', log: options.log ?? false });
  baseUrl = (options.publicUrl ?? running.url).replace(/\/+$/, '');

  const mock: MockOidc = {
    url: baseUrl,
    port: running.port,
    issuer: { google: issuerOf('google'), apple: issuerOf('apple') },
    endpoints(p: Provider) {
      const issuer = issuerOf(p);
      return {
        issuer,
        authorize: `${issuer}/authorize`,
        token: `${issuer}/token`,
        jwks: `${issuer}/jwks`,
        userinfo: p === 'google' ? `${issuer}/userinfo` : null,
        discovery: `${issuer}/.well-known/openid-configuration`,
      };
    },
    registerClient(client: OidcClientInput) {
      const stored = storeClient(client);
      clients.set(ckey(stored.provider, stored.client_id), stored);
    },
    registerIdentity(input: OidcIdentityInput) {
      const identity = normalizeIdentity(input);
      for (const k of [...authorized]) if (k.startsWith(`${identity.provider}|`) && k.endsWith(`|${identity.sub}`)) authorized.delete(k);
      identities.delete(ikey(identity.provider, identity.sub));
      identities.set(ikey(identity.provider, identity.sub), identity);
      return identity;
    },
    identities(p?: Provider) {
      return [...identities.values()].filter((i) => !p || i.provider === p);
    },
    requests(filter = {}) {
      return log
        .filter((e) => (!filter.provider || e.provider === filter.provider) && (!filter.endpoint || e.endpoint === filter.endpoint) && (!filter.client_id || e.client_id === filter.client_id))
        .reverse();
    },
    reset() {
      seed();
      codes.clear();
      accessTokens.clear();
      authorized.clear();
      next.google = [];
      next.apple = [];
      faults = [];
      log = [];
    },
    stop: () => running.stop(),
  };
  return mock;
}


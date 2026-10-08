// A deliberately small stand-in for Silicon Accounts, implementing the parts of
// 02-api.md the testkit talks to — so the fake app server and the lib helpers can be
// tested end to end before (and independently of) the real service. It follows the
// spec's shapes: token endpoint (authorization_code + PKCE, refresh rotation with reuse
// detection, SLT), proofs (User verification/App verification issue + verify), app webhook registration, and the
// hosted flow (flow cookie, Origin check, email/phone codes sent through the mock
// Postmark/Twilio APIs, signup, the details page + review, Google/Apple via mock-oidc).

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, decodeJwt, exportJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from 'jose';
import { codeChallengeS256, createPkcePair } from '../lib/pkce.ts';
import type { SiliconAppsApp } from '../src/fake-apps/types.ts';
import { apiError, HttpError, jsonObject, Router, serializeCookie, serve, type Ctx } from '../src/shared/http.ts';
import { parseBasicAuth } from '../src/shared/util.ts';
import { appleClientSecret } from './helpers.ts';

export interface StubAccount {
  uuid: string;
  kind: 'carbon' | 'silicon';
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  dob: string;
  timezone: string;
}

export interface StubOptions {
  apps: SiliconAppsApp[];
  messaging?: { url: string; postmarkToken: string; twilio: { accountSid: string; authToken: string; messagingServiceSid: string } };
  oidc?: {
    url: string;
    google: { client_id: string; client_secret: string };
    apple: { services_id: string; team_id: string; key_id: string; private_key_pem: string };
  };
}

interface CodeRecord {
  app_id: string;
  redirect_uri: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  nonce: string | null;
  scopes: string[];
  account: StubAccount;
  used: boolean;
}

interface FlowRecord {
  id: string;
  binding: string;
  app_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  nonce: string | null;
  scopes: string[];
  step: string;
  account: StubAccount | null;
  challenge: { channel: 'email' | 'phone'; destination: string; code: string } | null;
  signup: Record<string, unknown> | null;
  provider: { name: 'google' | 'apple'; state: string; nonce: string; verifier: string | null } | null;
  redirect_to: string | null;
}

export interface StubAccounts {
  url: string;
  accounts: StubAccount[];
  /** Pre-issue an authorization code as if a sign-in completed. */
  issueCode(input: { app_id: string; redirect_uri: string; code_challenge?: string | null; code_challenge_method?: string | null; nonce?: string | null; scopes?: string[]; account: StubAccount }): string;
  issueSlt(appId: string, account: StubAccount): string;
  createAccount(input: Partial<StubAccount> & { id: string }): StubAccount;
  tokenRequests: Array<{ grant_type: string; client_id: string | null; form: Record<string, string> }>;
  verifyRequests: Array<{ app_id: string; valid: boolean }>;
  revoked: string[];
  webhookSecrets: Map<string, string>;
  stop(): Promise<void>;
}

const random = (bytes = 24): string => randomBytes(bytes).toString('base64url');
let uuidCounter = 0;
function nextUuid(): string {
  uuidCounter += 1;
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let n = 1000 + uuidCounter * 7919;
  let out = '';
  for (let i = 0; i < 3; i++) {
    out += alphabet[n % 62];
    n = Math.floor(n / 62);
  }
  return out;
}

export async function startStubAccounts(options: StubOptions): Promise<StubAccounts> {
  const router = new Router();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const kid = 'stub-1';
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' };
  const apps = new Map(options.apps.map((a) => [a.app_id, a]));
  const accounts: StubAccount[] = [];
  const codes = new Map<string, CodeRecord>();
  const slts = new Map<string, { app_id: string; account: StubAccount; used: boolean }>();
  const refresh = new Map<string, { family: string; app_id: string; account: StubAccount; used: boolean }>();
  const revokedFamilies = new Set<string>();
  const proofs = new Map<string, { kind: 'user_verification' | 'app_verification'; issuing: string; audiences: string[]; user: StubAccount | null; expires: number; scopes: string[]; proof_id: string }>();
  const flows = new Map<string, FlowRecord>();
  const sessions = new Map<string, StubAccount>();
  const tokenRequests: StubAccounts['tokenRequests'] = [];
  const verifyRequests: StubAccounts['verifyRequests'] = [];
  const revoked: string[] = [];
  const webhookSecrets = new Map<string, string>();
  let url = '';

  function createAccount(input: Partial<StubAccount> & { id: string }): StubAccount {
    const account: StubAccount = {
      uuid: input.uuid ?? nextUuid(),
      kind: input.kind ?? 'carbon',
      id: input.id,
      display_name: input.display_name ?? input.id.replace(/^c:|^si:/, ''),
      email: input.email ?? null,
      phone: input.phone ?? null,
      dob: input.dob ?? '2000-01-01',
      timezone: input.timezone ?? 'UTC',
    };
    accounts.push(account);
    return account;
  }

  function accountForApp(account: StubAccount, appId: string, scopes: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {
      uuid: account.uuid,
      membership_id: `${appId}:${account.uuid}`,
      kind: account.kind,
      id: account.id,
      display_name: account.display_name,
      pfp_url: `https://iris.teamofsilicons.com/pfp/${account.kind}?id=${account.uuid}`,
      updated_at: '2026-10-06T00:00:00.000Z',
      version: 1,
    };
    if (scopes.includes('email') && account.email) Object.assign(out, { email: account.email, email_verified: true });
    if (scopes.includes('phone') && account.phone) Object.assign(out, { phone: account.phone, phone_verified: true });
    if (scopes.includes('timezone')) out.timezone = account.timezone;
    if (scopes.includes('dob')) out.dob = account.dob;
    return out;
  }

  function appAuth(ctx: Ctx, form?: URLSearchParams): SiliconAppsApp {
    const basic = parseBasicAuth(ctx.header('authorization'));
    const id = basic?.user ?? form?.get('client_id') ?? null;
    const secret = basic?.pass ?? form?.get('client_secret') ?? null;
    const app = id ? apps.get(id) : undefined;
    if (!app || secret !== app.secret) throw new HttpError(401, { error: 'invalid_client', error_description: `Unknown app or wrong secret for ${id ?? '(none)'}.` });
    return app;
  }

  async function issueTokens(app: SiliconAppsApp, account: StubAccount, scopes: string[], nonce: string | null, family: string = randomUUID()): Promise<Record<string, unknown>> {
    const now = Math.floor(Date.now() / 1000);
    const access = await new SignJWT({ kind: account.kind, id: account.id, mid: `${app.app_id}:${account.uuid}`, fid: family, scope: scopes.join(' ') })
      .setProtectedHeader({ alg: 'EdDSA', kid })
      .setIssuer(url)
      .setSubject(account.uuid)
      .setAudience(app.app_id)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 1800)
      .setJti(randomUUID())
      .sign(privateKey);
    const refreshToken = `sar_${random(32)}`;
    refresh.set(refreshToken, { family, app_id: app.app_id, account, used: false });
    const body: Record<string, unknown> = {
      access_token: access,
      token_type: 'Bearer',
      expires_in: 1800,
      refresh_token: refreshToken,
      refresh_token_expires_at: new Date(Date.now() + 900 * 86_400_000).toISOString(),
      scope: scopes.join(' '),
      membership_id: `${app.app_id}:${account.uuid}`,
      account: accountForApp(account, app.app_id, scopes),
    };
    if (scopes.includes('openid')) {
      const claims: JWTPayload = { sub: account.uuid, name: account.display_name };
      if (nonce) claims.nonce = nonce;
      if (scopes.includes('email') && account.email) Object.assign(claims, { email: account.email, email_verified: true });
      body.id_token = await new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', kid }).setIssuer(url).setAudience(app.app_id).setIssuedAt(now).setExpirationTime(now + 1800).sign(privateKey);
    }
    return body;
  }

  async function verifyAccess(token: string): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtVerify(token, publicKey, { issuer: url });
      if (revokedFamilies.has(String(payload.fid))) return null;
      return payload;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------- discovery

  router.get('/readyz', (ctx) => ctx.sendJson(200, { database: 'ok' }));
  router.get('/v1/meta', (ctx) =>
    ctx.sendJson(200, { name: 'Silicon Accounts', version: 'stub', environment: 'test', public_url: url, silicon_apps_url: 'https://apps.teamofsilicons.com', providers: { google: !!options.oidc, apple: !!options.oidc }, delivery: 'providers' }),
  );
  router.get('/.well-known/openid-configuration', (ctx) => ctx.sendJson(200, { issuer: url, jwks_uri: `${url}/.well-known/jwks.json`, token_endpoint: `${url}/v1/oauth/token`, authorization_endpoint: `${url}/authorize` }));
  router.get('/.well-known/jwks.json', (ctx) => ctx.sendJson(200, { keys: [jwk] }));

  // --------------------------------------------------------------- tokens

  router.post('/v1/oauth/token', async (ctx) => {
    const form = await ctx.form();
    const grant = form.get('grant_type') ?? '';
    tokenRequests.push({ grant_type: grant, client_id: parseBasicAuth(ctx.header('authorization'))?.user ?? form.get('client_id'), form: Object.fromEntries(form) });
    const app = appAuth(ctx, form);
    const fail = (error: string, description: string): void => ctx.sendJson(400, { error, error_description: description });
    if (grant === 'authorization_code') {
      const record = codes.get(form.get('code') ?? '');
      if (!record || record.app_id !== app.app_id) return fail('invalid_grant', 'Unknown authorization code.');
      if (record.used) return fail('invalid_grant', 'The authorization code was already used.');
      if (form.get('redirect_uri') !== record.redirect_uri) return fail('invalid_grant', `redirect_uri does not match (${form.get('redirect_uri')} vs ${record.redirect_uri}).`);
      if (record.code_challenge) {
        const verifier = form.get('code_verifier');
        if (!verifier) return fail('invalid_grant', 'code_verifier is required: the flow used PKCE.');
        const computed = record.code_challenge_method === 'plain' ? verifier : codeChallengeS256(verifier);
        if (computed !== record.code_challenge) return fail('invalid_grant', 'code_verifier does not match the code_challenge.');
      }
      record.used = true;
      return ctx.sendJson(200, await issueTokens(app, record.account, record.scopes, record.nonce));
    }
    if (grant === 'refresh_token') {
      const record = refresh.get(form.get('refresh_token') ?? '');
      if (!record || record.app_id !== app.app_id || revokedFamilies.has(record.family)) return fail('invalid_grant', 'Unknown or revoked refresh token.');
      if (record.used) {
        revokedFamilies.add(record.family);
        return fail('invalid_grant', 'Refresh token reuse detected: the whole token family is revoked.');
      }
      record.used = true;
      return ctx.sendJson(200, await issueTokens(app, record.account, ['profile'], null, record.family));
    }
    if (grant === 'urn:silicon:params:oauth:grant-type:slt' || grant === 'slt') {
      const record = slts.get(form.get('slt') ?? '');
      if (!record || record.app_id !== app.app_id || record.used) return fail('invalid_grant', 'Unknown, used or foreign short-lived token.');
      record.used = true;
      return ctx.sendJson(200, await issueTokens(app, record.account, ['profile', 'timezone'], null));
    }
    ctx.sendJson(400, { error: 'unsupported_grant_type', error_description: `grant_type ${grant} is not supported.` });
  });

  router.post('/v1/oauth/revoke', async (ctx) => {
    const form = await ctx.form();
    appAuth(ctx, form);
    const token = form.get('token') ?? '';
    revoked.push(token);
    const record = refresh.get(token);
    if (record) revokedFamilies.add(record.family);
    ctx.sendJson(200, {});
  });

  router.get('/v1/userinfo', async (ctx) => {
    const token = /^Bearer (.+)$/.exec(ctx.header('authorization') ?? '')?.[1] ?? '';
    const claims = await verifyAccess(token);
    const account = accounts.find((a) => a.uuid === claims?.sub);
    if (!claims || !account) throw apiError(401, 'unauthenticated', 'Invalid access token.');
    ctx.sendJson(200, { ...accountForApp(account, String(claims.aud), String(claims.scope).split(' ')), sub: account.uuid });
  });

  // --------------------------------------------------------------- proofs

  router.post('/v1/proofs/user-verification', async (ctx) => {
    const app = appAuth(ctx);
    const body = await jsonObject(ctx);
    const claims = await verifyAccess(String(body.subject_token ?? ''));
    if (!claims) throw apiError(400, 'invalid_subject_token', 'subject_token is not a valid access token.');
    if (claims.aud !== app.app_id) throw apiError(403, 'subject_token_wrong_app', `subject_token was issued to ${String(claims.aud)}, not ${app.app_id}.`);
    const receiving = String(body.receiving_app ?? '');
    if (!apps.has(receiving) || receiving === app.app_id) throw apiError(400, 'unknown_receiving_app', `No app ${receiving}.`);
    const user = accounts.find((a) => a.uuid === claims.sub) ?? null;
    const token = `sap_${random(32)}`;
    const proofId = randomUUID();
    const ttl = typeof body.access_ttl_seconds === 'number' ? body.access_ttl_seconds : 1800;
    proofs.set(token, { kind: 'user_verification', issuing: app.app_id, audiences: [receiving], user, expires: Date.now() + ttl * 1000, scopes: (body.scopes as string[]) ?? [], proof_id: proofId });
    ctx.sendJson(201, {
      proof_id: proofId,
      kind: 'user_verification',
      proof_token: token,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      proof_refresh_token: `sapr_${random(32)}`,
      issuing_app: app.app_id,
      receiving_app: receiving,
      user: user ? { uuid: user.uuid, id: user.id, kind: user.kind, membership_id: `${app.app_id}:${user.uuid}` } : null,
      scopes: body.scopes ?? [],
    });
  });

  router.post('/v1/proofs/app-verification', async (ctx) => {
    const app = appAuth(ctx);
    const body = await jsonObject(ctx);
    if (body.audiences !== undefined) throw apiError(422, 'app_verification_single_app', 'An app verification proof is for exactly one app; ask for one proof per app.');
    const receiving = String(body.receiving_app ?? '');
    if (!apps.has(receiving) || receiving === app.app_id) throw apiError(400, 'unknown_receiving_app', `No app ${receiving}.`);
    const token = `sap_${random(32)}`;
    const proofId = randomUUID();
    const ttl = typeof body.access_ttl_seconds === 'number' ? body.access_ttl_seconds : 1800;
    proofs.set(token, { kind: 'app_verification', issuing: app.app_id, audiences: [receiving], user: null, expires: Date.now() + ttl * 1000, scopes: (body.scopes as string[]) ?? [], proof_id: proofId });
    ctx.sendJson(201, { proof_id: proofId, kind: 'app_verification', proof_token: token, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), proof_refresh_token: `sapr_${random(32)}`, issuing_app: app.app_id, receiving_app: receiving, scopes: body.scopes ?? [] });
  });

  router.post('/v1/proofs/verify', async (ctx) => {
    const app = appAuth(ctx);
    const body = await jsonObject(ctx);
    const proof = proofs.get(String(body.proof_token ?? ''));
    const valid = !!proof && proof.expires > Date.now() && proof.audiences.includes(app.app_id);
    verifyRequests.push({ app_id: app.app_id, valid });
    if (!proof || !valid) return ctx.sendJson(200, { valid: false, expires_at: null });
    ctx.sendJson(200, {
      valid: true,
      proof_id: proof.proof_id,
      kind: proof.kind,
      expires_at: new Date(proof.expires).toISOString(),
      issuing_app: { app_id: proof.issuing, name: apps.get(proof.issuing)?.name },
      receiving_app: { app_id: app.app_id, name: app.name },
      user: proof.user ? { uuid: proof.user.uuid, id: proof.user.id, kind: proof.user.kind, membership_id: `${proof.issuing}:${proof.user.uuid}` } : null,
      scopes: proof.scopes,
    });
  });

  router.put('/v1/apps/:app/webhook', async (ctx) => {
    const app = appAuth(ctx);
    if (app.app_id !== ctx.params.app) throw apiError(403, 'app_mismatch', 'Wrong app.');
    const body = await jsonObject(ctx);
    const secret = `whsec_${random(32)}`;
    webhookSecrets.set(app.app_id, secret);
    ctx.sendJson(200, { url: body.url, secret });
  });

  // ----------------------------------------------------------------- flows

  function originGuard(ctx: Ctx): void {
    if (ctx.method !== 'GET' && ctx.header('origin') !== url) throw apiError(403, 'origin_not_allowed', `Origin ${ctx.header('origin') ?? '(none)'} is not allowed.`);
  }

  function boundFlow(ctx: Ctx): FlowRecord {
    const flow = flows.get(ctx.params.id ?? '');
    if (!flow) throw apiError(404, 'not_found', 'No such flow.');
    if (ctx.cookies().sa_flow !== flow.binding) throw apiError(403, 'flow_not_bound', 'This flow belongs to another browser.');
    originGuard(ctx);
    return flow;
  }

  function view(flow: FlowRecord): Record<string, unknown> {
    const app = apps.get(flow.app_id);
    return {
      flow: {
        id: flow.id,
        step: flow.step,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        app: { app_id: flow.app_id, name: app?.name ?? 'Silicon Accounts', logo_url: null, branding: {}, copy: {}, first_party: flow.app_id === 'accounts' },
        methods: ['email', 'phone', 'google', 'apple'],
        signed_in_as: null,
        challenge: flow.challenge ? { channel: flow.challenge.channel, destination: flow.challenge.destination, expires_at: '', resend_available_at: '' } : null,
        signup: flow.signup,
        details: flow.step === 'details' ? { index: 0, count: 1, id: 'details', title: null, subtitle: null, continue_label: null, layout: null, fields: [], challenge: null } : null,
        review: null,
        redirect_to: flow.redirect_to,
        error: null,
        intent: 'signin',
        method_hint: null,
      },
    };
  }

  function afterSignIn(ctx: Ctx, flow: FlowRecord, account: StubAccount): void {
    flow.account = account;
    const sid = `sas_${random()}`;
    sessions.set(sid, account);
    ctx.addHeader('Set-Cookie', serializeCookie('sa_session', sid, { path: '/' }));
    if (flow.app_id === 'accounts') complete(flow);
    else flow.step = 'details';
  }

  function complete(flow: FlowRecord): void {
    const code = `sac_${random()}`;
    codes.set(code, { app_id: flow.app_id, redirect_uri: flow.redirect_uri, code_challenge: flow.code_challenge, code_challenge_method: flow.code_challenge_method, nonce: flow.nonce, scopes: ['profile', ...flow.scopes], account: flow.account as StubAccount, used: false });
    const target = new URL(flow.redirect_uri);
    target.searchParams.set('code', code);
    if (flow.state) target.searchParams.set('state', flow.state);
    flow.redirect_to = target.toString();
    flow.step = 'complete';
  }

  router.post('/v1/flows', async (ctx) => {
    const body = await jsonObject(ctx);
    const appId = String(body.app_id ?? '');
    const redirectUri = String(body.redirect_uri ?? '');
    const app = apps.get(appId);
    if (appId !== 'accounts' && !app) throw apiError(400, 'unknown_app', `No app ${appId}.`);
    // Spec: loopback redirect URIs match ignoring the port, only when registered with that host.
    const loopback = (u: string): string => {
      try {
        const parsed = new URL(u);
        if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') parsed.port = '';
        return parsed.toString();
      } catch {
        return u;
      }
    };
    const allowed = appId === 'accounts' ? redirectUri.startsWith(url) : (app?.signin_defaults.redirect_uris ?? []).some((r) => r === redirectUri || loopback(r) === loopback(redirectUri));
    if (!allowed) throw apiError(400, 'redirect_uri_not_registered', `${redirectUri} is not registered for ${appId}.`);
    const binding = `saf_${random()}`;
    const flow: FlowRecord = {
      id: random(12),
      binding,
      app_id: appId,
      redirect_uri: redirectUri,
      state: (body.state as string) ?? null,
      code_challenge: (body.code_challenge as string) ?? null,
      code_challenge_method: (body.code_challenge_method as string) ?? null,
      nonce: (body.nonce as string) ?? null,
      scopes: String(body.scope ?? '').split(' ').filter(Boolean),
      step: 'choose_method',
      account: null,
      challenge: null,
      signup: null,
      provider: null,
      redirect_to: null,
    };
    flows.set(flow.id, flow);
    ctx.addHeader('Set-Cookie', serializeCookie('sa_flow', binding, { path: '/' }));
    ctx.sendJson(201, view(flow));
  });

  router.get('/v1/flows/:id', (ctx) => ctx.sendJson(200, view(boundFlow(ctx))));

  async function sendCode(flow: FlowRecord, channel: 'email' | 'phone', destination: string): Promise<void> {
    const code = String(100_000 + (randomBytes(3).readUIntBE(0, 3) % 900_000));
    flow.challenge = { channel, destination, code };
    flow.step = 'verify_code';
    const m = options.messaging;
    if (!m) return;
    if (channel === 'email') {
      const res = await fetch(`${m.url}/postmark/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Postmark-Server-Token': m.postmarkToken },
        body: JSON.stringify({ From: 'Silicon Accounts <accounts@teamofsilicons.com>', To: destination, Subject: `${code} is your Silicon Accounts code`, TextBody: `Your code is ${code}.`, MessageStream: 'outbound' }),
      });
      if (!res.ok) throw new Error(`stub could not send email: ${res.status} ${await res.text()}`);
    } else {
      const res = await fetch(`${m.url}/twilio/2010-04-01/Accounts/${m.twilio.accountSid}/Messages.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${m.twilio.accountSid}:${m.twilio.authToken}`).toString('base64')}` },
        body: new URLSearchParams({ To: destination, Body: `Your Silicon Accounts code is ${code}`, MessagingServiceSid: m.twilio.messagingServiceSid }).toString(),
      });
      if (!res.ok) throw new Error(`stub could not send SMS: ${res.status} ${await res.text()}`);
    }
  }

  router.post('/v1/flows/:id/email', async (ctx) => {
    const flow = boundFlow(ctx);
    const body = await jsonObject(ctx);
    await sendCode(flow, 'email', String(body.email ?? '').toLowerCase());
    ctx.sendJson(200, view(flow));
  });

  router.post('/v1/flows/:id/phone', async (ctx) => {
    const flow = boundFlow(ctx);
    const body = await jsonObject(ctx);
    await sendCode(flow, 'phone', String(body.phone ?? ''));
    ctx.sendJson(200, view(flow));
  });

  router.post('/v1/flows/:id/verify', async (ctx) => {
    const flow = boundFlow(ctx);
    const body = await jsonObject(ctx);
    if (!flow.challenge || body.code !== flow.challenge.code) throw apiError(422, 'invalid_code', 'That code is not right.', undefined, { remaining_attempts: 9 });
    const { channel, destination } = flow.challenge;
    const existing = accounts.find((a) => (channel === 'email' ? a.email === destination : a.phone === destination));
    if (existing) afterSignIn(ctx, flow, existing);
    else {
      const local = channel === 'email' ? (destination.split('@')[0] ?? 'carbon') : `carbon${destination.slice(-4)}`;
      flow.signup = { display_name: local, id: `c:${local.replace(/[^a-z0-9_-]+/g, '-').slice(0, 30)}`, timezone: 'UTC', dob: '2008-10-06', pfp_url: null, email: channel === 'email' ? destination : null, phone: channel === 'phone' ? destination : null, provider: null, finishing_import: false };
      flow.step = 'signup';
    }
    ctx.sendJson(200, view(flow));
  });

  router.post('/v1/flows/:id/signup', async (ctx) => {
    const flow = boundFlow(ctx);
    const body = await jsonObject(ctx);
    if (!flow.signup) throw apiError(409, 'no_signup', 'Nothing to sign up.');
    if (accounts.some((a) => a.id === body.id)) throw apiError(409, 'id_taken', `${String(body.id)} is taken.`);
    const account = createAccount({ id: String(body.id), display_name: String(body.display_name), timezone: String(body.timezone), dob: String(body.dob), email: (flow.signup.email as string) ?? null, phone: (flow.signup.phone as string) ?? null });
    afterSignIn(ctx, flow, account);
    ctx.sendJson(200, view(flow));
  });

  router.post('/v1/flows/:id/details/continue', (ctx) => {
    const flow = boundFlow(ctx);
    if (flow.step !== 'details') throw apiError(409, 'invalid_step', `Flow is at ${flow.step}.`);
    complete(flow);
    ctx.sendJson(200, view(flow));
  });

  router.post('/v1/flows/:id/review', async (ctx) => {
    const flow = boundFlow(ctx);
    const body = await jsonObject(ctx);
    if (body.approve === false) {
      const target = new URL(flow.redirect_uri);
      target.searchParams.set('error', 'access_denied');
      if (flow.state) target.searchParams.set('state', flow.state);
      flow.redirect_to = target.toString();
      flow.step = 'complete';
    } else complete(flow);
    ctx.sendJson(200, view(flow));
  });

  router.get('/v1/me', (ctx) => {
    const sid = ctx.cookies().sa_session;
    const account = sid ? sessions.get(sid) : undefined;
    if (!account) throw apiError(401, 'unauthenticated', 'Sign in first.');
    ctx.sendJson(200, { ...account, emails: account.email ? [{ email: account.email, is_primary: true }] : [] });
  });

  // ------------------------------------------------- Google / Apple via mock-oidc

  router.post('/v1/flows/:id/oauth/:provider', (ctx) => {
    const flow = boundFlow(ctx);
    const oidc = options.oidc;
    if (!oidc) throw apiError(503, 'provider_not_configured', 'No providers.');
    const provider = ctx.params.provider === 'apple' ? 'apple' : 'google';
    const state = random();
    const nonce = random();
    const pkce = provider === 'google' ? createPkcePair() : null;
    flow.provider = { name: provider, state, nonce, verifier: pkce?.code_verifier ?? null };
    const authorize = new URL(`${oidc.url}/${provider}/authorize`);
    authorize.searchParams.set('client_id', provider === 'google' ? oidc.google.client_id : oidc.apple.services_id);
    authorize.searchParams.set('redirect_uri', `${url}/v1/oauth/callback/${provider}`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('nonce', nonce);
    if (provider === 'google') {
      authorize.searchParams.set('scope', 'openid email profile');
      authorize.searchParams.set('code_challenge', pkce?.code_challenge ?? '');
      authorize.searchParams.set('code_challenge_method', 'S256');
    } else {
      authorize.searchParams.set('scope', 'name email');
      authorize.searchParams.set('response_mode', 'form_post');
    }
    ctx.sendJson(200, { authorize_url: authorize.toString() });
  });

  async function providerCallback(ctx: Ctx, provider: 'google' | 'apple', params: URLSearchParams): Promise<void> {
    const oidc = options.oidc;
    const flow = [...flows.values()].find((f) => f.provider?.state === params.get('state') && f.provider?.name === provider);
    if (!oidc || !flow?.provider) throw apiError(400, 'unknown_state', 'Unknown provider state.');
    const form: Record<string, string> = { grant_type: 'authorization_code', code: params.get('code') ?? '', redirect_uri: `${url}/v1/oauth/callback/${provider}` };
    if (provider === 'google') Object.assign(form, { client_id: oidc.google.client_id, client_secret: oidc.google.client_secret, code_verifier: flow.provider.verifier ?? '' });
    else {
      const { createPrivateKey } = await import('node:crypto');
      Object.assign(form, {
        client_id: oidc.apple.services_id,
        client_secret: await appleClientSecret({ privateKey: createPrivateKey(oidc.apple.private_key_pem), teamId: oidc.apple.team_id, keyId: oidc.apple.key_id, servicesId: oidc.apple.services_id, audience: `${oidc.url}/apple` }),
      });
    }
    const res = await fetch(`${oidc.url}/${provider}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
    const tokens = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw apiError(502, 'provider_error', `${provider} token exchange failed: ${JSON.stringify(tokens)}`);
    const { payload } = await jwtVerify(String(tokens.id_token), createRemoteJWKSet(new URL(`${oidc.url}/${provider}/jwks`)), { issuer: `${oidc.url}/${provider}`, audience: String(form.client_id) });
    if (payload.nonce !== flow.provider.nonce) throw apiError(400, 'nonce_mismatch', 'id_token nonce does not match.');
    if (payload.email_verified !== true && payload.email_verified !== 'true') throw apiError(400, 'email_not_verified', 'Provider email is not verified.');
    const email = String(payload.email);
    const existing = accounts.find((a) => a.email === email);
    if (existing) afterSignIn(ctx, flow, existing);
    else {
      const user = params.get('user') ? (JSON.parse(params.get('user') ?? '{}') as { name?: { firstName?: string; lastName?: string } }) : null;
      const name = provider === 'google' ? String(decodeJwt(String(tokens.id_token)).name ?? email) : [user?.name?.firstName, user?.name?.lastName].filter(Boolean).join(' ') || email;
      flow.signup = { display_name: name, id: `c:${(email.split('@')[0] ?? 'x').replace(/[^a-z0-9_-]+/g, '-').slice(0, 30)}`, timezone: 'UTC', dob: '2008-10-06', pfp_url: null, email, phone: null, provider, finishing_import: false };
      flow.step = 'signup';
    }
    ctx.redirect(`${url}/authorize/flow/${flow.id}`);
  }

  router.get('/v1/oauth/callback/google', (ctx) => providerCallback(ctx, 'google', ctx.query));
  router.post('/v1/oauth/callback/apple', async (ctx) => providerCallback(ctx, 'apple', await ctx.form()));

  const running = await serve(router, { name: 'stub-accounts', port: 0 });
  url = running.url;

  return {
    url,
    accounts,
    issueCode(input) {
      const code = `sac_${random()}`;
      codes.set(code, { app_id: input.app_id, redirect_uri: input.redirect_uri, code_challenge: input.code_challenge ?? null, code_challenge_method: input.code_challenge_method ?? null, nonce: input.nonce ?? null, scopes: input.scopes ?? ['profile'], account: input.account, used: false });
      return code;
    },
    issueSlt(appId, account) {
      const slt = `slt_${random()}`;
      slts.set(slt, { app_id: appId, account, used: false });
      return slt;
    },
    createAccount,
    tokenRequests,
    verifyRequests,
    revoked,
    webhookSecrets,
    stop: () => running.stop(),
  };
}

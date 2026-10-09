// Clients for the testkit servers' inspection and control endpoints.

import { randomBytes } from 'node:crypto';
import type { CapturedMessage, Channel, MessagingFault, ProviderRequestLog } from '../src/mock-messaging.ts';
import type { IdTokenTamper, OidcFault, OidcIdentity, OidcIdentityInput, OidcRequestLogEntry, Provider } from '../src/mock-oidc.ts';
import { expectStatus, HttpClient, type CookieJar } from './http.ts';

export type { CapturedMessage, Channel, OidcIdentity, OidcRequestLogEntry, Provider };

function rand(n = 6): string {
  return randomBytes(n).toString('hex');
}

/** A fresh, collision-free test email, e.g. `ada+3f9c1e2b7a4d@example.test`. */
export function randomEmail(local = 'carbon', domain = 'example.test'): string {
  return `${local}+${rand()}@${domain}`;
}

// US area codes for which libphonenumber (JS) and the Rust `phonenumber` crate both accept
// every <area>-555-XXXX number. 555 exchange numbers are not reachable by real carriers,
// so even a misconfigured run never texts a real person.
const AREA_CODES =
  '201 202 203 205 206 207 208 209 210 212 213 214 215 216 217 218 219 224 225 228 229 231 234 239 240 248 251 252 253 254 256 260 262 267 269 270 276 281 301 302 303 304 305 307 308 309 310 312 313 314 315 316 317 318 319 320 321 323 325 330 334 336 337 339 347 351 352 360 361 386 401 402 404 405 406 407 408 409 410 412 413 414 415 417 419 423 424 425 430 432 434 435 440 443 469 478 479 480 484 501 502 503 504 505 507 508 509 510 512 513 515 516 517 518 520 530 540 541 551 559 561 562 563 567 570 571 573 574 575 580 585 586 601 602 603 605 606 607 608 609 610 612 614 615 616 617 618 619 620 623 626 630 631 636 641 646 650 651 660 661 662 678 682 701 702 703 704 706 707 708 712 713 714 715 716 717 718 719 720 724 727 731 732 734 740 754 757 760 763 765 770 772 773 774 775 781 785 786 801 802 803 804 805 806 808 810 812 813 814 815 816 817 818 828 830 831 832 843 845 847 848 850 856 857 858 859 860 862 863 864 865 870 901 903 904 906 907 908 909 910 912 913 914 915 916 917 918 919 920 925 928 931 936 937 940 941 947 949 951 952 954 956 970 971 972 973 978 979 980 985 989'.split(
    ' ',
  );
const issuedPhones = new Set<string>();

/**
 * A fresh, valid US number (E.164) of the form +1 <area> 555 XXXX — 2.7 million
 * possibilities, never repeated within one process.
 */
export function randomPhone(): string {
  for (;;) {
    const bytes = randomBytes(4);
    const area = AREA_CODES[bytes.readUInt16BE(0) % AREA_CODES.length]!;
    const line = String(bytes.readUInt16BE(2) % 10_000).padStart(4, '0');
    const phone = `+1${area}555${line}`;
    if (!issuedPhones.has(phone)) {
      issuedPhones.add(phone);
      return phone;
    }
  }
}

// ------------------------------------------------------------------ messaging

export interface MessageFilter {
  to?: string;
  channel?: Channel | 'phone';
  since?: string;
  /** Only messages with seq greater than this (see lastSeq()). */
  after?: number;
  contains?: string;
  subject?: string;
  limit?: number;
}

export class MockMessagingClient {
  readonly http: HttpClient;

  constructor(url: string = process.env.MOCK_MESSAGING_URL ?? 'http://127.0.0.1:8592') {
    this.http = new HttpClient({ baseUrl: url });
  }

  private query(filter: MessageFilter): Record<string, string | number | undefined> {
    return { to: filter.to, channel: filter.channel, since: filter.since, after: filter.after, contains: filter.contains, subject: filter.subject, limit: filter.limit };
  }

  /** Captured messages, newest first. */
  async messages(filter: MessageFilter = {}): Promise<CapturedMessage[]> {
    const res = expectStatus(await this.http.get<{ items: CapturedMessage[] }>('/_messages', { query: this.query(filter) }), 200);
    return res.body.items;
  }

  async latest(filter: MessageFilter = {}): Promise<CapturedMessage | null> {
    const res = await this.http.get<CapturedMessage>('/_messages/latest', { query: this.query(filter) });
    if (res.status === 404) return null;
    return expectStatus(res, 200).body;
  }

  /** The newest sequence number; pass it as `after` to wait only for messages sent later. */
  async lastSeq(): Promise<number> {
    const res = expectStatus(await this.http.get<{ last_seq: number }>('/_messages', { query: { limit: 1 } }), 200);
    return res.body.last_seq;
  }

  /** Waits (server-side long-poll) for the first message matching `filter`. */
  async waitFor(filter: MessageFilter & { timeoutMs?: number }): Promise<CapturedMessage> {
    const timeoutMs = filter.timeoutMs ?? 15_000;
    const res = await this.http.get<CapturedMessage>('/_messages/wait', { query: { ...this.query(filter), timeout_ms: timeoutMs }, timeoutMs: timeoutMs + 5_000 });
    return expectStatus(res, 200).body;
  }

  /** Waits for a message to `to` (sent after `after`) and returns its 6-digit code. */
  async waitForCode(filter: MessageFilter & { timeoutMs?: number }): Promise<string> {
    const message = await this.waitFor(filter);
    if (!message.code) {
      throw new Error(`The message to ${message.to} ("${message.subject ?? message.text?.slice(0, 60) ?? ''}") contains no 6-digit code.`);
    }
    return message.code;
  }

  async clear(filter: MessageFilter = {}): Promise<number> {
    const res = expectStatus(await this.http.delete<{ deleted: number }>('/_messages', { query: this.query(filter) }), 200);
    return res.body.deleted;
  }

  async requests(filter: { provider?: 'postmark' | 'twilio'; outcome?: 'accepted' | 'rejected' | 'fault' } = {}): Promise<ProviderRequestLog[]> {
    return expectStatus(await this.http.get<{ items: ProviderRequestLog[] }>('/_requests', { query: filter }), 200).body.items;
  }

  /** Makes the next `count` sends fail (default HTTP 500). */
  async fault(input: { count?: number; status?: number; channel?: Channel | 'phone' | 'any'; delay_ms?: number; drop?: boolean; message?: string } = {}): Promise<MessagingFault> {
    return expectStatus(await this.http.post<{ fault: MessagingFault }>('/_faults', { json: input }), 201).body.fault;
  }

  async clearFaults(): Promise<void> {
    expectStatus(await this.http.delete('/_faults'), 204);
  }

  async reset(): Promise<void> {
    expectStatus(await this.http.post('/_reset'), 200);
  }
}

// ----------------------------------------------------------------------- oidc

export type AuthorizeOutcome =
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'form_post'; action: string; fields: Record<string, string> }
  | { kind: 'chooser'; html: string }
  | { kind: 'error'; status: number; error: string | null; description: string | null; html: string };

function decodeEntities(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/** Parses the mock Apple form_post page (or any auto-submitting form) into action + fields. */
export function parseFormPost(html: string): { action: string; fields: Record<string, string> } | null {
  const form = /<form[^>]*\baction="([^"]*)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form?.[1]) return null;
  const fields: Record<string, string> = {};
  for (const input of (form[2] ?? '').matchAll(/<input[^>]*>/gi)) {
    const name = /\bname="([^"]*)"/i.exec(input[0])?.[1];
    const value = /\bvalue="([^"]*)"/i.exec(input[0])?.[1] ?? '';
    if (name) fields[decodeEntities(name)] = decodeEntities(value);
  }
  return { action: decodeEntities(form[1]), fields };
}

export class MockOidcClient {
  readonly http: HttpClient;

  constructor(url: string = process.env.MOCK_OIDC_URL ?? 'http://127.0.0.1:8591') {
    this.http = new HttpClient({ baseUrl: url });
  }

  get url(): string {
    return this.http.baseUrl;
  }

  issuer(provider: Provider): string {
    return `${this.http.baseUrl}/${provider}`;
  }

  async registerIdentity(input: OidcIdentityInput): Promise<OidcIdentity> {
    return expectStatus(await this.http.post<{ identity: OidcIdentity }>('/_identities', { json: input }), 201).body.identity;
  }

  /** Registers an identity with a fresh random email (and name) and returns it. */
  async randomIdentity(provider: Provider, overrides: Partial<OidcIdentityInput> = {}): Promise<OidcIdentity> {
    const tag = rand(4);
    return this.registerIdentity({
      provider,
      email: overrides.email ?? `${provider}+${rand()}@example.test`,
      name: overrides.name ?? `Test ${provider === 'google' ? 'Googler' : 'Apple'} ${tag}`,
      given_name: overrides.given_name ?? 'Test',
      family_name: overrides.family_name ?? `${provider === 'google' ? 'Googler' : 'Apple'} ${tag}`,
      ...overrides,
    });
  }

  async identities(provider?: Provider): Promise<OidcIdentity[]> {
    return expectStatus(await this.http.get<{ items: OidcIdentity[] }>('/_identities', { query: { provider } }), 200).body.items;
  }

  async deleteIdentities(filter: { provider?: Provider; email?: string; sub?: string } = {}): Promise<number> {
    return expectStatus(await this.http.delete<{ deleted: number }>('/_identities', { query: filter }), 200).body.deleted;
  }

  async registerClient(input: Record<string, unknown>): Promise<void> {
    expectStatus(await this.http.post('/_clients', { json: input }), 201);
  }

  async clients(): Promise<Array<Record<string, unknown>>> {
    return expectStatus(await this.http.get<{ items: Array<Record<string, unknown>> }>('/_clients'), 200).body.items;
  }

  /** Queues what the next authorize for `provider` picks: an identity (by email or sub) or an error. */
  async next(provider: Provider, selection: { email?: string; sub?: string; name?: string; error?: string }): Promise<void> {
    expectStatus(await this.http.post('/_next', { json: { provider, ...selection } }), 201);
  }

  async requests(filter: { provider?: Provider; endpoint?: string; client_id?: string; outcome?: string } = {}): Promise<OidcRequestLogEntry[]> {
    return expectStatus(await this.http.get<{ items: OidcRequestLogEntry[] }>('/_requests', { query: filter }), 200).body.items;
  }

  async clearRequests(): Promise<void> {
    expectStatus(await this.http.delete('/_requests'), 204);
  }

  async fault(input: {
    endpoint: 'authorize' | 'token' | 'jwks' | 'userinfo';
    provider?: Provider;
    count?: number;
    status?: number;
    error?: string;
    error_description?: string;
    delay_ms?: number;
    id_token?: IdTokenTamper;
  }): Promise<OidcFault> {
    return expectStatus(await this.http.post<{ fault: OidcFault }>('/_faults', { json: input }), 201).body.fault;
  }

  async clearFaults(): Promise<void> {
    expectStatus(await this.http.delete('/_faults'), 204);
  }

  async rotateKey(provider: Provider, keepPrevious = true): Promise<{ kid: string; published: string[] }> {
    return expectStatus(await this.http.post<{ kid: string; published: string[] }>('/_keys/rotate', { json: { provider, keep_previous: keepPrevious } }), 200).body;
  }

  async reset(): Promise<void> {
    expectStatus(await this.http.post('/_reset'), 200);
  }

  /**
   * Plays the browser at the provider: GETs `authorizeUrl` (optionally choosing `email`
   * via `_auto`) and reports what the provider answered — a redirect back to the
   * caller (Google), an auto-submitting form_post (Apple), the chooser, or an error page.
   */
  async authorize(authorizeUrl: string, select?: { email?: string; error?: string }): Promise<AuthorizeOutcome> {
    const url = new URL(authorizeUrl);
    if (select?.email) url.searchParams.set('_auto', select.email);
    if (select?.error) url.searchParams.set('_error', select.error);
    const res = await fetch(url, { redirect: 'manual', headers: { Accept: 'text/html' } });
    const html = await res.text();
    if (res.status >= 300 && res.status < 400) {
      return { kind: 'redirect', status: res.status, location: new URL(res.headers.get('location') ?? '', url).toString() };
    }
    if (res.status === 200 && html.includes('id="apple-form-post"')) {
      const form = parseFormPost(html);
      if (form) return { kind: 'form_post', ...form };
    }
    if (res.status === 200 && html.includes('id="chooser"')) return { kind: 'chooser', html };
    return {
      kind: 'error',
      status: res.status,
      error: /data-error="([^"]*)"/.exec(html)?.[1] ?? null,
      description: decodeEntities(/<p id="error-description">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '') || null,
      html,
    };
  }
}

// ------------------------------------------------------------------ fake apps

export interface FakeAppEvent {
  seq: number;
  event_id: string;
  type: string;
  delivery_id: string | null;
  received_at: string;
  timestamp: number;
  deliveries: number;
  duplicate_count: number;
  /** Accepted only after the secret was registered (it first arrived unverifiable). */
  recovered: boolean;
  payload: { event_id: string; type: string; occurred_at: string; app_id: string | null; silicon: string | null; data: Record<string, unknown> };
}

export class FakeAppsClient {
  readonly http: HttpClient;

  /** Pass a jar to share the fake apps' session cookie with a flow you drive yourself. */
  constructor(url: string = process.env.FAKE_APPS_URL ?? 'http://127.0.0.1:8593', jar?: CookieJar) {
    this.http = new HttpClient({ baseUrl: url, ...(jar ? { jar } : {}) });
  }

  get url(): string {
    return this.http.baseUrl;
  }

  async state(appId: string, includeTokens = false): Promise<Record<string, unknown> & { accounts: Array<Record<string, unknown>> }> {
    return expectStatus(await this.http.get<Record<string, unknown> & { accounts: Array<Record<string, unknown>> }>(`/${appId}/_state`, { query: { include_tokens: includeTokens ? 1 : undefined } }), 200).body;
  }

  async reset(appId?: string): Promise<void> {
    expectStatus(await this.http.delete(appId ? `/${appId}/_state` : '/_state'), 204);
  }

  async events(appId: string, filter: { type?: string; uuid?: string; after?: number; includeRejected?: boolean } = {}): Promise<{ items: FakeAppEvent[]; duplicates: number; deliveries: number; last_seq: number; rejected?: Array<Record<string, unknown>> }> {
    return expectStatus(
      await this.http.get<{ items: FakeAppEvent[]; duplicates: number; deliveries: number; last_seq: number; rejected?: Array<Record<string, unknown>> }>(`/${appId}/_events`, {
        query: { type: filter.type, uuid: filter.uuid, after: filter.after, include_rejected: filter.includeRejected ? 1 : undefined },
      }),
      200,
    ).body;
  }

  /** Waits (server-side long-poll) for an event at `appId`'s webhook matching the filter. */
  async waitForEvent(appId: string, filter: { type?: string; uuid?: string; after?: number; timeoutMs?: number } = {}): Promise<FakeAppEvent> {
    const timeoutMs = filter.timeoutMs ?? 20_000;
    return expectStatus(
      await this.http.get<FakeAppEvent>(`/${appId}/_events/wait`, { query: { type: filter.type, uuid: filter.uuid, after: filter.after, timeout_ms: timeoutMs }, timeoutMs: timeoutMs + 5_000 }),
      200,
    ).body;
  }

  async clearEvents(appId: string): Promise<void> {
    expectStatus(await this.http.delete(`/${appId}/_events`), 204);
  }

  /** Registers the secret Accounts returned for `appId`'s webhook; refused deliveries that verify with it are recovered. */
  async setWebhookSecret(appId: string, secret: string | null, keepPrevious = false): Promise<{ recovered: number }> {
    const res = expectStatus(await this.http.post<{ recovered: number }>(`/${appId}/_webhook-secret`, { json: { secret, keep_previous: keepPrevious } }), 200);
    return { recovered: res.body.recovered };
  }

  /** The fake app registers its own webhook at Silicon Accounts (PUT /v1/apps/{app}/webhook) and keeps a fresh secret (rotated when the URL kept a stored one). */
  async connectWebhook(appId: string, url?: string): Promise<void> {
    expectStatus(await this.http.post(`/${appId}/_connect-webhook`, { json: url ? { url } : {} }), 200);
  }

  async webhookFaults(appId: string, input: { fail_next: number; status?: number; delay_ms?: number }): Promise<void> {
    expectStatus(await this.http.post(`/${appId}/_webhook-faults`, { json: input }), 200);
  }

  async sltLogin(appId: string, slt: string, includeTokens = false): Promise<Record<string, unknown>> {
    return (await this.http.post<Record<string, unknown>>(`/${appId}/slt-login`, { json: { slt }, query: { include_tokens: includeTokens ? 1 : undefined } })).body;
  }

  /**
   * Starts a sign-in at the fake app without a browser: returns the authorize URL (and the
   * state, PKCE verifier and nonce the app holds). The fake app's session cookie lands in
   * this client's jar so callback() later passes the state check.
   */
  async authorizeUrl(appId: string, params: Record<string, string> = {}): Promise<{ authorize_url: string; embed_url: string; state: string; code_verifier: string | null; nonce: string | null; redirect_uri: string }> {
    return expectStatus(await this.http.get<{ authorize_url: string; embed_url: string; state: string; code_verifier: string | null; nonce: string | null; redirect_uri: string }>(`/${appId}/authorize-url`, { query: params }), 200).body;
  }

  /** Delivers the redirect back to the fake app (JSON mode). */
  async callback(appId: string, redirectTo: string): Promise<Record<string, unknown>> {
    const url = new URL(redirectTo);
    return (await this.http.get<Record<string, unknown>>(`/${appId}/callback`, { query: { ...Object.fromEntries(url.searchParams), format: 'json' } })).body;
  }

  async saveToBriefcase(input: { uuid: string; filename?: string; scopes?: string[]; access_ttl_seconds?: number; from?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.http.post<Record<string, unknown>>(`/${input.from ?? 'dm'}/actions/save-to-briefcase`, { json: input });
    return { status: res.status, body: res.body };
  }

  async notify(input: { message?: string; audiences?: string[]; access_ttl_seconds?: number; from?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.http.post<Record<string, unknown>>(`/${input.from ?? 'commit'}/actions/notify`, { json: input });
    return { status: res.status, body: res.body };
  }

  async verifyProof(appId: string, proofToken: string): Promise<{ status: number; verification: Record<string, unknown>; verify_ms: number }> {
    return expectStatus(await this.http.post<{ status: number; verification: Record<string, unknown>; verify_ms: number }>(`/${appId}/api/verify-proof`, { json: { proof_token: proofToken } }), 200).body;
  }

  async issueUserVerification(appId: string, input: { uuid: string; receiving_app?: string; scopes?: string[]; access_ttl_seconds?: number }): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.http.post<{ status: number; body: Record<string, unknown> }>(`/${appId}/actions/issue-user_verification`, { json: input });
    return res.body;
  }

  async refresh(appId: string, uuid: string, reusePrevious = false): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.http.post<Record<string, unknown>>(`/${appId}/refresh`, { json: { uuid, reuse_previous: reusePrevious } });
    return { status: res.status, body: res.body };
  }

  async userinfo(appId: string, uuid: string): Promise<{ status: number; body: unknown }> {
    return expectStatus(await this.http.get<{ status: number; body: unknown }>(`/${appId}/userinfo`, { query: { uuid } }), [200, 502]).body;
  }

  // -- generic webhook sinks (/hooks/<key>), e.g. for a Silicon's own webhook

  /** The URL to give Accounts as a webhook endpoint; events land in the sink named `key`. */
  hookUrl(key: string): string {
    return `${this.http.baseUrl}/hooks/${encodeURIComponent(key)}`;
  }

  /** Registers the sink's secret (e.g. the webhook_secret from creating a Silicon); earlier refused deliveries are re-verified. */
  async setHookSecret(key: string, secret: string | null): Promise<{ recovered: number }> {
    const res = expectStatus(await this.http.post<{ recovered: number }>(`/hooks/${encodeURIComponent(key)}/_webhook-secret`, { json: { secret } }), 200);
    return { recovered: res.body.recovered };
  }

  async hookEvents(key: string, filter: { type?: string; uuid?: string; after?: number; includeRejected?: boolean } = {}): Promise<{ items: FakeAppEvent[]; duplicates: number; deliveries: number; last_seq: number; rejected?: Array<Record<string, unknown>> }> {
    return expectStatus(
      await this.http.get<{ items: FakeAppEvent[]; duplicates: number; deliveries: number; last_seq: number; rejected?: Array<Record<string, unknown>> }>(`/hooks/${encodeURIComponent(key)}/_events`, {
        query: { type: filter.type, uuid: filter.uuid, after: filter.after, include_rejected: filter.includeRejected ? 1 : undefined },
      }),
      200,
    ).body;
  }

  async waitForHookEvent(key: string, filter: { type?: string; uuid?: string; after?: number; timeoutMs?: number } = {}): Promise<FakeAppEvent> {
    const timeoutMs = filter.timeoutMs ?? 20_000;
    return expectStatus(
      await this.http.get<FakeAppEvent>(`/hooks/${encodeURIComponent(key)}/_events/wait`, { query: { type: filter.type, uuid: filter.uuid, after: filter.after, timeout_ms: timeoutMs }, timeoutMs: timeoutMs + 5_000 }),
      200,
    ).body;
  }

  async hookFaults(key: string, input: { fail_next: number; status?: number; delay_ms?: number }): Promise<void> {
    expectStatus(await this.http.post(`/hooks/${encodeURIComponent(key)}/_webhook-faults`, { json: input }), 200);
  }

  async files(appId = 'briefcase', owner?: string): Promise<Array<Record<string, unknown>>> {
    return expectStatus(await this.http.get<{ items: Array<Record<string, unknown>> }>(`/${appId}/api/files`, { query: { owner } }), 200).body.items;
  }
}

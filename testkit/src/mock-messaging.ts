// mock-messaging — local stand-ins for the Postmark Email API (under /postmark) and
// the Twilio Messages API (under /twilio). Silicon Accounts is pointed here with
// ACCOUNTS_POSTMARK_API_URL / ACCOUNTS_TWILIO_API_URL. Every accepted message is
// captured with the 6-digit verification code extracted, so tests can read codes
// (GET /_messages, or long-poll GET /_messages/wait). Auth is checked exactly like
// the real APIs (X-Postmark-Server-Token; Twilio HTTP Basic sid:token), and
// POST /_faults makes the next sends fail so retry paths can be exercised.

import { apiError, jsonObject, Router, serve, type Ctx } from './shared/http.ts';
import { isRecord, nowIso, parseBasicAuth, randomHex, rfc2822, safeEqual, sleep, str, uuid } from './shared/util.ts';

export const DEFAULT_MOCK_MESSAGING_PORT = 8592;

export type Channel = 'email' | 'sms';

export interface CapturedMessage {
  /** Monotonic sequence number (use it with /_messages/wait?after=). */
  seq: number;
  id: string;
  channel: Channel;
  provider: 'postmark' | 'twilio';
  /** First recipient: lower-cased email or E.164 phone. */
  to: string;
  /** Every recipient (Postmark allows a comma-separated To). */
  recipients: string[];
  from: string | null;
  subject: string | null;
  /** Postmark TextBody, or the Twilio Body. */
  text: string | null;
  html: string | null;
  /** First 6-digit verification code found (subject, text, then html). */
  code: string | null;
  codes: string[];
  links: string[];
  message_stream: string | null;
  tag: string | null;
  metadata: Record<string, unknown> | null;
  messaging_service_sid: string | null;
  provider_message_id: string;
  received_at: string;
}

export interface ProviderRequestLog {
  seq: number;
  at: string;
  provider: 'postmark' | 'twilio';
  path: string;
  status: number;
  outcome: 'accepted' | 'rejected' | 'fault';
  error: string | null;
  to: string | null;
  fault_id: string | null;
  message_id: string | null;
}

export interface MessagingFault {
  id: string;
  channel: Channel | 'any';
  remaining: number;
  status: number;
  delay_ms: number;
  /** Close the connection without answering (network failure). */
  drop: boolean;
  message: string | null;
  created_at: string;
}

export interface MockMessagingOptions {
  /** Port to listen on (default 8592; 0 = any free port). */
  port?: number;
  host?: string;
  publicUrl?: string;
  postmark?: {
    /** Accepted X-Postmark-Server-Token values. */
    serverTokens: string[];
    /** Confirmed sender signatures; "*" accepts any From. Default accounts@teamofsilicons.com. */
    senders?: string[] | '*';
    /** Known message streams (default ["outbound"]). */
    messageStreams?: string[];
  };
  twilio?: {
    accountSid: string;
    authToken: string;
    /** Extra API key credentials (SK… sid + secret) accepted as Basic auth. */
    apiKeys?: Array<{ sid: string; secret: string }>;
    /** Known messaging services; empty = any MG… sid accepted. */
    messagingServiceSids?: string[];
    /** Known From numbers; empty = any E.164 number accepted. */
    fromNumbers?: string[];
  };
  log?: boolean | ((line: string) => void);
  /** Keep at most this many messages (oldest dropped). */
  maxMessages?: number;
}

export interface MockMessaging {
  url: string;
  port: number;
  postmarkApiUrl: string;
  twilioApiUrl: string;
  messages(filter?: { to?: string; channel?: Channel }): CapturedMessage[];
  clear(): void;
  stop(): Promise<void>;
}

const SIX_DIGITS = /(?<![0-9])([0-9]{6})(?![0-9])/g;
const SPACED_SIX = /(?<![0-9])([0-9]{3})[  -]([0-9]{3})(?![0-9])/g;
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Extracts 6-digit codes; falls back to "123 456" style only when no plain code exists. */
export function extractCodes(...texts: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(SIX_DIGITS)) if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  if (out.length > 0) return out;
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(SPACED_SIX)) {
      const code = `${m[1]}${m[2]}`;
      if (!out.includes(code)) out.push(code);
    }
  }
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(...texts: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(URL_RE)) out.add(m[0].replace(/[.,;:]+$/, '').replaceAll('&amp;', '&'));
  }
  return [...out];
}

/** "Silicon Accounts <accounts@x>" → "accounts@x" */
export function emailAddress(value: string): string {
  const angle = /<([^>]+)>/.exec(value);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

function splitRecipients(value: string): string[] {
  return value
    .split(',')
    .map((part) => emailAddress(part))
    .filter(Boolean);
}

function normalizePhone(value: string): string {
  return value.replace(/[\s().-]/g, '');
}

function channelFilter(value: string | null): Channel | null {
  if (!value) return null;
  if (value === 'email') return 'email';
  if (value === 'sms' || value === 'phone') return 'sms';
  throw apiError(422, 'invalid_channel', `channel must be email or sms (alias phone), got "${value}".`);
}

export async function start(options: MockMessagingOptions = {}): Promise<MockMessaging> {
  const router = new Router();
  const maxMessages = options.maxMessages ?? 20_000;
  const postmarkTokens = options.postmark?.serverTokens ?? [];
  const senders = options.postmark?.senders ?? ['accounts@teamofsilicons.com'];
  const streams = options.postmark?.messageStreams ?? ['outbound'];
  const twilio = options.twilio ?? null;

  let messages: CapturedMessage[] = [];
  let requests: ProviderRequestLog[] = [];
  let faults: MessagingFault[] = [];
  let seq = 0;
  let requestSeq = 0;
  const waiters = new Set<{ match: (m: CapturedMessage) => boolean; resolve: (m: CapturedMessage) => void }>();

  function logRequest(entry: Omit<ProviderRequestLog, 'seq' | 'at'>): void {
    requestSeq += 1;
    requests.push({ seq: requestSeq, at: nowIso(), ...entry });
    if (requests.length > maxMessages) requests = requests.slice(-maxMessages);
  }

  function capture(message: Omit<CapturedMessage, 'seq' | 'id' | 'received_at' | 'codes' | 'code' | 'links'>): CapturedMessage {
    seq += 1;
    const html = message.html ? htmlToText(message.html) : null;
    const codes = extractCodes(message.subject, message.text, html);
    const full: CapturedMessage = {
      seq,
      id: uuid(),
      received_at: nowIso(),
      code: codes[0] ?? null,
      codes,
      links: extractLinks(message.text, message.html),
      ...message,
    };
    messages.push(full);
    if (messages.length > maxMessages) messages = messages.slice(-maxMessages);
    for (const waiter of [...waiters]) {
      if (waiter.match(full)) {
        waiters.delete(waiter);
        waiter.resolve(full);
      }
    }
    return full;
  }

  /** Returns the fault to apply to this send, if any (consumes one use). */
  function takeFault(channel: Channel): MessagingFault | null {
    const index = faults.findIndex((f) => (f.channel === 'any' || f.channel === channel) && f.remaining > 0);
    if (index < 0) return null;
    const fault = faults[index]!;
    fault.remaining -= 1;
    if (fault.remaining <= 0) faults.splice(index, 1);
    return fault;
  }

  /** Applies a fault; returns true when the request was answered (or dropped). */
  async function applyFault(ctx: Ctx, fault: MessagingFault, provider: 'postmark' | 'twilio', to: string | null): Promise<boolean> {
    if (fault.delay_ms > 0) await sleep(fault.delay_ms, ctx.signal);
    logRequest({ provider, path: ctx.path, status: fault.drop ? 0 : fault.status, outcome: 'fault', error: fault.message, to, fault_id: fault.id, message_id: null });
    if (fault.drop) {
      ctx.req.socket.destroy();
      return true;
    }
    if (fault.status >= 200 && fault.status < 300) return false; // delay-only fault
    if (provider === 'postmark') {
      ctx.sendJson(fault.status, { ErrorCode: fault.status === 429 ? 429 : 0, Message: fault.message ?? `Simulated Postmark failure (HTTP ${fault.status}) from mock-messaging fault injection.` }, fault.status === 429 ? { 'Retry-After': '1' } : {});
    } else {
      const code = fault.status === 429 ? 20429 : 20500;
      ctx.sendJson(
        fault.status,
        { code, message: fault.message ?? `Simulated Twilio failure (HTTP ${fault.status}) from mock-messaging fault injection.`, more_info: `https://www.twilio.com/docs/errors/${code}`, status: fault.status },
        fault.status === 429 ? { 'Retry-After': '1' } : {},
      );
    }
    return true;
  }

  // ------------------------------------------------------------- Postmark

  type PostmarkResult = { status: number; body: Record<string, unknown>; message?: CapturedMessage };

  function validatePostmark(payload: unknown): PostmarkResult {
    if (!isRecord(payload)) return { status: 422, body: { ErrorCode: 300, Message: 'Invalid email request: the body must be a JSON object.' } };
    const from = str(payload.From);
    const to = str(payload.To);
    const textBody = str(payload.TextBody) ?? null;
    const htmlBody = str(payload.HtmlBody) ?? null;
    if (!from) return { status: 422, body: { ErrorCode: 300, Message: "Invalid email request: 'From' is required." } };
    if (!to || splitRecipients(to).length === 0) return { status: 422, body: { ErrorCode: 300, Message: 'Zero recipients specified' } };
    const recipients = splitRecipients(to);
    const badRecipient = recipients.find((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r));
    if (badRecipient) return { status: 422, body: { ErrorCode: 300, Message: `Error parsing 'To': Illegal email address '${badRecipient}'. It must contain the '@' symbol.` } };
    if (recipients.length > 50) return { status: 422, body: { ErrorCode: 300, Message: 'Invalid email request: more than 50 recipients.' } };
    if (!textBody && !htmlBody) return { status: 422, body: { ErrorCode: 300, Message: 'Provide either email TextBody or HtmlBody or both.' } };
    const fromAddress = emailAddress(from);
    if (senders !== '*' && !senders.map((s) => s.toLowerCase()).includes(fromAddress)) {
      return {
        status: 422,
        body: {
          ErrorCode: 400,
          Message: `The 'From' address you supplied (${from}) is not a Sender Signature on your account. Please add and confirm this address in order to be able to use it in the 'From' field of your messages.`,
        },
      };
    }
    const stream = str(payload.MessageStream) ?? 'outbound';
    if (!streams.includes(stream)) return { status: 422, body: { ErrorCode: 1235, Message: `The message stream for the provided 'ID' was not found: '${stream}'.` } };
    const messageId = uuid();
    const message = capture({
      channel: 'email',
      provider: 'postmark',
      to: recipients[0]!,
      recipients,
      from,
      subject: str(payload.Subject) ?? null,
      text: textBody,
      html: htmlBody,
      message_stream: stream,
      tag: str(payload.Tag) ?? null,
      metadata: isRecord(payload.Metadata) ? payload.Metadata : null,
      messaging_service_sid: null,
      provider_message_id: messageId,
    });
    const submitted = new Date().toISOString().replace('Z', '0000Z');
    return { status: 200, body: { To: to, SubmittedAt: submitted, MessageID: messageId, ErrorCode: 0, Message: 'OK' }, message };
  }

  function postmarkAuthorized(ctx: Ctx): { ok: true } | { ok: false; message: string } {
    const token = ctx.header('x-postmark-server-token');
    if (!token) {
      return { ok: false, message: 'No Account or Server API tokens were supplied in the HTTP headers. Please add a header for either X-Postmark-Server-Token or X-Postmark-Account-Token.' };
    }
    if (postmarkTokens.length === 0 || !postmarkTokens.some((t) => safeEqual(t, token))) {
      return { ok: false, message: 'Request does not contain a valid Server token: the X-Postmark-Server-Token header does not match the token configured on mock-messaging.' };
    }
    return { ok: true };
  }

  router.post('/postmark/email', async (ctx) => {
    const auth = postmarkAuthorized(ctx);
    if (!auth.ok) {
      logRequest({ provider: 'postmark', path: ctx.path, status: 401, outcome: 'rejected', error: 'ErrorCode 10', to: null, fault_id: null, message_id: null });
      ctx.sendJson(401, { ErrorCode: 10, Message: auth.message });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await ctx.text());
    } catch {
      logRequest({ provider: 'postmark', path: ctx.path, status: 422, outcome: 'rejected', error: 'ErrorCode 402', to: null, fault_id: null, message_id: null });
      ctx.sendJson(422, { ErrorCode: 402, Message: 'Received invalid JSON input.' });
      return;
    }
    const to = isRecord(payload) ? (str(payload.To) ?? null) : null;
    const fault = takeFault('email');
    if (fault && (await applyFault(ctx, fault, 'postmark', to))) return;
    const result = validatePostmark(payload);
    logRequest({
      provider: 'postmark',
      path: ctx.path,
      status: result.status,
      outcome: result.message ? 'accepted' : 'rejected',
      error: result.message ? null : `ErrorCode ${String(result.body.ErrorCode)}`,
      to,
      fault_id: fault?.id ?? null,
      message_id: result.message?.id ?? null,
    });
    ctx.sendJson(result.status, result.body);
  });

  router.post('/postmark/email/batch', async (ctx) => {
    const auth = postmarkAuthorized(ctx);
    if (!auth.ok) {
      logRequest({ provider: 'postmark', path: ctx.path, status: 401, outcome: 'rejected', error: 'ErrorCode 10', to: null, fault_id: null, message_id: null });
      ctx.sendJson(401, { ErrorCode: 10, Message: auth.message });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await ctx.text());
    } catch {
      ctx.sendJson(422, { ErrorCode: 402, Message: 'Received invalid JSON input.' });
      return;
    }
    if (!Array.isArray(payload)) {
      ctx.sendJson(422, { ErrorCode: 300, Message: 'Invalid email request: the batch endpoint expects a JSON array of messages.' });
      return;
    }
    const fault = takeFault('email');
    if (fault && (await applyFault(ctx, fault, 'postmark', null))) return;
    const results = payload.map((item) => {
      const result = validatePostmark(item);
      logRequest({
        provider: 'postmark',
        path: ctx.path,
        status: result.status,
        outcome: result.message ? 'accepted' : 'rejected',
        error: result.message ? null : `ErrorCode ${String(result.body.ErrorCode)}`,
        to: isRecord(item) ? (str(item.To) ?? null) : null,
        fault_id: null,
        message_id: result.message?.id ?? null,
      });
      return result.body;
    });
    ctx.sendJson(200, results);
  });

  // --------------------------------------------------------------- Twilio

  function twilioError(ctx: Ctx, status: number, code: number, message: string, to: string | null): void {
    logRequest({ provider: 'twilio', path: ctx.path, status, outcome: 'rejected', error: `${code}: ${message}`, to, fault_id: null, message_id: null });
    ctx.sendJson(status, { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status });
  }

  function twilioAuthenticated(ctx: Ctx): boolean {
    if (!twilio) return false;
    const basic = parseBasicAuth(ctx.header('authorization'));
    if (!basic) return false;
    if (basic.user === twilio.accountSid && safeEqual(basic.pass, twilio.authToken)) return true;
    return (twilio.apiKeys ?? []).some((k) => k.sid === basic.user && safeEqual(basic.pass, k.secret));
  }

  const twilioMessages = new Map<string, Record<string, unknown>>();

  router.post('/twilio/2010-04-01/Accounts/:sid/Messages.json', async (ctx) => {
    const sid = ctx.params.sid ?? '';
    if (!twilioAuthenticated(ctx)) {
      return twilioError(ctx, 401, 20003, 'Authenticate: HTTP Basic credentials (AccountSid:AuthToken) are missing or do not match the account configured on mock-messaging.', null);
    }
    if (!twilio || sid !== twilio.accountSid) {
      return twilioError(ctx, 404, 20404, `The requested resource /2010-04-01/Accounts/${sid}/Messages.json was not found (unknown Account SID).`, null);
    }
    const contentType = ctx.contentType();
    const form = contentType === 'application/x-www-form-urlencoded' ? await ctx.form() : new URLSearchParams();
    const toRaw = form.get('To');
    const to = toRaw ? normalizePhone(toRaw) : null;
    if (!toRaw) {
      const hint = contentType !== 'application/x-www-form-urlencoded' ? ` (Twilio expects application/x-www-form-urlencoded; got "${contentType || 'no content type'}")` : '';
      return twilioError(ctx, 400, 21604, `A 'To' phone number is required.${hint}`, null);
    }
    const fault = takeFault('sms');
    if (fault && (await applyFault(ctx, fault, 'twilio', to))) return;
    if (!to || !E164.test(to)) return twilioError(ctx, 400, 21211, `The 'To' number ${toRaw} is not a valid phone number.`, toRaw);
    const body = form.get('Body');
    if (!body && !form.get('MediaUrl') && !form.get('ContentSid')) return twilioError(ctx, 400, 21602, 'Message body is required.', to);
    if (body && body.length > 1600) return twilioError(ctx, 400, 21617, 'The concatenated message body exceeds the 1600 character limit.', to);
    const service = form.get('MessagingServiceSid');
    const from = form.get('From');
    if (!service && !from) return twilioError(ctx, 400, 21603, "A 'From' phone number is required.", to);
    if (service) {
      const known = twilio.messagingServiceSids ?? [];
      if (!/^MG[0-9a-f]{32}$/.test(service) || (known.length > 0 && !known.includes(service))) {
        return twilioError(ctx, 400, 21701, `The Messaging Service Sid ${service} is invalid.`, to);
      }
    }
    if (from && !service) {
      const known = twilio.fromNumbers ?? [];
      if (!E164.test(normalizePhone(from)) || (known.length > 0 && !known.includes(normalizePhone(from)))) {
        return twilioError(ctx, 400, 21606, `The From phone number ${from} is not a valid, SMS-capable inbound phone number or short code for your account.`, to);
      }
    }
    const messageSid = `SM${randomHex(32)}`;
    const captured = capture({
      channel: 'sms',
      provider: 'twilio',
      to,
      recipients: [to],
      from: from ? normalizePhone(from) : null,
      subject: null,
      text: body,
      html: null,
      message_stream: null,
      tag: null,
      metadata: null,
      messaging_service_sid: service,
      provider_message_id: messageSid,
    });
    const now = rfc2822();
    const resource = {
      account_sid: twilio.accountSid,
      api_version: '2010-04-01',
      body: body ?? '',
      date_created: now,
      date_sent: null,
      date_updated: now,
      direction: 'outbound-api',
      error_code: null,
      error_message: null,
      from: service ? null : normalizePhone(from ?? ''),
      messaging_service_sid: service,
      num_media: '0',
      num_segments: String(Math.max(1, Math.ceil((body ?? '').length / 160))),
      price: null,
      price_unit: 'USD',
      sid: messageSid,
      status: service ? 'accepted' : 'queued',
      subresource_uris: { media: `/2010-04-01/Accounts/${twilio.accountSid}/Messages/${messageSid}/Media.json` },
      to,
      uri: `/2010-04-01/Accounts/${twilio.accountSid}/Messages/${messageSid}.json`,
    };
    twilioMessages.set(messageSid, resource);
    logRequest({ provider: 'twilio', path: ctx.path, status: 201, outcome: 'accepted', error: null, to, fault_id: fault?.id ?? null, message_id: captured.id });
    ctx.sendJson(201, resource);
  });

  router.get('/twilio/2010-04-01/Accounts/:sid/Messages/:messageSid.json', (ctx) => {
    if (!twilioAuthenticated(ctx)) return twilioError(ctx, 401, 20003, 'Authenticate', null);
    const resource = twilioMessages.get(ctx.params.messageSid ?? '');
    if (!resource) return twilioError(ctx, 404, 20404, `The requested resource ${ctx.path} was not found`, null);
    ctx.sendJson(200, resource);
  });

  // ------------------------------------------------------------- inspection

  function matcher(query: URLSearchParams): (m: CapturedMessage) => boolean {
    const to = query.get('to');
    const toNorm = to ? (to.includes('@') ? to.trim().toLowerCase() : normalizePhone(to)) : null;
    const channel = channelFilter(query.get('channel'));
    const since = query.get('since');
    const sinceMs = since ? Date.parse(since) : null;
    if (since && Number.isNaN(sinceMs)) throw apiError(422, 'invalid_since', `since must be an ISO timestamp, got "${since}".`);
    const after = query.get('after');
    const afterSeq = after ? Number.parseInt(after, 10) : null;
    const contains = query.get('contains');
    const subject = query.get('subject');
    return (m) =>
      (!toNorm || m.recipients.includes(toNorm)) &&
      (!channel || m.channel === channel) &&
      (sinceMs === null || Date.parse(m.received_at) >= sinceMs) &&
      (afterSeq === null || m.seq > afterSeq) &&
      (!contains || `${m.subject ?? ''}\n${m.text ?? ''}\n${m.html ?? ''}`.includes(contains)) &&
      (!subject || (m.subject ?? '').includes(subject));
  }

  router.get('/_messages', (ctx) => {
    const match = matcher(ctx.query);
    const limit = Math.max(1, Math.min(1000, Number.parseInt(ctx.query.get('limit') ?? '100', 10) || 100));
    const items = messages.filter(match).reverse().slice(0, limit);
    ctx.sendJson(200, { items, count: items.length, last_seq: seq });
  });

  router.get('/_messages/latest', (ctx) => {
    const match = matcher(ctx.query);
    const found = [...messages].reverse().find(match);
    if (!found) throw apiError(404, 'no_message', 'No captured message matches this filter yet.', 'Use GET /_messages/wait to wait for one.');
    ctx.sendJson(200, found);
  });

  router.get('/_messages/wait', async (ctx) => {
    const match = matcher(ctx.query);
    const timeoutMs = Math.max(0, Math.min(120_000, Number.parseInt(ctx.query.get('timeout_ms') ?? '10000', 10) || 10_000));
    const existing = messages.find(match);
    if (existing) {
      ctx.sendJson(200, existing);
      return;
    }
    const message = await new Promise<CapturedMessage | null>((resolve) => {
      const finish = (m: CapturedMessage | null): void => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        waiters.delete(waiter);
        resolve(m);
      };
      const onAbort = (): void => finish(null);
      const waiter = { match, resolve: (m: CapturedMessage) => finish(m) };
      const timer = setTimeout(() => finish(null), timeoutMs);
      waiters.add(waiter);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
    if (ctx.signal.aborted) return;
    if (!message) {
      throw apiError(408, 'timeout', `No message matching ${ctx.url.search || '(no filter)'} arrived within ${timeoutMs} ms.`, 'Check that Silicon Accounts runs with ACCOUNTS_DELIVERY=providers and points ACCOUNTS_POSTMARK_API_URL / ACCOUNTS_TWILIO_API_URL at this mock; GET /_requests shows rejected sends.');
    }
    ctx.sendJson(200, message);
  });

  router.get('/_messages/:id', (ctx) => {
    const found = messages.find((m) => m.id === ctx.params.id);
    if (!found) throw apiError(404, 'no_message', `No captured message with id ${ctx.params.id}.`);
    ctx.sendJson(200, found);
  });

  router.delete('/_messages', (ctx) => {
    const match = ctx.query.size > 0 ? matcher(ctx.query) : () => true;
    const before = messages.length;
    messages = messages.filter((m) => !match(m));
    ctx.sendJson(200, { deleted: before - messages.length });
  });

  router.get('/_requests', (ctx) => {
    const provider = ctx.query.get('provider');
    const outcome = ctx.query.get('outcome');
    ctx.sendJson(200, { items: requests.filter((r) => (!provider || r.provider === provider) && (!outcome || r.outcome === outcome)).reverse() });
  });
  router.delete('/_requests', (ctx) => {
    requests = [];
    ctx.noContent();
  });

  router.post('/_faults', async (ctx) => {
    const body = await jsonObject(ctx);
    const channel = body.channel === undefined || body.channel === null || body.channel === 'any' ? 'any' : channelFilter(String(body.channel));
    const status = typeof body.status === 'number' ? body.status : 500;
    if (status < 200 || status > 599) throw apiError(422, 'invalid_fault', `status must be an HTTP status code, got ${status}.`);
    const count = [body.count, body.fail_next, body.n].find((v): v is number => typeof v === 'number') ?? 1;
    const fault: MessagingFault = {
      id: uuid(),
      channel: channel ?? 'any',
      remaining: Math.max(1, Math.floor(count)),
      status,
      delay_ms: typeof body.delay_ms === 'number' ? Math.max(0, body.delay_ms) : 0,
      drop: body.drop === true,
      message: str(body.message) ?? null,
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

  router.post('/_reset', (ctx) => {
    mock.clear();
    ctx.sendJson(200, { ok: true });
  });

  router.get('/_health', (ctx) => ctx.sendJson(200, { ok: true, service: 'mock-messaging', postmark: postmarkTokens.length > 0, twilio: twilio !== null }));

  router.get('/', (ctx) =>
    ctx.sendJson(200, {
      service: 'mock-messaging',
      description: 'Mock Postmark Email API (/postmark) and Twilio Messages API (/twilio) for Silicon Accounts development and e2e tests.',
      postmark_api_url: `${base}/postmark`,
      twilio_api_url: `${base}/twilio`,
      endpoints: {
        'POST /postmark/email': 'Postmark single send (X-Postmark-Server-Token)',
        'POST /postmark/email/batch': 'Postmark batch send',
        'POST /twilio/2010-04-01/Accounts/{sid}/Messages.json': 'Twilio message create (HTTP Basic sid:token, form body)',
        'GET /_messages?to=&channel=email|sms&since=&after=&contains=&limit=': 'captured messages, newest first, each with the extracted 6-digit code',
        'GET /_messages/latest?to=&channel=': 'newest matching message or 404',
        'GET /_messages/wait?to=&channel=&after=<seq>&timeout_ms=': 'long-poll for the first matching message (408 on timeout)',
        'DELETE /_messages?to=': 'clear captured messages',
        'GET /_requests?provider=&outcome=': 'every provider call incl. rejected and faulted ones, newest first',
        'POST /_faults': 'make the next sends fail {count|fail_next, status=500, channel=email|sms|any, delay_ms?, drop?, message?}',
        'POST /_reset': 'clear messages, requests and faults',
      },
    }),
  );

  const running = await serve(router, { name: 'mock-messaging', port: options.port ?? DEFAULT_MOCK_MESSAGING_PORT, host: options.host ?? '127.0.0.1', log: options.log ?? false });
  const base = (options.publicUrl ?? running.url).replace(/\/+$/, '');

  const mock: MockMessaging = {
    url: base,
    port: running.port,
    postmarkApiUrl: `${base}/postmark`,
    twilioApiUrl: `${base}/twilio`,
    messages(filter = {}) {
      const query = new URLSearchParams();
      if (filter.to) query.set('to', filter.to);
      if (filter.channel) query.set('channel', filter.channel);
      return messages.filter(matcher(query)).reverse();
    },
    clear() {
      messages = [];
      requests = [];
      faults = [];
    },
    stop: () => running.stop(),
  };
  return mock;
}

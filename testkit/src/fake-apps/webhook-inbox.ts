// A webhook receiver that behaves like a careful app: verifies X-Accounts-Signature,
// refuses stale timestamps, dedupes by event_id, and records everything for tests.
//
// Refused deliveries keep their raw bytes, so when a secret is registered later (a
// Silicon only learns its webhook secret from the create response, after Accounts may
// already have sent `silicon.created`) they are re-verified as of when they arrived and
// recovered into the event list — tests then don't have to wait for Accounts' retry.

import { verifyWebhookSignature, WEBHOOK_HEADERS } from '../../lib/signature.ts';
import type { Ctx } from '../shared/http.ts';
import { isRecord, nowIso, sleep, str } from '../shared/util.ts';

const MAX_RECORDS = 500;

export interface InboxEvent {
  seq: number;
  event_id: string;
  type: string;
  delivery_id: string | null;
  received_at: string;
  timestamp: number;
  deliveries: number;
  duplicate_count: number;
  /** true when the event was accepted retroactively after a secret was registered. */
  recovered: boolean;
  payload: Record<string, unknown>;
}

export interface InboxRejection {
  seq: number;
  at: string;
  status: number;
  reason: string;
  message: string;
  event_id: string | null;
  type: string | null;
  delivery_id: string | null;
  recovered: boolean;
}

interface StoredRejection extends InboxRejection {
  raw: Buffer;
  timestampHeader: string | null;
  signatureHeader: string | null;
  receivedAtSeconds: number;
}

type Outcome = { accepted: true; event: InboxEvent; duplicate: boolean } | { accepted: false; status: number; reason: string; message: string };

export class WebhookInbox {
  readonly name: string;
  /** For app inboxes: events must carry this app_id (null/absent app_id is allowed). */
  readonly expectedAppId: string | null;
  readonly tolerance: number;
  secret: string | null;
  previous: string | null = null;
  fault: { remaining: number; status: number; delay_ms: number } | null = null;
  events: InboxEvent[] = [];
  byId = new Map<string, InboxEvent>();
  rejected: StoredRejection[] = [];
  duplicates = 0;
  deliveries = 0;
  seq = 0;
  private readonly waiters = new Set<{ match: (e: InboxEvent) => boolean; resolve: (e: InboxEvent) => void }>();

  constructor(options: { name: string; secret: string | null; expectedAppId?: string | null; toleranceSeconds?: number }) {
    this.name = options.name;
    this.secret = options.secret;
    this.expectedAppId = options.expectedAppId ?? null;
    this.tolerance = options.toleranceSeconds ?? 300;
  }

  /** Handles POST <webhook url>. */
  async receive(ctx: Ctx): Promise<void> {
    const raw = await ctx.body();
    this.deliveries += 1;
    const fault = this.fault;
    if (fault && fault.remaining > 0) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) this.fault = null;
      if (fault.delay_ms > 0) await sleep(fault.delay_ms, ctx.signal);
      this.reject(ctx, raw, fault.status, 'fault_injected', `Simulated failure (HTTP ${fault.status}) from the ${this.name} fault injection.`);
      return;
    }
    const outcome = this.process(raw, ctx.header(WEBHOOK_HEADERS.timestamp) ?? null, ctx.header(WEBHOOK_HEADERS.signature) ?? null, ctx.header(WEBHOOK_HEADERS.eventId) ?? null, ctx.header(WEBHOOK_HEADERS.eventType) ?? null, ctx.header(WEBHOOK_HEADERS.deliveryId) ?? null, undefined, false);
    if (!outcome.accepted) {
      this.reject(ctx, raw, outcome.status, outcome.reason, outcome.message);
      return;
    }
    ctx.sendJson(200, outcome.duplicate ? { ok: true, duplicate: true, event_id: outcome.event.event_id } : { ok: true, event_id: outcome.event.event_id });
  }

  private reject(ctx: Ctx, raw: Buffer, status: number, reason: string, message: string): void {
    this.seq += 1;
    this.rejected.push({
      seq: this.seq,
      at: nowIso(),
      status,
      reason,
      message,
      event_id: ctx.header(WEBHOOK_HEADERS.eventId) ?? null,
      type: ctx.header(WEBHOOK_HEADERS.eventType) ?? null,
      delivery_id: ctx.header(WEBHOOK_HEADERS.deliveryId) ?? null,
      recovered: false,
      raw,
      timestampHeader: ctx.header(WEBHOOK_HEADERS.timestamp) ?? null,
      signatureHeader: ctx.header(WEBHOOK_HEADERS.signature) ?? null,
      receivedAtSeconds: Math.floor(Date.now() / 1000),
    });
    if (this.rejected.length > MAX_RECORDS) this.rejected.splice(0, this.rejected.length - MAX_RECORDS);
    ctx.sendJson(status, { ok: false, error: { code: reason, message } });
  }

  private process(
    raw: Buffer,
    timestamp: string | null,
    signature: string | null,
    headerId: string | null,
    headerType: string | null,
    deliveryId: string | null,
    nowSeconds: number | undefined,
    recovered: boolean,
  ): Outcome {
    const verification = verifyWebhookSignature({ secrets: [this.secret, this.previous], timestamp, signature, rawBody: raw, toleranceSeconds: this.tolerance, ...(nowSeconds !== undefined ? { nowSeconds } : {}) });
    if (!verification.ok) return { accepted: false, status: 401, reason: verification.reason, message: verification.message };
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return { accepted: false, status: 400, reason: 'invalid_json', message: 'The webhook body is not valid JSON.' };
    }
    if (!isRecord(payload)) return { accepted: false, status: 400, reason: 'invalid_json', message: 'The webhook body must be a JSON object.' };
    const eventId = str(payload.event_id);
    const type = str(payload.type);
    if (!eventId || !type) return { accepted: false, status: 400, reason: 'invalid_event', message: 'The webhook body needs event_id and type.' };
    if (headerId !== eventId || headerType !== type) {
      return { accepted: false, status: 400, reason: 'header_body_mismatch', message: `Headers say ${String(headerType)}/${String(headerId)} but the body says ${type}/${eventId}.` };
    }
    if (this.expectedAppId && typeof payload.app_id === 'string' && payload.app_id !== this.expectedAppId) {
      return { accepted: false, status: 400, reason: 'wrong_app', message: `This event is for app ${payload.app_id}, but it was delivered to ${this.expectedAppId}'s webhook.` };
    }
    const existing = this.byId.get(eventId);
    if (existing) {
      existing.duplicate_count += 1;
      existing.deliveries += 1;
      this.duplicates += 1;
      return { accepted: true, event: existing, duplicate: true };
    }
    this.seq += 1;
    const event: InboxEvent = {
      seq: this.seq,
      event_id: eventId,
      type,
      delivery_id: deliveryId,
      received_at: nowIso(),
      timestamp: verification.timestamp,
      deliveries: 1,
      duplicate_count: 0,
      recovered,
      payload,
    };
    this.events.push(event);
    this.byId.set(eventId, event);
    if (this.events.length > MAX_RECORDS) this.events.splice(0, this.events.length - MAX_RECORDS);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(event)) {
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
    return { accepted: true, event, duplicate: false };
  }

  /** Sets the secret; refused deliveries that verify with it (as of their arrival) are recovered. */
  setSecret(secret: string | null, keepPrevious = false): { recovered: number } {
    this.previous = keepPrevious ? this.secret : null;
    this.secret = secret;
    let recovered = 0;
    if (!secret) return { recovered };
    for (const rejection of this.rejected) {
      if (rejection.recovered || (rejection.reason !== 'signature_mismatch' && rejection.reason !== 'no_secret')) continue;
      const outcome = this.process(rejection.raw, rejection.timestampHeader, rejection.signatureHeader, rejection.event_id, rejection.type, rejection.delivery_id, rejection.receivedAtSeconds, true);
      if (outcome.accepted) {
        rejection.recovered = true;
        if (!outcome.duplicate) recovered += 1;
      }
    }
    return { recovered };
  }

  setFault(failNext: number, status: number, delayMs: number): void {
    this.fault = failNext > 0 ? { remaining: failNext, status, delay_ms: delayMs } : null;
  }

  matcher(query: URLSearchParams): (e: InboxEvent) => boolean {
    const type = query.get('type');
    const eventId = query.get('event_id');
    const after = query.get('after');
    const afterSeq = after ? Number.parseInt(after, 10) : null;
    const uuidFilter = query.get('uuid');
    return (e) =>
      (!type || e.type === type) &&
      (!eventId || e.event_id === eventId) &&
      (afterSeq === null || e.seq > afterSeq) &&
      (!uuidFilter || (isRecord(e.payload.data) && e.payload.data.uuid === uuidFilter) || e.payload.silicon === uuidFilter);
  }

  list(query: URLSearchParams): Record<string, unknown> {
    const items = this.events.filter(this.matcher(query)).reverse();
    const out: Record<string, unknown> = { items, count: items.length, duplicates: this.duplicates, deliveries: this.deliveries, last_seq: this.seq };
    if (query.get('include_rejected') === '1') out.rejected = this.rejected.map(({ raw: _raw, timestampHeader: _t, signatureHeader: _s, receivedAtSeconds: _r, ...rest }) => rest).reverse();
    return out;
  }

  /** Resolves with the first matching event (existing or future), or null on timeout/abort. */
  wait(query: URLSearchParams, timeoutMs: number, signal: AbortSignal): Promise<InboxEvent | null> {
    const match = this.matcher(query);
    const existing = this.events.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const finish = (event: InboxEvent | null): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(waiter);
        resolve(event);
      };
      const onAbort = (): void => finish(null);
      const waiter = { match, resolve: (event: InboxEvent) => finish(event) };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.waiters.add(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  clear(): void {
    this.events = [];
    this.byId.clear();
    this.rejected = [];
    this.duplicates = 0;
    this.deliveries = 0;
  }

  stats(): Record<string, unknown> {
    return {
      secret_set: this.secret !== null,
      previous_secret_set: this.previous !== null,
      deliveries: this.deliveries,
      events: this.events.length,
      duplicates: this.duplicates,
      rejected: this.rejected.length,
      pending_faults: this.fault?.remaining ?? 0,
    };
  }
}

// Webhook signatures exactly as Silicon Accounts sends them (02-api.md "Webhooks"):
//   X-Accounts-Timestamp: <unix seconds>
//   X-Accounts-Signature: v1=<hex HMAC-SHA256(secret, "{timestamp}.{raw body}")>
// The HMAC key is the webhook secret string itself (the whole `whsec_…` value, UTF-8).
// Several `v1=` values may be present (comma or space separated); any match is accepted.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_HEADERS = {
  eventId: 'x-accounts-event-id',
  eventType: 'x-accounts-event-type',
  deliveryId: 'x-accounts-delivery-id',
  timestamp: 'x-accounts-timestamp',
  signature: 'x-accounts-signature',
} as const;

export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Hex HMAC-SHA256(secret, "{timestamp}.{rawBody}"). */
export function computeWebhookSignature(secret: string, timestamp: string | number, rawBody: string | Buffer | Uint8Array): string {
  const mac = createHmac('sha256', Buffer.from(secret, 'utf8'));
  mac.update(`${timestamp}.`, 'utf8');
  mac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody));
  return mac.digest('hex');
}

/** The full header value, `v1=<hex>`. */
export function webhookSignatureHeader(secret: string, timestamp: string | number, rawBody: string | Buffer | Uint8Array): string {
  return `v1=${computeWebhookSignature(secret, timestamp, rawBody)}`;
}

/** All v1 signatures in a header value. */
export function parseSignatureHeader(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .map((part) => part.slice(3).toLowerCase())
    .filter((hex) => /^[0-9a-f]+$/.test(hex));
}

export type WebhookVerificationFailure =
  | 'no_secret'
  | 'missing_signature'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'no_v1_signature'
  | 'signature_mismatch';

export type WebhookVerification =
  | { ok: true; timestamp: number; age_seconds: number }
  | { ok: false; reason: WebhookVerificationFailure; message: string };

export interface VerifyWebhookOptions {
  /** Current secret, or [current, previous] while rotating. */
  secrets: string | Array<string | null | undefined> | null | undefined;
  /** X-Accounts-Timestamp value. */
  timestamp: string | null | undefined;
  /** X-Accounts-Signature value. */
  signature: string | null | undefined;
  /** Exact bytes received (never a re-serialised JSON object). */
  rawBody: string | Buffer | Uint8Array;
  /** Allowed clock difference in seconds (default 300). */
  toleranceSeconds?: number;
  /** Override "now" in unix seconds (tests). */
  nowSeconds?: number;
}

export function verifyWebhookSignature(options: VerifyWebhookOptions): WebhookVerification {
  const secrets = (Array.isArray(options.secrets) ? options.secrets : [options.secrets]).filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) {
    return { ok: false, reason: 'no_secret', message: 'No webhook secret is registered, so the signature cannot be checked.' };
  }
  if (!options.signature) return { ok: false, reason: 'missing_signature', message: 'The X-Accounts-Signature header is missing.' };
  if (!options.timestamp) return { ok: false, reason: 'missing_timestamp', message: 'The X-Accounts-Timestamp header is missing.' };
  if (!/^\d{1,12}$/.test(options.timestamp)) {
    return { ok: false, reason: 'invalid_timestamp', message: `X-Accounts-Timestamp must be unix seconds, got "${options.timestamp}".` };
  }
  const timestamp = Number.parseInt(options.timestamp, 10);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const age = now - timestamp;
  if (Math.abs(age) > tolerance) {
    return {
      ok: false,
      reason: 'timestamp_out_of_tolerance',
      message: `X-Accounts-Timestamp ${timestamp} is ${age} s away from now (tolerance ${tolerance} s); refusing a possibly replayed delivery.`,
    };
  }
  const candidates = parseSignatureHeader(options.signature);
  if (candidates.length === 0) {
    return { ok: false, reason: 'no_v1_signature', message: `X-Accounts-Signature has no v1=<hex> value (got "${options.signature.slice(0, 80)}").` };
  }
  for (const secret of secrets) {
    const expected = Buffer.from(computeWebhookSignature(secret, options.timestamp, options.rawBody), 'hex');
    for (const candidate of candidates) {
      const given = Buffer.from(candidate, 'hex');
      if (given.length === expected.length && timingSafeEqual(given, expected)) {
        return { ok: true, timestamp, age_seconds: age };
      }
    }
  }
  return {
    ok: false,
    reason: 'signature_mismatch',
    message: 'X-Accounts-Signature does not match HMAC-SHA256(secret, "{timestamp}.{raw body}") for the registered secret (wrong or rotated secret, or the body was altered).',
  };
}

export interface SignedDelivery {
  headers: Record<string, string>;
  body: string;
}

/**
 * Builds a delivery the way Silicon Accounts would send it — useful to post hand-made
 * events at the fake app server or any webhook receiver under test.
 */
export function signWebhookDelivery(
  secret: string,
  event: { event_id: string; type: string; [key: string]: unknown },
  options: { timestamp?: number; deliveryId?: string } = {},
): SignedDelivery {
  const body = JSON.stringify(event);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'SiliconAccounts-Webhooks/1',
      'X-Accounts-Event-Id': event.event_id,
      'X-Accounts-Event-Type': event.type,
      'X-Accounts-Delivery-Id': options.deliveryId ?? crypto.randomUUID(),
      'X-Accounts-Timestamp': timestamp,
      'X-Accounts-Signature': webhookSignatureHeader(secret, timestamp, body),
    },
  };
}

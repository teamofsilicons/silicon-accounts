// Small helpers shared by every testkit server and the e2e helper library.
// Nothing here talks to the network.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** base64url without padding. */
export function b64url(data: Buffer | Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

/** `bytes` random bytes encoded as base64url (no padding). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Uniformly random string over `alphabet` (rejection sampling, no modulo bias). */
export function randomFrom(alphabet: string, length: number): string {
  const max = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < max) out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export const randomAlnum = (length: number): string => randomFrom(ALNUM, length);
export const randomLowerAlnum = (length: number): string => randomFrom(LOWER_ALNUM, length);
export const randomUpperAlnum = (length: number): string => randomFrom(UPPER_ALNUM, length);
export const randomHex = (length: number): string => randomFrom('0123456789abcdef', length);
export const randomDigits = (length: number): string => randomFrom('0123456789', length);

export function uuid(): string {
  return randomUUID();
}

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * Constant-time string comparison. Both sides are hashed first so the comparison
 * does not leak the length of the expected value.
 */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** RFC 3339 UTC timestamp with milliseconds, e.g. `2026-10-06T12:00:00.000Z`. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Parses `Authorization: Basic …`. Per RFC 6749 §2.3.1 OAuth clients
 * form-urlencode the id and secret before base64; we accept both encoded and raw.
 */
export function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=._~-]+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s.replaceAll('+', ' '));
    } catch {
      return s;
    }
  };
  return { user: decode(decoded.slice(0, colon)), pass: decode(decoded.slice(colon + 1)) };
}

export function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rounds a duration in milliseconds to 2 decimals for reports. */
export function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/** Masks a secret for display: keeps a short prefix so values can still be told apart. */
export function mask(secret: string | null | undefined, keep = 8): string | null {
  if (!secret) return null;
  if (secret.length <= keep) return '*'.repeat(secret.length);
  return `${secret.slice(0, keep)}…(${secret.length} chars)`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a string field from an unknown JSON value. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function clampInt(value: string | null | undefined, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Formats a Date the way Twilio does: RFC 2822, e.g. `Tue, 06 Oct 2026 12:00:00 +0000`. */
export function rfc2822(date: Date = new Date()): string {
  return date.toUTCString().replace('GMT', '+0000');
}

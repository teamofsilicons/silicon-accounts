/**
 * The fetch wrapper every endpoint goes through: same-origin, JSON in and out, errors mapped to ApiError (message +
 * hint), Idempotency-Key support, headers set once for every request (the telemetry opt-out) and a 401 hook so the
 * shell can send people to sign in.
 *
 * On the developer site the endpoints keep the API's own paths (`/v1/apps/briefcase`), and this wrapper sends them to
 * the site's BFF instead: `/v1/x` → `/api/accounts/x`, `/.well-known/x` → `/api/accounts/.well-known/x`. The BFF
 * (app/api/accounts/[...path]/route.ts) adds the Carbon's token from the sealed session cookie; the browser never holds
 * one.
 *
 * Framework-free: the TanStack Query hooks (lib/query) and any plain code call these functions.
 */
import { ApiError, errorFromResponse, networkError } from "./errors";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];

export interface RequestOptions {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  /** JSON body (serialized). */
  body?: unknown;
  /** A raw body (an image, CSV text, a form) sent as is with `contentType`. */
  raw?: BodyInit;
  contentType?: string;
  headers?: Record<string, string>;
  /** Sends `Idempotency-Key`. `true` generates a fresh key; pass your own to make retries of the same action safe. */
  idempotencyKey?: string | true;
  /** Credentials for app-authenticated endpoints (tools and docs only; the account site never holds a secret). */
  auth?: { basic: { appId: string; secret: string } } | { bearer: string };
  signal?: AbortSignal;
  /** Do not call the global 401 handler (for calls that expect 401, such as reading the session). */
  quiet401?: boolean;
}

export interface ApiConfig {
  /** Origin of Silicon Accounts. Empty means same origin (the account site). */
  baseUrl: string;
  /** Called once per request that fails with 401, unless the call passed `quiet401`. */
  onUnauthenticated?: (error: ApiError) => void;
}

const config: ApiConfig = { baseUrl: "" };
/** Headers sent with every request, merged by name (setApiHeader), never replaced wholesale. */
const globalHeaders = new Map<string, string>();

/** Changes where and how the client talks to Silicon Accounts. */
export function configureApi(next: Partial<ApiConfig>): void {
  Object.assign(config, next);
}

/** Sets (or with null, removes) one header sent with every request, for example `X-Accounts-Telemetry: off`. */
export function setApiHeader(name: string, value: string | null): void {
  if (value === null) globalHeaders.delete(name);
  else globalHeaders.set(name, value);
}

export function apiBaseUrl(): string {
  return config.baseUrl;
}

/** A fresh Idempotency-Key (1..200 chars). Keep it for the retries of one logical action. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Encodes a path segment (ids such as `c:saket`, emails, app ids). */
export const seg = (value: string | number): string => encodeURIComponent(String(value));

export function queryString(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
    else params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function basic(appId: string, secret: string): string {
  const bytes = new TextEncoder().encode(`${appId}:${secret}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null;
  const text = await response.text();
  if (!text) return null;
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json") || /^[\s]*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Where an API path is served on this site: the BFF under /api/accounts. */
export function bffPath(path: string): string {
  if (path.startsWith("/v1/")) return `/api/accounts/${path.slice(4)}`;
  if (path.startsWith("/.well-known/")) return `/api/accounts${path}`;
  return path;
}

/** Performs one API call. Resolves with the parsed JSON body (or null for 204); rejects with ApiError. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? (options.body !== undefined || options.raw !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { Accept: "application/json", ...Object.fromEntries(globalHeaders), ...options.headers };
  let body: BodyInit | undefined;
  if (options.raw !== undefined) {
    body = options.raw;
    if (options.contentType) headers["Content-Type"] = options.contentType;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] = options.contentType ?? "application/json";
  }
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey === true ? newIdempotencyKey() : options.idempotencyKey;
  if (options.auth) headers.Authorization = "basic" in options.auth ? basic(options.auth.basic.appId, options.auth.basic.secret) : `Bearer ${options.auth.bearer}`;
  const url = `${config.baseUrl}${bffPath(path)}${queryString(options.query)}`;

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, credentials: "same-origin", signal: options.signal, cache: "no-store" });
  } catch (error) {
    throw networkError(error, method, path);
  }
  const parsed = await readBody(response).catch(() => null);
  if (!response.ok) {
    const error = errorFromResponse(response, parsed, method, path);
    if (error.status === 401 && !options.quiet401) config.onUnauthenticated?.(error);
    throw error;
  }
  return parsed as T;
}

/** Form-encoded POST body (the OAuth endpoints accept both; forms are what generic OAuth clients send). */
export function formBody(fields: Record<string, string | undefined>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) form.set(key, value);
  return form;
}

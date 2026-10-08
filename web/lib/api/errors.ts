/**
 * Typed errors for the account site. Every failed call rejects with an ApiError that carries the server's own words:
 * `message` says exactly what went wrong and why, `hint` says what to do next. Show both (toasts, inline alerts).
 */
import type { ApiErrorBody, OAuthErrorBody } from "./types";

export interface ApiErrorInit {
  status: number;
  code: string;
  message: string;
  hint?: string | null;
  details?: Record<string, unknown>;
  requestId?: string | null;
  /** Seconds from a Retry-After header or `details.retry_after_seconds`. */
  retryAfter?: number | null;
  method?: string;
  path?: string;
  cause?: unknown;
}

export class ApiError extends Error {
  /** HTTP status; 0 when the request never reached the server. */
  readonly status: number;
  /** Stable machine code, for example `id_taken`, `invalid_code`, `rate_limited`, `network_error`. */
  readonly code: string;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;
  readonly retryAfter: number | null;
  readonly method: string | undefined;
  readonly path: string | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.hint = init.hint ?? undefined;
    this.details = init.details ?? {};
    this.requestId = init.requestId ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.method = init.method;
    this.path = init.path;
  }

  /** True when `error` is an ApiError, optionally with one of `codes`. */
  static is(error: unknown, ...codes: string[]): error is ApiError {
    return error instanceof ApiError && (codes.length === 0 || codes.includes(error.code));
  }

  /** Wraps anything thrown into an ApiError so callers handle one shape. */
  static from(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    if (error instanceof DOMException && error.name === "AbortError") {
      return new ApiError({ status: 0, code: "aborted", message: "The request was cancelled before it finished.", cause: error });
    }
    // A plain {code, message, hint?, status?} (for example a toast fed by hand) keeps its words.
    if (error && typeof error === "object" && !(error instanceof Error)) {
      const value = error as Partial<ApiErrorInit>;
      if (typeof value.code === "string" && typeof value.message === "string") {
        return new ApiError({ status: typeof value.status === "number" ? value.status : 0, code: value.code, message: value.message, hint: value.hint, details: value.details });
      }
    }
    const text = error instanceof Error ? error.message : String(error);
    return new ApiError({
      status: 0,
      code: "client_error",
      message: `Something in this page failed before the request finished: ${text}`,
      hint: "Reload the page and try again. If it keeps happening, report it with `silicon-accounts report`.",
      cause: error,
    });
  }

  /** 401: the browser has no (live) session or the token is not accepted. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** 429 / 423 with a wait time. */
  get isRateLimited(): boolean {
    return this.status === 429 || this.status === 423;
  }

  /** The request never reached Silicon Accounts (offline, DNS, server down). */
  get isNetwork(): boolean {
    return this.code === "network_error";
  }

  /** Field-level validation messages from a 422 `validation_failed` (`details.fields`), keyed by path. */
  get fields(): Record<string, string> {
    const fields = this.details.fields;
    if (!fields || typeof fields !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
      out[key] = Array.isArray(value) ? value.map(String).join(" ") : String(value);
    }
    return out;
  }

  /** `details.suggestions` (for example free ids after `id_taken`). */
  get suggestions(): string[] {
    const list = this.details.suggestions;
    return Array.isArray(list) ? list.map(String) : [];
  }

  /** `details.remaining_attempts` after a wrong code. */
  get remainingAttempts(): number | null {
    const value = this.details.remaining_attempts;
    return typeof value === "number" ? value : null;
  }

  /** `details.locked_until` after the 10th wrong code or with 423 verification_locked. */
  get lockedUntil(): string | null {
    const value = this.details.locked_until;
    return typeof value === "string" ? value : null;
  }

  /**
   * `details.redirect_to` on /v1/flows errors raised after the redirect URI was validated (invalid_scope,
   * method_not_enabled…): the RFC 6749 error redirect back to the app. Absent for unknown_app,
   * redirect_uri_not_registered and app_disabled, which must never redirect.
   */
  get redirectTo(): string | null {
    const value = this.details.redirect_to;
    return typeof value === "string" ? value : null;
  }

  /** One line for logs and fallbacks: message, hint and request id. */
  describe(): string {
    return [this.message, this.hint, this.requestId ? `(request ${this.requestId})` : ""].filter(Boolean).join(" ");
  }
}

function retryAfterFrom(headers: Headers, details: Record<string, unknown> | undefined): number | null {
  const fromDetails = details?.retry_after_seconds;
  if (typeof fromDetails === "number" && Number.isFinite(fromDetails)) return fromDetails;
  const header = headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : null;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  return !!error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" && typeof (error as { message?: unknown }).message === "string";
}

function isOAuthErrorBody(value: unknown): value is OAuthErrorBody {
  return !!value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string";
}

const STATUS_WORDS: Record<number, string> = {
  400: "the request was not valid",
  401: "you are not signed in",
  403: "this account is not allowed to do that",
  404: "it does not exist",
  409: "it conflicts with the current state",
  410: "it has expired",
  413: "the request is too large",
  415: "the content type is not supported",
  422: "the input was not accepted",
  423: "it is locked for a moment",
  429: "too many requests were made",
  500: "Silicon Accounts hit an internal error",
  502: "Silicon Accounts is not reachable through the proxy",
  503: "Silicon Accounts is temporarily unavailable",
  504: "Silicon Accounts took too long to answer",
};

/** Builds the ApiError for a non-2xx response from its (already parsed, possibly null) JSON body. */
export function errorFromResponse(response: Response, body: unknown, method: string, path: string): ApiError {
  const requestId = response.headers.get("x-request-id");
  if (isApiErrorBody(body)) {
    const { code, message, hint, details } = body.error;
    return new ApiError({
      status: response.status,
      code,
      message,
      hint,
      details,
      requestId: requestId ?? (typeof details?.request_id === "string" ? details.request_id : null),
      retryAfter: retryAfterFrom(response.headers, details),
      method,
      path,
    });
  }
  if (isOAuthErrorBody(body)) {
    return new ApiError({
      status: response.status,
      code: body.error,
      message: body.error_description ?? `The OAuth request failed with ${body.error}.`,
      requestId,
      retryAfter: retryAfterFrom(response.headers, undefined),
      method,
      path,
    });
  }
  const reason = STATUS_WORDS[response.status] ?? `the server answered ${response.status}`;
  return new ApiError({
    status: response.status,
    code: response.status >= 500 ? "server_unavailable" : "unexpected_response",
    message: `${method} ${path} failed: ${reason} (HTTP ${response.status}), and the response had no error details.`,
    hint: response.status >= 500 ? "Wait a moment and try again." : "Reload the page and try again.",
    requestId,
    retryAfter: retryAfterFrom(response.headers, undefined),
    method,
    path,
  });
}

/** The error for a request that never got a response. */
export function networkError(error: unknown, method: string, path: string): ApiError {
  if (error instanceof DOMException && error.name === "AbortError") return ApiError.from(error);
  const reason = error instanceof Error && error.message ? error.message : "the network request failed";
  return new ApiError({
    status: 0,
    code: "network_error",
    message: `Could not reach Silicon Accounts for ${method} ${path}: ${reason}.`,
    hint: "Check your connection, then try again.",
    method,
    path,
    cause: error,
  });
}

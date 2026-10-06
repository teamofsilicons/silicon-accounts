// A small fetch wrapper for tests: per-origin cookie jar, Origin header for cookie
// requests (Silicon Accounts' CSRF guard), JSON/form bodies, Basic/Bearer auth, timing,
// and errors that say exactly which request failed and why.

export interface StoredCookie {
  name: string;
  value: string;
  path: string;
  expiresMs: number | null;
}

/** Cookies per origin (scheme+host+port) — stricter than browsers, which share cookies across ports. */
export class CookieJar {
  private readonly store = new Map<string, Map<string, StoredCookie>>();

  setFromResponse(url: string, headers: Headers): void {
    const origin = new URL(url).origin;
    for (const line of headers.getSetCookie()) this.setCookieLine(origin, line);
  }

  setCookieLine(origin: string, line: string): void {
    const [pair = '', ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep raw
    }
    let path = '/';
    let expiresMs: number | null = null;
    for (const attribute of attributes) {
      const [rawKey = '', ...rest] = attribute.split('=');
      const key = rawKey.trim().toLowerCase();
      const attrValue = rest.join('=').trim();
      if (key === 'path' && attrValue.startsWith('/')) path = attrValue;
      if (key === 'max-age') {
        const seconds = Number.parseInt(attrValue, 10);
        if (Number.isFinite(seconds)) expiresMs = Date.now() + seconds * 1000;
      }
      if (key === 'expires' && expiresMs === null) {
        const at = Date.parse(attrValue);
        if (Number.isFinite(at)) expiresMs = at;
      }
    }
    let cookies = this.store.get(origin);
    if (!cookies) {
      cookies = new Map();
      this.store.set(origin, cookies);
    }
    if (expiresMs !== null && expiresMs <= Date.now()) cookies.delete(`${name}|${path}`);
    else cookies.set(`${name}|${path}`, { name, value, path, expiresMs });
  }

  set(origin: string, name: string, value: string, path = '/'): void {
    this.setCookieLine(new URL(origin).origin, `${name}=${encodeURIComponent(value)}; Path=${path}`);
  }

  get(origin: string, name: string): string | undefined {
    const cookies = this.store.get(new URL(origin).origin);
    if (!cookies) return undefined;
    for (const cookie of cookies.values()) if (cookie.name === name && (cookie.expiresMs === null || cookie.expiresMs > Date.now())) return cookie.value;
    return undefined;
  }

  /** The Cookie header for a request to `url`, or undefined when no cookie applies. */
  header(url: string): string | undefined {
    const target = new URL(url);
    const cookies = this.store.get(target.origin);
    if (!cookies) return undefined;
    const now = Date.now();
    const parts: string[] = [];
    for (const cookie of cookies.values()) {
      if (cookie.expiresMs !== null && cookie.expiresMs <= now) continue;
      const pathMatches = target.pathname === cookie.path || target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`) || cookie.path === '/';
      if (pathMatches) parts.push(`${cookie.name}=${encodeURIComponent(cookie.value)}`);
    }
    return parts.length > 0 ? parts.join('; ') : undefined;
  }

  clear(origin?: string): void {
    if (origin) this.store.delete(new URL(origin).origin);
    else this.store.clear();
  }
}

export interface RequestOptions {
  json?: unknown;
  form?: Record<string, string> | URLSearchParams;
  body?: string | Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  basic?: [string, string];
  bearer?: string;
  idempotencyKey?: string;
  /** 'manual' returns 3xx responses as-is (default). */
  redirect?: 'manual' | 'follow';
  /** Send `Origin: <origin>` (cookie-authenticated mutations need it). Defaults to the client's origin. */
  origin?: string | null;
  timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
  method: string;
  url: string;
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON when the response is JSON, else the raw text. */
  body: T;
  text: string;
  location: string | null;
  requestId: string | null;
  ms: number;
}

/** Thrown by HttpClient.expect* helpers when a response is not what the test needed. */
export class HttpExpectationError extends Error {
  readonly response: HttpResponse;
  constructor(response: HttpResponse, expected: string) {
    const body = response.body;
    let detail = '';
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      const error = record.error;
      if (error && typeof error === 'object') {
        const e = error as Record<string, unknown>;
        detail = ` ${String(e.code ?? '')}: ${String(e.message ?? '')}${e.hint ? ` (hint: ${String(e.hint)})` : ''}`;
      } else if (typeof error === 'string') {
        detail = ` ${error}${record.error_description ? `: ${String(record.error_description)}` : ''}`;
      } else {
        detail = ` ${JSON.stringify(body).slice(0, 400)}`;
      }
    } else if (response.text) {
      detail = ` ${response.text.slice(0, 400)}`;
    }
    super(`${response.method} ${response.url} answered HTTP ${response.status}, expected ${expected}.${detail}${response.requestId ? ` [request id ${response.requestId}]` : ''}`);
    this.name = 'HttpExpectationError';
    this.response = response;
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  jar?: CookieJar;
  /** Origin header sent on every non-GET request unless overridden (null = never). */
  origin?: string | null;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpClient {
  readonly baseUrl: string;
  readonly jar: CookieJar;
  origin: string | null;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.jar = options.jar ?? new CookieJar();
    this.origin = options.origin ?? null;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  url(path: string, query?: RequestOptions['query']): string {
    const url = new URL(/^https?:\/\//.test(path) ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return url.toString();
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = { Accept: 'application/json', ...this.headers, ...options.headers };
    let body: string | Uint8Array | undefined;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = (options.form instanceof URLSearchParams ? options.form : new URLSearchParams(options.form)).toString();
    } else if (options.body !== undefined) {
      body = options.body;
      if (options.contentType) headers['Content-Type'] = options.contentType;
    }
    if (options.basic) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(options.basic[0])}:${encodeURIComponent(options.basic[1])}`).toString('base64')}`;
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    const origin = options.origin === undefined ? this.origin : options.origin;
    if (origin && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') headers.Origin = origin;
    const cookie = this.jar.header(url);
    if (cookie) headers.Cookie = cookie;

    const started = performance.now();
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body as RequestInit['body'],
      redirect: options.redirect ?? 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
    });
    const text = await res.text();
    const ms = performance.now() - started;
    this.jar.setFromResponse(url, res.headers);
    let parsed: unknown = text;
    if ((res.headers.get('content-type') ?? '').includes('json') && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const location = res.headers.get('location');
    return {
      method: method.toUpperCase(),
      url,
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      body: parsed as T,
      text,
      location: location ? new URL(location, url).toString() : null,
      requestId: res.headers.get('x-request-id'),
      ms,
    };
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, options);
  }

  post<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, options);
  }

  put<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', path, options);
  }

  patch<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('PATCH', path, options);
  }

  delete<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', path, options);
  }

  /** Performs the request and throws HttpExpectationError unless the status is one of `statuses`. */
  async expect<T = unknown>(statuses: number | number[], method: string, path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    const list = Array.isArray(statuses) ? statuses : [statuses];
    const res = await this.request<T>(method, path, options);
    if (!list.includes(res.status)) throw new HttpExpectationError(res as HttpResponse, list.join(' or '));
    return res;
  }
}

/** Throws HttpExpectationError unless `res.status` is one of `statuses`. */
export function expectStatus<T>(res: HttpResponse<T>, statuses: number | number[]): HttpResponse<T> {
  const list = Array.isArray(statuses) ? statuses : [statuses];
  if (!list.includes(res.status)) throw new HttpExpectationError(res as HttpResponse, list.join(' or '));
  return res;
}

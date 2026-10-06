// A deliberately tiny HTTP layer on top of node:http: a path router, request
// context helpers and a server wrapper with graceful shutdown. The testkit
// servers stay dependency-free and easy to read.

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Throw from a handler to answer with `status` and `body` (JSON unless body is a string). */
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;

  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    super(typeof body === 'string' ? body : JSON.stringify(body));
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** Shorthand for the testkit's own error shape (mirrors the Accounts error body). */
export function apiError(status: number, code: string, message: string, hint?: string, details?: Record<string, unknown>): HttpError {
  const error: Record<string, unknown> = { code, message };
  if (hint) error.hint = hint;
  if (details) error.details = details;
  return new HttpError(status, { error });
}

export interface CookieOptions {
  path?: string;
  httpOnly?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  maxAge?: number;
  secure?: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export class Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly url: URL;
  readonly params: Record<string, string>;
  /** Aborted when the client disconnects or the server stops (use it for long-polls). */
  readonly signal: AbortSignal;
  readonly bodyLimit: number;
  private bodyPromise: Promise<Buffer> | undefined;
  private cookieCache: Record<string, string> | undefined;
  private readonly extraHeaders: Array<[string, string]> = [];

  constructor(init: {
    req: IncomingMessage;
    res: ServerResponse;
    method: string;
    url: URL;
    params: Record<string, string>;
    signal: AbortSignal;
    bodyLimit: number;
  }) {
    this.req = init.req;
    this.res = init.res;
    this.method = init.method;
    this.url = init.url;
    this.params = init.params;
    this.signal = init.signal;
    this.bodyLimit = init.bodyLimit;
  }

  get path(): string {
    return this.url.pathname;
  }

  get query(): URLSearchParams {
    return this.url.searchParams;
  }

  get sent(): boolean {
    return this.res.headersSent;
  }

  header(name: string): string | undefined {
    const value = this.req.headers[name.toLowerCase()];
    if (Array.isArray(value)) return value.join(', ');
    return value;
  }

  /** Lower-cased media type without parameters, e.g. `application/json`. */
  contentType(): string {
    return (this.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  }

  cookies(): Record<string, string> {
    this.cookieCache ??= parseCookies(this.header('cookie'));
    return this.cookieCache;
  }

  body(): Promise<Buffer> {
    this.bodyPromise ??= readBody(this.req, this.bodyLimit);
    return this.bodyPromise;
  }

  async text(): Promise<string> {
    return (await this.body()).toString('utf8');
  }

  async json<T = unknown>(): Promise<T> {
    const text = await this.text();
    if (text.trim() === '') throw apiError(400, 'invalid_json', 'The request body is empty; this endpoint expects a JSON object.', 'Send Content-Type: application/json with a JSON body.');
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw apiError(400, 'invalid_json', `The request body is not valid JSON: ${(error as Error).message}.`, 'Send Content-Type: application/json with a JSON body.');
    }
  }

  async form(): Promise<URLSearchParams> {
    return new URLSearchParams(await this.text());
  }

  /** Adds a header to whatever response is sent next (e.g. Set-Cookie). */
  addHeader(name: string, value: string): void {
    this.extraHeaders.push([name, value]);
  }

  send(status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
    if (this.res.headersSent) return;
    for (const [name, value] of this.extraHeaders) this.res.appendHeader(name, value);
    for (const [name, value] of Object.entries(headers)) this.res.setHeader(name, value);
    if (!this.res.hasHeader('cache-control')) this.res.setHeader('Cache-Control', 'no-store');
    this.res.statusCode = status;
    this.res.end(body);
  }

  sendJson(status: number, body: unknown, headers: Record<string, string> = {}): void {
    this.send(status, `${JSON.stringify(body, null, 2)}\n`, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  }

  sendHtml(status: number, html: string, headers: Record<string, string> = {}): void {
    this.send(status, html, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  }

  sendText(status: number, text: string, headers: Record<string, string> = {}): void {
    this.send(status, text, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  }

  redirect(location: string, status = 302, headers: Record<string, string> = {}): void {
    this.send(status, '', { Location: location, ...headers });
  }

  noContent(): void {
    this.send(204, '');
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > limit) {
      throw apiError(413, 'payload_too_large', `The request body exceeds ${limit} bytes.`, 'Send a smaller body.');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export type Handler = (ctx: Ctx) => unknown;

interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  handler: Handler;
  bodyLimit: number | undefined;
}

function compilePattern(pattern: string): RegExp {
  let source = '';
  const tokenRe = /:([A-Za-z_][A-Za-z0-9_]*)|\*/g;
  let last = 0;
  for (const match of pattern.matchAll(tokenRe)) {
    source += escapeRegex(pattern.slice(last, match.index));
    source += match[0] === '*' ? '(?<rest>.*)' : `(?<${match[1]}>[^/]+?)`;
    last = (match.index ?? 0) + match[0].length;
  }
  source += escapeRegex(pattern.slice(last));
  return new RegExp(`^${source}/?$`);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Router {
  private readonly routes: Route[] = [];

  /** Registers `handler`; `:name` captures one path segment, `*` captures the rest. */
  on(methods: string | string[], pattern: string, handler: Handler, options: { bodyLimit?: number } = {}): this {
    for (const method of Array.isArray(methods) ? methods : [methods]) {
      this.routes.push({ method: method.toUpperCase(), pattern, regex: compilePattern(pattern), handler, bodyLimit: options.bodyLimit });
    }
    return this;
  }

  get(pattern: string, handler: Handler, options?: { bodyLimit?: number }): this {
    return this.on('GET', pattern, handler, options);
  }

  post(pattern: string, handler: Handler, options?: { bodyLimit?: number }): this {
    return this.on('POST', pattern, handler, options);
  }

  put(pattern: string, handler: Handler, options?: { bodyLimit?: number }): this {
    return this.on('PUT', pattern, handler, options);
  }

  delete(pattern: string, handler: Handler, options?: { bodyLimit?: number }): this {
    return this.on('DELETE', pattern, handler, options);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | { allowed: string[] } | null {
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      if (route.method !== method && route.method !== '*') {
        allowed.add(route.method);
        continue;
      }
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(m.groups ?? {})) {
        if (value === undefined) continue;
        try {
          params[key] = decodeURIComponent(value);
        } catch {
          params[key] = value;
        }
      }
      return { route, params };
    }
    return allowed.size > 0 ? { allowed: [...allowed] } : null;
  }

  list(): Array<{ method: string; pattern: string }> {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern }));
  }
}

export interface ServeOptions {
  /** Port to listen on; 0 picks a free port. */
  port?: number;
  /** Interface to bind; defaults to 127.0.0.1 (never exposed beyond the machine). */
  host?: string;
  /** Short service name for logs and error messages. */
  name: string;
  /** true logs one line per request to stderr (no query strings, no bodies). */
  log?: boolean | ((line: string) => void);
  /** Default request body limit in bytes. */
  bodyLimit?: number;
}

export interface RunningServer {
  server: Server;
  /** Base URL, e.g. `http://127.0.0.1:8591`. */
  url: string;
  host: string;
  port: number;
  /** Aborted when stop() is called. */
  signal: AbortSignal;
  stop(): Promise<void>;
}

export async function serve(router: Router, options: ServeOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const shutdown = new AbortController();
  const log = typeof options.log === 'function' ? options.log : options.log ? (line: string) => process.stderr.write(`${line}\n`) : null;
  const defaultLimit = options.bodyLimit ?? 5 * 1024 * 1024;

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.keepAliveTimeout = 5_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}`}`);
    const method = (req.method ?? 'GET').toUpperCase();
    const routeMethod = method === 'HEAD' ? 'GET' : method;
    const requestAbort = new AbortController();
    const onShutdown = (): void => requestAbort.abort(new Error('server stopping'));
    shutdown.signal.addEventListener('abort', onShutdown, { once: true });
    res.on('close', () => {
      shutdown.signal.removeEventListener('abort', onShutdown);
      if (!res.writableFinished) requestAbort.abort(new Error('client disconnected'));
    });

    const match = router.match(routeMethod, url.pathname);
    const ctx = new Ctx({
      req,
      res,
      method: routeMethod,
      url,
      params: match && 'params' in match ? match.params : {},
      signal: requestAbort.signal,
      bodyLimit: match && 'route' in match ? (match.route.bodyLimit ?? defaultLimit) : defaultLimit,
    });

    try {
      if (!match) {
        throw apiError(404, 'not_found', `${options.name} has no route for ${method} ${url.pathname}.`, `GET / on ${options.name} lists every endpoint.`);
      }
      if ('allowed' in match) {
        throw new HttpError(
          405,
          { error: { code: 'method_not_allowed', message: `${method} is not supported on ${url.pathname}; allowed: ${match.allowed.join(', ')}.` } },
          { Allow: match.allowed.join(', ') },
        );
      }
      await match.route.handler(ctx);
      if (!ctx.sent) ctx.noContent();
    } catch (error) {
      if (error instanceof HttpError) {
        if (typeof error.body === 'string') ctx.sendText(error.status, error.body, error.headers);
        else ctx.sendJson(error.status, error.body, error.headers);
      } else if (requestAbort.signal.aborted) {
        if (!res.headersSent && !res.destroyed) ctx.sendJson(503, { error: { code: 'aborted', message: `${options.name} stopped before answering.` } });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[${options.name}] handler error on ${method} ${url.pathname}: ${error instanceof Error ? (error.stack ?? message) : message}\n`);
        if (!res.headersSent) {
          ctx.sendJson(500, { error: { code: 'internal', message: `${options.name} failed while handling ${method} ${url.pathname}: ${message}` } });
        } else {
          res.destroy();
        }
      }
    } finally {
      if (log) log(`[${options.name}] ${method} ${url.pathname} -> ${res.statusCode} (${(performance.now() - started).toFixed(1)} ms)`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`${options.name} cannot listen on ${host}:${options.port ?? 0}: the port is already in use. Stop whatever holds it or choose another port.`));
      } else {
        reject(error);
      }
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port ?? 0, host);
  });

  const address = server.address() as AddressInfo;
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  let stopping: Promise<void> | undefined;

  return {
    server,
    url: `http://${urlHost}:${address.port}`,
    host,
    port: address.port,
    signal: shutdown.signal,
    stop(): Promise<void> {
      stopping ??= new Promise<void>((resolve) => {
        shutdown.abort(new Error('server stopping'));
        server.close(() => resolve());
        // Give in-flight responses (e.g. aborted long-polls answering 503) a moment, then drop keep-alive sockets.
        setImmediate(() => {
          server.closeIdleConnections();
          setTimeout(() => server.closeAllConnections(), 250).unref();
        });
      });
      return stopping;
    },
  };
}

/** JSON body helper: returns the parsed object or throws a precise 400. */
export async function jsonObject(ctx: Ctx): Promise<Record<string, unknown>> {
  const value = await ctx.json<unknown>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw apiError(400, 'invalid_body', 'The JSON body must be an object.', 'Send a JSON object, e.g. {"key":"value"}.');
  }
  return value as Record<string, unknown>;
}

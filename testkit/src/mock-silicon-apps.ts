// mock-silicon-apps: a local stand-in for the Silicon Apps API, the developer site's publishing upstream
// (APPS_API_URL). scripts/dev.sh points every stack's developer site here unless it runs the real Apps API
// (--apps=on), so the apps workspace loads on any stack and nothing leaves the machine.
//
// It knows no apps: the signed-in account's list (GET /v1/apps?mine=true) and its invitations are empty, the public
// catalog is empty, and anything about one app is 404 not_found, the real API's words for an app it does not have.
// Creating an app (and checking an app ID for it) is 503 dependency_unavailable: run the real Apps API for that. Every /v1 call needs a bearer token,
// as the real API's authoring routes do (401 authentication_required without one).
//
// Tests and journeys steer it:
//   PUT    /_refuse    {"code"?, "message"?}  every /v1 call answers 401 with that error, as an Apps API answers a
//                                            token it does not trust (default: invalid_token, wrong issuer)
//   DELETE /_refuse                          back to answering
//   GET    /_requests                         what it was asked, newest first (method, path, the token's aud and sub)
//   DELETE /_requests                         forget them
//   GET    /_health                           {"ok": true, "service": "mock-silicon-apps", "refusing": bool}

import { Router, serve, type Ctx } from './shared/http.ts';
import { nowIso } from './shared/util.ts';

export interface SiliconAppsRequest {
  seq: number;
  at: string;
  method: string;
  /** Path and query. */
  path: string;
  /** The bearer token's `aud` and `sub` claims (read, never verified), or null without a token. */
  aud: unknown;
  sub: unknown;
}

export interface MockSiliconAppsOptions {
  /** Port to listen on (0 picks a free port). */
  port?: number;
  host?: string;
  log?: boolean | ((line: string) => void);
}

export interface MockSiliconApps {
  /** The value for the developer site's APPS_API_URL, e.g. http://127.0.0.1:8596. */
  url: string;
  port: number;
  requests(): SiliconAppsRequest[];
  /** Every /v1 call answers 401 with this error from now on (null: answer again). */
  refuse(error: { code: string; message: string } | null): void;
  reset(): void;
  stop(): Promise<void>;
}

/** What the real Apps API says about a token whose issuer it does not trust (silicon-apps crates/server auth.rs). */
export const DEFAULT_REFUSAL = {
  code: 'invalid_token',
  message: 'The access token was not issued by http://127.0.0.1:1. Hint: Make sure the token comes from the Silicon Accounts instance you trust.',
};

function claims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const error = (ctx: Ctx, status: number, code: string, message: string, hint: string): void =>
  ctx.sendJson(status, { error: { code, message, hint, details: null } }, { 'Cache-Control': 'no-store' });

export async function start(options: MockSiliconAppsOptions = {}): Promise<MockSiliconApps> {
  const router = new Router();
  let requests: SiliconAppsRequest[] = [];
  let seq = 0;
  let refusal: { code: string; message: string } | null = null;

  router.on('*', '/v1/*', (ctx) => {
    const token = (ctx.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const said = token ? claims(token) : {};
    seq += 1;
    requests.push({ seq, at: nowIso(), method: ctx.method, path: `${ctx.path}${ctx.query.size ? `?${ctx.query.toString()}` : ''}`, aud: token ? said.aud ?? null : null, sub: token ? said.sub ?? null : null });
    if (requests.length > 2_000) requests = requests.slice(-2_000);
    if (refusal) return error(ctx, 401, refusal.code, refusal.message, 'Sign in to Silicon Apps again.');
    if (!token) return error(ctx, 401, 'authentication_required', 'Sign in to Silicon Accounts to continue.', 'Run silicon-apps login and retry.');
    const path = ctx.path.replace(/\/+$/, '');
    if (ctx.method === 'GET' && path === '/v1/apps') {
      const limit = Math.min(100, Math.max(1, Number(ctx.query.get('limit') ?? 20) || 20));
      return ctx.sendJson(200, { items: [], limit, next_offset: null, offset: 0, sort: 'relevance', total: 0 }, { 'Cache-Control': 'no-store' });
    }
    if (ctx.method === 'GET' && path === '/v1/invites') return ctx.sendJson(200, { items: [] }, { 'Cache-Control': 'no-store' });
    if ((ctx.method === 'POST' && path === '/v1/apps') || (ctx.method === 'GET' && path.startsWith('/v1/apps/availability/'))) {
      return error(ctx, 503, 'dependency_unavailable', "This local stack's stand-in for Silicon Apps does not create apps.", 'Start the stack with scripts/dev.sh --apps=on to create and publish apps through the real Apps API.');
    }
    return error(ctx, 404, 'not_found', 'The requested app or resource is unavailable.', 'Check its ID and sign in if it is private.');
  });
  router.put('/_refuse', async (ctx) => {
    const body = (await ctx.json().catch(() => ({}))) as { code?: unknown; message?: unknown } | null;
    refusal = {
      code: typeof body?.code === 'string' && body.code ? body.code : DEFAULT_REFUSAL.code,
      message: typeof body?.message === 'string' && body.message ? body.message : DEFAULT_REFUSAL.message,
    };
    ctx.sendJson(200, { refusing: refusal });
  });
  router.delete('/_refuse', (ctx) => {
    refusal = null;
    ctx.noContent();
  });
  router.get('/_requests', (ctx) => ctx.sendJson(200, { count: requests.length, items: requests.slice(-200).reverse() }));
  router.delete('/_requests', (ctx) => {
    requests = [];
    ctx.noContent();
  });
  router.get('/_health', (ctx) => ctx.sendJson(200, { ok: true, service: 'mock-silicon-apps', refusing: refusal !== null }));
  router.get('/', (ctx) =>
    ctx.sendJson(200, {
      service: 'mock-silicon-apps',
      endpoints: {
        'GET /v1/apps[?mine=true]': 'no apps (a bearer token is required)',
        'GET /v1/invites': 'no invitations',
        'POST /v1/apps, GET /v1/apps/availability/<id>': '503: the stand-in creates nothing',
        '* /v1/…': '404 not_found',
        'PUT /_refuse {code?, message?}': 'every /v1 call answers 401 with that error',
        'DELETE /_refuse': 'answer again',
        'GET /_requests': 'what it was asked, newest first',
        'DELETE /_requests': 'forget them',
        'GET /_health': 'liveness',
      },
    }),
  );

  const running = await serve(router, { name: 'mock-silicon-apps', port: options.port ?? 0, ...(options.host ? { host: options.host } : {}), log: options.log ?? false });
  return {
    url: running.url,
    port: running.port,
    requests: () => [...requests],
    refuse(next) {
      refusal = next;
    },
    reset() {
      requests = [];
      refusal = null;
    },
    stop: () => running.stop(),
  };
}

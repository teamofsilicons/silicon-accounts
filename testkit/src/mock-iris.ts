// mock-iris — a local stand-in for Iris, the service that draws every account's default profile
// photo. Silicon Accounts builds those URLs from ACCOUNTS_IRIS_BASE_URL:
//   {iris}/pfp/carbon?id={uuid}    {iris}/pfp/silicon?id={uuid}
// Pointing it here (http://127.0.0.1:8594 by default) keeps every local stack and end-to-end run
// off the internet. Each id always gets the same small SVG (woven straps for a Carbon, a chip grid
// for a Silicon, colours from a hash of the id), so screenshots stay stable between runs.
// GET /_requests lists what was drawn (tests can assert the site loaded its photos from here).

import { createHash } from 'node:crypto';
import { Router, serve, type Ctx } from './shared/http.ts';
import { nowIso } from './shared/util.ts';

export const DEFAULT_MOCK_IRIS_PORT = 8594;

export type IrisKind = 'carbon' | 'silicon';

export interface IrisRequest {
  seq: number;
  at: string;
  kind: IrisKind;
  id: string;
  /** The page that asked (the Referer header), when the browser sent one. */
  referer: string | null;
}

export interface MockIrisOptions {
  /** Port to listen on (default 8594; 0 picks a free port). */
  port?: number;
  host?: string;
  log?: boolean | ((line: string) => void);
  /** How many requests GET /_requests remembers (default 5000). */
  maxRequests?: number;
}

export interface MockIris {
  /** The value for ACCOUNTS_IRIS_BASE_URL, e.g. http://127.0.0.1:8594. */
  url: string;
  port: number;
  requests(): IrisRequest[];
  reset(): void;
  stop(): Promise<void>;
}

/** The photo for one account: a 96×96 SVG that depends only on `kind` and `id`. */
export function irisSvg(kind: IrisKind, id: string): string {
  const hash = createHash('sha256').update(`${kind}:${id}`).digest();
  const byte = (i: number): number => hash[i % hash.length] ?? 0;
  const hue = Math.round((byte(0) / 255) * 360);
  const background = `hsl(${hue} 46% 88%)`;
  const ink = `hsl(${(hue + 150 + byte(1)) % 360} 52% 38%)`;
  const accent = `hsl(${(hue + 40) % 360} 60% 52%)`;
  const shapes: string[] = [];
  if (kind === 'carbon') {
    // Woven straps: four horizontal and four vertical bands, over and under by the hash.
    for (let i = 0; i < 4; i++) {
      shapes.push(`<rect x="8" y="${14 + i * 19}" width="80" height="11" rx="5.5" fill="${ink}" opacity="${(0.55 + (byte(2 + i) % 40) / 100).toFixed(2)}"/>`);
    }
    for (let i = 0; i < 4; i++) {
      if (byte(6 + i) % 2 === 0) shapes.push(`<rect x="${14 + i * 19}" y="8" width="11" height="80" rx="5.5" fill="${accent}" opacity="0.85"/>`);
    }
  } else {
    // A chip: a 4×4 grid of cells, some lit, inside a frame.
    shapes.push(`<rect x="14" y="14" width="68" height="68" rx="12" fill="none" stroke="${ink}" stroke-width="4"/>`);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const lit = byte(2 + row * 4 + col) % 3 !== 0;
        shapes.push(`<rect x="${22 + col * 14}" y="${22 + row * 14}" width="10" height="10" rx="2.5" fill="${lit ? accent : ink}" opacity="${lit ? '0.95' : '0.25'}"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" fill="${background}"/>${shapes.join('')}</svg>`;
}

export async function start(options: MockIrisOptions = {}): Promise<MockIris> {
  const router = new Router();
  const maxRequests = options.maxRequests ?? 5_000;
  let requests: IrisRequest[] = [];
  let seq = 0;

  function photo(kind: IrisKind) {
    return (ctx: Ctx): void => {
      const id = ctx.query.get('id') ?? '';
      seq += 1;
      requests.push({ seq, at: nowIso(), kind, id, referer: ctx.header('referer') ?? null });
      if (requests.length > maxRequests) requests = requests.slice(-maxRequests);
      ctx.send(200, irisSvg(kind, id), {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        // Pages on other origins (the account site, the fake apps) show these photos.
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      });
    };
  }

  router.get('/pfp/carbon', photo('carbon'));
  router.get('/pfp/silicon', photo('silicon'));
  router.get('/_requests', (ctx) => {
    const kind = ctx.query.get('kind');
    const items = requests.filter((r) => !kind || r.kind === kind);
    ctx.sendJson(200, { count: items.length, items: items.slice(-200).reverse() });
  });
  router.delete('/_requests', (ctx) => {
    requests = [];
    ctx.noContent();
  });
  router.get('/_health', (ctx) => ctx.sendJson(200, { ok: true, service: 'mock-iris' }));
  router.get('/', (ctx) =>
    ctx.sendJson(200, {
      service: 'mock-iris',
      endpoints: {
        'GET /pfp/carbon?id=<uuid>': "a Carbon's default photo (SVG, the same for the same id)",
        'GET /pfp/silicon?id=<uuid>': "a Silicon's default photo (SVG)",
        'GET /_requests[?kind=carbon|silicon]': 'what was drawn, newest first (count + the last 200)',
        'DELETE /_requests': 'forget them',
        'GET /_health': 'liveness',
      },
    }),
  );

  const running = await serve(router, { name: 'mock-iris', port: options.port ?? DEFAULT_MOCK_IRIS_PORT, ...(options.host ? { host: options.host } : {}), log: options.log ?? false });
  return {
    url: running.url,
    port: running.port,
    requests: () => [...requests],
    reset() {
      requests = [];
    },
    stop: () => running.stop(),
  };
}

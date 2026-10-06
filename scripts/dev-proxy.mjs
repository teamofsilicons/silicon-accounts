#!/usr/bin/env node
// A minimal stand-in for the account site's proxy: forwards /v1/* and /.well-known/* from the
// public origin to accounts-api exactly the way the Next.js site's `rewrites` do, and serves
// nothing else. scripts/dev.sh --web=proxy and scripts/journeys.sh --proxy put it in front of
// accounts-api to prove the API works behind a proxy without building the site.
//
//   node scripts/dev-proxy.mjs --port 8590 --target http://127.0.0.1:8589 [--host 127.0.0.1] [--quiet]
//
// What it does, matching Next.js 16 (`next/dist/server/lib/router-utils/proxy-request.js`):
// - method, path, query string and body are forwarded unchanged (streamed, any size);
// - every request header is forwarded unchanged (Cookie, Origin, Authorization, Content-Type,
//   Idempotency-Key, X-Forwarded-For…), except that Host becomes the target's (changeOrigin) and
//   X-Forwarded-Host carries the original Host. Like Next, it adds no X-Forwarded-For: a client's
//   own X-Forwarded-For passes through untouched, and without one accounts-api sees the proxy's
//   address (in production the load balancer in front of the site appends the client address);
// - the status and every response header come back unchanged, including each Set-Cookie and an
//   absolute Location (Next sets no Location or cookie rewriting either);
// - hop-by-hop headers (Connection, Keep-Alive, Transfer-Encoding…) are not forwarded.
// Other paths answer 404 with a short note: the pages themselves are the Next.js site's job.

import http from 'node:http';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function usage(problem) {
  process.stderr.write(
    `error: ${problem}\nhint: node scripts/dev-proxy.mjs --port 8590 --target http://127.0.0.1:8589 [--host 127.0.0.1] [--quiet]\n`,
  );
  process.exit(2);
}

const options = { host: '127.0.0.1', port: null, target: null, quiet: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
  if (name === '--quiet') {
    options.quiet = true;
    continue;
  }
  if (!['--port', '--target', '--host'].includes(name)) usage(`unknown argument "${arg}"`);
  const value = inline ?? args[++i];
  if (value === undefined) usage(`${name} needs a value`);
  options[name.slice(2)] = value;
}
const port = Number(options.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) usage(`--port must be a port number, got "${options.port}"`);
let target;
try {
  target = new URL(options.target ?? '');
} catch {
  usage(`--target must be the accounts-api URL like http://127.0.0.1:8589, got "${options.target}"`);
}
if (target.protocol !== 'http:') usage('--target must be an http:// URL (accounts-api listens on plain http locally)');

const proxied = (path) => path === '/v1' || path.startsWith('/v1/') || path === '/.well-known' || path.startsWith('/.well-known/');

function log(line) {
  if (!options.quiet) process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

/** Request headers for accounts-api: Host rewritten, X-Forwarded-Host added, hop-by-hop dropped. */
function forwardHeaders(req) {
  const out = [];
  const raw = req.rawHeaders;
  const connectionTokens = new Set(
    String(req.headers.connection ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'x-forwarded-host' || HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;
    out.push(name, raw[i + 1]);
  }
  out.push('Host', target.host);
  out.push('X-Forwarded-Host', req.headers.host ?? '');
  return out;
}

/** Response headers for the browser: everything but hop-by-hop headers, Set-Cookie kept per line. */
function backHeaders(res) {
  const out = [];
  const raw = res.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (HOP_BY_HOP.has(raw[i].toLowerCase())) continue;
    out.push(raw[i], raw[i + 1]);
  }
  return out;
}

const server = http.createServer((req, res) => {
  const started = performance.now();
  const path = (req.url ?? '/').split('?')[0];
  if (!proxied(path)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      `Not found: ${path}\n\nThis is scripts/dev-proxy.mjs, a stand-in for the account site that only forwards /v1/* and /.well-known/* to accounts-api at ${target.origin}.\nThe pages are served by the Next.js site (web/): run scripts/dev.sh without --web=proxy once web/ has its Next.js app.\n`,
    );
    log(`${req.method} ${path} 404 (not proxied)`);
    return;
  }
  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, backHeaders(upstreamRes));
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => log(`${req.method} ${path} ${upstreamRes.statusCode} ${Math.round(performance.now() - started)}ms`));
    },
  );
  upstream.on('error', (error) => {
    log(`${req.method} ${path} 502 (${error.message})`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          error: {
            code: 'bad_gateway',
            message: `The dev proxy could not reach accounts-api at ${target.origin}: ${error.message}.`,
            hint: 'Start accounts-api (scripts/dev.sh) or point --target at it.',
          },
        }),
      );
    } else {
      res.destroy(error);
    }
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(port, options.host, () => {
  const address = server.address();
  process.stdout.write(
    `dev-proxy listening on http://${options.host}:${typeof address === 'object' && address ? address.port : port} → ${target.origin} (/v1/*, /.well-known/*)\n`,
  );
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) process.exit(1);
    closing = true;
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

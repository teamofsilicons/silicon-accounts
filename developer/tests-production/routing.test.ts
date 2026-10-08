import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";

/** next start does not expose the loopback-normalization bug: use the actual deployment entry point. */
test("standalone routing remains internal behind Caddy HTTPS forwarding", { timeout: 30_000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const standalone = join(process.cwd(), ".next/standalone");
  cpSync("public", join(standalone, "public"), { recursive: true });
  cpSync(".next/static", join(standalone, ".next/static"), { recursive: true });
  const server = spawn(process.execPath, [join(standalone, "server.js")], {
    cwd: standalone,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", DEVELOPER_PUBLIC_URL: "https://developers.teamofsilicons.com", DEVELOPER_SESSION_SECRET: randomBytes(48).toString("base64url") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  server.stdout.on("data", data => { diagnostics = (diagnostics + data).slice(-4000); });
  server.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-4000); });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(`${origin}/docs`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, diagnostics);
    for (const forwarded of [false, true]) {
      const headers: Record<string, string> = forwarded ? { Host: "developers.teamofsilicons.com", "X-Forwarded-Host": "developers.teamofsilicons.com", "X-Forwarded-Proto": "https" } : {};
      for (const path of ["/docs/not-a-real-product/unknown", "/docs/404", "/docs/accounts/missing.md", "/apps/test-app/unknown-tab"]) {
        const response = await fetch(`${origin}${path}`, { headers, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 404, `${path} forwarded=${forwarded}: ${diagnostics}`);
        assert.match(response.headers.get("x-middleware-rewrite") ?? "", /^\//, "Internal rewrites must stay relative");
        assert.match(response.headers.get("content-security-policy") ?? "", /nonce-/);
        if (forwarded) assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=/);
        if (path.startsWith("/docs/")) assert.match(await response.text(), /No page here/);
      }
      for (const [from, to] of [["branding", "pages"], ["proofs", "ata"]]) {
        const response = await fetch(`${origin}/apps/briefcase/${from}?from=x`, { headers, redirect: "manual", signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 308);
        assert.equal(response.headers.get("location"), `/apps/briefcase/${to}?from=x`);
      }
      for (const path of ["/docs", "/docs/apps/start/install", "/docs/accounts/index.md", "/docs/search-index.json", "/llms.txt"]) {
        const response = await fetch(`${origin}${path}`, { headers, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.has("x-middleware-rewrite"), false, path);
      }
    }
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
});

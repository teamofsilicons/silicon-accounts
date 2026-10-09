import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { cpSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";

/**
 * The deployed entry point (`.next/standalone/server.js`) behind Caddy's HTTPS forwarding headers: internal rewrites,
 * like the signed-out `/` to `/landing`, must stay on the local listener. `next start` doesn't show the bug this guards.
 * Run after `pnpm build` with `pnpm test:production-routing`.
 */
test("standalone routing stays internal behind Caddy HTTPS forwarding", { timeout: 60_000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close(error => (error ? reject(error) : resolve())));
  const standalone = join(process.cwd(), ".next/standalone");
  cpSync("public", join(standalone, "public"), { recursive: true });
  cpSync(".next/static", join(standalone, ".next/static"), { recursive: true });
  const server = spawn(process.execPath, [join(standalone, "server.js")], {
    cwd: standalone,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", ACCOUNTS_PUBLIC_URL: "https://accounts.teamofsilicons.com" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  server.stdout.on("data", data => { diagnostics = (diagnostics + data).slice(-4000); });
  server.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-4000); });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { if ((await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, diagnostics);
    for (const forwarded of [false, true]) {
      const headers: Record<string, string> = forwarded
        ? { Host: "accounts.teamofsilicons.com", "X-Forwarded-Host": "accounts.teamofsilicons.com", "X-Forwarded-Proto": "https" }
        : {};
      const home = await fetch(`${origin}/`, { headers, signal: AbortSignal.timeout(10_000) });
      const body = await home.text();
      assert.equal(home.status, 200, `signed-out / forwarded=${forwarded}: ${diagnostics}`);
      assert.match(body, /<main/, "the landing renders on the server");
      assert.doesNotMatch(body, /modelContext|webmcp/i, "the landing registers no tools in the browser");
      assert.match(home.headers.get("x-middleware-rewrite") ?? "/", /^\//, "internal rewrites stay relative");
      for (const path of ["/llms.txt", "/robots.txt", "/sitemap.xml", "/.well-known/security.txt", "/sign-in"]) {
        const response = await fetch(`${origin}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 200, `${path} forwarded=${forwarded}: ${diagnostics}`);
        if (path === "/sign-in") assert.doesNotMatch(await response.text(), /modelContext|webmcp/i, "/sign-in registers no tools in the browser");
      }
    }
  } finally {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
});

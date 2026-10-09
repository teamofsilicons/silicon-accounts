import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
// This installed Next release still exports the pre-rename testing helper.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "../proxy";
import { developerDocsPath } from "../lib/docs-redirects";
import { developerDocsUrl, SECTIONS, sectionHref } from "../lib/navigation";

const cases = [
  ["/docs", "/docs"],
  ["/docs/", "/docs"],
  ["/docs/start/add-sign-in", "/docs/accounts/start/add-sign-in"],
  ["/docs/reference/api/apps", "/docs/accounts/reference/api/apps"],
  ["/docs/start/app-verification.md", "/docs/accounts/start/app-verification.md"],
  ["/docs/index.md", "/docs/accounts/index.md"],
  ["/docs.md", "/docs/accounts/index.md"],
  ["/docs/no-such-page", "/docs/accounts/no-such-page"],
  ["/docs/search-index.json", "/docs/search-index.json"],
] as const;

test("legacy documentation permanently redirects using the service's developer origin and preserves queries", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    assert.equal(String(input), "http://127.0.0.1:8589/v1/meta");
    return Response.json({ developer_url: "https://developers.example.test/portal/" });
  };
  try {
    for (const [source, destination] of cases) {
      for (const method of ["GET", "HEAD"]) {
        const request = new NextRequest(`https://accounts.example.test${source}?from=old&query=a%2Bb&query=c`, { method });
        const response = await proxy(request);
        assert.equal(response.status, 308, source);
        assert.equal(response.headers.get("location"), `https://developers.example.test/portal${destination}?from=old&query=a%2Bb&query=c`, source);
        assert.equal(response.headers.has("set-cookie"), false);
      }
    }
    const request = new NextRequest("https://accounts.example.test/docs/start/app-verification?return_to=https%3A%2F%2Fevil.invalid", {
      headers: { "x-forwarded-host": "evil.invalid", rsc: "1", "next-router-prefetch": "1" },
    });
    assert.equal((await proxy(request)).headers.get("location"), "https://developers.example.test/portal/docs/accounts/start/app-verification?return_to=https%3A%2F%2Fevil.invalid");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prefetch and RSC cannot bypass redirects and render old documentation", () => {
  for (const [source] of cases) {
    for (const headers of [{}, { "next-router-prefetch": "1" }, { purpose: "prefetch", rsc: "1" }]) {
      assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: source, headers }), true, source);
    }
  }
  for (const url of ["/v1/me", "/.well-known/openid-configuration", "/.well-known/agent.json", "/.well-known/security.txt", "/openapi.json", "/sdk/v1.js", "/_next/static/a.js",
    "/llms.txt", "/llms-full.txt", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest", "/mcp", "/og.png", "/icon.svg", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png", "/favicon.ico", "/fonts/bdo-grotesk/BDOGrotesk-DemiBold.woff2"]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }), false, url);
  }
  // Pages whose names start like an agent file still get the page headers.
  for (const url of ["/", "/mcp-guide", "/apps", "/sign-in"]) assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }), true, url);
});

test("the site serves its own llms.txt and llms-full.txt: no redirect to the developer site", async () => {
  for (const path of ["/llms.txt", "/llms-full.txt"]) assert.equal(developerDocsPath(path), null, path);
});

test("\"/\" is the public landing without a session cookie, and the account site with one the API accepts", async () => {
  const originalFetch = globalThis.fetch;
  const asked: string[] = [];
  let answer = 200;
  globalThis.fetch = async (input, init) => {
    asked.push(`${String(input)} ${new Headers(init?.headers).get("cookie") ?? ""}`);
    return new Response("{}", { status: answer });
  };
  const surface = (response: Response) => response.headers.get("x-middleware-request-x-sa-surface");
  const rewrite = (response: Response) => response.headers.get("x-middleware-rewrite");
  try {
    const landing = await proxy(new NextRequest("https://accounts.example.test/?ref=x"));
    assert.equal(surface(landing), "public");
    assert.equal(rewrite(landing), "https://accounts.example.test/landing?ref=x");
    assert.equal(asked.length, 0, "no cookie: no question to the API");
    const direct = await proxy(new NextRequest("https://accounts.example.test/landing?ref=x"));
    assert.equal(direct.status, 308);
    assert.equal(direct.headers.get("location"), "https://accounts.example.test/?ref=x");
    const live = await proxy(new NextRequest("https://accounts.example.test/", { headers: { cookie: "sa_session=live" } }));
    assert.equal(surface(live), "site");
    assert.equal(rewrite(live), null);
    assert.match(asked.at(-1) ?? "", /\/v1\/session sa_session=live$/);
    answer = 401;
    const stale = await proxy(new NextRequest("https://accounts.example.test/", { headers: { cookie: "sa_session=old; other=1" } }));
    assert.equal(surface(stale), "public");
    assert.equal(rewrite(stale), "https://accounts.example.test/landing");
    assert.match(stale.headers.get("set-cookie") ?? "", /^sa_session=; Path=\/; .*Max-Age=0/i);
    // Client navigations (RSC) never ask; other pages never ask.
    const before = asked.length;
    assert.equal(surface(await proxy(new NextRequest("https://accounts.example.test/", { headers: { cookie: "sa_session=old", rsc: "1" } }))), "site");
    assert.equal(surface(await proxy(new NextRequest("https://accounts.example.test/apps", { headers: { cookie: "sa_session=old" } }))), "site");
    assert.equal(surface(await proxy(new NextRequest("https://accounts.example.test/embed/v1/buttons?app_id=x"))), "embed");
    assert.equal(asked.slice(before).some(line => line.includes("/v1/session")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("account and hosted sign-in routes retain their CSP response without a docs redirect", async () => {
  for (const path of ["/", "/apps", "/settings", "/sign-in", "/authorize", "/device", "/documentation", "/docs-other"]) {
    assert.equal(developerDocsPath(path), null);
    const response = await proxy(new NextRequest(`https://accounts.example.test${path}`));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.has("location"), false, path);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-/);
  }
});

test("site navigation links directly to shared documentation on the configured developer site", () => {
  const section = SECTIONS.find(section => section.key === "docs");
  assert.ok(section);
  assert.equal(section.external, true);
  assert.equal(sectionHref(section, "http://localhost:8600"), "http://localhost:8600/docs");
  assert.equal(developerDocsUrl("https://developers.example.test/portal/"), "https://developers.example.test/portal/docs");
  assert.equal(developerDocsUrl(), "https://developers.teamofsilicons.com/docs");
});

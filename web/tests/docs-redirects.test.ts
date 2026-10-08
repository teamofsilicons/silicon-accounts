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
  ["/docs/start/ata.md", "/docs/accounts/start/ata.md"],
  ["/docs/index.md", "/docs/accounts/index.md"],
  ["/docs.md", "/docs/accounts/index.md"],
  ["/docs/no-such-page", "/docs/accounts/no-such-page"],
  ["/docs/search-index.json", "/docs/search-index.json"],
  ["/llms.txt", "/llms.txt"],
  ["/llms-full.txt", "/llms-full.txt"],
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
    const request = new NextRequest("https://accounts.example.test/docs/start/ata?return_to=https%3A%2F%2Fevil.invalid", {
      headers: { "x-forwarded-host": "evil.invalid", rsc: "1", "next-router-prefetch": "1" },
    });
    assert.equal((await proxy(request)).headers.get("location"), "https://developers.example.test/portal/docs/accounts/start/ata?return_to=https%3A%2F%2Fevil.invalid");
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
  for (const url of ["/v1/me", "/.well-known/openid-configuration", "/sdk/v1.js", "/_next/static/a.js"]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }), false, url);
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

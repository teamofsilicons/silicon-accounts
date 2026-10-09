import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { robotsTxt, AI_CRAWLERS, DISALLOWED } from "../lib/agent/robots";
import { openApi } from "../lib/agent/openapi";
import { LLMS_FULL_TXT, LLMS_TXT } from "../lib/docs/generated/llms";
import { CORS_HEADERS, preflight } from "../lib/server/public-response";
import { rateLimit, resetRateLimits } from "../lib/server/rate-limit";

test("llms.txt and llms-full.txt are bundled exactly as the Carbon wrote them", () => {
  assert.equal(LLMS_TXT, existsSync("llms/llms.md") ? readFileSync("llms/llms.md", "utf8") : null);
  assert.equal(LLMS_FULL_TXT, existsSync("llms/llms-full.md") ? readFileSync("llms/llms-full.md", "utf8") : null);
});

test("robots.txt welcomes crawlers to public pages, names AI crawlers, keeps private paths out and points at the sitemap", () => {
  const robots = robotsTxt();
  for (const agent of [...AI_CRAWLERS, "*"]) assert.match(robots, new RegExp(`^User-agent: ${agent.replace("*", "\\*")}$`, "m"));
  assert.match(robots, /^Allow: \/$/m);
  for (const path of DISALLOWED) assert.match(robots, new RegExp(`^Disallow: ${path}$`, "m"));
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
  assert.doesNotMatch(robots, /^Disallow: \/docs$/m);
  assert.doesNotMatch(robots, /mcp/i);
  assert.match(robots, /^Sitemap: https:\/\/developers\.teamofsilicons\.com\/sitemap\.xml$/m);
});

test("openapi.json is OpenAPI 3.1 with every public endpoint, rate limits and the related APIs", () => {
  const spec = openApi();
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(Object.keys(spec.paths).filter(path => path.startsWith("/api/")).sort(), ["/api/docs", "/api/docs/pages", "/api/docs/pages/{product}/{path}", "/api/docs/search"]);
  assert.match(spec.info.description, /429 with Retry-After/);
  assert.deepEqual(spec["x-related-apis"].map(api => api.openapi), ["https://accounts.teamofsilicons.com/openapi.json", "https://apps.teamofsilicons.com/openapi.json"]);
  // Every $ref names a component that exists.
  const text = JSON.stringify(spec);
  for (const [, kind, name] of text.matchAll(/"\$ref":"#\/components\/(\w+)\/([\w-]+)"/g)) {
    assert.ok((spec.components as Record<string, Record<string, unknown>>)[kind!]?.[name!], `${kind}/${name}`);
  }
});

test("the site runs no MCP server: no /mcp route, no MCP library, and nothing in openapi.json or CORS offers one", () => {
  assert.equal(existsSync("app/mcp"), false);
  assert.equal(existsSync("lib/mcp"), false);
  const spec = openApi();
  assert.ok(!("/mcp" in spec.paths));
  assert.doesNotMatch(JSON.stringify(spec), /mcp|model context|json-?rpc/i);
  assert.doesNotMatch(JSON.stringify(CORS_HEADERS), /mcp/i);
  assert.doesNotMatch(preflight().headers.get("access-control-allow-headers") ?? "", /mcp/i);
});

test("rate limits count per address and bucket, and answer with Retry-After past the limit", () => {
  resetRateLimits();
  const request = (address: string) => new Request("http://local/api/docs", { headers: { "x-forwarded-for": `${address}, 10.0.0.1` } });
  const limit = { limit: 3, windowSeconds: 60 };
  for (let n = 0; n < 3; n++) assert.equal(rateLimit(request("198.51.100.1"), "api", limit).ok, true);
  const refused = rateLimit(request("198.51.100.1"), "api", limit);
  assert.equal(refused.ok, false);
  assert.equal(refused.remaining, 0);
  assert.ok(Number(refused.headers["Retry-After"]) > 0 && Number(refused.headers["Retry-After"]) <= 60);
  assert.equal(rateLimit(request("198.51.100.2"), "api", limit).ok, true);
  assert.equal(rateLimit(request("198.51.100.1"), "other", limit).ok, true);
  resetRateLimits();
});

/**
 * The account site's agent entry points: the hand-written llms files bundled as written, robots.txt and sitemap.xml,
 * no MCP server (no /mcp route, nothing that advertises one) and no tools registered in the browser. Production's
 * answer to /mcp (404) is checked by tests-production/routing.test.ts.
 *
 *   web/node_modules/.bin/tsx --test web/tests/agent.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { AI_CRAWLERS, DISALLOWED, robotsTxt } from "../lib/agent/robots";
import { sitemapEntries, sitemapXml } from "../lib/agent/sitemap";
import { LLMS_FULL_TXT, LLMS_TXT } from "../lib/agent/generated/llms";
import { hasSessionCookie } from "../lib/server/session";

test("llms.txt and llms-full.txt are bundled exactly as the Carbon wrote them", () => {
  assert.equal(LLMS_TXT, existsSync("llms/llms.md") ? readFileSync("llms/llms.md", "utf8") : null);
  assert.equal(LLMS_FULL_TXT, existsSync("llms/llms-full.md") ? readFileSync("llms/llms-full.md", "utf8") : null);
});

test("robots.txt welcomes crawlers to public pages, names AI crawlers, keeps private paths out and points at the sitemap", () => {
  const robots = robotsTxt();
  for (const agent of [...AI_CRAWLERS, "*"]) assert.match(robots, new RegExp(`^User-agent: ${agent.replace("*", "\\*")}$`, "m"));
  assert.match(robots, /^Allow: \/$/m);
  for (const path of DISALLOWED) assert.match(robots, new RegExp(`^Disallow: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  for (const path of ["/apps", "/silicons", "/proofs", "/settings", "/sign-in", "/authorize", "/device", "/embed/", "/v1/"]) assert.ok(DISALLOWED.includes(path), path);
  // The public documents agents need stay open.
  for (const open of ["/llms.txt", "/llms-full.txt", "/openapi.json", "/.well-known/", "/sitemap.xml"]) {
    assert.ok(!DISALLOWED.some(path => open.startsWith(path)), open);
  }
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
  assert.doesNotMatch(robots, /\/mcp\b|\bMCP\b/, "robots.txt has no rule or comment about an MCP server");
  assert.match(robots, /^Sitemap: https:\/\/accounts\.teamofsilicons\.com\/sitemap\.xml$/m);
});

test("sitemap.xml lists the landing page and the agent files on the canonical origin", () => {
  const xml = sitemapXml();
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.deepEqual(sitemapEntries().map(entry => entry.path), ["/", "/llms.txt", "/llms-full.txt", "/openapi.json"]);
  assert.equal((xml.match(/<url>/g) ?? []).length, (xml.match(/<\/url>/g) ?? []).length);
  for (const [, loc] of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) assert.match(loc!, /^https:\/\/accounts\.teamofsilicons\.com\//);
  for (const [, date] of xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) assert.ok(!Number.isNaN(Date.parse(date!)), date);
});

test("no page registers tools in the browser: no WebMCP script and no navigator.modelContext anywhere in the site", () => {
  assert.equal(existsSync("lib/webmcp.ts"), false);
  const sources = ["app", "components", "lib", "styles"].flatMap(dir =>
    (readdirSync(dir, { recursive: true }) as string[])
      .filter(file => /\.(ts|tsx|js|mjs|css)$/.test(file) && !file.includes("generated"))
      .map(file => `${dir}/${file}`),
  );
  assert.ok(sources.includes("app/layout.tsx"), "the walk reaches the root layout");
  for (const file of [...sources, "proxy.ts"]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /modelContext/, file);
    assert.doesNotMatch(text, /webmcp/i, file);
  }
});

test("the site runs no MCP server: no /mcp route or library, and nothing it serves or links to advertises one", () => {
  for (const path of ["app/mcp", "lib/mcp", "lib/server/rate-limit.ts"]) assert.equal(existsSync(path), false, path);
  const sources = ["app", "components", "lib", "styles"].flatMap(dir =>
    (readdirSync(dir, { recursive: true }) as string[])
      .filter(file => /\.(ts|tsx|js|mjs|css)$/.test(file) && !file.includes("generated"))
      .map(file => `${dir}/${file}`),
  );
  for (const file of [...sources, "proxy.ts"]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\/mcp\b|#mcp\b/, file);
    assert.doesNotMatch(text, /MCP (server|client|endpoint)/i, file);
  }
  for (const [name, text] of [["llms.txt", LLMS_TXT], ["llms-full.txt", LLMS_FULL_TXT], ["robots.txt", robotsTxt()], ["sitemap.xml", sitemapXml()]] as const) {
    if (text !== null) assert.doesNotMatch(text, /\/mcp\b/, name);
  }
});

test("a session cookie is recognised by name only", () => {
  assert.equal(hasSessionCookie("a=1; sa_session=x"), true);
  assert.equal(hasSessionCookie("__Host-sa_session=x"), true);
  assert.equal(hasSessionCookie("sa_sessionx=1; sa_flow=2"), false);
  assert.equal(hasSessionCookie(null), false);
});

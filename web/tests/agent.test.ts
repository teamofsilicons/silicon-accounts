/**
 * The account site's agent entry points: the hand-written llms files bundled as written, robots.txt and sitemap.xml,
 * the MCP protocol (lib/mcp/protocol.ts, the tools get the caller's context), the rate limit, WebMCP and the docs
 * topics. The tools themselves call the API and are walked against a running stack (README.md, "Agent files").
 *
 *   web/node_modules/.bin/tsx --test web/tests/agent.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { AI_CRAWLERS, DISALLOWED, robotsTxt } from "../lib/agent/robots";
import { sitemapEntries, sitemapXml } from "../lib/agent/sitemap";
import { LLMS_FULL_TXT, LLMS_TXT } from "../lib/agent/generated/llms";
import { LATEST_VERSION, handleBody, negotiateVersion, toolError, toolResult, type Tool, type ToolContext } from "../lib/mcp/protocol";
import { rateLimit, resetRateLimits } from "../lib/server/rate-limit";
import { hasSessionCookie } from "../lib/server/session";
import { DOCS_TOPICS, matchTopic } from "../lib/site";
import { WEBMCP_SCRIPT, siliconAccountSteps } from "../lib/webmcp";

test("llms.txt and llms-full.txt are bundled exactly as the Carbon wrote them", () => {
  assert.equal(LLMS_TXT, existsSync("llms/llms.md") ? readFileSync("llms/llms.md", "utf8") : null);
  assert.equal(LLMS_FULL_TXT, existsSync("llms/llms-full.md") ? readFileSync("llms/llms-full.md", "utf8") : null);
});

test("robots.txt welcomes crawlers to public pages, names AI crawlers, keeps private paths out and points at the sitemap", () => {
  const robots = robotsTxt();
  for (const agent of [...AI_CRAWLERS, "*"]) assert.match(robots, new RegExp(`^User-agent: ${agent.replace("*", "\\*")}$`, "m"));
  assert.match(robots, /^Allow: \/$/m);
  for (const path of DISALLOWED) assert.match(robots, new RegExp(`^Disallow: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  for (const path of ["/apps", "/silicons", "/proofs", "/settings", "/sign-in", "/authorize", "/device", "/embed/", "/v1/", "/mcp"]) assert.ok(DISALLOWED.includes(path), path);
  // The public documents agents need stay open.
  for (const open of ["/llms.txt", "/llms-full.txt", "/openapi.json", "/.well-known/", "/sitemap.xml"]) {
    assert.ok(!DISALLOWED.some(path => open.startsWith(path)), open);
  }
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
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

const SERVER = { name: "test", title: "Test", version: "0.0.0", instructions: "Test server." };
const seen: ToolContext[] = [];
const TOOLS: Tool[] = [
  { definition: { name: "echo", title: "Echo", description: "Echo", inputSchema: { type: "object" } }, call: async (args, context) => (seen.push(context), toolResult({ echoed: args })) },
  { definition: { name: "fail", title: "Fail", description: "Fail", inputSchema: { type: "object" } }, call: async () => { throw new Error("boom"); } },
  { definition: { name: "refuse", title: "Refuse", description: "Refuse", inputSchema: { type: "object" } }, call: async () => toolError("nope", "Not possible.", "Ask again.") },
];
const ask = async (message: unknown, context: ToolContext = {}) => handleBody(JSON.stringify(message), TOOLS, SERVER, context);

test("MCP: initialize negotiates the protocol version and offers tools", async () => {
  const answer = (await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })) as { result: { protocolVersion: string; capabilities: { tools: unknown }; instructions: string } };
  assert.equal(answer.result.protocolVersion, "2025-03-26");
  assert.ok(answer.result.capabilities.tools);
  assert.equal(answer.result.instructions, "Test server.");
  assert.equal(negotiateVersion("1999-01-01"), LATEST_VERSION);
});

test("MCP: tools/call hands the tool the caller's context; failures are results; JSON-RPC errors", async () => {
  const echoed = (await ask({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { x: 1 } } }, { authorization: "Bearer t", forwardedFor: "198.51.100.7" })) as { result: { structuredContent: unknown } };
  assert.deepEqual(echoed.result.structuredContent, { echoed: { x: 1 } });
  assert.deepEqual(seen.at(-1), { authorization: "Bearer t", forwardedFor: "198.51.100.7" });
  const failed = (await ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fail" } })) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0]!.text, /boom/);
  const refused = (await ask({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "refuse" } })) as { result: { structuredContent: { error: { code: string } } } };
  assert.equal(refused.result.structuredContent.error.code, "nope");
  assert.equal(((await ask({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "missing" } })) as { error: { code: number } }).error.code, -32602);
  assert.equal(((await ask({ jsonrpc: "2.0", id: 7, method: "sampling/createMessage" })) as { error: { code: number } }).error.code, -32601);
  assert.equal(((await handleBody("{oops", TOOLS, SERVER)) as { error: { code: number } }).error.code, -32700);
  const batch = (await ask([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }])) as Array<{ id: number }>;
  assert.deepEqual(batch.map(entry => entry.id), [1, 2]);
});

test("rate limits count per address and bucket, and answer with Retry-After past the limit", () => {
  resetRateLimits();
  const request = (address: string) => new Request("http://local/mcp", { method: "POST", headers: { "x-forwarded-for": `${address}, 10.0.0.1` } });
  const limit = { limit: 3, windowSeconds: 60 };
  for (let n = 0; n < 3; n++) assert.equal(rateLimit(request("198.51.100.1"), "mcp", limit).ok, true);
  const refused = rateLimit(request("198.51.100.1"), "mcp", limit);
  assert.equal(refused.ok, false);
  assert.ok(Number(refused.headers["Retry-After"]) > 0 && Number(refused.headers["Retry-After"]) <= 60);
  assert.equal(rateLimit(request("198.51.100.2"), "mcp", limit).ok, true);
  resetRateLimits();
});

test("WebMCP registers check_id_available and how_to_create_silicon_account behind a feature check", () => {
  assert.match(WEBMCP_SCRIPT, /^\(function\(\)\{\nif\(!\("modelContext" in navigator\)/);
  assert.match(WEBMCP_SCRIPT, /name:"check_id_available"/);
  assert.match(WEBMCP_SCRIPT, /name:"how_to_create_silicon_account"/);
  assert.match(WEBMCP_SCRIPT, /\/v1\/ids\/available\?/);
  assert.doesNotMatch(WEBMCP_SCRIPT, /<\/script/i);
  const steps = siliconAccountSteps();
  assert.equal(steps.steps.length, 4);
  assert.match(steps.steps[2]!.command, /^silicon-accounts silicon create --self-create --id si:\{your-id\} --custodian /);
});

test("docs topics: keys, and free words matched to the closest page", () => {
  assert.equal(matchTopic("add-sign-in"), "add-sign-in");
  assert.equal(matchTopic("how do I add sign-in to my app"), "add-sign-in");
  assert.equal(matchTopic("webhooks"), "webhooks");
  assert.equal(matchTopic("zzz"), "overview");
  for (const entry of Object.values(DOCS_TOPICS)) assert.match(entry.path, /^\/docs\/(accounts|apps)(\/|$)/);
});

test("a session cookie is recognised by name only", () => {
  assert.equal(hasSessionCookie("a=1; sa_session=x"), true);
  assert.equal(hasSessionCookie("__Host-sa_session=x"), true);
  assert.equal(hasSessionCookie("sa_sessionx=1; sa_flow=2"), false);
  assert.equal(hasSessionCookie(null), false);
});

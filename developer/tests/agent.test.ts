import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { robotsTxt, AI_CRAWLERS, DISALLOWED } from "../lib/agent/robots";
import { openApi } from "../lib/agent/openapi";
import { LLMS_FULL_TXT, LLMS_TXT } from "../lib/docs/generated/llms";
import { handleBody, negotiateVersion, toolError, toolResult, LATEST_VERSION, type Tool } from "../lib/mcp/protocol";
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
  assert.match(robots, /^Sitemap: https:\/\/developers\.teamofsilicons\.com\/sitemap\.xml$/m);
});

test("openapi.json is OpenAPI 3.1 with every public endpoint, rate limits and the related APIs", () => {
  const spec = openApi();
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(Object.keys(spec.paths).filter(path => path.startsWith("/api/")).sort(), ["/api/docs", "/api/docs/pages", "/api/docs/pages/{product}/{path}", "/api/docs/search"]);
  assert.ok(spec.paths["/mcp"].post);
  assert.match(spec.info.description, /429 with Retry-After/);
  assert.deepEqual(spec["x-related-apis"].map(api => api.openapi), ["https://accounts.teamofsilicons.com/openapi.json", "https://apps.teamofsilicons.com/openapi.json"]);
  // Every $ref names a component that exists.
  const text = JSON.stringify(spec);
  for (const [, kind, name] of text.matchAll(/"\$ref":"#\/components\/(\w+)\/([\w-]+)"/g)) {
    assert.ok((spec.components as Record<string, Record<string, unknown>>)[kind!]?.[name!], `${kind}/${name}`);
  }
});

const SERVER = { name: "test", title: "Test", version: "0.0.0", instructions: "Test server." };
const TOOLS: Tool[] = [
  { definition: { name: "echo", title: "Echo", description: "Echo", inputSchema: { type: "object" } }, call: async args => toolResult({ echoed: args }) },
  { definition: { name: "fail", title: "Fail", description: "Fail", inputSchema: { type: "object" } }, call: async () => { throw new Error("boom"); } },
  { definition: { name: "refuse", title: "Refuse", description: "Refuse", inputSchema: { type: "object" } }, call: async () => toolError("nope", "Not possible.", "Ask again.") },
];
const ask = async (message: unknown) => handleBody(JSON.stringify(message), TOOLS, SERVER);

test("MCP: initialize negotiates the protocol version and offers tools", async () => {
  const answer = (await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })) as { result: { protocolVersion: string; capabilities: { tools: unknown }; instructions: string } };
  assert.equal(answer.result.protocolVersion, "2025-03-26");
  assert.ok(answer.result.capabilities.tools);
  assert.equal(answer.result.instructions, "Test server.");
  assert.equal(negotiateVersion("1999-01-01"), LATEST_VERSION);
  assert.equal(negotiateVersion(undefined), LATEST_VERSION);
});

test("MCP: tools/list, tools/call, tool failures as results, and JSON-RPC errors", async () => {
  const list = (await ask({ jsonrpc: "2.0", id: "a", method: "tools/list" })) as { id: string; result: { tools: Array<{ name: string }> } };
  assert.equal(list.id, "a");
  assert.deepEqual(list.result.tools.map(tool => tool.name), ["echo", "fail", "refuse"]);
  const echoed = (await ask({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { x: 1 } } })) as { result: { structuredContent: unknown; content: Array<{ text: string }> } };
  assert.deepEqual(echoed.result.structuredContent, { echoed: { x: 1 } });
  assert.deepEqual(JSON.parse(echoed.result.content[0]!.text), { echoed: { x: 1 } });
  const failed = (await ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fail" } })) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0]!.text, /boom/);
  const refused = (await ask({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "refuse" } })) as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
  assert.equal(refused.result.structuredContent.error.code, "nope");
  const unknown = (await ask({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "missing" } })) as { error: { code: number } };
  assert.equal(unknown.error.code, -32602);
  const badArgs = (await ask({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "echo", arguments: [1] } })) as { error: { code: number } };
  assert.equal(badArgs.error.code, -32602);
  assert.equal(((await ask({ jsonrpc: "2.0", id: 7, method: "sampling/createMessage" })) as { error: { code: number } }).error.code, -32601);
  assert.deepEqual(await ask({ jsonrpc: "2.0", id: 8, method: "ping" }), { jsonrpc: "2.0", id: 8, result: {} });
  assert.equal(((await handleBody("{oops", TOOLS, SERVER)) as { error: { code: number } }).error.code, -32700);
  assert.equal(((await ask({ id: 9, method: "ping" })) as { error: { code: number } }).error.code, -32600);
  assert.equal(((await ask([])) as { error: { code: number } }).error.code, -32600);
});

test("MCP: notifications and client responses need no answer; batches answer each request", async () => {
  assert.equal(await ask({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await ask({ jsonrpc: "2.0", id: 1, result: {} }), null);
  const batch = (await ask([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }])) as Array<{ id: number }>;
  assert.deepEqual(batch.map(entry => entry.id), [1, 2]);
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
  assert.equal(rateLimit(request("198.51.100.1"), "mcp", limit).ok, true);
  resetRateLimits();
});

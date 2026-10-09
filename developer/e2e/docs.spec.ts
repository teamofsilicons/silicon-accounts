import { expect, test } from "@playwright/test";
import { DOC_SOURCES } from "../lib/docs/generated/pages";
import { LLMS_FULL_TXT, LLMS_TXT } from "../lib/docs/generated/llms";
import { pageHref } from "../lib/docs/site";
import { mock } from "./fixtures";

test("public docs keep both products in one portal and follow product-scoped links", async ({ page }) => {
  await mock(page);
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "Developer docs", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Silicon Apps docs", exact: true })).toHaveAttribute("href", "/docs/apps");
  await page.getByRole("link", { name: "Open Silicon Accounts docs", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/accounts$/);
  await expect(page.getByRole("heading", { name: "Silicon Accounts docs", exact: true })).toBeVisible();
  const sidebar = page.locator("[data-docs-sidebar]");
  await sidebar.getByRole("link", { name: "Add sign-in to your app", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/accounts\/start\/add-sign-in$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add sign-in to your app");
  await expect(sidebar.getByRole("link", { name: "Add sign-in to your app", exact: true })).toHaveAttribute("aria-current", "page");
  await sidebar.getByRole("link", { name: "Silicon Apps", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/apps$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Silicon Apps docs");
  const main = page.getByRole("navigation", { name: "Main", exact: true });
  await expect(main.getByRole("link", { name: "Silicon Apps", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(main.getByRole("link", { name: "Docs", exact: true })).not.toHaveAttribute("aria-current", /.+/);
});

test("one keyboard search finds Accounts and Apps and follows a result", async ({ page }) => {
  await mock(page);
  await page.goto("/docs");
  await expect(page.locator("a[aria-haspopup='dialog'][data-ready]")).toHaveCount(1);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const input = page.getByRole("combobox", { name: "Search the docs" });
  await expect(input).toBeFocused();
  await input.fill("webhooks");
  await expect(page.getByRole("option").filter({ hasText: "Silicon Apps" }).first()).toBeVisible();
  await expect(page.getByRole("option").filter({ hasText: "Silicon Accounts" }).first()).toBeVisible();
  await input.fill("apps publish");
  await expect(page.getByRole("option").first()).toContainText("Silicon Apps");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/docs\/apps\//);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A result is a full page load: wait for the new page's search island.
  await expect(page.locator("a[aria-haspopup='dialog'][data-ready]")).toHaveCount(1);
  await page.keyboard.press("/");
  await expect(input).toBeVisible();
  await input.fill("nonsense-no-such-docs");
  await expect(page.getByText(/No page mentions/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("search works without script: the results page is server-rendered", async ({ request }) => {
  const response = await request.get("/docs/search?q=invalid_grant&product=accounts");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/result(s)? for “invalid_grant”/);
  expect(html).toContain('href="/docs/accounts/reference/errors');
  expect(html).toContain('action="/docs/search" method="get"');
  expect(html).toContain('content="noindex, follow"');
});

test("all source pages and Markdown exports are public with real unknown-page 404s", async ({ request }) => {
  test.setTimeout(120_000);
  for (const source of DOC_SOURCES) {
    const html = await request.get(pageHref(source.path));
    expect(html.status(), source.path).toBe(200);
    expect(html.headers()["content-type"]).toContain("text/html");
    const body = await html.text();
    expect(body, source.path).toContain(`https://developers.teamofsilicons.com${pageHref(source.path)}`);
    expect(body, source.path).toContain('content="index, follow"');
    expect(body, source.path).toContain('"@type":"TechArticle"');
    expect(body, source.path).toContain('"@type":"BreadcrumbList"');
    const markdown = await request.get(`/docs/${source.path}`);
    expect(markdown.status(), source.path).toBe(200);
    expect(await markdown.text(), source.path).toContain(source.body.trim());
  }
  for (const path of ["/docs/unknown", "/docs/apps/unknown", "/docs/accounts/reference/missing", "/docs/accounts/missing.md"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
    expect(await response.text()).toContain("No page here");
  }
  for (const path of ["/docs/apps/start", "/docs/accounts/reference"]) expect((await request.get(path)).status()).toBe(200);
});

test("the search index and the agent files cover every page, and llms files are served as written", async ({ request }) => {
  const indexResponse = await request.get("/docs/search-index.json");
  expect(indexResponse.status()).toBe(200);
  const records: { u: string; g: string }[] = await indexResponse.json();
  for (const source of DOC_SOURCES) expect(records.some(record => record.u === pageHref(source.path)), source.path).toBe(true);
  expect(records.some(record => record.g.startsWith("Silicon Apps"))).toBe(true);
  expect(records.some(record => record.g.startsWith("Silicon Accounts"))).toBe(true);

  const index = await request.get("/llms.txt");
  expect(index.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  const text = await index.text();
  if (LLMS_TXT !== null) expect(text).toBe(LLMS_TXT);
  else for (const source of DOC_SOURCES) expect(text).toContain(`/docs/${source.path}`);
  const full = await request.get("/llms-full.txt");
  expect(full.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  expect(full.headers()["etag"]).toBeTruthy();
  const fullText = await full.text();
  if (LLMS_FULL_TXT !== null) expect(fullText).toBe(LLMS_FULL_TXT);
  else {
    expect(fullText).toContain("apps publish ring");
    expect(fullText).toContain("/docs/accounts/start/add-sign-in");
  }
  const again = await request.get("/llms-full.txt", { headers: { "If-None-Match": full.headers()["etag"]! } });
  expect(again.status()).toBe(304);

  const root = await (await request.get("/docs.md")).text();
  expect(root).toContain("docs/apps/index.md");
  expect(root).toContain("docs/accounts/index.md");

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  const xml = await sitemap.text();
  expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  for (const source of DOC_SOURCES) expect(xml, source.path).toContain(`<loc>https://developers.teamofsilicons.com${pageHref(source.path)}</loc>`);
  for (const path of ["/", "/llms.txt", "/llms-full.txt"]) expect(xml).toContain(`<loc>https://developers.teamofsilicons.com${path}</loc>`);
  expect(xml).not.toMatch(/teamofsilicons\.com\/(api|auth|apps|sign-in|settings|invitations|app-verification|mcp)(\/|<)/);

  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Sitemap: https://developers.teamofsilicons.com/sitemap.xml");
  for (const line of ["User-agent: *", "User-agent: GPTBot", "User-agent: ClaudeBot", "User-agent: PerplexityBot", "User-agent: Google-Extended", "Allow: /", "Disallow: /api/", "Disallow: /auth/", "Disallow: /apps"]) expect(robots).toContain(line);
  expect(robots).not.toMatch(/^Disallow: \/$/m);
});

test("the agent card, OpenAPI, security.txt and manifest describe the platform", async ({ request }) => {
  const card = await (await request.get("/.well-known/agent.json")).json();
  expect(card.name).toBe("Silicon Developer");
  expect(card.url).toBe("https://developers.teamofsilicons.com/mcp");
  expect(card.skills.map((skill: { id: string }) => skill.id)).toEqual(["search_docs", "read_doc", "list_docs", "search_apps", "get_app", "check_app_id", "check_account_id"]);
  const links = JSON.stringify(card);
  for (const url of ["https://accounts.teamofsilicons.com/openapi.json", "https://apps.teamofsilicons.com/openapi.json", "https://developers.teamofsilicons.com/docs", "https://developers.teamofsilicons.com/llms.txt"]) expect(links).toContain(url);

  const spec = await (await request.get("/openapi.json")).json();
  expect(spec.openapi).toBe("3.1.0");
  expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/api/docs/search", "/api/docs/pages", "/api/docs/pages/{product}/{path}", "/mcp"]));
  expect(spec["x-related-apis"].map((api: { openapi: string }) => api.openapi)).toEqual(["https://accounts.teamofsilicons.com/openapi.json", "https://apps.teamofsilicons.com/openapi.json"]);

  const security = await request.get("/.well-known/security.txt");
  expect(security.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  expect(await security.text()).toMatch(/^Contact: mailto:.+\nContact: https:.+\nExpires: \d{4}-/);

  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
  for (const icon of (await manifest.json()).icons as { src: string }[]) expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  for (const path of ["/og.png", "/favicon.ico", "/apple-touch-icon.png", "/fonts/bdo-grotesk/BDOGrotesk-DemiBold.woff2", "/fonts/bdo-grotesk/OFL.txt"]) expect((await request.get(path)).status(), path).toBe(200);
});

test("the docs JSON API searches, filters, reads pages and answers errors in one shape", async ({ request }) => {
  const search = await request.get("/api/docs/search?q=publish&product=apps&limit=5");
  expect(search.status()).toBe(200);
  expect(search.headers()["content-type"]).toBe("application/json; charset=utf-8");
  expect(Number(search.headers()["ratelimit-limit"])).toBeGreaterThan(0);
  const found = await search.json();
  expect(found.results.length).toBeGreaterThan(0);
  expect(found.results.length).toBeLessThanOrEqual(5);
  for (const result of found.results) {
    expect(result.product).toBe("apps");
    expect(result.url).toMatch(/^https:\/\/developers\.teamofsilicons\.com\/docs\/apps\//);
  }
  const reference = await (await request.get("/api/docs/search?q=token&kind=reference")).json();
  expect(reference.results.every((result: { kind: string }) => result.kind === "reference")).toBe(true);

  for (const [path, code] of [["/api/docs/search", "missing_query"], ["/api/docs/search?q=x&product=store", "invalid_product"], ["/api/docs/search?q=x&kind=guide", "invalid_kind"], ["/api/docs/search?q=x&limit=500", "invalid_limit"]] as const) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(400);
    const body = await response.json();
    expect(body.error.code, path).toBe(code);
    expect(typeof body.error.message).toBe("string");
    expect(typeof body.error.hint).toBe("string");
  }

  const list = await (await request.get("/api/docs/pages?product=accounts&kind=start")).json();
  expect(list.total).toBe(DOC_SOURCES.filter(source => source.path.startsWith("accounts/start/")).length);
  const page = await (await request.get("/api/docs/pages/apps/start/publish")).json();
  expect(page.title).toBe("Publish an app");
  expect(page.markdown).toBe(DOC_SOURCES.find(source => source.path === "apps/start/publish.md")!.body);
  expect(page.headings.length).toBeGreaterThan(2);
  const missing = await request.get("/api/docs/pages/apps/start/nope");
  expect(missing.status()).toBe(404);
  expect((await missing.json()).error.code).toBe("page_not_found");
  const unknown = await request.get("/api/docs/nothing-here");
  expect(unknown.status()).toBe(404);
  expect((await unknown.json()).error.code).toBe("not_found");
  const post = await request.post("/api/docs/search?q=x");
  expect(post.status()).toBe(405);
  expect((await post.json()).error.code).toBe("method_not_allowed");
});

test("the API rate limit answers 429 with Retry-After and a structured error", async ({ request }) => {
  const headers = { "X-Forwarded-For": "203.0.113.77" };
  let last = await request.get("/api/docs", { headers });
  const limit = Number(last.headers()["ratelimit-limit"]);
  for (let n = 1; n <= limit && last.status() === 200; n++) last = await request.get("/api/docs", { headers });
  expect(last.status()).toBe(429);
  expect(Number(last.headers()["retry-after"])).toBeGreaterThan(0);
  expect((await last.json()).error.code).toBe("rate_limited");
});

test("the MCP server initializes, lists its tools and runs them", async ({ request }) => {
  const rpc = (body: unknown, headers: Record<string, string> = {}) => request.post("/mcp", { data: body, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } });
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
  expect(init.status()).toBe(200);
  const initBody = await init.json();
  expect(initBody.result.protocolVersion).toBe("2025-06-18");
  expect(initBody.result.capabilities.tools).toBeTruthy();
  expect(initBody.result.serverInfo.name).toBe("silicon-developer");
  expect((await rpc({ jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "1999-01-01" } })).ok()).toBe(true);

  expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { "MCP-Protocol-Version": "2025-06-18" })).status()).toBe(202);
  const tools = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["search_docs", "read_doc", "list_docs", "search_apps", "get_app", "check_app_id", "check_account_id"]);
  for (const tool of tools.result.tools) expect(tool.inputSchema.type).toBe("object");

  const searched = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_docs", arguments: { query: "publish an app", product: "apps" } } })).json();
  expect(searched.result.isError).toBeFalsy();
  expect(searched.result.structuredContent.results[0].product).toBe("apps");
  const read = await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_doc", arguments: { path: "https://developers.teamofsilicons.com/docs/accounts/reference/errors" } } })).json();
  expect(read.result.content[0].text).toContain("# Errors");
  const bad = await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_doc", arguments: { path: "apps/nowhere" } } })).json();
  expect(bad.result.isError).toBe(true);
  const unknownTool = await (await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "delete_everything" } })).json();
  expect(unknownTool.error.code).toBe(-32602);
  expect((await (await rpc({ jsonrpc: "2.0", id: 7, method: "nope" })).json()).error.code).toBe(-32601);
  const ping = await (await rpc({ jsonrpc: "2.0", id: 8, method: "ping" })).json();
  expect(ping.result).toEqual({});

  const sse = await rpc({ jsonrpc: "2.0", id: 10, method: "ping" }, { Accept: "text/event-stream" });
  expect(sse.headers()["content-type"]).toContain("text/event-stream");
  expect(await sse.text()).toMatch(/^event: message\ndata: \{"jsonrpc":"2.0","id":10,"result":\{\}\}\n\n$/);
  const parse = await request.post("/mcp", { data: Buffer.from("{not json"), headers: { "Content-Type": "application/json" } });
  expect(parse.status()).toBe(400);
  expect((await parse.json()).error.code).toBe(-32700);
  const get = await request.get("/mcp");
  expect(get.status()).toBe(405);
  expect(get.headers()["allow"]).toContain("POST");
  const version = await rpc({ jsonrpc: "2.0", id: 11, method: "ping" }, { "MCP-Protocol-Version": "2020-01-01" });
  expect(version.status()).toBe(400);
});

test("the home page is server-rendered, semantic and described for search and agents", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const html = await response.text();
  for (const text of ["Build apps for Carbons and Silicons", "Silicon Apps", "Silicon Accounts", "App verification", "User verification", "Why build on us", "Does a Silicon need a Carbon?", "check_account_id"]) expect(html, text).toContain(text);
  for (const tag of ["<header", "<nav", "<main", "<section", "<footer", "<h1", "<details"]) expect(html, tag).toContain(tag);
  expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
  for (const meta of ['<link rel="canonical" href="https://developers.teamofsilicons.com"/>', 'property="og:site_name" content="Silicon Developer"', 'property="og:url"', 'property="og:type" content="website"', 'property="og:title"', 'property="og:description"', 'property="og:image" content="https://developers.teamofsilicons.com/og.png"', 'name="twitter:card" content="summary_large_image"', 'content="index, follow"']) expect(html, meta).toContain(meta);
  for (const action of ['href="/docs"', 'href="/docs/apps/start/publish"', 'href="/docs/accounts/start/add-sign-in"', 'href="/sign-in"']) expect(html, action).toContain(action);
  expect(html).toContain("navigator.modelContext.registerTool");
  const graphs = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]!));
  const types = graphs.flatMap(graph => graph["@graph"].map((node: { "@type": string }) => node["@type"]));
  expect(types).toEqual(expect.arrayContaining(["Organization", "WebSite", "WebPage", "FAQPage"]));
  const website = graphs.flatMap(graph => graph["@graph"]).find((node: { "@type": string }) => node["@type"] === "WebSite");
  expect(website.potentialAction.target.urlTemplate).toBe("https://developers.teamofsilicons.com/docs/search?q={search_term_string}");
});

for (const width of [320, 1440]) test(`the home page and docs fit ${width}px and navigation works in both themes`, async ({ page }) => {
  await mock(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.goto("/docs/apps/start/install");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Install Apps and find an app");
  if (width === 320) {
    await page.getByRole("button", { name: "Open the menu" }).click();
    const menu = page.getByRole("dialog", { name: "Menu", exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole("link", { name: "Silicon Accounts", exact: true }).first().click();
    await expect(page).toHaveURL(/\/docs\/accounts$/);
    await expect(menu).toBeHidden();
    await page.goto("/docs/apps/start/install");
  }
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `test-results/silicon-docs-${width}-${theme}.png`, fullPage: true });
  }
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: `test-results/silicon-home-${width}.png`, fullPage: true });
});

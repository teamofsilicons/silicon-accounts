import { expect, test } from "@playwright/test";
import { DOC_SOURCES } from "../lib/docs/generated/pages";
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
  await sidebar.getByRole("link", { name: "Silicon Apps", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/apps$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Silicon Apps docs");
  await expect(page.getByRole("link", { name: "Docs", exact: true }).first()).toHaveAttribute("aria-current", "page");
});

test("one keyboard search finds Accounts and Apps and follows a result", async ({ page }) => {
  await mock(page);
  await page.goto("/docs");
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
  await page.keyboard.press("/");
  await expect(input).toBeVisible();
  await input.fill("nonsense-no-such-docs");
  await expect(page.getByText(/No page mentions/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
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

test("combined search and llms exports include every page and namespaced Markdown links", async ({ request }) => {
  const indexResponse = await request.get("/docs/search-index.json");
  expect(indexResponse.status()).toBe(200);
  const records: {u:string;g:string}[] = await indexResponse.json();
  for (const source of DOC_SOURCES) expect(records.some(record => record.u === pageHref(source.path)), source.path).toBe(true);
  expect(records.some(record => record.g.startsWith("Silicon Apps"))).toBe(true);
  expect(records.some(record => record.g.startsWith("Silicon Accounts"))).toBe(true);
  const index = await request.get("/llms.txt");
  expect(index.headers()["content-type"]).toContain("text/plain");
  const text = await index.text();
  for (const source of DOC_SOURCES) expect(text).toContain(`/docs/${source.path}`);
  const full = await (await request.get("/llms-full.txt")).text();
  expect(full).toContain("apps publish ring");
  expect(full).toContain("/docs/accounts/start/add-sign-in");
  expect(full).toContain("/docs/apps/start/install");
  const root = await (await request.get("/docs.md")).text();
  expect(root).toContain("docs/apps/index.md");
  expect(root).toContain("docs/accounts/index.md");
});

for (const width of [320, 1440]) test(`unified docs fit ${width}px and navigation works in both themes`, async ({ page }) => {
  await mock(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.goto("/docs/apps/start/install");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Install Apps and find an app");
  if (width === 320) {
    await page.getByRole("button", { name: "Open the docs menu" }).click();
    const drawer = page.getByRole("dialog", { name: "Docs", exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "Silicon Accounts", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(/\/docs\/accounts$/);
    await page.goto("/docs/apps/start/install");
  }
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") await page.getByRole("button", { name: "Switch to dark mode", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `/tmp/silicon-unified-docs-${width}-${theme}.png`, fullPage: true });
  }
});

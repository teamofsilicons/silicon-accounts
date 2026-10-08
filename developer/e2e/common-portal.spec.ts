import { test, expect } from "@playwright/test";
import { mock } from "./fixtures";

test("one workspace retains Accounts tabs beside Apps publishing without store exploration", async ({ page }) => {
  await mock(page, true);
  await page.goto("/apps/test-app/publishing");
  const tabs = ["Overview", "Publishing", "Releases", "Authors", "History", "Sign-in", "Details", "Flows", "Pages", "Users", "Import", "Webhooks", "ATA", "Embed"];
  for (const name of tabs) await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
  await page.getByRole("tab", {name: "Sign-in", exact: true}).click();
  await expect(page).toHaveURL(/\/apps\/test-app\/sign-in$/);
  await expect(page.getByRole("heading", {name: /Sign-in methods/})).toBeVisible();
  await page.getByRole("tab", {name: "Publishing", exact: true}).click();
  await expect(page.getByLabel("App name", {exact: true})).toHaveValue("A useful app");
  await expect(page.getByRole("link", {name: /Explore|Discover/})).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("tab", {name: "Overview", exact: true}).click();
  await expect(page.getByRole("link", {name: "Manage publishing"})).toHaveAttribute("href", "/apps/test-app/publishing");
  await expect(page.locator('a[href="https://apps.teamofsilicons.com"]')).toHaveCount(0);
  await page.getByRole("link", {name: "Manage publishing"}).click();
  await expect(page.getByLabel("App name", {exact: true})).toHaveValue("A useful app");
  await page.screenshot({path: "/tmp/silicon-common-portal.png", fullPage: true});
});

test("browser history retains a failed publishing draft and recovers it in the same workspace", async ({ page }) => {
  const changes = await mock(page, true);
  let fail = true;
  await page.route("**/api/apps/apps/test-app", route => {
    if (route.request().method() === "PATCH" && fail) return route.fulfill({status: 503, json: {error: {code: "storage_unavailable", message: "Keep this draft until storage recovers."}}});
    return route.fallback();
  });
  await page.goto("/apps/test-app/sign-in");
  await page.getByRole("tab", {name: "Publishing", exact: true}).click();
  await page.getByLabel("App name", {exact: true}).fill("Preserve browser history draft");
  await expect(page.getByText("Changes could not be saved")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole("button", {name: "Return to publishing draft"}).click();
  await expect(page.getByLabel("App name", {exact: true})).toHaveValue("Preserve browser history draft");
  fail = false;
  await page.getByRole("tab", {name: "Authors", exact: true}).click();
  await expect(page.getByRole("heading", {name: "Build with others", exact: true})).toBeVisible();
  expect(changes.some(change => change.body.name === "Preserve browser history draft")).toBe(true);
  await expect(page.getByRole("button", {name: "Return to publishing draft"})).toHaveCount(0);
});

for (const width of [390, 768, 1024, 1440]) test(`common publishing workspace fits ${width}px`, async ({ page }) => {
  await page.setViewportSize({width, height: 1000});
  await mock(page, true);
  await page.goto("/apps/test-app/publishing?step=3");
  await expect(page.getByText("Three commands, on every platform")).toBeVisible();
  const overflow = await page.evaluate(() => ({width: document.documentElement.scrollWidth, viewport: innerWidth, elements: [...document.querySelectorAll(".publishing-panel *")].map(el => ({tag: el.tagName, cls: el.className, right: el.getBoundingClientRect().right})).filter(el => el.right > innerWidth)}));
  expect(overflow.width, JSON.stringify(overflow)).toBeLessThanOrEqual(width + 1);
  await page.getByRole("tab", {name: "Sign-in", exact: true}).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("the live BFF rejects store operations and unsigned management before upstream requests", async ({ request }) => {
  expect((await request.get("/api/apps/apps")).status()).toBe(404);
  expect((await request.post("/api/apps/reports", {data: {text: "fixture"}})).status()).toBe(404);
  expect((await request.get("/api/apps/apps?mine=true")).status()).toBe(401);
  expect((await request.post("/api/apps/apps/test-app/packages/linux-x86_64", {headers: {Origin: "http://127.0.0.1:8620"}, data: "not-authenticated"})).status()).toBe(401);
});

test("shared telemetry preference persists and applies to publishing requests", async ({ page }) => {
  const changes = await mock(page, true);
  await page.goto("/settings");
  await page.getByRole("switch", {name: "Share usage telemetry"}).click();
  await expect(page.getByRole("switch", {name: "Share usage telemetry"})).not.toBeChecked();
  await page.goto("/apps/test-app/publishing");
  await page.getByLabel("App name", {exact: true}).fill("Telemetry preference applied");
  await page.getByRole("button", {name: "2 Access Required"}).click();
  expect(changes.find(change => change.body.name === "Telemetry preference applied")?.headers["x-apps-telemetry"]).toBe("off");
  await page.goto("/settings");
  await expect(page.getByRole("switch", {name: "Share usage telemetry"})).not.toBeChecked();
});

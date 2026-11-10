import { test, expect, type Page } from "@playwright/test";
import { makeApp, mock } from "./fixtures";

async function publishingOnly(page: Page, isAuthor = true) {
  await mock(page, true);
  const app = { ...makeApp(), app_id: "silicon-accounts", name: "Silicon Accounts", published: true, is_author: isAuthor, is_admin: false };
  await page.route("**/api/accounts/me/owned-apps*", route => route.fulfill({ json: { items: [], next_cursor: null } }));
  await page.route("**/api/accounts/apps/silicon-accounts", route => route.fulfill({ status: 403, json: { error: { code: "not_app_owner", message: "Accounts sign-in settings are protected." } } }));
  const pages: string[] = [];
  await page.route("**/api/apps/apps?*", route => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get("mine")).toBe("true");
    pages.push(params.get("offset") ?? "0");
    return route.fulfill({ json: params.get("offset") === "100" ? { items: [app], next_offset: null } : { items: [makeApp()], next_offset: 100 } });
  });
  await page.route("**/api/apps/apps/silicon-accounts", route => route.fulfill({ json: app }));
  await page.route("**/api/apps/apps/silicon-accounts/readiness", route => route.fulfill({ json: { ready: true, errors: [] } }));
  return { pages };
}

test("publishing authors see paginated apps without Accounts configuration and can invite authors", async ({ page }) => {
  const { pages } = await publishingOnly(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/apps");
  const tile = page.getByRole("list", { name: "Your apps" }).getByRole("link", { name: /Silicon Accounts/ });
  await expect(tile).toBeVisible();
  expect(pages).toContain("100");
  await tile.click();
  await expect(page.getByRole("heading", { name: "Silicon Accounts", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Sign-in", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Authors", exact: true }).click();
  await expect(page.getByLabel("Invite an author")).toBeVisible();
  await page.getByLabel("Invite an author").fill("si:saket-agents");
  let invite: unknown;
  await page.route("**/api/apps/apps/silicon-accounts/invites", route => {
    if (route.request().method() === "POST") { invite = route.request().postDataJSON(); return route.fulfill({ json: { id: "test-invite" } }); }
    return route.fulfill({ json: { items: [] } });
  });
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("Invitation created for si:saket-agents.")).toBeVisible();
  expect(invite).toEqual({ to: "si:saket-agents" });
  await page.screenshot({ path: "../.dev/ting-release/publishing-authors-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Invite an author")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "../.dev/ting-release/publishing-authors-mobile.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("a public listing grants no publishing access to a non-author", async ({ page }) => {
  await publishingOnly(page, false);
  await page.goto("/apps");
  await expect(page.getByRole("list", { name: "Your apps" }).getByRole("link", { name: /Silicon Accounts/ })).toHaveCount(0);
  await page.goto("/apps/silicon-accounts/authors");
  await expect(page.getByText("You don't own silicon-accounts", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Invite an author")).toHaveCount(0);
});

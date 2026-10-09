import { expect, test, type Page, type Route } from "@playwright/test";
import type { AccountVerificationRequest } from "../lib/api/types";
import { mock } from "./fixtures";

const endpoint = "**/api/accounts/apps/test-app/account-verification-request";
const receipt = (reason = "We want a consistent sign-in domain for our customers."): AccountVerificationRequest => ({
  request_id: "f8cde638-1bc7-4e9b-aa36-740e4c511d18", account_uuid: "test-author",
  context_app: { app_id: "test-app", name: "A useful app", logo_url: null, logo_dark_url: null, homepage_url: null },
  reason, status: "pending", submitted_at: "2026-10-08T12:00:00Z", response_expected_by: "2026-10-10T12:00:00Z", reviewed_at: null,
});
const requestState = (request: AccountVerificationRequest | null) => ({ request, response_time_hours: 48 });
async function setup(page: Page, handler: (route: Route) => Promise<void>) {
  await mock(page, true);
  await page.route(endpoint, handler);
  await page.goto("/apps/test-app/sign-in");
  await expect(page.getByRole("heading", { name: "Account verification", exact: true })).toBeVisible();
}
const openRequest = async (page: Page) => {
  await page.getByRole("button", { name: "Request account verification", exact: true }).click();
  return page.getByRole("dialog", { name: "Request account verification", exact: true });
};

test("reason-only request validates Unicode length and persists the pending receipt", async ({ page }) => {
  let saved: AccountVerificationRequest | null = null;
  const posts: { reason: string }[] = [];
  await setup(page, async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON(); posts.push(body);
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      saved = receipt(body.reason);
      await route.fulfill({ status: 201, json: { ...requestState(saved), created: true } });
    } else await route.fulfill({ json: requestState(saved) });
  });
  const dialog = await openRequest(page);
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Reason" })).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("textbox", { name: "Reason" })).toBeFocused();
  await dialog.getByRole("textbox", { name: "Reason" }).fill("😀".repeat(5001));
  await dialog.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Reason" })).toHaveAttribute("aria-invalid", "true");
  expect(posts).toHaveLength(0);
  await dialog.getByRole("textbox", { name: "Reason" }).fill("  We want login.ourapp.com for a consistent sign-in experience.  ");
  await dialog.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toEqual([{ reason: "We want login.ourapp.com for a consistent sign-in experience." }]);
  const status = page.getByRole("status").filter({ hasText: "Request submitted" });
  await expect(status).toBeFocused();
  await expect(page.getByText("Pending review", { exact: true })).toBeVisible();
  await expect(page.getByText(/A response may take up to 48 hours, expected by/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Request account verification", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Request awaiting review", { exact: true })).toBeVisible();
  await expect(page.getByText("We want login.ourapp.com for a consistent sign-in experience.", { exact: true })).toBeVisible();
  expect(posts).toHaveLength(1);
});

test("a lost submission preserves the draft and idempotency key for retry", async ({ page }) => {
  const keys: string[] = [];
  let saved: AccountVerificationRequest | null = null;
  await setup(page, async route => {
    if (route.request().method() === "POST") {
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length === 1) { await route.abort("failed"); return; }
      saved = receipt(route.request().postDataJSON().reason);
      await route.fulfill({ status: 201, json: { ...requestState(saved), created: true } });
    } else await route.fulfill({ json: requestState(saved) });
  });
  const dialog = await openRequest(page);
  const reason = dialog.getByRole("textbox", { name: "Reason" });
  await reason.fill("Our customers recognize our sign-in domain.");
  await dialog.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(dialog.getByText("Request could not be submitted", { exact: true })).toBeVisible();
  await expect(reason).toHaveValue("Our customers recognize our sign-in domain.");
  expect(keys).toHaveLength(1);
  await dialog.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

test("server validation and status failures are exact and recover without losing input", async ({ page }) => {
  let statusFails = true;
  await setup(page, async route => {
    if (route.request().method() === "POST") await route.fulfill({ status: 422, json: { error: { code: "invalid_request", message: "The reason could not be accepted.", hint: "Revise your reason and try again.", details: { fields: { reason: "Describe why you need your own sign-in domain." } } } } });
    else if (statusFails) await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Account verification requests are temporarily unavailable." } } });
    else await route.fulfill({ json: requestState(null) });
  });
  await expect(page.getByText("Account verification requests are temporarily unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request account verification", exact: true })).toHaveCount(0);
  statusFails = false;
  await page.getByRole("button", { name: "Try request status again" }).click();
  const dialog = await openRequest(page);
  const reason = dialog.getByRole("textbox", { name: "Reason" });
  await reason.fill("Our initial reason.");
  await dialog.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(dialog.getByText(/The reason could not be accepted./)).toBeVisible();
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(reason).toHaveAccessibleDescription(/Describe why you need your own sign-in domain./);
  await expect(reason).toHaveValue("Our initial reason.");
  await expect(reason).toBeFocused();
});

test("an existing account-wide request retains the original app and reason", async ({ page }) => {
  const existing = { ...receipt("We submitted this from our other app."), context_app: { ...receipt().context_app, app_id: "other-app", name: "Another app" } };
  await setup(page, route => route.fulfill({ json: requestState(existing) }));
  await expect(page.getByText("Request awaiting review", { exact: true })).toBeVisible();
  await expect(page.getByText(/from Another app \(other-app\)/)).toBeVisible();
  await expect(page.getByText(existing.reason, { exact: true })).toBeVisible();
  await expect(page.getByText(/applies to your account across the apps you manage/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Request account verification", exact: true })).toHaveCount(0);
});

test("a request created elsewhere while the form is open is not represented as another request", async ({ page }) => {
  const existing = receipt("The original pending reason."); let submitted = false;
  await setup(page, async route => {
    if (route.request().method() === "POST") { submitted = true; await route.fulfill({ json: { ...requestState(existing), created: false } }); }
    else await route.fulfill({ json: requestState(submitted ? existing : null) });
  });
  const dialog = await openRequest(page);
  await dialog.getByRole("textbox", { name: "Reason" }).fill("A newer reason that will not replace the original.");
  await dialog.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(page.getByText(/This is your existing request; another one was not created./)).toBeVisible();
  await expect(page.getByText(existing.reason, { exact: true })).toBeVisible();
  await expect(page.getByText("A newer reason that will not replace the original.", { exact: true })).toHaveCount(0);
});

test("dialog keyboard focus restores on cancel and BFF rejects unauthenticated requests", async ({ page, request }) => {
  await setup(page, route => route.fulfill({ json: requestState(null) }));
  const trigger = page.getByRole("button", { name: "Request account verification", exact: true });
  await trigger.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Request account verification", exact: true });
  await expect(dialog).toBeVisible();
  const last = dialog.getByRole("button", { name: "Submit request", exact: true });
  await last.focus(); await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await request.get("/api/accounts/apps/test-app/account-verification-request")).status()).toBe(401);
  expect((await request.post("/api/accounts/apps/test-app/account-verification-request", { headers: { Origin: `http://127.0.0.1:${process.env.E2E_PORT || 8620}` }, data: { reason: "Unsigned request" } })).status()).toBe(401);
});

for (const width of [320, 1440]) test(`account verification form and receipt fit ${width}px in both themes`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  let saved: AccountVerificationRequest | null = null;
  await setup(page, async route => {
    if (route.request().method() === "POST") { saved = receipt(route.request().postDataJSON().reason); await route.fulfill({ status: 201, json: { ...requestState(saved), created: true } }); }
    else await route.fulfill({ json: requestState(saved) });
  });
  const dialog = await openRequest(page);
  await dialog.getByRole("textbox", { name: "Reason" }).fill("We want customers to sign in at login.ourapp.com while keeping Silicon Accounts as our identity provider.");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `/tmp/silicon-account-verification-form-${width}-${theme}.png` });
  }
  await dialog.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const section = page.locator("#signin-account-verification");
  await section.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  await section.screenshot({ path: `/tmp/silicon-account-verification-receipt-${width}.png` });
});

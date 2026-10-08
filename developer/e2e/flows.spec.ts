import { test, expect } from "@playwright/test";
import { mock } from "./fixtures";
test("creation shows a one-time secret and flushes an edit before another setup step", async ({
  page,
}) => {
  const changes = await mock(page, true);
  await page.goto("/");
  await page.getByRole("button", { name: "New app", exact: true }).first().click();
  await page.getByLabel("App name", { exact: true }).fill("A useful app");
  await page.getByLabel("App ID", { exact: true }).fill("test-app");
  await expect(page.getByText("This app ID is available")).toBeVisible();
  await page
    .getByRole("button", { name: "Create app", exact: true })
    .last()
    .click();
  await expect(page.getByText("test-secret-shown-once")).toBeVisible();
  await page.getByRole("button", { name: "I saved my secret" }).click();
  await expect(
    page.getByRole("heading", { name: "Make a good introduction" }),
  ).toBeVisible();
  await page.getByLabel("App name", { exact: true }).fill("My renamed app");
  await page.getByRole("button", { name: "2 Access Required" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose who can find your app" }),
  ).toBeVisible();
  expect(changes.some((change) => change.body.name === "My renamed app")).toBe(
    true,
  );
  for (const change of changes)
    expect(change.headers["idempotency-key"]).toBeTruthy();
  await expect(page.getByText("test-secret-shown-once")).toHaveCount(0);
  expect(
    await page.evaluate(() => Object.values(localStorage).join(" ")),
  ).not.toContain("test-secret");
});
test("failed package validation exposes command, expectation, and exact error", async ({
  page,
}) => {
  await mock(page, true);
  await page.goto("/apps/test-app/publishing?step=3");
  await expect(
    page.getByText("Three commands, on every platform"),
  ).toBeVisible();
  await page.locator("input[type=file]").setInputFiles({
    name: "test-app.tar.gz",
    mimeType: "application/gzip",
    buffer: Buffer.from("fixture"),
  });
  await page.getByRole("button", { name: "Upload and validate" }).click();
  await expect(
    page.getByText("silicon-accounts --json returned the wrong app_id."),
  ).toBeVisible();
  await page.getByText("View exact error details").click();
  await expect(page.getByText(/contract mismatch/)).toBeVisible();
  await expect(
    page.getByText("Return test-app in the app_id field."),
  ).toBeVisible();
});
test("failed autosave keeps the user on the current step until a retry succeeds", async ({
  page,
}) => {
  await mock(page, true);
  let fail = true;
  await page.route("**/api/apps/apps/test-app", async (route) => {
    if (route.request().method() === "PATCH" && fail) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "save_unavailable",
            message: "Draft storage is temporarily unavailable.",
            hint: "Retry once the service is available.",
          },
        }),
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/apps/test-app/publishing");
  await page.getByLabel("App name", { exact: true }).fill("Unsaved name");
  await expect(page.getByText("Changes could not be saved")).toBeVisible();
  await page.getByRole("button", { name: "2 Access Required" }).click();
  await expect(
    page.getByRole("heading", { name: "Make a good introduction" }),
  ).toBeVisible();
  await expect(page.getByLabel("App name", { exact: true })).toHaveValue(
    "Unsaved name",
  );
  fail = false;
  await page.getByRole("button", { name: "2 Access Required" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose who can find your app" }),
  ).toBeVisible();
});
test("creation dialog traps keyboard focus and returns it on Escape", async ({
  page,
}) => {
  await mock(page, true);
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "New app", exact: true }).first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let n = 0; n < 10; n++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});
test("failed draft save also protects navigation away from the workspace", async ({
  page,
}) => {
  await mock(page, true);
  await page.route("**/api/apps/apps/test-app", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "save_unavailable",
            message: "Save unavailable. Try again.",
          },
        }),
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/apps/test-app/publishing");
  await page.getByLabel("App name", { exact: true }).fill("Keep this draft");
  await page
    .getByRole("link", { name: "Your apps", exact: true })
    .last()
    .click();
  await expect(page.getByLabel("App name", { exact: true })).toHaveValue(
    "Keep this draft",
  );
  await expect(page).toHaveURL(/apps\/test-app\/publishing/);
  await expect(
    page.getByText("Save unavailable. Try again.").first(),
  ).toBeVisible();
});
test("webhook secret can be generated before an endpoint and preferences autosave without exposing it again", async ({
  page,
}) => {
  await mock(page, true);
  let rotations = 0;
  await page.route("**/api/apps/apps/test-app/webhook**", async (route) => {
    const request = route.request();
    const result = request.url().endsWith("/rotate")
      ? (rotations++, { webhook_secret: "whsec_test-only" })
      : request.method() === "GET"
        ? { url: null, events: null, secret_set: false }
        : { url: request.postDataJSON().url, secret: null };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(result),
    });
  });
  await page.goto("/apps/test-app/publishing?step=6");
  await expect(page.locator(".event-options input:checked")).toHaveCount(5);
  await page
    .getByRole("button", {
      name: "Configure webhook for updates from Silicon Accounts",
    })
    .click();
  await expect(page.getByText("whsec_test-only")).toBeVisible();
  await page.getByRole("button", { name: "I saved my secret" }).click();
  await expect(page.getByText("whsec_test-only")).toHaveCount(0);
  await page
    .getByLabel("Webhook endpoint")
    .fill("https://example.com/accounts");
  await expect(page.getByText("All changes saved")).toBeVisible();
  expect(rotations).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("retry after an uncertain network failure reuses the mutation idempotency key", async ({
  page,
}) => {
  await mock(page, true);
  const keys: string[] = [];
  await page.route("**/api/apps/apps/test-app/invites", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "invite-1", status: "pending" }),
    });
  });
  await page.goto("/apps/test-app/publishing");
  await page.getByRole("tab", { name: "Authors", exact: true }).click();
  await page.getByLabel("Invite an author").fill("c:friend");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText("Could not reach Silicon Apps.")).toBeVisible();
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(
    page.getByText("Invitation created for c:friend."),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});

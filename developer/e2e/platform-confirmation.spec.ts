import { test, expect } from "@playwright/test";
import { mock } from "./fixtures";

test("non-Linux uploads require a fresh platform confirmation and send it explicitly", async ({ page }) => {
  await mock(page, true);
  const requests: Record<string, string>[] = [];
  await page.route("**/api/apps/apps/test-app/packages/*", async route => {
    requests.push(route.request().headers());
    await route.fulfill({ json: { id: "confirmed-package" } });
  });
  await page.goto("/apps/test-app/publishing?step=3");
  const target = page.getByLabel("Package target");
  await target.selectOption("macos-aarch64");
  const file = page.locator('input[type="file"]');
  await file.setInputFiles({ name: "app.tar.gz", mimeType: "application/gzip", buffer: Buffer.from("fixture") });
  const upload = page.getByRole("button", { name: "Upload and validate" });
  const confirmation = page.getByRole("checkbox", { name: /I checked this package/ });
  await expect(upload).toBeDisabled();
  await confirmation.check();
  await expect(upload).toBeEnabled();
  await target.selectOption("windows-x86_64");
  await expect(confirmation).not.toBeChecked();
  await expect(upload).toBeDisabled();
  await confirmation.check();
  await file.setInputFiles({ name: "replacement.tar.gz", mimeType: "application/gzip", buffer: Buffer.from("replacement") });
  await expect(confirmation).not.toBeChecked();
  await confirmation.check();
  await upload.click();
  await expect(page.getByText(/Your platform confirmation was recorded/)).toBeVisible();
  expect(requests[0]["x-apps-platform-confirmed"]).toBe("true");
  await expect(confirmation).not.toBeChecked();
  await target.selectOption("linux-x86_64");
  await expect(confirmation).toHaveCount(0);
  await file.setInputFiles({ name: "linux.tar.gz", mimeType: "application/gzip", buffer: Buffer.from("linux") });
  await upload.click();
  await expect(page.getByText(/All three commands passed server validation/)).toBeVisible();
  expect(requests[1]["x-apps-platform-confirmed"]).toBeUndefined();
});

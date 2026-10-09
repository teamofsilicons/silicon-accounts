import { test, expect, type Page } from "@playwright/test";
import { mock } from "./fixtures";

/** The main frame's paths, one entry per page (the client router reports one move more than once). */
function trackVisits(page: Page): string[] {
  const visits: string[] = [];
  page.on("framenavigated", frame => {
    if (frame !== page.mainFrame()) return;
    const path = new URL(frame.url()).pathname;
    if (visits.at(-1) !== path) visits.push(path);
  });
  return visits;
}

test("a 401 from Silicon Apps never sends a signed-in Carbon to the sign-in page and back", async ({ page }) => {
  await mock(page, true);
  // An Apps API that does not trust this developer token answers 401 invalid_token. Whatever reaches the browser, it
  // asks who is signed in (/auth/session, /v1/me) before it leaves, and both say signed in.
  await page.route("**/api/apps/apps?mine=true*", route => route.fulfill({ status: 401, json: { error: { code: "invalid_token", message: "The access token was not issued by http://127.0.0.1:1." } } }));
  const visits = trackVisits(page);
  await page.goto("/apps");
  await expect(page.getByRole("heading", { level: 1, name: "Your apps" })).toBeVisible();
  await expect(page.getByRole("link", { name: /A useful app/ })).toBeVisible();
  await page.waitForTimeout(4_000);
  expect(visits).toEqual(["/apps"]);
});

test("the apps workspace says in words when Silicon Apps refuses the sign-in, and keeps the apps from Silicon Accounts", async ({ page }) => {
  await mock(page, true);
  let refuse = true;
  await page.route("**/api/apps/apps?mine=true*", route => refuse
    ? route.fulfill({ status: 502, json: { error: { code: "apps_rejected_sign_in", message: "Silicon Apps did not accept your developer site sign-in. You are still signed in, and everything that comes from Silicon Accounts keeps working.", hint: "Try again in a moment.", details: { upstream_status: 401, upstream_code: "invalid_token" } } } })
    : route.fulfill({ json: { items: [], total: 0 } }));
  const visits = trackVisits(page);
  await page.goto("/apps");
  const notice = page.getByRole("status").filter({ hasText: "Publishing details could not be loaded" });
  await expect(notice).toContainText("Silicon Apps did not accept your developer site sign-in");
  await expect(notice).toContainText("Try again in a moment.");
  await expect(page.getByRole("link", { name: /A useful app/ })).toBeVisible();
  refuse = false;
  await notice.getByRole("button", { name: "Try again" }).click();
  await expect(notice).toHaveCount(0);
  expect(visits).toEqual(["/apps"]);
});

test("a sign-in that really ended still goes to the sign-in card, once", async ({ page }) => {
  await mock(page, true);
  let ended = false;
  await page.route("**/auth/session", route => route.fulfill({ json: { signed_in: !ended } }));
  await page.route("**/api/apps/apps?mine=true*", route => ended
    ? route.fulfill({ status: 401, json: { error: { code: "signed_out", message: "Your sign-in to the developer site ended at Silicon Accounts." } } })
    : route.fulfill({ json: { items: [], total: 0 } }));
  const visits = trackVisits(page);
  await page.goto("/apps");
  await expect(page.getByRole("heading", { level: 1, name: "Your apps" })).toBeVisible();
  ended = true;
  await page.reload();
  await expect(page).toHaveURL(/\/sign-in\?return_to=%2Fapps$/);
  await expect(page.getByRole("link", { name: /Continue with Silicon Accounts/ })).toBeVisible();
  await page.waitForTimeout(3_000);
  expect(visits.filter(path => path === "/sign-in")).toHaveLength(1);
  expect(visits.at(-1)).toBe("/sign-in");
});

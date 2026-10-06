/**
 * Screens and checks of CLI device approval (/device). Screens are picked up by scripts/screens.ts; the checks run
 * with the hosted pages' checks (src/pages/auth/screens.ts, run directly). The signed-in Carbon is the mock's
 * c:saket; the device requests below are samples.
 */
import { expect } from "@playwright/test";
import type { MockRoute, ScreenSpec } from "../../../scripts/screens-types";
import type { MockCheck } from "../auth/screens";

const minutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();

/** WDJB-MJHT is waiting; EXPD-0000 expired; USED-0000 was used. */
export const deviceRoutes: MockRoute[] = [
  ["GET /v1/device/:code", ({ params }) => {
    const code = params.code ?? "";
    const status = code.startsWith("EXPD") ? "expired" : code.startsWith("USED") ? "consumed" : "pending";
    return { json: { user_code: code, client_label: "accounts CLI on saket-mbp", created_at: minutes(-1), expires_at: minutes(status === "expired" ? -2 : 9), status } };
  }],
  ["POST /v1/device/:code/approve", () => ({ status: 204 })],
  ["POST /v1/device/:code/deny", () => ({ status: 204 })],
];

export const screens: ScreenSpec[] = [
  { name: "device-enter", path: "/device", routes: deviceRoutes, waitFor: 'main[data-fonts="ready"]' },
  { name: "device-review", path: "/device?code=WDJB-MJHT", routes: deviceRoutes, waitFor: "text=Approve this sign-in?" },
  {
    name: "device-approved",
    path: "/device?code=WDJB-MJHT",
    routes: deviceRoutes,
    waitFor: "text=Approve this sign-in?",
    prepare: async page => {
      await page.getByRole("button", { name: "Approve sign-in" }).click();
      await page.waitForSelector("text=Your terminal is signed in");
      await page.waitForTimeout(1200);
    },
  },
  { name: "device-expired", path: "/device?code=EXPD-0000", routes: deviceRoutes, waitFor: "text=This code expired" },
];

const LONG_LABEL = "accounts CLI on a review laptop with a long hostname (build-agent-17.ci.example.internal, macOS 27, arm64)";

/** Interaction checks of /device (mock API). */
export const checks: MockCheck[] = [
  {
    name: "device: only this page's own approval says the terminal is signed in as this Carbon",
    path: "/device?code=WDJB-MJHT",
    as: "carbon",
    routes: [
      ...deviceRoutes,
      ["GET /v1/device/:code", ({ params }) => ({ json: { user_code: params.code, client_label: "accounts CLI on saket-mbp", created_at: minutes(-2), expires_at: minutes(8), status: "approved" } })],
    ],
    run: async ({ page }) => {
      await expect(page.getByRole("heading", { level: 1, name: "This sign-in was already approved" })).toBeVisible();
      await expect(page.getByText("Your terminal is signed in")).toHaveCount(0);
      await expect(page.getByText("c:saket", { exact: true })).toHaveCount(0);
    },
  },
  {
    name: "device: a consumed code says it was used, without guessing who used it",
    path: "/device?code=USED-0000",
    as: "carbon",
    routes: deviceRoutes,
    run: async ({ page }) => {
      await expect(page.getByRole("heading", { level: 1, name: "This code was already used" })).toBeVisible();
      await expect(page.getByText(/each code works once/)).toBeVisible();
      await expect(page.getByText("Someone already answered")).toHaveCount(0);
    },
  },
  {
    name: "device: the whole client label is readable before approving; approving names the account",
    path: "/device?code=WDJB-MJHT",
    as: "carbon",
    width: 390,
    routes: [
      ...deviceRoutes,
      ["GET /v1/device/:code", ({ params }) => ({ json: { user_code: params.code, client_label: LONG_LABEL, created_at: minutes(-1), expires_at: minutes(9), status: "pending" } })],
    ],
    run: async ({ page }) => {
      await expect(page.getByRole("heading", { level: 1, name: "Approve this sign-in?" })).toBeVisible();
      const label = page.locator("dd").filter({ hasText: "accounts CLI on a review laptop" });
      await expect(label).toHaveText(LONG_LABEL);
      // Wrapped, not cut off: nothing hides overflow, no ellipsis, more than one line, and all of it inside the card.
      const shown = await label.evaluate(el => {
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const card = el.closest("main")?.getBoundingClientRect();
        return { overflow: style.overflowX, ellipsis: style.textOverflow, height: box.height, inside: !!card && box.left >= card.left && box.right <= card.right };
      });
      expect(shown.overflow).toBe("visible");
      expect(shown.ellipsis).not.toBe("ellipsis");
      expect(shown.height).toBeGreaterThan(30);
      expect(shown.inside).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.getByRole("button", { name: "Approve sign-in" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Your terminal is signed in" })).toBeVisible();
      await expect(page.getByText("c:saket", { exact: true })).toBeVisible();
    },
  },
];

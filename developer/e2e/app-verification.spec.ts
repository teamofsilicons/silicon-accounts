import { expect, test, type Page } from "@playwright/test";
import type { AppProofHistoryEvent, ManagedAppProof } from "../lib/api/types";
import { mock } from "./fixtures";

const app = { app_id: "test-app", name: "A useful app", logo_url: null, logo_dark_url: null, homepage_url: null };
const verification = (proof_id: string, status: ManagedAppProof["status"] = "active"): ManagedAppProof => ({
  proof_id, kind: "app_verification", issuing_app: app, receiving_app: "receiver", user: null, scopes: ["files.write"],
  created_at: "2026-10-01T12:00:00Z", expires_at: "2029-03-19T12:00:00Z", token_expires_at: "2026-10-01T12:30:00Z",
  last_refreshed_at: null, revoked_at: status === "revoked" ? "2026-10-02T12:00:00Z" : null,
  revoke_reason: status === "revoked" ? "revoked_by_owner" : null, status, access_ttl_seconds: 1800,
});
const event = (event_id: string, action: AppProofHistoryEvent["action"], source: AppProofHistoryEvent["token_expiry_source"]): AppProofHistoryEvent => ({
  event_id, action, at: "2026-10-01T12:00:00Z", actor: { kind: "app", id: "test-app" },
  token_expires_at: source ? "2026-10-01T12:30:00Z" : null, token_expiry_source: source,
  details: { access_ttl_seconds: 1800, scopes: ["files.write"] },
});

async function setup(page: Page) {
  await mock(page, true);
  await page.route("**/api/accounts/apps/receiver/public", route => route.fulfill({ json: { app_id: "receiver", name: "Receiving app", logo_url: null } }));
}

test("central history pages retained records and applies issuing-app/status filters on the server", async ({ page }) => {
  await setup(page);
  await page.route("**/api/accounts/me/owned-apps**", route => route.fulfill({ json: { items: [app, { ...app, app_id: "all", name: "All" }], next_cursor: null } }));
  const requests: URL[] = [];
  await page.route("**/api/accounts/me/app-verifications**", route => {
    const url = new URL(route.request().url()); requests.push(url);
    const filtered = url.searchParams.get("status") === "revoked";
    return route.fulfill({ json: { items: [verification(filtered ? "revoked-record" : url.searchParams.has("cursor") ? "older-record" : "newest-record", filtered ? "revoked" : url.searchParams.has("cursor") ? "expired" : "active")], next_cursor: filtered || url.searchParams.has("cursor") ? null : "older-page" } });
  });
  await page.goto("/app-verification");
  await expect(page.getByRole("heading", { name: "App verification", exact: true })).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Verification newest-record" })).toBeVisible();
  await page.getByRole("button", { name: "Load more verifications" }).click();
  await expect(page.getByRole("listitem", { name: "Verification older-record" })).toBeVisible();
  await expect(page.getByText("2 verifications shown.")).toBeVisible();
  expect(requests.some(url => url.searchParams.get("cursor") === "older-page")).toBe(true);
  await page.getByRole("combobox", { name: "Issuing app" }).click();
  await page.getByRole("option", { name: "A useful app · test-app" }).click();
  await page.getByRole("combobox", { name: "Status", exact: true }).click();
  await page.getByRole("option", { name: "Revoked", exact: true }).click();
  await expect(page).toHaveURL(/app_id=test-app&status=revoked/);
  await expect(page.getByRole("listitem", { name: "Verification revoked-record" })).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Verification older-record" })).toHaveCount(0);
  expect(requests.at(-1)?.searchParams.get("app_id")).toBe("test-app");
  expect(requests.at(-1)?.searchParams.has("cursor")).toBe(false);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/app-verification$/);
  await page.getByRole("combobox", { name: "Issuing app" }).click();
  await page.getByRole("option", { name: "All · all", exact: true }).click();
  await expect(page).toHaveURL(/app_id=all$/);
  await expect.poll(() => requests.at(-1)?.searchParams.get("app_id")).toBe("all");
});

test("history loads only when expanded and distinguishes recorded, derived and unavailable expiry", async ({ page }) => {
  await setup(page);
  let historyCalls = 0;
  await page.route("**/api/accounts/me/app-verifications**", route => route.fulfill({ json: { items: [{ ...verification("history-record"), token_expires_at: null }], next_cursor: null } }));
  await page.route("**/api/accounts/apps/test-app/proofs/history-record/history**", route => {
    historyCalls++;
    const more = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({ json: { items: more ? [event("issued-old", "proof.issued", null)] : [event("refresh-new", "proof.refreshed", "recorded"), event("refresh-old", "proof.refreshed", "derived")], next_cursor: more ? null : "event-page" } });
  });
  await page.goto("/app-verification");
  await expect(page.getByText("No longer retained")).toBeVisible();
  expect(historyCalls).toBe(0);
  const toggle = page.getByRole("button", { name: "View history" });
  await toggle.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Hide history" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Recorded at issuance")).toBeVisible();
  await expect(page.getByText("Derived from event time and recorded lifetime")).toBeVisible();
  await page.getByRole("button", { name: "Load more history" }).click();
  await expect(page.getByText("Token expiry: Unavailable")).toBeVisible();
  await expect(page.getByText("Verification issued", { exact: true })).toBeVisible();
  await expect(page.getByText(/cannot be retrieved here/)).toBeVisible();
  await page.getByRole("button", { name: "Hide history" }).click();
  await expect(page.getByRole("heading", { name: "Issuance and token history" })).toHaveCount(0);
});

test("revocation refreshes the central record and its expanded history", async ({ page }) => {
  await setup(page);
  let revoked = false;
  await page.route("**/api/accounts/me/app-verifications**", route => route.fulfill({ json: { items: [verification("revoke-record", revoked ? "revoked" : "active")], next_cursor: null } }));
  await page.route("**/api/accounts/apps/test-app/proofs/revoke-record/history**", route => route.fulfill({ json: { items: [event(revoked ? "revocation" : "issuance", revoked ? "proof.revoked" : "proof.issued", null)], next_cursor: null } }));
  await page.route("**/api/accounts/apps/test-app/proofs/revoke-record", route => { expect(route.request().method()).toBe("DELETE"); revoked = true; return route.fulfill({ status: 204 }); });
  await page.goto("/app-verification");
  const row = page.getByRole("listitem", { name: "Verification revoke-record" });
  await row.getByRole("button", { name: "View history" }).click();
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(row.getByRole("group", { name: "Revoke this verification?" })).toBeVisible();
  await row.getByRole("group", { name: "Revoke this verification?" }).getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(row.getByText("Verification revoked", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
  expect(revoked).toBe(true);
});

test("revoking the last active result returns keyboard focus to the page heading", async ({ page }) => {
  await setup(page);
  let revoked = false;
  await page.route("**/api/accounts/me/app-verifications**", route => route.fulfill({ json: { items: revoked ? [] : [verification("last-active")], next_cursor: null } }));
  await page.route("**/api/accounts/apps/test-app/proofs/last-active", route => { revoked = true; return route.fulfill({ status: 204 }); });
  await page.goto("/app-verification?status=active");
  await page.getByRole("button", { name: "Revoke", exact: true }).focus();
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("group", { name: "Revoke this verification?" }).getByRole("button", { name: "Revoke", exact: true });
  await confirm.focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("No app verifications match")).toBeVisible();
  await expect(page.locator("#app-verification-heading")).toBeFocused();
});

test("listing and history failures stay visible and recover independently", async ({ page }) => {
  await setup(page);
  let listFails = true; let historyFails = true;
  await page.route("**/api/accounts/me/app-verifications**", route => listFails ? route.fulfill({ status: 404, json: { error: { code: "not_found", message: "No managed app with this ID.", hint: "Choose an app you manage." } } }) : route.fulfill({ json: { items: [verification("recover-record")], next_cursor: null } }));
  await page.route("**/api/accounts/apps/test-app/proofs/recover-record/history**", route => historyFails ? route.fulfill({ status: 429, json: { error: { code: "rate_limited", message: "History is temporarily rate limited." } } }) : route.fulfill({ json: { items: [event("recovered", "proof.issued", "recorded")], next_cursor: null } }));
  await page.goto("/app-verification?app_id=missing");
  await expect(page.getByText("No managed app with this ID.", { exact: false })).toBeVisible();
  await expect(page.getByText("No app verifications match")).toHaveCount(0);
  listFails = false; await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("button", { name: "View history" }).click();
  await expect(page.getByText("History is temporarily rate limited.")).toBeVisible();
  await expect(page.getByRole("listitem", { name: "Verification recover-record" })).toBeVisible();
  historyFails = false; await page.getByRole("button", { name: "Try history again" }).click();
  await expect(page.getByText("Recorded at issuance")).toBeVisible();
});

for (const denied of ["list", "history"] as const) test(`a ${denied} denial after revocation hides cached protected data`, async ({ page }) => {
  await setup(page);
  let changed = false;
  const refusal = { status: denied === "list" ? 404 : 403, json: { error: { code: "verification_not_found", message: "This verification is no longer available to this account." } } };
  await page.route("**/api/accounts/me/app-verifications**", route => changed && denied === "list" ? route.fulfill(refusal) : route.fulfill({ json: { items: [verification("private-record")], next_cursor: null } }));
  await page.route("**/api/accounts/apps/test-app/proofs/private-record/history**", route => changed && denied === "history" ? route.fulfill(refusal) : route.fulfill({ json: { items: [event("private-event", "proof.issued", "recorded")], next_cursor: null } }));
  await page.route("**/api/accounts/apps/test-app/proofs/private-record", route => { changed = true; return route.fulfill({ status: 204 }); });
  await page.goto("/app-verification");
  await page.getByRole("button", { name: "View history" }).click();
  await expect(page.getByText("Recorded at issuance")).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("group", { name: "Revoke this verification?" }).getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText("This verification is no longer available to this account.")).toBeVisible();
  await expect(page.getByText("Recorded at issuance")).toHaveCount(0);
  await expect(page.getByText("Verification ID: private-record")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
});

test("per-app verification keeps the old URL, clear kind labels and one-time creation", async ({ page }) => {
  await setup(page);
  let created = false; const kinds: string[] = [];
  await page.route("**/api/accounts/apps/test-app/proofs?**", route => { kinds.push(new URL(route.request().url()).searchParams.get("kind") ?? "all"); return route.fulfill({ json: { items: created ? [verification("created-record")] : [], next_cursor: null } }); });
  await page.route("**/api/accounts/apps/test-app/proofs/app-verification", route => { created = true; expect(route.request().postDataJSON().receiving_app).toBe("receiver"); return route.fulfill({ status: 201, json: { proof_id: "created-record", kind: "app_verification", receiving_app: "receiver", scopes: [], proof_token: "sap_fixture_once", proof_refresh_token: "sapr_fixture_once", expires_at: "2026-10-08T12:30:00Z", refresh_expires_at: "2029-03-19T12:00:00Z" } }); });
  await page.goto("/apps/test-app/app-verification");
  await expect(page.getByRole("tab", { name: "App verification", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("textbox", { name: "The app that receives it" }).fill("receiver");
  await page.getByRole("button", { name: "Choose", exact: true }).click();
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const reveal = page.getByRole("group", { name: "Your verification tokens" });
  await expect(reveal).toBeVisible();
  await reveal.getByRole("button", { name: "Show the verification token", exact: true }).click();
  await expect(reveal.getByText("sap_fixture_once", { exact: true })).toBeVisible();
  await reveal.getByRole("button", { name: "I've stored them" }).click();
  await expect(reveal).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).not.toContain("fixture_once");
  await page.getByRole("button", { name: "User verification", exact: true }).click();
  await expect.poll(() => kinds.at(-1)).toBe("user_verification");
  await expect(page.getByRole("link", { name: "All app verification history" })).toHaveAttribute("href", "/app-verification?app_id=test-app");
});

test("empty history states, command navigation and protected BFF stay scoped", async ({ page, request }) => {
  await setup(page);
  await page.goto("/app-verification?status=expired");
  await expect(page).toHaveTitle("App verification · Silicon Developer");
  await expect(page.getByText("No app verifications match")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText("No app verifications yet")).toBeVisible();
  await page.getByRole("button", { name: /Search and jump/ }).click();
  await page.getByRole("combobox", { name: "Search pages and actions" }).fill("App verification");
  await expect(page.getByRole("option", { name: /App verification/ })).toBeVisible();
  expect((await request.get("/api/accounts/me/app-verifications")).status()).toBe(401);
  expect((await request.post("/api/accounts/me/app-verifications", { data: {} })).status()).toBe(404);
  expect((await request.get("/api/accounts/me/app-verifications/other")).status()).toBe(404);
});

for (const width of [320, 768, 1024, 1440]) test(`verification history fits ${width}px with expanded events`, async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.route("**/api/accounts/me/app-verifications**", route => route.fulfill({ json: { items: [verification("fdd79346-bf74-4a95-9bd2-06576b1d8856")], next_cursor: null } }));
  await page.route("**/api/accounts/apps/test-app/proofs/*/history**", route => route.fulfill({ json: { items: [event("refresh", "proof.refreshed", "derived")], next_cursor: null } }));
  await page.goto("/app-verification");
  await page.getByRole("button", { name: "View history" }).click();
  await expect(page.getByText("Derived from event time and recorded lifetime")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  if (width === 320 || width === 1440) {
    await page.screenshot({ path: `/tmp/silicon-app-verification-${width}-dark.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    await page.screenshot({ path: `/tmp/silicon-app-verification-${width}-light.png`, fullPage: true });
  }
});

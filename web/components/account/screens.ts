/**
 * Screens of the account pages, picked up by scripts/screens.ts and answered by the mock API (scripts/mock/): the
 * identity card and its editors, sign-in methods (adding an email up to the code), apps, proofs, Silicons (the
 * request deck, the create drawer and a Silicon's drawer section by section), activity and settings, long names and
 * ids, plus empty pages.
 *
 *   pnpm screens --only account-                  everything here
 *   pnpm screens --only account-silicons --widths 390 --themes dark
 *   SCREENS_ERRORS=1 pnpm screens --only account-error --allow-errors
 *       pages whose API answers are errors (Chromium logs every failed fetch as a console error)
 *
 * The live interaction checks (a real code, a real STK rotation) ran against the API; these are for looking.
 */
import { expect, type Page } from "@playwright/test";
import type { AccountSummary, CustodianRequest, MyProof } from "../../lib/api/types";
import * as data from "../../scripts/mock/fixtures";
import type { MockReply, MockRoute, ScreenSpec } from "../../scripts/screens-types";

const fromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const error = (status: number, code: string, message: string, hint: string): MockReply => ({ status, json: { error: { code, message, hint } } });

/** The accounts the samples mention, for GET /v1/accounts/{uuid}. */
const accounts: AccountSummary[] = [
  data.carbonSummary,
  { uuid: "Sh7", kind: "carbon", id: "c:shubham", display_name: "Shubham", pfp_url: data.portrait("Shubham", 300), status: "active" },
  ...data.silicons.map(({ uuid, kind, id, display_name, pfp_url, status }) => ({ uuid, kind, id, display_name, pfp_url, status })),
];

/** Proofs whose times follow the clock, so the expiry ring shows minutes left whenever the screens run. */
const proofs = (): MyProof[] => data.proofs.map(proof => (proof.status === "active"
  ? { ...proof, created_at: fromNow(-30), last_refreshed_at: fromNow(-4), expires_at: fromNow(60 * 24 * 30), token_expires_at: fromNow(11) }
  : { ...proof, created_at: fromNow(-60 * 5), revoked_at: fromNow(-60 * 4), expires_at: fromNow(-60 * 4) }));

const requests = (): CustodianRequest[] => data.custodianRequests.map(request => ({ ...request, created_at: fromNow(-45), expires_at: fromNow(60 * 24 * 14 - 45) }));

/** What every account screen needs beyond the defaults: list pages for contacts, account lookups and adding an email. */
const accountRoutes: MockRoute[] = [
  ["GET /v1/me/emails", () => ({ json: data.page(data.carbon.emails.map(email => ({ ...email, created_at: email.verified_at }))) })],
  ["GET /v1/me/phones", () => ({ json: data.page(data.carbon.phones.map(phone => ({ ...phone, verified_via: "code", created_at: phone.verified_at }))) })],
  ["GET /v1/me/identities", () => ({ json: data.page(data.carbon.identities) })],
  ["GET /v1/me/proofs", () => ({ json: data.page(proofs()) })],
  ["GET /v1/me/custodian-requests", () => ({ json: data.page(requests()) })],
  ["GET /v1/accounts/:uuid", ({ params }) => {
    const found = accounts.find(account => account.uuid === params.uuid);
    return found ? { json: found } : error(404, "account_not_found", `No account with uuid '${params.uuid}' exists.`, "Check the uuid.");
  }],
  ["POST /v1/me/emails", ({ body }) => {
    const email = String((body as { email?: unknown } | null)?.email ?? "");
    const [name = "", domain = ""] = email.split("@");
    return { status: 201, json: { challenge_id: "0192a6f0-0000-7000-8000-0000000000d1", channel: "email", destination: `${name.slice(0, 1)}***@${domain}`, expires_at: fromNow(10), resend_available_at: fromNow(0.5) } };
  }],
];

const empty: MockRoute[] = [
  ["GET /v1/me/apps", () => ({ json: data.page([]) })],
  ["GET /v1/me/proofs", () => ({ json: data.page([]) })],
  ["GET /v1/me/silicons", () => ({ json: data.page([]) })],
  ["GET /v1/me/custodian-requests", () => ({ json: data.page([]) })],
  ["GET /v1/me/history", () => ({ json: data.page([]) })],
  ["GET /v1/me", () => ({ json: { ...data.carbon, custodian_of: 0 } })],
];

const longName = "Hubert Blaine Wolfeschlegelsteinhausenbergerdorff Senior of the Long Names Society of Accounts";
const longSilicon = { ...data.silicons[0], uuid: "Lng", id: "si:a_very_long_silicon_handle_x30", display_name: "Head of Strategic Partnerships and Growth", pending_transfer: null };

const click = async (page: Page, name: string | RegExp) => { await page.getByRole("button", { name }).first().click(); };
const wait = (page: Page, ms = 700) => page.waitForTimeout(ms);
const drawer = "[role='dialog']";

async function openSilicon(page: Page, id: string) {
  await page.getByRole("button", { name: new RegExp(`^Manage ${id}`) }).click();
  await page.waitForSelector(drawer);
  await wait(page, 900);
}

async function drawerTo(page: Page, heading: string) {
  await page.locator(drawer).getByRole("heading", { name: heading, exact: true }).scrollIntoViewIfNeeded();
  await wait(page, 400);
}

const card = "[data-identity-card]";

const shown: ScreenSpec[] = [
  // Identity: the card, its back, the photo menu, the editors and the id dialog with a taken id.
  { name: "account-identity", path: "/", waitFor: card },
  { name: "account-identity-details", path: "/", waitFor: card, prepare: async page => { await click(page, "Details"); await wait(page, 1200); } },
  { name: "account-identity-photo", path: "/", waitFor: card, fullPage: false, prepare: async page => { await click(page, "Change your photo"); await wait(page); } },
  { name: "account-identity-timezone", path: "/", waitFor: card, fullPage: false, prepare: async page => { await click(page, "Change your timezone"); await wait(page); } },
  { name: "account-identity-dob", path: "/", waitFor: card, fullPage: false, prepare: async page => { await click(page, "Details"); await wait(page, 1200); await click(page, "Change your date of birth"); await wait(page); } },
  { name: "account-identity-change-id", path: "/", waitFor: card, fullPage: false, prepare: async page => { await click(page, "Change id"); await wait(page); await page.keyboard.type("shubham"); await wait(page, 1200); } },

  // Sign-in methods: the lists, adding an email up to the code, and the remove question.
  { name: "account-sign-in-methods", path: "/sign-in-methods" },
  { name: "account-sign-in-methods-add", path: "/sign-in-methods", prepare: async page => {
    await click(page, "Add an email");
    await wait(page);
    await page.getByLabel("Email address").fill("night.shift@example.com");
    await click(page, "Send code");
    await page.getByText("Enter the 6-digit code").waitFor();
    await wait(page, 900);
  } },
  { name: "account-sign-in-methods-remove", path: "/sign-in-methods", prepare: async page => { await page.getByRole("button", { name: "Remove", exact: true }).nth(1).click(); await wait(page, 600); } },

  // Apps: with access, the remove question, the removed ones.
  { name: "account-apps", path: "/apps" },
  { name: "account-apps-remove", path: "/apps", prepare: async page => { await click(page, "Remove access"); await wait(page, 600); } },
  { name: "account-apps-removed", path: "/apps", prepare: async page => { await click(page, /^Access removed/); await wait(page, 900); } },

  // Proofs: the active one with its ring, the revoke question, the ended ones.
  { name: "account-proofs", path: "/proofs", prepare: async page => {
    await expect(page.getByRole("heading", { name: "User verification", exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Active verifications", exact: true })).toBeVisible();
    await expect(page).toHaveTitle(/User verification/);
  } },
  { name: "account-proofs-revoke", path: "/proofs", prepare: async page => { await click(page, "Revoke"); await wait(page, 600); } },
  { name: "account-proofs-ended", path: "/proofs", prepare: async page => { await click(page, /^Ended/); await wait(page, 900); } },

  // Silicons: the deck and tiles, the create drawer, a Silicon's drawer section by section.
  { name: "account-silicons", path: "/silicons" },
  { name: "account-silicons-create", path: "/silicons", fullPage: false, prepare: async page => {
    await page.locator("[data-create-silicon]").click();
    await page.waitForSelector(drawer);
    await wait(page, 600);
    await page.getByLabel("Display name").fill("Night Shift");
    await wait(page, 1200);
  } },
  { name: "account-silicons-drawer", path: "/silicons", fullPage: false, prepare: async page => { await openSilicon(page, "si:scout"); } },
  { name: "account-silicons-drawer-stk", path: "/silicons", fullPage: false, prepare: async page => { await openSilicon(page, "si:scout"); await drawerTo(page, "STK"); } },
  { name: "account-silicons-drawer-webhook", path: "/silicons", fullPage: false, prepare: async page => { await openSilicon(page, "si:scout"); await drawerTo(page, "Webhook"); } },
  { name: "account-silicons-drawer-transfer", path: "/silicons", fullPage: false, prepare: async page => { await openSilicon(page, "si:head_of_growth"); await drawerTo(page, "Custodian"); } },
  { name: "account-silicons-drawer-delete", path: "/silicons", fullPage: false, prepare: async page => { await openSilicon(page, "si:scout"); await drawerTo(page, "Delete this Silicon"); } },
  { name: "account-silicons-drawer-change-id", path: "/silicons", fullPage: false, prepare: async page => { await openSilicon(page, "si:head_of_growth"); await click(page, "Change its id"); await wait(page, 600); await page.keyboard.type("scout"); await wait(page, 1300); } },

  // Activity: the timeline and an opened row.
  { name: "account-activity", path: "/activity" },
  { name: "account-activity-open", path: "/activity", prepare: async page => { await page.locator("[data-timeline-trigger]").first().click(); await wait(page, 900); } },

  // Settings: theme, telemetry, sessions, and deleting blocked by the Silicons in your care; then free to delete.
  { name: "account-settings", path: "/settings" },
  { name: "account-settings-signout", path: "/settings", prepare: async page => { await page.getByRole("button", { name: "Sign out", exact: true }).nth(1).click(); await wait(page, 600); } },
  { name: "account-settings-deletable", path: "/settings", routes: [["GET /v1/me/silicons", () => ({ json: data.page([]) })], ["GET /v1/me", () => ({ json: { ...data.carbon, custodian_of: 0 } })]] },

  // Long values: a 94-character display name wraps on the card; a 30-character si:id and a long name wrap on a tile.
  { name: "account-identity-long-name", path: "/", waitFor: card, routes: [["GET /v1/me", () => ({ json: { ...data.carbon, display_name: longName } })]] },
  { name: "account-silicons-long", path: "/silicons", routes: [["GET /v1/me/silicons", () => ({ json: data.page([...data.silicons, longSilicon]) })]] },

  // A Carbon with nothing yet.
  ...["apps", "proofs", "silicons", "activity"].map((path): ScreenSpec => ({ name: `account-empty-${path}`, path: `/${path}`, routes: empty })),
];

/** Pages whose lists fail to load: only with SCREENS_ERRORS=1 (and --allow-errors), since every failed fetch logs. */
const failing: MockRoute[] = ["apps", "proofs", "silicons", "custodian-requests", "history", "sessions"]
  .map((path): MockRoute => [`GET /v1/me/${path}`, () => error(503, "unavailable", "Silicon Accounts could not read this right now.", "Try again in a moment.")]);
// Queries retry a 5xx twice (lib/query/client.ts), so the error shows after about two seconds.
const errors: ScreenSpec[] = [
  ...["identity", "apps", "proofs", "silicons", "activity", "settings"]
    .map(page => ({ name: `account-error-${page}`, path: page === "identity" ? "/" : `/${page}`, routes: failing, settle: 4500 })),
  // GET /v1/meta failing: connecting Google or Apple says so, with Try again.
  { name: "account-error-sign-in-methods-meta", path: "/sign-in-methods", routes: [["GET /v1/meta", () => error(503, "unavailable", "Silicon Accounts is restarting.", "Try again in a moment.")]], settle: 4500 },
];

export const screens: ScreenSpec[] = [...shown, ...(process.env.SCREENS_ERRORS ? errors : [])]
  .map(spec => ({ ...spec, routes: [...accountRoutes, ...(spec.routes ?? [])] }));

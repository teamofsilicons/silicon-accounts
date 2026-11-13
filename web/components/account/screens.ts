/**
 * Screens of the account pages, picked up by scripts/screens.ts and answered by the mock API (scripts/mock/): the
 * Personal info and its editors, sign-in methods (adding an email up to the code), apps, proofs, Silicons (the
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
const openSecurityPhone = async (page: Page) => {
  await page.getByText("Text code", { exact: true }).locator("xpath=ancestor::li").getByRole("link").click();
  const add = page.getByRole("button", { name: "Add a Phone Number" });
  if (await add.isVisible()) await add.click();
  await page.getByRole("textbox", { name: "Phone number" }).waitFor();
};
/** A Silicon's panel: the side column from 1024px (SidePanel), the bottom drawer under it. */
const drawer = "[role='dialog'], [data-side-panel][data-open]";

async function openSilicon(page: Page, id: string) {
  await page.getByRole("button", { name: new RegExp(`^Manage ${id}`) }).click();
  await page.waitForSelector(drawer);
  await wait(page, 900);
}

async function drawerTo(page: Page, heading: string) {
  await page.locator(drawer).getByRole("heading", { name: heading, exact: true }).scrollIntoViewIfNeeded();
  await wait(page, 400);
}

/** Personal info is ready when its Profile card is. */
const card = "#personal-profile";

const shown: ScreenSpec[] = [
  // Home: needs you with a custodian request, then all clear with the introduction dismissed.
  { name: "account-home", path: "/", waitFor: "[data-home]" },
  { name: "account-font-lab", path: "/personal", waitFor: card, fullPage: false, prepare: async page => {
    const openLab = async () => {
      await page.getByRole("button", { name: /^Dev tools/ }).click();
      await page.getByText("Font lab", { exact: true }).locator("..").getByRole("button", { name: "Open" }).click();
    };
    await openLab();
    let lab = page.locator('aside[aria-label="Font lab"]');
    const fonts = () => lab.getByRole("combobox", { name: "Font" });
    await fonts().first().click();
    await page.getByRole("option", { name: "Hanken Grotesk" }).click();
    await fonts().last().click();
    await page.getByRole("option", { name: "Inter" }).click();
    const text = lab.getByRole("region", { name: "Text" });
    await text.getByRole("slider", { name: "Text size" }).press("ArrowRight");
    await text.getByRole("slider", { name: "Weight" }).press("ArrowRight");
    await text.getByRole("slider", { name: "Letter spacing" }).press("ArrowRight");
    await text.getByRole("slider", { name: "Line height" }).press("ArrowRight");
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("17px");
    await expect.poll(() => page.evaluate(() => {
      const style = getComputedStyle(document.body), size = parseFloat(style.fontSize);
      return [Number(style.fontWeight), Number((parseFloat(style.letterSpacing) / size).toFixed(3)), Number((parseFloat(style.lineHeight) / size).toFixed(2))];
    })).toEqual([410, 0.005, 1.55]);
    await expect.poll(() => page.evaluate(() => document.head.querySelector('style[data-dev-style="2-font-lab"]')?.textContent ?? "")).toContain("--body: 410 17px/1.55 var(--font-body)");
    await expect.poll(() => page.evaluate(() => document.head.querySelector('style[data-dev-style="2-font-lab"]')?.textContent ?? "")).toContain("--body-tracking: 0.005em");
    let link = lab.getByRole("checkbox", { name: "Use same font for display and body" });
    await link.click();
    await expect(link).toHaveAttribute("aria-checked", "true");
    await expect(fonts().last()).toBeDisabled();
    await expect(text.getByRole("slider", { name: "Text size" })).toBeEnabled();
    await expect(fonts().last()).toContainText("Hanken Grotesk");
    await expect.poll(() => page.evaluate(() => document.head.querySelector('style[data-dev-style="2-font-lab"]')?.textContent ?? "")).toContain("--font-body: var(--font-hanken-grotesk)");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await lab.getByRole("button", { name: "Copy CSS" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("--font-display: var(--font-hanken-grotesk)");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("--body: 410 17px/1.55 var(--font-body)");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(card);
    await openLab();
    lab = page.locator('aside[aria-label="Font lab"]');
    link = lab.getByRole("checkbox", { name: "Use same font for display and body" });
    await expect(link).toHaveAttribute("aria-checked", "true");
    await expect(fonts().last()).toBeDisabled();
    const savedText = lab.getByRole("region", { name: "Text" });
    await expect(savedText.getByRole("slider", { name: "Text size" })).toHaveAttribute("aria-valuenow", "17");
    await expect(savedText.getByRole("slider", { name: "Weight" })).toHaveAttribute("aria-valuenow", "410");
    await expect(savedText.getByRole("slider", { name: "Letter spacing" })).toHaveAttribute("aria-valuenow", "0.005");
    await expect(savedText.getByRole("slider", { name: "Line height" })).toHaveAttribute("aria-valuenow", "1.55");
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("17px");
    await link.click();
    await expect(fonts().last()).toBeEnabled();
    await expect(fonts().last()).toContainText("Inter");
    await lab.getByRole("button", { name: "Reset", exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("accounts.dev.font-lab"))).toBeNull();
    await expect(lab.getByRole("region", { name: "Text" }).getByRole("slider", { name: "Text size" })).toHaveAttribute("aria-valuenow", "16");
    await expect(savedText.getByRole("slider", { name: "Weight" })).toHaveAttribute("aria-valuenow", "400");
    await expect(savedText.getByRole("slider", { name: "Letter spacing" })).toHaveAttribute("aria-valuenow", "0");
    await expect(savedText.getByRole("slider", { name: "Line height" })).toHaveAttribute("aria-valuenow", "1.5");
    await fonts().first().click();
    await page.getByRole("option", { name: "Hanken Grotesk" }).click();
    await link.click();
    await expect(fonts().last()).toBeDisabled();
    await lab.getByRole("region", { name: "Text" }).getByRole("slider", { name: "Line height" }).scrollIntoViewIfNeeded();
  } },
  { name: "account-home-review", path: "/", waitFor: "[data-home]", fullPage: false, prepare: async page => { await click(page, "Review"); await wait(page, 900); } },
  { name: "account-home-new", path: "/", waitFor: "[data-home]", routes: [["GET /v1/me/custodian-requests", () => ({ json: data.page([]) })], ["GET /v1/me/silicons", () => ({ json: data.page([]) })], ["GET /v1/me/apps", () => ({ json: data.page([]) })], ["GET /v1/me", () => ({ json: { ...data.carbon, phones: [], custodian_of: 0 } })]] },
  { name: "account-home-clear", path: "/", waitFor: "[data-home]", routes: [["GET /v1/me/custodian-requests", () => ({ json: data.page([]) })]], prepare: async page => { await click(page, "Dismiss"); await wait(page, 400); } },
  // Identity: the card, its back, the photo menu, the editors and the id dialog with a taken id.
  { name: "account-identity", path: "/personal", waitFor: card },
  { name: "account-identity-name", path: "/personal?edit=name", waitFor: "[role='dialog']", fullPage: false, prepare: async page => { await wait(page); } },
  { name: "account-identity-photo", path: "/personal?edit=photo", waitFor: "[role='dialog']", fullPage: false, prepare: async page => { await wait(page); } },
  { name: "account-identity-timezone", path: "/personal?edit=timezone", waitFor: "[role='dialog']", fullPage: false, prepare: async page => { await wait(page); } },
  { name: "account-identity-dob", path: "/personal?edit=dob", waitFor: "[role='dialog']", fullPage: false, prepare: async page => { await wait(page); } },
  { name: "account-identity-year-select", path: "/personal?edit=dob", waitFor: "[role='dialog']", fullPage: false, prepare: async page => {
    await page.getByRole("combobox", { name: "Year" }).click();
    await page.getByRole("option", { name: "1998", exact: true }).press("End");
    const alignment = (year: string) => page.evaluate(expected => {
      const viewport = document.querySelector<HTMLElement>("[data-radix-select-viewport]");
      const item = viewport?.querySelector<HTMLElement>("[role='option'][data-highlighted]");
      const highlight = viewport?.querySelector<HTMLElement>("span[aria-hidden='true']");
      if (!viewport || !item || !highlight || item.textContent !== expected || viewport.scrollTop === 0) return Infinity;
      const a = item.getBoundingClientRect(), b = highlight.getBoundingClientRect();
      return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height));
    }, year);
    await expect.poll(() => alignment("1900")).toBeLessThan(1);
    const next = await page.getByRole("option", { name: "1901", exact: true }).boundingBox();
    if (!next) throw new Error("Year 1901 is not visible after scrolling");
    await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2);
    await expect.poll(() => alignment("1901")).toBeLessThan(1);
  } },
  { name: "account-identity-change-id", path: "/personal?edit=id", waitFor: "[role='dialog']", fullPage: false, prepare: async page => { await wait(page); await page.keyboard.type("shubham"); await wait(page, 1200); } },

  // Sign-in methods: the lists, adding an email up to the code, and the remove question.
  { name: "account-sign-in-methods", path: "/sign-in-methods" },
  { name: "account-security-phone-dialog", path: "/sign-in-methods", fullPage: false, prepare: async page => {
    await openSecurityPhone(page);
    await wait(page, 600);
  } },
  { name: "account-security-country-picker", path: "/sign-in-methods", fullPage: false, prepare: async page => {
    await openSecurityPhone(page);
    await page.getByRole("button", { name: /^Country,/ }).click();
    await page.getByRole("listbox", { name: "Countries" }).waitFor();
    await wait(page, 800);
    const geometry = await page.getByRole("listbox", { name: "Countries" }).evaluate(node => {
      const field = node.closest("[data-open]") as HTMLElement;
      const shape = field.querySelector('[class*="shape"]') as HTMLElement;
      const control = field.querySelector('input[type="tel"]')!.parentElement!.parentElement as HTMLElement;
      const scroll = node.parentElement as HTMLElement;
      const clip = scroll.getBoundingClientRect();
      const first = [...node.querySelectorAll('[role="option"]')].find(option => option.getBoundingClientRect().bottom > clip.top) as HTMLElement;
      const rect = shape.getBoundingClientRect();
      return {
        hit: shape.contains(document.elementFromPoint(rect.left + 20, rect.bottom - 12)),
        bottom: rect.bottom,
        viewportBottom: window.innerHeight,
        radius: getComputedStyle(shape).borderTopLeftRadius,
        controlRadius: getComputedStyle(control).borderTopLeftRadius,
        firstTop: first.getBoundingClientRect().top,
        scrollTop: clip.top,
      };
    });
    expect(geometry.hit).toBe(true);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportBottom);
    expect(geometry.radius).toBe(geometry.controlRadius);
    expect(geometry.firstTop).toBeGreaterThanOrEqual(geometry.scrollTop - 1);
  } },
  { name: "account-security-country-choice", path: "/sign-in-methods", fullPage: false, prepare: async page => {
    await openSecurityPhone(page);
    await page.getByRole("button", { name: /^Country,/ }).click();
    await page.getByRole("option", { name: /India/ }).click();
    await expect(page.getByRole("button", { name: "Country, India +91" })).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "Country, India +91" }).click();
    const search = page.getByRole("combobox", { name: "Search countries or calling codes" });
    await search.fill("Germany");
    await search.press("Enter");
    await expect(page.getByRole("button", { name: "Country, Germany +49" })).toHaveAttribute("aria-expanded", "false");
  } },
  { name: "account-security-unsupported-phone", path: "/sign-in-methods", fullPage: false, prepare: async page => {
    await openSecurityPhone(page);
    await page.getByRole("textbox", { name: "Phone number" }).fill("+40755345678");
    await page.locator('[data-phone-mode="international"]').waitFor();
    await wait(page, 600);
  } },
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
  { name: "account-app-page", path: "/apps/briefcase" },
  { name: "account-apps-remove", path: "/apps/briefcase", prepare: async page => { await click(page, "Remove"); await wait(page, 600); } },
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
  // A Silicon's Photo dialog: make its avatar (form, colour, eyes, facing, shuffle), or a photo, a link, its default.
  { name: "account-silicon-photo", path: "/silicons/Qz4?tab=settings", fullPage: false, prepare: async page => {
    await page.getByRole("listitem").filter({ hasText: "Photo" }).getByRole("button", { name: "Change" }).click();
    await page.getByRole("dialog", { name: "Photo" }).waitFor();
    await wait(page, 900);
  } },
  { name: "account-silicons-new", path: "/silicons?new", fullPage: false, prepare: async page => { await page.waitForSelector(drawer); await wait(page, 900); } },
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

  // Settings: sessions, and deleting blocked by the Silicons in your care; then free to delete.
  { name: "account-privacy", path: "/privacy" },
  // Sessions are on the Security pillar since 2026-10-17 (components/account/security/sessions.tsx).
  { name: "account-security-signout", path: "/sign-in-methods", prepare: async page => { await page.getByRole("button", { name: "Sign out", exact: true }).nth(1).click(); await wait(page, 600); } },
  { name: "account-privacy-delete", path: "/privacy/delete" },
  { name: "account-privacy-deletable", path: "/privacy/delete", routes: [["GET /v1/me/silicons", () => ({ json: data.page([]) })], ["GET /v1/me", () => ({ json: { ...data.carbon, custodian_of: 0 } })]] },

  // Long values: a 94-character display name wraps on the card; a 30-character si:id and a long name wrap on a tile.
  { name: "account-identity-long-name", path: "/personal", waitFor: card, routes: [["GET /v1/me", () => ({ json: { ...data.carbon, display_name: longName } })]] },
  { name: "account-silicons-long", path: "/silicons", routes: [["GET /v1/me/silicons", () => ({ json: data.page([...data.silicons, longSilicon]) })]] },

  // A Carbon with nothing yet.
  ...["apps", "proofs", "silicons", "activity"].map((path): ScreenSpec => ({ name: `account-empty-${path}`, path: `/${path}`, routes: empty })),
];

/** Pages whose lists fail to load: only with SCREENS_ERRORS=1 (and --allow-errors), since every failed fetch logs. */
const failing: MockRoute[] = ["apps", "proofs", "silicons", "custodian-requests", "history", "sessions"]
  .map((path): MockRoute => [`GET /v1/me/${path}`, () => error(503, "unavailable", "Silicon Accounts could not read this right now.", "Try again in a moment.")]);
// Queries retry a 5xx twice (lib/query/client.ts), so the error shows after about two seconds.
const errors: ScreenSpec[] = [
  ...["identity", "apps", "proofs", "silicons", "activity", "privacy"]
    .map(page => ({ name: `account-error-${page}`, path: page === "identity" ? "/" : `/${page}`, routes: failing, settle: 4500 })),
  // GET /v1/meta failing: connecting Google or Apple says so, with Try again.
  { name: "account-error-sign-in-methods-meta", path: "/sign-in-methods", routes: [["GET /v1/meta", () => error(503, "unavailable", "Silicon Accounts is restarting.", "Try again in a moment.")]], settle: 4500 },
];

export const screens: ScreenSpec[] = [...shown, ...(process.env.SCREENS_ERRORS ? errors : [])]
  .map(spec => ({ ...spec, routes: [...accountRoutes, ...(spec.routes ?? [])] }));

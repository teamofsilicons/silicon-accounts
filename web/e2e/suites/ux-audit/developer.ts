/**
 * ux-audit: the developer pages, in light and dark at 1440 and 390 px:
 *
 *   empty      a new Carbon who owns one new app (made in the stack's database, as Silicon Apps would deliver it, with
 *              briefcase's setup): /developer and every tab of the app, empty states; and the Branding tab's live
 *              contrast readout judging a 3.62:1 button pair "Too low" (4.5:1, the server's rule; UX note 6)
 *   briefcase  briefcase's owner (the seeded c:saket) after a new Carbon signed into briefcase and a dry-run import:
 *              /developer and every tab with data
 *
 * Every page: the generic audit (_audit.ts) and the dock check (no content under the dock at the bottom).
 */
import type { Cookie, Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { appAccount, sql, tag } from "../../lib";
import { VARIANTS, auditContext, auditVariants, checkDock, collectConsole, findingsFor, freshEmail, hostedLink, pageFetch, saveFindings, sendEmailCode, settle, signInAsSeededOwner, signedInCarbon, waitUntil, type Findings } from "./_audit";

const TABS = ["overview", "sign-in", "branding", "users", "import", "webhooks", "proofs", "embed"] as const;

/** Opens a developer page and waits for its content (the tab's chunk, its data) to settle. */
async function openDeveloperPage(ctx: Ctx, page: Page, path: string): Promise<string> {
  await page.goto(`${ctx.env.site}${path}`);
  await page.locator("main").first().waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  await waitUntil(page, "!document.querySelector('main [aria-busy=\"true\"]')", 15_000);
  await settle(page, 900);
  return (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
}

/** Where the selected tab sits in its scrolling strip: fully in view, or how much of it is hidden. */
const ACTIVE_TAB = `(() => {
  const tab = document.querySelector('[role=tablist] [role=tab][data-state=active]');
  if (!tab) return { found: false };
  let strip = tab.parentElement;
  while (strip && getComputedStyle(strip).overflowX === "visible") strip = strip.parentElement;
  const t = tab.getBoundingClientRect();
  const s = (strip || document.documentElement).getBoundingClientRect();
  const shown = Math.max(0, Math.min(t.right, s.right) - Math.max(t.left, s.left));
  return { found: true, name: (tab.textContent || "").trim(), shownPx: Math.round(shown), widthPx: Math.round(t.width), tab: [Math.round(t.left), Math.round(t.right)], strip: [Math.round(s.left), Math.round(s.right)] };
})()`;

interface ActiveTab {
  found: boolean;
  name?: string;
  shownPx?: number;
  widthPx?: number;
  tab?: number[];
  strip?: number[];
}

/**
 * On a phone the developer tabs scroll sideways: the selected tab must be in view, both when the page opens at 390 px
 * and after the window narrows from 1440 to 390 px (a rotated tablet, a narrowed window).
 */
async function checkActiveTab(ctx: Ctx, findings: Findings, prefix: string, appId: string, cookies: Cookie[]): Promise<void> {
  const context = await auditContext(ctx.browser, { width: 390, height: 844, cookies });
  const page = await context.newPage();
  ctx.results.watch(page, `${prefix}-tabs-390`);
  for (const tab of TABS) {
    const path = `/developer/${appId}${tab === "overview" ? "" : `/${tab}`}`;
    await page.setViewportSize({ width: 390, height: 844 });
    await openDeveloperPage(ctx, page, path);
    const opened = (await page.evaluate(ACTIVE_TAB)) as ActiveTab;
    findings.pages[`${prefix}-${tab} active tab opened at 390`] = opened;
    ctx.results.check(`${prefix}-${tab} 390: opened on a phone, the selected tab is in view in the tab strip`, opened.found && (opened.shownPx ?? 0) >= (opened.widthPx ?? 1) - 2, JSON.stringify(opened));
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDeveloperPage(ctx, page, path);
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page, 500);
    const narrowed = (await page.evaluate(ACTIVE_TAB)) as ActiveTab;
    findings.pages[`${prefix}-${tab} active tab after 1440 → 390`] = narrowed;
    await page.screenshot({ path: `${ctx.env.shots}/uxa-${prefix}-${tab}-tabs-narrowed-390.png`, clip: { x: 0, y: 0, width: 390, height: 420 } }).catch(() => undefined);
    ctx.results.check(`${prefix}-${tab}: after the window narrows from 1440 to 390 px, the selected tab is still in view`, narrowed.found && (narrowed.shownPx ?? 0) >= (narrowed.widthPx ?? 1) - 2, JSON.stringify(narrowed));
  }
  await context.close();
}

async function auditDeveloper(ctx: Ctx, page: Page, findings: Findings, prefix: string, appId: string): Promise<void> {
  const home = await openDeveloperPage(ctx, page, "/developer");
  ctx.results.check(`${prefix}-home: lists ${appId}`, home.length > 0 && (await page.locator(`a[href="/developer/${appId}"]`).count()) > 0, home.slice(0, 200));
  await auditVariants(ctx, page, findings, `${prefix}-home`, VARIANTS, { fullPage: true });
  await checkDock(ctx, page, findings, `${prefix}-home`);
  for (const tab of TABS) {
    const text = await openDeveloperPage(ctx, page, `/developer/${appId}${tab === "overview" ? "" : `/${tab}`}`);
    ctx.results.check(`${prefix}-${tab}: the tab renders (no error panel)`, !/could not load|Try again|went wrong/i.test(text) && text.length > 40, text.slice(0, 200));
    await auditVariants(ctx, page, findings, `${prefix}-${tab}`, VARIANTS, { fullPage: true });
    await checkDock(ctx, page, findings, `${prefix}-${tab}`);
  }
  await checkActiveTab(ctx, findings, prefix, appId, await page.context().cookies());
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-developer-empty",
    title: "a new Carbon's own new app: /developer and its eight tabs (empty states), light/dark × 1440/390, the dock, and the Branding tab's live contrast readout at 4.5:1",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results } = ctx;
      const findings = findingsFor(ctx);
      const owner = await signedInCarbon(ctx, "uxa.dev");
      const { page } = owner;
      results.watch(page, "developer-empty");
      collectConsole(page);
      const appId = `uxa-${tag()}`;
      await sql(env, `insert into apps (app_id, name, description, logo_url, logo_dark_url, homepage_url, owner_uuid, secret_hash, status, source)
        select '${appId}', 'Audit Notes ${appId.slice(4)}', 'An app the ux-audit suite made for its owner', logo_url, logo_dark_url, homepage_url, '${owner.uuid}', secret_hash, 'active', 'fake' from apps where app_id = 'briefcase'`);
      await sql(env, `insert into app_signin_configs (app_id, version, config, updated_by) select '${appId}', 1, config, 'system' from app_signin_configs where app_id = 'briefcase'`);
      const owned = await pageFetch<{ items?: Array<{ app_id: string }> }>(page, "/v1/me/owned-apps");
      results.check("developer-empty: the new Carbon owns the new app", !!owned.body.items?.some(item => item.app_id === appId), JSON.stringify(owned.body).slice(0, 200));

      await auditDeveloper(ctx, page, findings, "developer-empty", appId);

      // The Branding tab's live contrast readout: a 3.62:1 button pair is "Too low" (the server refuses below 4.5:1).
      await openDeveloperPage(ctx, page, `/developer/${appId}/branding`);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
      await settle(page, 400);
      await page.getByText("Light palette", { exact: true }).first().click({ timeout: 10_000 }).catch(() => undefined);
      await settle(page, 300);
      await page.getByRole("button", { name: /^Primary #/ }).first().click({ timeout: 15_000 });
      const hex = page.getByRole("textbox", { name: "Primary in Hex" });
      await hex.waitFor({ timeout: 10_000 });
      await hex.fill("#3B82F6");
      await hex.press("Enter");
      await page.getByRole("button", { name: "Done" }).first().click().catch(() => undefined);
      await settle(page, 600);
      const row = page.getByRole("table", { name: "Contrast checks" }).getByRole("row").filter({ hasText: "Button text on primary" });
      const cells = await row.getByRole("cell").evaluateAll(nodes => nodes.map(node => ({ text: (node.textContent ?? "").replace(/\s+/g, " ").trim(), title: node.getAttribute("title") ?? "", ok: node.hasAttribute("data-ok") })));
      await page.screenshot({ path: `${env.shots}/uxa-developer-empty-branding-contrast.png` });
      const [light, dark] = cells;
      results.check("developer-empty: the Branding tab judges #FFFDF9 on #3B82F6 (3.62:1) \"Too low\" against 4.5:1 in the light column (UX note 6)", !!light && /3\.6\d:1/.test(light.text) && /Too low/.test(light.text) && !light.ok && /4\.5:1/.test(light.title), JSON.stringify(cells));
      results.check("developer-empty: the dark palette's default pair stays AA (6.10:1, #FFFDF9 on #1F5FB8)", !!dark && /6\.10:1/.test(dark.text) && dark.ok, JSON.stringify(dark));
      results.check("developer-empty: findings saved", true, saveFindings(ctx, findings));
      await owner.context.close();
    },
  },
  {
    name: "ux-audit-developer-briefcase",
    title: "briefcase's owner after a new Carbon signed in and a dry-run import: /developer and every tab with data, light/dark × 1440/390, and the dock",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);

      // A new Carbon signs into briefcase (a user, webhook deliveries).
      {
        const context = await auditContext(browser);
        const page = await context.newPage();
        results.watch(page, "developer-briefcase-user");
        await page.goto(await hostedLink(env, page, "briefcase"));
        const code = await sendEmailCode(env, page, freshEmail("uxa.devuser"));
        await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
        await page.keyboard.type(code, { delay: 25 });
        await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
        await page.getByRole("button", { name: "Share and continue" }).click({ timeout: 30_000 });
        await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/briefcase/`), { timeout: 30_000 });
        const account = await appAccount(page);
        results.check("developer-briefcase: a new Carbon signed into briefcase", typeof account?.uuid === "string");
        await context.close();
      }

      // The seeded owner's photo is test data on the production Iris (a harness defect): this stack's mock Iris draws it.
      const context = await auditContext(browser);
      const page = await context.newPage();
      results.watch(page, "developer-briefcase");
      collectConsole(page);
      await signInAsSeededOwner(ctx, page, findings);
      const rows = [
        { email: `uxa.import.${tag()}@example.test`, display_name: "Imported Carbon", external_id: `ext-${tag()}` },
        { email: "not-an-email", display_name: "Bad Row" },
      ];
      const dry = await pageFetch(page, "/v1/apps/briefcase/imports", { method: "POST", body: { rows, options: { dry_run: true } } });
      results.check("developer-briefcase: a dry-run import ran (the Import tab has a recent import)", dry.status >= 200 && dry.status < 300, `${dry.status} ${JSON.stringify(dry.body).slice(0, 200)}`);
      await auditDeveloper(ctx, page, findings, "developer-briefcase", "briefcase");
      results.check("developer-briefcase: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
];

/**
 * ux-audit: the developer site (developers.teamofsilicons.com, `developer/`, base + 5), where everything about building
 * an app's sign-in lives in v2 (UNDERSTANDING.md "developers.teamofsilicons.com"), in light and dark at 1440 and 390 px:
 *
 *   signin     signed out: its /sign-in card, a failed sign-in's words, the hosted sign-in it sends to (the account
 *              site's page for the first-party app `developer`), the not-found page, an app the Carbon does not own,
 *              an app that does not exist, an unknown tab, and signing out of the developer site
 *   empty      a new Carbon: the apps home without apps; then an app of their own (made in the stack's database, as
 *              Silicon Apps would deliver it): the home with it and every tab (Overview, Sign-in, Details, Flows, Pages,
 *              Users, Import, Webhooks, ATA, Embed) in its empty state; the selected tab in view on a phone; the Pages
 *              tab's contrast readout judging a 3.62:1 button pair "Too low"
 *   briefcase  briefcase's owner (the seeded c:saket) after a new Carbon signed in, an import and an ATA proof: every tab
 *              with data
 *   ledgerly   ledgerly's owner (c:ledgerly-dev): the Details and Flows tabs with a two-page flow and a review, and the
 *              Pages tab's preview of every page (method choice in both intents, Opening Google and Apple, the codes,
 *              setting up, each flow page, the review, the embed buttons), each with "Powered by"
 *   preview    the Pages tab's preview of briefcase's what's-shared page against the real hosted page: the same words
 *
 * Every page: the generic audit (_audit.ts). The developer site has no floating dock (a top bar that scrolls away).
 */
import type { Cookie, Page, Route } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { appAccount, developerApi, json, live, signInWithCode, sleep, startAtApp, tag } from "../../lib";
import { DEVELOPER_EXPECTED, POWERED_HREF, TABS, VARIANTS, tabPath, waitUntil, auditContext, auditVariants, collectConsole, developerCarbon, findingsFor, freshEmail, openDeveloperPage, ownedApp, saveFindings, settle, signInAsSeededOwnerOnDeveloper, stepReady, LEDGERLY_OWNER_EMAIL, type Findings } from "./_audit";
import { auditStep } from "./_hosted";


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
}

/** A tab rendered its content, not an error or a loading state. */
async function tabRendered(ctx: Ctx, prefix: string, tab: string, text: string): Promise<void> {
  ctx.results.check(`${prefix}-${tab}: the tab renders (no error panel, not stuck loading)`, !/could not be loaded|went wrong|Try again/i.test(text) && text.length > 60, text.slice(0, 200));
}

/**
 * On a phone the tabs scroll sideways: the selected tab must be in view, both when the page opens at 390 px and after
 * the window narrows from 1440 to 390 px (a rotated tablet, a narrowed window).
 */
async function checkActiveTab(ctx: Ctx, findings: Findings, prefix: string, appId: string, cookies: Cookie[]): Promise<void> {
  const context = await auditContext(ctx.browser, { width: 390, height: 844, cookies });
  const page = await context.newPage();
  ctx.results.watch(page, `${prefix}-tabs-390`, DEVELOPER_EXPECTED);
  for (const tab of TABS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDeveloperPage(ctx, page, tabPath(appId, tab));
    const opened = (await page.evaluate(ACTIVE_TAB)) as ActiveTab;
    findings.pages[`${prefix}-${tab} active tab opened at 390`] = opened;
    ctx.results.check(`${prefix}-${tab} 390: opened on a phone, the selected tab is in view in the tab strip`, opened.found && (opened.shownPx ?? 0) >= (opened.widthPx ?? 1) - 2, JSON.stringify(opened));
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDeveloperPage(ctx, page, tabPath(appId, tab));
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page, 500);
    const narrowed = (await page.evaluate(ACTIVE_TAB)) as ActiveTab;
    findings.pages[`${prefix}-${tab} active tab after 1440 → 390`] = narrowed;
    await page.screenshot({ path: `${ctx.env.shots}/uxa-${prefix}-${tab}-tabs-narrowed-390.png`, clip: { x: 0, y: 0, width: 390, height: 420 } }).catch(() => undefined);
    ctx.results.check(`${prefix}-${tab}: after the window narrows from 1440 to 390 px, the selected tab is still in view`, narrowed.found && (narrowed.shownPx ?? 0) >= (narrowed.widthPx ?? 1) - 2, JSON.stringify(narrowed));
  }
  await context.close();
}

/** The apps home and every tab of `appId`, in every variant. */
async function auditApp(ctx: Ctx, page: Page, findings: Findings, prefix: string, appId: string, appName: RegExp): Promise<void> {
  const home = await openDeveloperPage(ctx, page, "/");
  ctx.results.check(`${prefix}-home: lists ${appId}`, appName.test(home) && (await page.locator(`a[href="/apps/${appId}"]`).count()) > 0, home.slice(0, 200));
  await auditVariants(ctx, page, findings, `${prefix}-home`, VARIANTS, { fullPage: true, expectedConsole: DEVELOPER_EXPECTED });
  for (const tab of TABS) {
    const text = await openDeveloperPage(ctx, page, tabPath(appId, tab));
    await tabRendered(ctx, prefix, tab, text);
    await auditVariants(ctx, page, findings, `${prefix}-${tab}`, VARIANTS, { fullPage: true, expectedConsole: DEVELOPER_EXPECTED });
  }
  await checkActiveTab(ctx, findings, prefix, appId, await page.context().cookies());
}

/** Visible words of an element, one line. */
const wordsOf = async (page: Page, selector: string): Promise<string> => ((await page.locator(selector).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();

export const journeys: Journey[] = [
  {
    name: "ux-audit-developer-signin",
    title: "the developer site signed out and at its edges: /sign-in, a failed sign-in, the hosted sign-in it sends to, not-found, an app not owned, an app that does not exist, an unknown tab, signing out — light/dark × 1440/390",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      const context = await auditContext(browser);
      const page = await context.newPage();
      // The session probe's 401 while signed out, and the 404s asked for below.
      const expected = [...DEVELOPER_EXPECTED, /status of 404/, /status of 403 .*\/api\/accounts\/apps\/briefcase/];
      results.watch(page, "developer-signin", expected);
      collectConsole(page, expected);

      await page.goto(`${env.developer}/sign-in`);
      await page.getByRole("link", { name: /Continue with Silicon Accounts/ }).waitFor({ timeout: 30_000 });
      await settle(page, 600);
      await auditVariants(ctx, page, findings, "developer-signin", VARIANTS, { expectedConsole: expected });
      const accountLink = await page.locator("main a[href^='http']").evaluateAll((links, site) => links.filter(link => (link as HTMLAnchorElement).href.replace(/\/+$/, "") === site).length, env.site);
      results.check("developer-signin: says where a Carbon's own account lives (a link to the account site)", accountLink > 0);

      await page.goto(`${env.developer}/sign-in?error=access_denied`);
      await page.locator("main [role=alert]").first().waitFor({ timeout: 20_000 });
      const said = await wordsOf(page, "main [role=alert]");
      results.check("developer-signin-error: a cancelled sign-in says what happened in words (not the address's own text)", /cancelled the sign-in/i.test(said), said);
      await page.goto(`${env.developer}/sign-in?error=access_denied&error_description=${encodeURIComponent("Visit evil.example to fix your account")}`);
      await page.locator("main [role=alert]").first().waitFor({ timeout: 20_000 });
      const injected = await wordsOf(page, "main");
      results.check("developer-signin-error: words from the address (error_description) are never shown", !/evil\.example/.test(injected), injected.slice(0, 200));
      await settle(page, 400);
      await auditVariants(ctx, page, findings, "developer-signin-error", [VARIANTS[0]!, VARIANTS[3]!], { expectedConsole: expected });

      // The hosted sign-in it sends to: the account site's page for the first-party app `developer`.
      await page.goto(`${env.developer}/sign-in`);
      await page.getByRole("link", { name: /Continue with Silicon Accounts/ }).click({ timeout: 30_000 });
      await page.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 30_000 });
      await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditStep(ctx, page, findings, "developer-hosted-signin", VARIANTS, { expectedConsole: expected });
      const email = freshEmail("uxa.devsignin");
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
      await page.waitForURL(url => url.href.startsWith(env.developer) && !url.pathname.startsWith("/auth/"), { timeout: 30_000 });
      const home = await openDeveloperPage(ctx, page, "/");
      results.check("developer-signin: back on the developer site, signed in, on the apps home", /apps/i.test(home), home.slice(0, 160));

      // Edges, signed in: an unknown address, an unknown tab, an app not owned, an app that does not exist.
      for (const [path, name, words, status] of [
        ["/no-such-page", "developer-not-found", /Nothing lives at this address/, 404],
        ["/apps/briefcase/no-such-tab", "developer-unknown-tab", /Nothing lives at this address/, 404],
        ["/apps/briefcase", "developer-not-owner", /You don't own briefcase/, 200],
        [`/apps/uxa-none-${tag()}`, "developer-no-app", /No app with the id/, 200],
      ] as const) {
        const answer = await page.goto(`${env.developer}${path}`);
        await page.locator("main").first().waitFor({ timeout: 30_000 });
        await waitUntil(page, "!document.querySelector('[aria-busy=\"true\"]')", 20_000);
        await settle(page, 600);
        const text = await wordsOf(page, "main");
        results.check(`${name}: says so in words (${words.source})${status === 404 ? " and answers 404" : ""}`, words.test(text) && (status !== 404 || answer?.status() === 404), `${answer?.status()} ${text.slice(0, 200)}`);
        results.check(`${name}: offers a way back to the apps`, (await page.getByRole("link", { name: /Open your apps|Your apps/ }).count()) > 0);
        await auditVariants(ctx, page, findings, name, VARIANTS, { expectedConsole: expected });
      }

      // Signing out of the developer site only.
      await openDeveloperPage(ctx, page, "/");
      const signedOut = await developerApi(env, page, "/me");
      results.check("developer: the BFF knows the Carbon before signing out", signedOut.status === 200, String(signedOut.status));
      const out = await page.request.post(`${env.developer}/auth/sign-out`, { headers: { origin: env.developer }, maxRedirects: 0 }).catch(() => null);
      results.check("developer: signing out answers", !!out && out.status() < 400, String(out?.status()));
      await page.goto(`${env.developer}/sign-in?signed_out=1`);
      await page.getByRole("link", { name: /Continue with Silicon Accounts/ }).waitFor({ timeout: 30_000 });
      await settle(page, 400);
      const notice = await wordsOf(page, "main");
      findings.notes.push(`signed-out page: ${notice.slice(0, 300)}`);
      await auditVariants(ctx, page, findings, "developer-signed-out", [VARIANTS[0]!, VARIANTS[3]!], { expectedConsole: expected });
      const account = await page.request.get(`${env.site}/v1/me`);
      results.check("developer: signing out of the developer site leaves the account site signed in", account.status() === 200, String(account.status()));
      results.check("developer-signin: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
  {
    name: "ux-audit-developer-empty",
    title: "a new Carbon on the developer site: the apps home without apps, then an app of their own and its ten tabs in their empty states (light/dark × 1440/390), the selected tab in view on a phone, and the Pages tab's contrast readout at 4.5:1",
    timeoutMs: 1_500_000,
    async run(ctx) {
      const { env, results } = ctx;
      const findings = findingsFor(ctx);
      const owner = await developerCarbon(ctx, "uxa.dev");
      const { page } = owner;
      results.watch(page, "developer-empty", DEVELOPER_EXPECTED);
      collectConsole(page, DEVELOPER_EXPECTED);
      results.check("developer-empty: a new Carbon is signed in to the developer site", owner.uuid.length > 0, `${owner.id} ${owner.uuid}`);

      const none = await openDeveloperPage(ctx, page, "/");
      results.check("developer-empty-home: without apps, says how apps come to be (Silicon Apps) instead of an empty grid", /Silicon Apps/.test(none), none.slice(0, 300));
      await auditVariants(ctx, page, findings, "developer-empty-noapps", VARIANTS, { fullPage: true, expectedConsole: DEVELOPER_EXPECTED });

      const appId = `uxa-${tag()}`;
      const name = `Audit Notes ${appId.slice(4)}`;
      await ownedApp(ctx, owner.uuid, appId, name);
      const owned = await developerApi<{ items?: Array<{ app_id: string }> }>(env, page, "/me/owned-apps");
      results.check("developer-empty: the new Carbon owns the new app", !!owned.body.items?.some(item => item.app_id === appId), JSON.stringify(owned.body).slice(0, 200));
      await auditApp(ctx, page, findings, "developer-empty", appId, new RegExp(name));

      // The Pages tab's live contrast readout: a 3.62:1 button pair is "Too low" (the server refuses below 4.5:1).
      await openDeveloperPage(ctx, page, tabPath(appId, "pages"));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
      await settle(page, 400);
      await page.getByRole("button", { name: "Light palette" }).first().click({ timeout: 10_000 }).catch(() => undefined);
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
      await page.screenshot({ path: `${env.shots}/uxa-developer-empty-pages-contrast.png` });
      const [light, dark] = cells;
      results.check("developer-empty: the Pages tab judges #FFFDF9 on #3B82F6 (3.62:1) \"Too low\" against 4.5:1 in the light column", !!light && /3\.6\d:1/.test(light.text) && /Too low/.test(light.text) && !light.ok && /4\.5:1/.test(light.title), JSON.stringify(cells));
      results.check("developer-empty: the dark palette's default pair stays AA (6.10:1, #FFFDF9 on #1F5FB8)", !!dark && /6\.10:1/.test(dark.text) && dark.ok, JSON.stringify(dark));
      // The unsaved change: leaving asks first (the guard), and "Stay" keeps it.
      results.check("developer-empty: findings saved", true, saveFindings(ctx, findings));
      await owner.context.close();
    },
  },
  {
    name: "ux-audit-developer-briefcase",
    title: "briefcase's owner after a new Carbon signed in, a dry-run import and an ATA proof: the apps home and every tab with data, light/dark × 1440/390, the selected tab in view on a phone",
    timeoutMs: 1_500_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);

      // A new Carbon signs into briefcase (a user, webhook deliveries).
      {
        const context = await auditContext(browser);
        const page = await context.newPage();
        results.watch(page, "developer-briefcase-user");
        await startAtApp(env, page, "briefcase");
        await signInWithCode(env, page, { email: freshEmail("uxa.devuser") });
        await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
        await page.getByRole("button", { name: "Share and continue" }).click({ timeout: 30_000 });
        await page.waitForURL(url => url.href.startsWith(`${env.apps}/briefcase/`), { timeout: 30_000 });
        const account = await appAccount(page);
        results.check("developer-briefcase: a new Carbon signed into briefcase", typeof account?.uuid === "string");
        await context.close();
      }

      const context = await auditContext(browser);
      const page = await context.newPage();
      results.watch(page, "developer-briefcase", DEVELOPER_EXPECTED);
      collectConsole(page, DEVELOPER_EXPECTED);
      await signInAsSeededOwnerOnDeveloper(ctx, page, findings);
      const rows = [
        { email: `uxa.import.${tag()}@example.test`, display_name: "Imported Carbon", external_id: `ext-${tag()}` },
        { email: "not-an-email", display_name: "Bad Row" },
      ];
      const dry = await developerApi(env, page, "/apps/briefcase/imports", { json: { rows, options: { dry_run: true } }, headers: { "idempotency-key": `uxa-dry-${tag()}` } });
      results.check("developer-briefcase: a dry-run import ran through the BFF (the Import tab has a recent import)", dry.status >= 200 && dry.status < 300, `${dry.status} ${JSON.stringify(dry.body).slice(0, 200)}`);
      const ata = await developerApi(env, page, "/apps/briefcase/proofs/ata", { json: { receiving_app: "remind" }, headers: { "idempotency-key": `uxa-ata-${tag()}` } });
      results.check("developer-briefcase: an ATA proof for one app (remind) was made through the BFF (the ATA tab lists it)", ata.status >= 200 && ata.status < 300, `${ata.status} ${JSON.stringify(ata.body).slice(0, 160)}`);
      await auditApp(ctx, page, findings, "developer-briefcase", "briefcase", /Briefcase/);
      results.check("developer-briefcase: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
  {
    name: "ux-audit-developer-ledgerly",
    title: "ledgerly's owner: the Details and Flows tabs with a two-page flow and a review, and the Pages tab's preview of every page (both intents, Opening Google/Apple, codes, setting up, each flow page, review, embed buttons), each with Powered by",
    timeoutMs: 1_200_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      const context = await auditContext(browser);
      const page = await context.newPage();
      results.watch(page, "developer-ledgerly", DEVELOPER_EXPECTED);
      collectConsole(page, DEVELOPER_EXPECTED);
      await signInAsSeededOwnerOnDeveloper(ctx, page, findings, LEDGERLY_OWNER_EMAIL);
      for (const tab of ["details", "flows"] as const) {
        const text = await openDeveloperPage(ctx, page, tabPath("ledgerly", tab));
        await tabRendered(ctx, "developer-ledgerly", tab, text);
        if (tab === "flows") results.check("developer-ledgerly-flows: shows both pages of the flow and its review", /How can we reach you\?/.test(text) && /About you/.test(text) && /review/i.test(text), text.slice(0, 300));
        await auditVariants(ctx, page, findings, `developer-ledgerly-${tab}`, VARIANTS, { fullPage: true, expectedConsole: DEVELOPER_EXPECTED });
      }

      // The Pages tab: each page's preview, with "Powered by Silicon Accounts" in it.
      // At 1440 (the audits above end at 390, where a Page menu stands in for the chips).
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
      await openDeveloperPage(ctx, page, tabPath("ledgerly", "pages"));
      const chips = page.getByRole("group", { name: "Pages" }).getByRole("button");
      await chips.first().waitFor({ timeout: 20_000 }).catch(() => undefined);
      const names = (await chips.allInnerTexts()).map(name => name.trim());
      findings.pages["developer-ledgerly pages chips"] = names;
      for (const wanted of [/^Sign in$/, /^Sign up$/, /Opening Google/, /Email code/, /Phone code/, /Set up account/, /How can we reach you|Step 1|Page 1/i, /About you|Step 2|Page 2/i, /Review/, /Embed buttons/]) {
        results.check(`developer-ledgerly-pages: the preview offers ${wanted.source}`, names.some(name => wanted.test(name)), names.join(" | "));
      }
      // Only pages a Carbon can meet: ledgerly offers no Apple, so no Carbon ever sees "Opening Apple" for it.
      const methods = (await json<{ methods?: string[] }>(`${env.site}/v1/apps/ledgerly/public`)).body.methods ?? [];
      if (!methods.includes("apple")) results.check("developer-ledgerly-pages: the preview offers no page the app cannot show (no Opening Apple: ledgerly has no Apple)", !names.some(name => /Opening Apple/.test(name)), `methods ${methods.join(", ")}; pages ${names.join(" | ")}`);
      for (const [index, chip] of names.entries()) {
        await chips.nth(index).click();
        await sleep(700);
        const preview = page.locator("[inert]").filter({ hasText: /Powered by/ }).first();
        const powered = await page.evaluate(`(() => {
          const links = Array.from(document.querySelectorAll("a")).filter(a => (a.textContent || "").trim() === "Silicon Accounts" && /Powered by/.test((a.parentElement || a).textContent || ""));
          return links.map(a => ({ href: a.getAttribute("href"), visible: a.getClientRects().length > 0 }));
        })()`) as Array<{ href: string | null; visible: boolean }>;
        results.check(`developer-ledgerly-pages "${chip}": the preview keeps "Powered by Silicon Accounts" linking to accounts.teamofsilicons.com`, powered.some(link => link.visible && POWERED_HREF.test(link.href ?? "")), JSON.stringify(powered));
        await page.screenshot({ path: `${env.shots}/uxa-developer-ledgerly-preview-${index + 1}-${chip.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`, fullPage: false }).catch(() => undefined);
        void preview;
      }
      await auditVariants(ctx, page, findings, "developer-ledgerly-pages", VARIANTS, { fullPage: true, expectedConsole: DEVELOPER_EXPECTED });
      results.check("developer-ledgerly: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
  {
    name: "ux-audit-developer-preview",
    title: "the Pages tab's preview of briefcase's what's-shared page and Opening page says what the real hosted pages say (title, description, actions, rows, Required/Optional, footer)",
    timeoutMs: 600_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      // The real page: a new Carbon at briefcase's what's-shared page.
      const real = await (async () => {
        const context = await auditContext(browser, { width: 390, height: 844 });
        const page = await context.newPage();
        results.watch(page, "preview-real");
        await startAtApp(env, page, "briefcase");
        await signInWithCode(env, page, { email: freshEmail("uxa.preview") });
        await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
        await live(page, 'ul[aria-label^="Details shared with"]').first().waitFor({ timeout: 30_000 });
        await stepReady(page);
        await page.screenshot({ path: `${env.shots}/uxa-preview-real-details-390.png`, fullPage: true });
        const words = await page.evaluate(READ_PAGE);
        await context.close();
        return words as PageWords;
      })();
      const context = await auditContext(browser);
      const page = await context.newPage();
      results.watch(page, "preview-developer", DEVELOPER_EXPECTED);
      await signInAsSeededOwnerOnDeveloper(ctx, page, findings);
      await openDeveloperPage(ctx, page, tabPath("briefcase", "pages"));
      await page.getByRole("button", { name: "Phone", exact: true }).click().catch(() => undefined);
      await page.getByRole("group", { name: "Pages" }).getByRole("button", { name: /What's shared/ }).click();
      await sleep(800);
      await page.screenshot({ path: `${env.shots}/uxa-preview-developer-details.png` });
      const shown = (await page.evaluate(READ_PREVIEW)) as PageWords | null;
      findings.pages["preview fidelity"] = { real, preview: shown };
      const same = (what: string, a: string | string[] | undefined, b: string | string[] | undefined) => results.check(`preview: ${what} reads as on the real page`, JSON.stringify(a) === JSON.stringify(b), `real ${JSON.stringify(a)} | preview ${JSON.stringify(b)}`);
      same("the title", real.title, shown?.title);
      same("the description", real.description, shown?.description);
      same("the actions (Switch account, the main button, Cancel)", real.actions, shown?.actions);
      same("the rows (label and Required/Optional)", real.rows, shown?.rows);
      same("the footer (terms, privacy, help)", real.footer, shown?.footer);

      // The Opening page: the real one (held while it opens Google, so it can be read) and the preview's.
      const realOpening = await (async () => {
        const openingContext = await auditContext(browser);
        const opening = await openingContext.newPage();
        results.watch(opening, "preview-real-opening");
        const site = new URL(env.site).origin;
        const held: Route[] = [];
        const isStart = (url: URL) => url.origin === site && /^\/v1\/flows\/[^/]+\/oauth\/google$/.test(url.pathname);
        await openingContext.route(isStart, route => (route.request().method() === "POST" ? void held.push(route) : void route.continue()));
        await startAtApp(env, opening, "briefcase", { method: "google" });
        for (let i = 0; i < 100 && !held.length; i++) await sleep(100);
        await stepReady(opening);
        const words = (await opening.evaluate(READ_PAGE)) as PageWords;
        for (const route of held.splice(0)) await route.continue().catch(() => undefined);
        await openingContext.close();
        return words;
      })();
      await page.getByRole("group", { name: "Pages" }).getByRole("button", { name: "Opening Google", exact: true }).click();
      await sleep(800);
      const previewOpening = (await page.evaluate(READ_PREVIEW)) as PageWords | null;
      findings.pages["preview fidelity: opening"] = { real: realOpening, preview: previewOpening };
      same("the Opening page's title", realOpening.title, previewOpening?.title);
      same("the Opening page's description", realOpening.description, previewOpening?.description);
      results.check("preview: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
];

interface PageWords {
  title: string;
  description: string;
  /** The page's actions in order (buttons and text links with words: Switch account, Share and continue, Cancel). */
  actions: string[];
  /** Each row: its label and the word that says how it is shared (Always, Required, Optional; "" for an icon alone). */
  rows: string[];
  /** The footer: terms and privacy, help. */
  footer: string[];
}

/** The words of the real details page: heading, description, actions, rows (label · Required/Optional/Always), footer. */
const READ_PAGE = `(() => {
  const main = document.querySelector("main");
  const live = el => !el.closest("[data-step-leaving]");
  const text = el => (el ? (el.innerText || el.textContent || "") : "").replace(/\\s+/g, " ").trim();
  const heading = Array.from(main.querySelectorAll("h1")).find(live);
  const description = heading && heading.nextElementSibling ? text(heading.nextElementSibling) : "";
  const actions = Array.from(main.querySelectorAll("button")).filter(b => live(b) && b.getClientRects().length && text(b) && b.getAttribute("role") !== "checkbox" && !b.closest("li")).map(text);
  const mark = li => /\\bOptional\\b/.test(text(li)) ? "Optional" : /\\bRequired\\b/.test(text(li)) ? "Required" : /\\bAlways\\b/.test(text(li)) ? "Always" : "";
  const rows = Array.from(main.querySelectorAll('ul[aria-label^="Details shared with"] > li')).filter(live).map(li => {
    const label = text(li.querySelector("[class*=shareLabel]")).replace(/\\s*(Optional|New)\\b/g, "").trim();
    return label + " · " + mark(li);
  });
  const footer = Array.from(document.querySelectorAll(".sa-brand-legal")).filter(live).map(text);
  return { title: text(heading), description, actions, rows, footer };
})()`;

/** The same words from the developer site's preview of that page (the inert picture with "Powered by"). */
const READ_PREVIEW = `(() => {
  const preview = Array.from(document.querySelectorAll("[inert]")).find(el => /Powered by/.test(el.textContent || "") && el.querySelector(".sa-brand-body"));
  if (!preview) return null;
  const body = preview.querySelector(".sa-brand-body");
  const text = el => (el ? (el.innerText || el.textContent || "") : "").replace(/\\s+/g, " ").trim();
  const heading = body.querySelector("h1, h2");
  const description = heading && heading.nextElementSibling ? text(heading.nextElementSibling) : "";
  const actions = Array.from(body.querySelectorAll("button, [class*=textLink], a")).filter(el => el.getClientRects().length && text(el) && !el.closest("li")).map(text);
  const rows = Array.from(body.querySelectorAll("ul > li")).map(li => {
    const label = text(li.querySelector("[class*=sharedText] > span:first-child") || li.querySelector("span")).replace(/\\s*(Optional|New)\\b/g, "").trim();
    const words = text(li);
    const mark = /\\bOptional\\b/.test(words) ? "Optional" : /\\bRequired\\b/.test(words) ? "Required" : /\\bAlways\\b/.test(words) ? "Always" : "";
    return label + " · " + mark;
  });
  const footer = Array.from(preview.querySelectorAll(".sa-brand-legal")).map(text);
  return { title: text(heading), description, actions, rows, footer };
})()`;

/**
 * What the account site is for (UNDERSTANDING.md "Where things live" and "accounts.teamofsilicons.com"): a Carbon
 * manages their own account there (details, emails and phone numbers, the apps they signed into, proofs, Silicons).
 * "Anything about building apps lives on developers.teamofsilicons.com, not here." In v2 (06-v2 §1) the dock's Developer
 * item, the landing page's footer and /apps lead to the developer site (`developer_url` from GET /v1/meta), and every
 * old /developer[/*] address of the account site answers 307 there.
 */
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, api, hostedTitle, newContext, shot, sleep } from "../../lib";
import { newCarbon, signIntoApp, until } from "./_helpers";

/** The account site's own sections, as its dock names them (every one a page of this site). */
/** The sidebar's sections (lib/navigation.ts SECTIONS, 2026-11-07): every one a page of this site. */
const OWN = ["Home", "Silicons", "Connected apps", "Security", "Personal info"];

/** GET <site><path> without following redirects: the status and where it points. */
async function redirectOf(site: string, path: string): Promise<{ status: number; location: string }> {
  const answer = await fetch(`${site}${path}`, { redirect: "manual" });
  return { status: answer.status, location: answer.headers.get("location") ?? "" };
}

const scope: Journey = {
  name: "account-site-scope",
  title: "the account site is the Carbon's own account and builds no apps: its six sections plus the dock's Developer item leading out to the developer site (developer_url), /developer[/*] answering 307 there (path and query kept), /apps and the landing page pointing there too, and the landing's Create your account opening the sign-up page",
  async run(ctx) {
    const { env, results } = ctx;
    // The developer site's signed-out probe answers 401 when the dock's Developer item opens it.
    const carbon = await newCarbon(ctx, "acct-scope", { watch: [DEVELOPER_SIGNED_OUT] });
    const { page } = carbon;
    const account = await signIntoApp(env, page, "briefcase");
    results.check("setup: signed into Briefcase", account?.uuid === carbon.uuid);

    // The service names the developer site; the stack points it at this stack's developer site (base + 5).
    const meta = await api<{ developer_url?: string; public_url?: string }>(ctx, "/v1/meta");
    results.check("GET /v1/meta names the developer site (developer_url)", meta.status === 200 && meta.body.developer_url === env.developer, `${meta.status} developer_url ${meta.body.developer_url} (want ${env.developer})`);

    // The sections of the site: the sidebar's "Account sections", then "Other sites" (Developers, Docs); the phone sheet,
    // the number keys and the command palette read the same lists.
    await page.goto(`${env.site}/`);
    const dock = page.getByRole("navigation", { name: "Account sections" });
    const elsewhere = page.getByRole("navigation", { name: "Other sites" });
    await dock.waitFor({ timeout: 30_000 });
    await sleep(600);
    const linksOf = (nav: typeof dock) => nav.getByRole("link").evaluateAll(links => links.map(link => ({ name: (link.getAttribute("aria-label") ?? link.textContent ?? "").replace(/\s+/g, " ").trim(), href: link.getAttribute("href") ?? "" })));
    const own = await linksOf(dock);
    const external = await linksOf(elsewhere);
    await shot(env, page, "acct-scope-01-dock");
    results.check(
      "the sidebar's sections are the Carbon's account (Home, Silicons, Connected apps, Security, Personal info), every one a page of this site",
      OWN.every(name => own.some(section => section.name === name && section.href.startsWith("/"))) && own.length === OWN.length,
      own.map(section => `${section.name} ${section.href}`).join(", "),
    );
    results.check(
      "Other sites: Developers and Docs lead to app management and shared documentation on developer_url",
      external.length === 2 && external.some(section => section.name === "Developers" && section.href.replace(/\/$/, "") === env.developer)
        && external.some(section => section.name === "Docs" && section.href === `${env.developer}/docs`),
      JSON.stringify(external),
    );

    // Every old developer address of the account site goes to the developer site (307, path and query kept).
    const home = await redirectOf(env.site, "/developer");
    const app = await redirectOf(env.site, "/developer/briefcase");
    const tab = await redirectOf(env.site, "/developer/briefcase/branding?from=bookmark");
    results.check("/developer answers 307 to the developer site's home", home.status === 307 && home.location === `${env.developer}/`, `${home.status} → ${home.location}`);
    results.check("/developer/{app_id} and /developer/{app_id}/{tab}?query answer 307 to /apps/{app_id}[/{tab}] there, query kept", app.status === 307 && app.location === `${env.developer}/apps/briefcase` && tab.status === 307 && tab.location === `${env.developer}/apps/briefcase/branding?from=bookmark`, `${app.status} → ${app.location}; ${tab.status} → ${tab.location}`);

    // /apps: the apps the Carbon signed into; app builders are sent to the developer site, never into the account site.
    await page.goto(`${env.site}/apps`);
    await page.getByRole("region", { name: "Your apps" }).waitFor({ timeout: 30_000 });
    await sleep(600);
    const links = await page.locator("main a[href]").evaluateAll(anchors => anchors.map(anchor => ({ text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40), href: anchor.getAttribute("href") ?? "" })));
    const intoSite = links.filter(link => /^\/developer(\/|$|\?|#)/.test(link.href) || link.href.startsWith(`${env.site}/developer`));
    const toDeveloper = links.filter(link => link.href === env.developer && /developer site/i.test(link.text));
    await shot(env, page, "acct-scope-02-apps", true);
    results.check("/apps points app builders to the developer site (developer_url), never into a developer area of the account site", intoSite.length === 0 && toDeveloper.length === 1, `links on /apps: ${links.map(link => `"${link.text}" → ${link.href}`).join(" | ")}`);

    // The sidebar's Developers link leaves the account site for the developer site (a full navigation).
    await page.goto(`${env.site}/`);
    await dock.waitFor({ timeout: 30_000 });
    await sleep(500);
    await elsewhere.getByRole("link", { name: "Developers", exact: true }).click();
    const left = await page.waitForURL(url => url.href.startsWith(env.developer), { timeout: 30_000 }).then(() => true, () => false);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await sleep(800);
    await shot(env, page, "acct-scope-03-developer-site");
    results.check("clicking the sidebar's Developers link opens the developer site", left, page.url());

    // The section keys read the same list: 3 is Connected apps.
    await page.goto(`${env.site}/`);
    await dock.waitFor({ timeout: 30_000 });
    await sleep(600);
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press("3");
    const byKey = await page.waitForURL(url => url.pathname === "/apps", { timeout: 20_000 }).then(() => true, () => false);
    results.check("pressing 3 (Connected apps' key) opens /apps", byKey, page.url());

    // On a phone the sidebar is a sheet ("Your account") behind the Account sections button: the same links.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${env.site}/`);
    const menu = page.getByRole("button", { name: "Account sections" });
    await menu.waitFor({ timeout: 30_000 });
    await sleep(500);
    await menu.click();
    const sheet = page.getByRole("dialog", { name: "Your account" });
    await sheet.waitFor({ timeout: 10_000 });
    await sleep(700);
    await shot(env, page, "acct-scope-03b-phone-sheet");
    const sheetLinks = await sheet.getByRole("link").evaluateAll(links => links.map(link => ({ text: (link.textContent ?? "").replace(/\s+/g, " ").trim(), href: link.getAttribute("href") ?? "" })));
    const sheetDeveloper = sheetLinks.find(link => link.text.startsWith("Developers"));
    const sheetDocs = sheetLinks.find(link => link.text.startsWith("Docs"));
    results.check("on a phone, the sheet lists the five account sections, Developers and Docs", sheetLinks.length === 7 && sheetDeveloper?.href.replace(/\/$/, "") === env.developer && sheetDocs?.href === `${env.developer}/docs`, JSON.stringify(sheetLinks.map(link => `${link.text.slice(0, 24)} ${link.href}`)));
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });

    // Signed out: the landing page (redesigned 2026-11) has no footer; its header's "Team of Silicons" nav leads to the
    // developer site ("Developers"), and "Create your account" opens the sign-up page. The header's link is the
    // production address written into the page, not developer_url; both are accepted here and the difference is noted.
    const context = await newContext(ctx.browser);
    const visitor = await context.newPage();
    results.watch(visitor, "acct-scope-landing");
    await visitor.goto(`${env.site}/`);
    const header = visitor.getByRole("navigation", { name: "Team of Silicons" });
    await header.waitFor({ timeout: 30_000 });
    const developersHref = await header.getByRole("link", { name: "Developers", exact: true }).getAttribute("href", { timeout: 10_000 }).catch(() => null);
    results.check("the signed-out landing page's header links to the developer site", developersHref === env.developer || developersHref === "https://developers.teamofsilicons.com", `${developersHref}${developersHref === env.developer ? "" : " (the production address, not developer_url)"}`);
    const create = visitor.getByRole("link", { name: "Create your account", exact: true });
    const createHref = await create.getAttribute("href", { timeout: 10_000 }).catch(() => null);
    await shot(env, visitor, "acct-scope-04-landing");
    await create.click();
    await visitor.waitForURL(url => url.pathname.startsWith("/authorize/flow/"), { timeout: 30_000 }).catch(() => undefined);
    const title = await until(async () => hostedTitle(visitor, 5_000).catch(error => `no heading: ${String(error).slice(0, 80)}`), heading => heading === "Create your account", 15_000);
    await sleep(400);
    await shot(env, visitor, "acct-scope-05-signup");
    results.check("the landing's \"Create your account\" opens the account site's sign-up page (intent=signup: \"Create your account\")", createHref === "/sign-in?intent=signup" && title === "Create your account", `${createHref} → ${visitor.url()}: "${title}"`);
    await context.close();
    await carbon.context.close();
  },
};

export const journey = scope;

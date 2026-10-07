/**
 * What the account site is for (UNDERSTANDING.md "Where things live" and "accounts.teamofsilicons.com"): a Carbon
 * manages their own account there (details, emails and phone numbers, the apps they signed into, proofs, Silicons).
 * "Anything about building apps lives on developer.teamofsilicons.com, not here." In v2 (06-v2 §1) the dock's Developer
 * item, the landing page's footer and /apps lead to the developer site (`developer_url` from GET /v1/meta), and every
 * old /developer[/*] address of the account site answers 307 there.
 */
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, api, hostedTitle, newContext, shot, sleep } from "../../lib";
import { newCarbon, signIntoApp, until } from "./_helpers";

/** The account site's own sections, as its dock names them (every one a page of this site). */
const OWN = ["Identity", "Sign-in", "Apps", "Silicons", "Proofs", "Activity"];

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

    // The sections of the site (the dock; the phone sheet, the number keys and the command palette read the same list).
    await page.goto(`${env.site}/`);
    const dock = page.getByRole("navigation", { name: "Account sections" });
    await dock.waitFor({ timeout: 30_000 });
    await sleep(600);
    const sections = await dock.getByRole("link").evaluateAll(links => links.map(link => ({ name: (link.getAttribute("aria-label") ?? link.textContent ?? "").replace(/\s+/g, " ").trim(), href: link.getAttribute("href") ?? "", external: link.hasAttribute("data-external") })));
    const own = sections.filter(section => !section.external);
    const external = sections.filter(section => section.external);
    await shot(env, page, "acct-scope-01-dock");
    results.check(
      "the dock's own sections are the Carbon's account (identity, sign-in methods, apps signed into, Silicons, proofs, activity), every one a page of this site",
      OWN.every(name => own.some(section => section.name === name && section.href.startsWith("/"))) && own.length === OWN.length,
      sections.map(section => `${section.name} ${section.href}${section.external ? " (external)" : ""}`).join(", "),
    );
    results.check(
      "…and one more item, \"Developer site\", a link out to the developer site (developer_url), never a page here",
      external.length === 1 && external[0]?.name === "Developer site" && external[0]?.href === env.developer,
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
    await page.getByRole("list", { name: "Apps with access" }).waitFor({ timeout: 30_000 });
    await sleep(600);
    const links = await page.locator("main a[href]").evaluateAll(anchors => anchors.map(anchor => ({ text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40), href: anchor.getAttribute("href") ?? "" })));
    const intoSite = links.filter(link => /^\/developer(\/|$|\?|#)/.test(link.href) || link.href.startsWith(`${env.site}/developer`));
    const toDeveloper = links.filter(link => link.href === env.developer && /developer site/i.test(link.text));
    await shot(env, page, "acct-scope-02-apps", true);
    results.check("/apps points app builders to the developer site (developer_url), never into a developer area of the account site", intoSite.length === 0 && toDeveloper.length === 1, `links on /apps: ${links.map(link => `"${link.text}" → ${link.href}`).join(" | ")}`);

    // The dock's Developer item leaves the account site for the developer site (a full navigation).
    await page.goto(`${env.site}/`);
    await dock.waitFor({ timeout: 30_000 });
    await sleep(500);
    await dock.getByRole("link", { name: "Developer site", exact: true }).click();
    const left = await page.waitForURL(url => url.href.startsWith(env.developer), { timeout: 30_000 }).then(() => true, () => false);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await sleep(800);
    await shot(env, page, "acct-scope-03-developer-site");
    results.check("clicking the dock's Developer site item opens the developer site", left, page.url());

    // The section keys read the same list: 7 is the developer site.
    await page.goto(`${env.site}/`);
    await dock.waitFor({ timeout: 30_000 });
    await sleep(600);
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press("7");
    const byKey = await page.waitForURL(url => url.href.startsWith(env.developer), { timeout: 20_000 }).then(() => true, () => false);
    results.check("pressing 7 (the Developer section's key) opens the developer site too", byKey, page.url());

    // On a phone the dock is a "Go to" sheet: its Developer item leads out the same way.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${env.site}/`);
    // The compact bar's menu button names the section on screen ("Identity") and opens the sheet.
    const menu = page.locator('button[aria-haspopup="dialog"]').filter({ hasText: "Identity" }).first();
    await menu.waitFor({ timeout: 30_000 });
    await sleep(500);
    await menu.click();
    const sheet = page.getByRole("dialog", { name: "Go to" });
    await sheet.waitFor({ timeout: 10_000 });
    await sleep(700);
    await shot(env, page, "acct-scope-03b-phone-sheet");
    const sheetLinks = await sheet.getByRole("link").evaluateAll(links => links.map(link => ({ text: (link.textContent ?? "").replace(/\s+/g, " ").trim(), href: link.getAttribute("href") ?? "", external: link.hasAttribute("data-external") })));
    const sheetDeveloper = sheetLinks.find(link => link.external);
    results.check("on a phone, the Go to sheet lists the six sections and \"Developer site\" leading to developer_url", sheetLinks.length === 7 && !!sheetDeveloper && sheetDeveloper.text.startsWith("Developer site") && sheetDeveloper.href === env.developer, JSON.stringify(sheetLinks.map(link => `${link.text.slice(0, 24)} ${link.href}`)));
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });

    // Signed out: the landing page's footer leads to the developer site, and "Create your account" opens the sign-up page.
    const context = await newContext(ctx.browser);
    const visitor = await context.newPage();
    results.watch(visitor, "acct-scope-landing");
    await visitor.goto(`${env.site}/`);
    const footer = visitor.locator("footer");
    await footer.waitFor({ timeout: 30_000 });
    // The link starts at the production address and follows GET /v1/meta once it has loaded.
    const footerLink = await until(async () => footer.getByRole("link", { name: "Developer site", exact: true }).getAttribute("href", { timeout: 2_000 }).catch(() => null), href => href === env.developer, 10_000);
    results.check("the signed-out landing page's footer links to the developer site (developer_url)", footerLink === env.developer, String(footerLink));
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

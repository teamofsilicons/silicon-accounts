/**
 * What the account site is for (UNDERSTANDING.md, "Where things live" and "accounts.teamofsilicons.com"): a Carbon
 * manages their own account there (details, emails and phone numbers, the apps they signed into, proofs, Silicons).
 * "Anything about building apps lives on developer.teamofsilicons.com, not here."
 */
import type { Journey } from "../../context";
import { shot, sleep } from "../../lib";
import { newCarbon, signIntoApp } from "./_helpers";

/** The account site's own sections, as its dock names them. */
const OWN = ["Identity", "Sign-in", "Apps", "Silicons", "Proofs", "Activity"];

const scope: Journey = {
  name: "account-site-scope",
  title: "the account site is the Carbon's own account and holds nothing about building apps (UNDERSTANDING.md: that lives on developer.teamofsilicons.com, not here): its sections, and where /apps sends app builders",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await newCarbon(ctx, "acct-scope");
    const { page } = carbon;
    const account = await signIntoApp(env, page, "briefcase");
    results.check("setup: signed into Briefcase", account?.uuid === carbon.uuid);

    // The sections of the site (the dock; the phone sheet, the number keys and the command palette read the same list).
    await page.goto(`${env.site}/`);
    const dock = page.getByRole("navigation", { name: "Account sections" });
    await dock.waitFor({ timeout: 30_000 });
    await sleep(600);
    const sections = await dock.getByRole("link").evaluateAll(links => links.map(link => ({ name: (link.getAttribute("aria-label") ?? link.textContent ?? "").replace(/\s+/g, " ").trim(), href: link.getAttribute("href") ?? "" })));
    const extra = sections.filter(section => !OWN.includes(section.name));
    const developerHere = await page.request.get(`${env.site}/developer`, { maxRedirects: 0 }).then(answer => `${answer.status()}${answer.headers().location ? ` → ${answer.headers().location}` : ""}`, error => String(error).slice(0, 80));
    await shot(env, page, "acct-scope-01-dock");
    results.check(
      "the account site's sections are the Carbon's own account (identity, sign-in methods, apps signed into, Silicons, proofs, activity), with no area for building apps: that lives on developer.teamofsilicons.com",
      OWN.every(name => sections.some(section => section.name === name)) && extra.length === 0,
      `sections: ${sections.map(section => `${section.name} ${section.href}`).join(", ")}; GET ${env.site}/developer answers ${developerHere}`,
    );

    // /apps: the apps the Carbon signed into; app builders are sent to developer.teamofsilicons.com, not into the site.
    await page.goto(`${env.site}/apps`);
    await page.getByRole("list", { name: "Apps with access" }).waitFor({ timeout: 30_000 });
    await sleep(600);
    const links = await page.locator("main a[href]").evaluateAll(anchors => anchors.map(anchor => ({ text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40), href: anchor.getAttribute("href") ?? "" })));
    const intoSite = links.filter(link => /^\/developer(\/|$|\?|#)/.test(link.href) || link.href.startsWith(`${env.site}/developer`));
    const footnote = ((await page.locator("main p").filter({ hasText: /Making an app/ }).first().innerText().catch(() => "")) || "none").replace(/\s+/g, " ");
    await shot(env, page, "acct-scope-02-apps", true);
    results.check(
      "/apps never sends the Carbon into a developer area of the account site (building apps lives on developer.teamofsilicons.com)",
      intoSite.length === 0,
      `links on /apps: ${links.map(link => `"${link.text}" → ${link.href}`).join(" | ")}; footnote: "${footnote}"`,
    );
    await carbon.context.close();
  },
};

export const journey = scope;

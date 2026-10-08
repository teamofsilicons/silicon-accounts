/**
 * Every page of the account site, for an account with something on each (two emails, a phone number, two apps, one of
 * them removed, proofs active and ended, a history): one main landmark, a title naming the page, headings that start
 * at one h1 and never skip a level (assistive tech lists them as the page reads), and on a phone (390 px) nothing
 * wider than the screen, in every view a page can switch to.
 */
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { postJson, shot, sleep, tag } from "../../lib";
import { addContact, call, getMe, headingOutline, newCarbon, overflowX, randomPhone, signIntoApp } from "./_helpers";

interface View {
  name: string;
  path: string;
  /** The document title the page should have. */
  title: string;
  /** Visible once the page drew its data. */
  ready: (page: Page) => Locator;
  /** Switches the page to this view after it loaded (a segmented switch). */
  open?: (page: Page) => Promise<void>;
}

const VIEWS: View[] = [
  { name: "identity", path: "/", title: "Silicon Accounts", ready: page => page.getByRole("region", { name: /^Identity card of / }).first() },
  { name: "sign-in methods", path: "/sign-in-methods", title: "Sign-in methods · Silicon Accounts", ready: page => page.getByRole("list", { name: "Your phone numbers", exact: true }) },
  { name: "apps with access", path: "/apps", title: "Apps · Silicon Accounts", ready: page => page.getByRole("list", { name: "Apps with access" }) },
  {
    name: "apps whose access was removed",
    path: "/apps",
    title: "Apps · Silicon Accounts",
    ready: page => page.getByRole("list", { name: "Apps whose access you removed" }),
    open: async page => page.getByRole("button", { name: /^Access removed \(\d+\)$/ }).click({ timeout: 30_000 }),
  },
  { name: "active proofs", path: "/proofs", title: "User verification · Silicon Accounts", ready: page => page.getByRole("list", { name: "Active verifications" }) },
  {
    name: "ended proofs",
    path: "/proofs",
    title: "User verification · Silicon Accounts",
    ready: page => page.getByRole("list", { name: "Ended verifications" }),
    open: async page => page.getByRole("button", { name: /^Ended \(\d+\)$/ }).click({ timeout: 30_000 }),
  },
  { name: "activity", path: "/activity", title: "Activity · Silicon Accounts", ready: page => page.getByRole("region", { name: "Account activity" }) },
  {
    name: "activity filtered to an empty kind",
    path: "/activity",
    title: "Activity · Silicon Accounts",
    ready: page => page.getByText("Nothing here yet").first(),
    open: async page => page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Custodian", exact: true }).click({ timeout: 30_000 }),
  },
  { name: "settings", path: "/settings", title: "Settings · Silicon Accounts", ready: page => page.getByRole("list", { name: "Signed-in sessions" }) },
];

async function show(page: Page, site: string, view: View): Promise<boolean> {
  await page.goto(`${site}${view.path}`);
  if (view.open) {
    await page.locator("main").first().waitFor({ timeout: 30_000 });
    await sleep(600);
    await view.open(page);
  }
  const drawn = await view.ready(page).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  await sleep(700);
  return drawn;
}

const pages: Journey = {
  name: "account-site-pages",
  title: "every page and view of the account site with data on it: one main landmark, a title naming the page, headings from one h1 down without skipping a level, and nothing wider than a phone's screen (390 px)",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await newCarbon(ctx, "acct-pages");
    const { page, probe, uuid } = carbon;
    const email = await addContact(env, probe, "email", `acct.pages.more.${tag()}@example.test`);
    const phone = await addContact(env, probe, "phone", randomPhone());
    const briefcase = await signIntoApp(env, page, "briefcase");
    const commit = await signIntoApp(env, page, "commit");
    const issue = async () => (await postJson<{ body?: { proof_id?: string } }>(`${env.apps}/briefcase/actions/issue-obo`, { uuid, receiving_app: "commit", scopes: ["files.read"] })).body.body?.proof_id ?? "";
    const kept = await issue();
    const ended = await issue();
    const revoked = await call(probe, `/v1/me/proofs/${ended}`, { method: "DELETE" });
    const removed = await call(probe, "/v1/me/apps/commit", { method: "DELETE" });
    const me = await getMe(probe);
    results.check("setup: two emails, a phone number, Briefcase and Commit (Commit's access removed), one proof active and one ended", email.status === 200 && phone.status === 200 && briefcase?.uuid === uuid && commit?.uuid === uuid && !!kept && revoked.status === 204 && removed.status === 204 && me.emails.length === 2 && me.phones.length === 1, `${email.status} ${phone.status} ${revoked.status} ${removed.status}`);

    const drawnNot: string[] = [];
    const titles: string[] = [];
    const landmarks: string[] = [];
    const outlines: string[] = [];
    const skipped: string[] = [];
    for (const view of VIEWS) {
      if (!(await show(page, env.site, view))) drawnNot.push(view.name);
      const title = await page.title();
      if (title !== view.title) titles.push(`${view.name}: "${title}" (want "${view.title}")`);
      const outline = await headingOutline(page);
      if (outline.mains !== 1 || outline.h1 !== 1) landmarks.push(`${view.name}: ${outline.mains} main, ${outline.h1} h1`);
      outlines.push(`${view.name}: ${outline.headings.join(" > ")}`);
      if (outline.skips.length) skipped.push(`${view.name}: ${outline.skips.join("; ")}`);
    }
    results.check("every page and view draws its data", drawnNot.length === 0, drawnNot.join(", ") || VIEWS.map(view => view.name).join(", "));
    results.check("every page's title names it (\"<page> · Silicon Accounts\"; the identity home is the site's name)", titles.length === 0, titles.join(" | ") || "all as expected");
    results.check("every page and view has one main landmark and one h1", landmarks.length === 0, landmarks.join(" | ") || "all one and one");
    results.check("every page and view: headings start at the h1 and never skip a level", skipped.length === 0, skipped.length ? skipped.join(" | ") : outlines.join(" | ").slice(0, 900));

    // A phone: nothing wider than the screen, in any view.
    await page.setViewportSize({ width: 390, height: 844 });
    const wide: string[] = [];
    const widths: string[] = [];
    for (const view of VIEWS) {
      await show(page, env.site, view);
      const over = await overflowX(page);
      widths.push(`${view.name} ${over}`);
      if (over > 0) {
        wide.push(`${view.name}: ${over} px wider`);
        await shot(env, page, `acct-pages-wide-${view.name.replace(/[^a-z]+/g, "-")}`, true);
      }
    }
    await shot(env, page, "acct-pages-01-phone-settings", true);
    results.check("at 390 px no page or view is wider than the screen (no horizontal scroll)", wide.length === 0, wide.join(" | ") || widths.join(", "));
    await carbon.context.close();
  },
};

export const journey = pages;

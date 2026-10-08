/**
 * The developer site as an owner of several apps: the apps page (exactly the apps they own, as the API counts them, and
 * "New app" listing their stand-in apps), an app's Overview (its numbers and every part of its setup summarised from
 * the stored setup), the ten tabs switching in the browser (no reload, titles, Back and Forward), the old tab names
 * redirecting, an unknown tab a real 404, ⌘K, and a disabled app saying so.
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { developerApi, shot, sleep, sql } from "../../lib";
import { accessibleText, appDetail, ownerSignIn, type AppDetailView } from "./_helpers";

const METHOD: Record<string, string> = { google: "Google", apple: "Apple", email: "Email", phone: "Phone" };
const FIELD: Record<string, string> = { email: "Email address", phone: "Phone number", dob: "Date of birth", timezone: "Timezone" };
const plural = (count: number, one: string, other = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : other}`;
const TABS: Array<[string, string]> = [["overview", "Overview"], ["sign-in", "Sign-in"], ["details", "Details"], ["flows", "Flows"], ["pages", "Pages"], ["users", "Users"], ["import", "Import"], ["webhooks", "Webhooks"], ["ata", "App verification"], ["embed", "Embed"]];

/** What the Overview's setup cards say for a stored setup (developer/components/developer/tabs/overview.tsx). */
function expectedCards(app: AppDetailView): Record<string, string[]> {
  const c = app.signin_config;
  const enabled = c.method_order.filter(method => c.methods[method as keyof typeof c.methods]);
  const requested = [...c.required_fields, ...c.optional_fields.filter(field => !c.required_fields.includes(field))];
  const pages = c.flow?.steps.length ?? (requested.length ? 1 : 0);
  const hostOf = (url: string) => {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  };
  return {
    "Sign-in": [enabled.length ? enabled.map(method => METHOD[method]).join(", ") : "No method is on", `${plural(c.redirect_uris.length, "redirect URI")} · ${c.allow_signup ? "sign up allowed" : "existing accounts only"}`],
    Details: [requested.length ? requested.map(field => `${FIELD[field]}${c.optional_fields.includes(field) ? " (optional)" : ""}`).join(", ") : "Name, id and photo only"],
    Flows: [c.flow ? `Your own flow: ${plural(pages, "page")}${c.flow.review ? " and a review" : ""}` : requested.length ? "One page with every detail" : "The what's-shared page only"],
    Pages: [`${c.branding.layout.charAt(0).toUpperCase()}${c.branding.layout.slice(1)} layout · ${c.branding.font_family} · ${c.branding.corner_style} corners`, c.branding.theme === "auto" ? "Follows each visitor's light or dark setting" : `Always ${c.branding.theme}`],
    Users: [plural(app.stats.users, "Carbon or Silicon", "Carbons and Silicons"), `${app.stats.active_last_30d.toLocaleString("en-US")} signed in during the last 30 days`],
    Import: [app.stats.imported_unclaimed ? `${app.stats.imported_unclaimed.toLocaleString("en-US")} imported, not claimed yet` : "Bring your existing users"],
    Webhooks: app.webhook.url ? [hostOf(app.webhook.url), app.webhook.secret_set ? "Signed with a whsec_ secret" : "No signing secret stored"] : ["No webhook yet"],
    "App verification": ["Verify your app to one other app", "Create, review and revoke verification tokens"],
    Embed: [c.allowed_origins.length ? `${plural(c.allowed_origins.length, "allowed origin")} for the iframe` : "The hosted link and the SDK's buttons work on any site"],
  };
}

/** The app's own tab that is selected (an Embed tab has tabs of its own inside). */
const selectedTab = (page: Page) => page.getByRole("tablist", { name: / sections$/ }).getByRole("tab", { selected: true }).innerText().then(text => text.replace(/unsaved changes/, "").trim(), () => "");

export const journey: Journey = {
  name: "developer-site-overview",
  title: "an owner of four apps: the apps page lists exactly theirs with the API's numbers and New app lists their stand-in apps; an app's Overview summarises its stored setup; the ten tabs switch in the browser with titles, Back and Forward; old tab names redirect, an unknown tab is a 404; ⌘K jumps; a disabled app says so",
  async run(ctx) {
    const { env, results } = ctx;
    const appId = "commit";
    const { context, page } = await ownerSignIn(ctx, appId, { label: "overview", expected: [/status of 404 \(Not Found\)/] });

    // Nothing the developer site loads leaves this machine (the account menu shows the Carbon's photo).
    const external: string[] = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if ((url.protocol === "http:" || url.protocol === "https:") && !["localhost", "127.0.0.1"].includes(url.hostname)) external.push(request.url());
    });
    await page.reload();

    // The apps page: exactly the apps this Carbon owns.
    const list = page.getByRole("list", { name: "Your apps" });
    await list.waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Account menu/ }).waitFor({ timeout: 10_000 });
    await sleep(1200);
    const me = await developerApi<{ pfp_url?: string }>(env, page, "/me");
    results.check("the owner's profile photo comes from this stack's Iris, like every account made here, so the page loads nothing from the internet", (me.body.pfp_url ?? "").startsWith(env.iris) && external.length === 0, `pfp_url ${me.body.pfp_url}; loaded from outside: ${external.join(" ") || "nothing"}`);
    await sleep(500);
    await shot(env, page, "ds-e-01-apps");
    const owned = (await developerApi<{ items?: Array<{ app_id: string; name: string; users: number; source: string }> }>(env, page, "/me/owned-apps")).body.items ?? [];
    const tiles = await list.getByRole("link").evaluateAll(links => links.map(link => ({ href: link.getAttribute("href") ?? "", name: link.getAttribute("aria-label") ?? "" })));
    results.check("the apps page lists exactly the apps saket owns (briefcase, commit, remind, spacestation)", tiles.map(tile => tile.href).sort().join(" ") === ["briefcase", "commit", "remind", "spacestation"].map(id => `/apps/${id}`).join(" ") && owned.length === 4, tiles.map(tile => tile.href).join(" "));
    const named = owned.every(app => tiles.some(tile => tile.name === `${app.name}, ${app.app_id}, ${plural(app.users, "user")}, Stand-in app`));
    results.check("…each tile named by what it shows: name, id, the API's user count, Stand-in app", named, tiles.map(tile => tile.name).join(" | "));
    const notice = (await page.locator("main").getByRole("status").filter({ hasText: "Silicon Apps isn't open yet" }).innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("…with the notice that these are stand-in apps until Silicon Apps opens", /These are stand-in apps/.test(notice), notice);
    await page.getByRole("button", { name: "New app", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Apps come from Silicon Apps" });
    await dialog.waitFor({ timeout: 10_000 });
    const standIns = await dialog.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href") ?? "").filter(href => href.startsWith("/apps/")));
    results.check("New app explains Silicon Apps and lists the four stand-in apps", standIns.length === 4 && (await dialog.getByRole("link", { name: "Silicon Apps" }).count()) === 1, standIns.join(" "));
    await dialog.getByRole("link", { name: /Commit/ }).click();
    await page.waitForURL(`${env.developer}/apps/${appId}`, { timeout: 20_000 });
    results.check("…and opens one of them (the dialog closes)", (await dialog.count()) === 0, page.url());

    // The Overview: numbers and every part of the setup, from the stored setup.
    const panel = page.getByRole("tabpanel", { name: "Overview" });
    await panel.waitFor({ timeout: 30_000 });
    await panel.getByRole("link", { name: /^Sign-in / }).waitFor({ timeout: 20_000 });
    const detail = await appDetail(ctx, appId);
    const metrics = await Promise.all((await panel.locator("article").all()).map(card => accessibleText(card)));
    const metricOk = [["Users", detail.stats.users], ["Active in 30 days", detail.stats.active_last_30d], ["Imported, not claimed", detail.stats.imported_unclaimed]].every(([label, value]) => metrics.some(text => new RegExp(`^${label} ?${value}\\D`).test(text)));
    results.check("the three numbers are the API's (users, active in 30 days, imported not claimed)", metricOk, `${metrics.join(" | ")} vs ${JSON.stringify(detail.stats)}`);
    const expected = expectedCards(detail);
    const wrongCards: string[] = [];
    for (const [title, parts] of Object.entries(expected)) {
      const card = panel.getByRole("link", { name: new RegExp(`^${title} `) }).first();
      const text = (await card.innerText().catch(() => "")).replace(/\s+/g, " ");
      if (!parts.every(part => text.includes(part))) wrongCards.push(`${title}: "${text}" lacks ${parts.filter(part => !text.includes(part)).join(" / ")}`);
    }
    await shot(env, page, "ds-e-02-overview", true);
    results.check("every setup card summarises the stored setup (methods, redirect URIs, details, flow, look, users, webhook, origins)", wrongCards.length === 0, wrongCards.join(" | ") || Object.keys(expected).join(", "));
    const about = (await panel.getByRole("region", { name: "About this app" }).innerText()).replace(/\s+/g, " ");
    results.check("About this app: its id, Active, the owner's id and the stored setup's version", about.includes("commit") && /Status Active/.test(about) && about.includes("c:saket") && about.includes(`Version ${detail.config_version}`), about.slice(0, 300));

    // Tabs switch in the browser: no reload, the title follows, Back and Forward move between them.
    await page.evaluate(() => {
      (window as unknown as { __dsMarker?: number }).__dsMarker = 1;
    });
    await panel.getByRole("link", { name: /^Webhooks / }).click();
    await page.getByRole("tabpanel", { name: "Webhooks" }).waitFor({ timeout: 20_000 });
    const kept = await page.evaluate(() => (window as unknown as { __dsMarker?: number }).__dsMarker === 1);
    results.check("a setup card opens its tab in place: the address changes, the page is not reloaded", page.url() === `${env.developer}/apps/${appId}/webhooks` && kept, page.url());
    const titles: string[] = [];
    const wrongTabs: string[] = [];
    for (const [slug, label] of TABS) {
      const started = performance.now();
      await page.getByRole("tab", { name: label, exact: true }).click();
      await page.getByRole("tabpanel", { name: label }).waitFor({ timeout: 20_000 });
      const ms = performance.now() - started;
      const url = page.url();
      const title = await page.title();
      titles.push(title);
      if (url !== `${env.developer}/apps/${appId}${slug === "overview" ? "" : `/${slug}`}` || title !== `${label} · ${appId} · Silicon Developer` || (await selectedTab(page)) !== label) wrongTabs.push(`${label}: ${url} "${title}"`);
      results.metric(`switching to the ${label} tab`, ms);
    }
    const stillKept = await page.evaluate(() => (window as unknown as { __dsMarker?: number }).__dsMarker === 1);
    results.check("all ten tabs open in place with their address and document title (\"Sign-in · commit · Silicon Developer\")", wrongTabs.length === 0 && stillKept, wrongTabs.join(" | ") || titles.slice(0, 3).join(" | "));
    await page.goBack();
    await page.getByRole("tabpanel", { name: "App verification" }).waitFor({ timeout: 10_000 });
    const afterBack = `${page.url()} ${await selectedTab(page)}`;
    await page.goForward();
    await page.getByRole("tabpanel", { name: "Embed" }).waitFor({ timeout: 10_000 });
    results.check("Back and Forward move between tabs", afterBack === `${env.developer}/apps/${appId}/ata App verification` && page.url() === `${env.developer}/apps/${appId}/embed`, `${afterBack} → ${page.url()}`);

    // The account site's old tab names redirect; an unknown tab is a real 404.
    const branding = await page.goto(`${env.developer}/apps/${appId}/branding`);
    results.check("/apps/commit/branding (the old name) lands on the Pages tab", page.url() === `${env.developer}/apps/${appId}/pages` && branding?.status() === 200 && branding.request().redirectedFrom() !== null, page.url());
    await page.goto(`${env.developer}/apps/${appId}/proofs`);
    results.check("/apps/commit/proofs (the old name) lands on the ATA tab", page.url() === `${env.developer}/apps/${appId}/ata`, page.url());
    const unknown = await page.goto(`${env.developer}/apps/${appId}/settings`);
    const unknownText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    results.check("an unknown tab answers a real 404 with the not-found page", unknown?.status() === 404 && /Nothing lives at this address/.test(unknownText), `${unknown?.status()} ${unknownText.slice(0, 120)}`);

    // ⌘K: search and jump.
    await page.goto(`${env.developer}/apps/${appId}`);
    await page.getByRole("tabpanel", { name: "Overview" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /Search and jump/ }).click();
    const palette = page.getByRole("dialog", { name: "Search and jump" });
    await palette.waitFor({ timeout: 10_000 });
    await palette.getByRole("combobox").or(palette.getByRole("textbox")).first().fill("Users of Commit");
    await sleep(300);
    await page.keyboard.press("Enter");
    await page.getByRole("tabpanel", { name: "Users" }).waitFor({ timeout: 15_000 });
    results.check("⌘K → \"Users of Commit\" opens the Users tab", page.url() === `${env.developer}/apps/${appId}/users`, page.url());
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const reopened = await palette.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    await page.keyboard.press("Escape");
    results.check("…and the keyboard shortcut opens it too", reopened);
    await page.getByRole("link", { name: "Your apps" }).first().click();
    await page.waitForURL(`${env.developer}/`, { timeout: 15_000 });
    results.check("\"Your apps\" goes back to the apps page", page.url() === `${env.developer}/`);

    // A disabled app says so (Silicon Apps disables apps; the stand-in is disabled in its database row here).
    await sql(env, "update apps set status = 'disabled' where app_id = 'spacestation'");
    try {
      await page.goto(`${env.developer}/apps/spacestation`);
      const warning = page.getByRole("heading", { name: "Space Station is disabled" }).or(page.getByText("Space Station is disabled")).first();
      const shown = await warning.waitFor({ timeout: 20_000 }).then(() => true, () => false);
      await shot(env, page, "ds-e-03-disabled");
      const badge = (await page.locator("main header").innerText().catch(() => "")).includes("Disabled");
      results.check("a disabled app says it can't sign anyone in until Silicon Apps enables it, and still opens its setup", shown && badge && (await page.getByRole("tablist").count()) === 1, `${shown} ${badge}`);
      await page.goto(`${env.developer}/`);
      await page.getByRole("list", { name: "Your apps" }).waitFor({ timeout: 30_000 });
      const tile = await page.getByRole("link", { name: /^Disabled, Space Station/ }).count();
      results.check("…and its tile on the apps page starts with Disabled", tile === 1);
    } finally {
      await sql(env, "update apps set status = 'active' where app_id = 'spacestation'");
    }
    await context.close();
  },
};

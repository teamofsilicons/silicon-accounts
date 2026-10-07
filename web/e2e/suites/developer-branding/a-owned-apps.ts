/**
 * The developer area's front door: the apps a Carbon owns (exactly the ones the database says, with their user
 * counts), Silicon Apps for new ones, a signed-out visitor sent to sign in and brought back to the tab they asked
 * for, and the walls around other people's apps (pages and API, cookie and app credentials, CSRF).
 */
import type { Journey } from "../../context";
import { codeFor, json, lastSeq, newContext, shot, sleep, sql, tag } from "../../lib";
import { appBasic, asSession, fakeApp, forgetCodeSends, freshCarbonOnSite, keepIrisLocal } from "./_helpers";

interface OwnedApp {
  app_id: string;
  name: string;
  users: number;
  status: string;
  source: string;
}

export const journey: Journey = {
  name: "developer-branding-owned-apps",
  title: "developer home: the owner's apps exactly as stored, Silicon Apps links, sign-in return to the asked tab, a fresh Carbon's empty state and 403s on someone else's app",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const meta = (await json<{ silicon_apps_url: string }>(`${env.site}/v1/meta`)).body;
    const appsUrl = meta.silicon_apps_url.replace(/\/$/, "");

    // A signed-out visitor asks for a developer tab: sent to sign in, then back to exactly that tab.
    const ownerEmail = fakeApp("briefcase").owner_email!;
    await forgetCodeSends(env, ownerEmail);
    const context = await newContext(browser);
    const askedProductionIris: string[] = [];
    await keepIrisLocal(context, env, askedProductionIris);
    const page = await context.newPage();
    results.watch(page, "dvb-a-owner");
    const started = Date.now();
    await page.goto(`${env.site}/developer/briefcase/branding`);
    const emailField = page.getByRole("textbox", { name: "Email" });
    await emailField.waitFor({ timeout: 30_000 });
    results.check("a signed-out visitor to /developer/briefcase/branding is sent to sign in", !page.url().includes("/developer/"), page.url().slice(0, 120));
    const after = await lastSeq(env);
    await emailField.fill(ownerEmail);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, ownerEmail, after);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 25 });
    await page.waitForURL(`${env.site}/developer/briefcase/branding`, { timeout: 30_000 }).catch(() => undefined);
    const branding = page.getByRole("tab", { name: /^Branding/ });
    await branding.waitFor({ timeout: 20_000 }).catch(() => undefined);
    results.check("after signing in the owner lands back on the tab they asked for (Branding of briefcase)", page.url() === `${env.site}/developer/briefcase/branding` && (await branding.getAttribute("aria-selected").catch(() => null)) === "true", page.url());
    results.metric("signed-out visit → back on the developer tab", Date.now() - started);

    // The owner's apps: exactly what the database says they own, newest first, with live user counts.
    const stored = (await sql(env, "select a.app_id, a.name from apps a join accounts o on o.uuid = a.owner_uuid where o.handle = 'c:saket' order by a.created_at desc, a.app_id desc")).map(([id, name]) => ({ id: id!, name: name! }));
    const owned = await asSession<{ items: OwnedApp[] }>(page, env, "GET", "/v1/me/owned-apps?limit=100");
    const apiIds = (owned.body.items ?? []).map(item => item.app_id);
    results.check("GET /v1/me/owned-apps lists exactly the apps c:saket owns in the database, newest first", owned.status === 200 && JSON.stringify(apiIds) === JSON.stringify(stored.map(app => app.id)), `api ${apiIds.join(",")} | db ${stored.map(app => app.id).join(",")}`);
    for (const item of owned.body.items ?? []) {
      const [[live] = []] = await sql(env, `select count(*) from memberships m join accounts a on a.uuid = m.account_uuid where m.app_id = '${item.app_id}' and m.status in ('active', 'imported') and a.status <> 'deleted'`);
      results.check(`${item.app_id}: its user count (${item.users}) is its live members in the database`, item.users === Number(live), `db ${live}`);
    }
    await page.goto(`${env.site}/developer`);
    const list = page.getByRole("list", { name: "Your apps" });
    await list.waitFor({ timeout: 20_000 });
    await sleep(500);
    await shot(env, page, "dvb-a-01-owned-apps");
    const tiles = await list.getByRole("link").evaluateAll(links => links.map(link => ({ label: link.getAttribute("aria-label") ?? link.textContent ?? "", href: link.getAttribute("href") ?? "", target: link.getAttribute("target") })));
    const appTiles = tiles.filter(tile => tile.href.startsWith("/developer/"));
    const expectedLabels = (owned.body.items ?? []).map(item => `${item.name} (${item.app_id}), ${item.users} ${item.users === 1 ? "user" : "users"}`);
    results.check("the tiles are the owned apps, in the API's order, each with its name, app id and user count", JSON.stringify(appTiles.map(tile => tile.label)) === JSON.stringify(expectedLabels), appTiles.map(tile => tile.label).join(" | "));
    results.check("each tile opens that app's developer pages", appTiles.every((tile, index) => tile.href === `/developer/${apiIds[index]}`), appTiles.map(tile => tile.href).join(" "));
    const newApp = tiles.find(tile => /^New app/.test(tile.label));
    results.check("the New app tile opens Silicon Apps (meta.silicon_apps_url) in a new tab", !!newApp && newApp.href.replace(/\/$/, "") === appsUrl && newApp.target === "_blank", JSON.stringify(newApp));
    const headerNew = page.getByRole("main").getByRole("link", { name: /^New app/ }).first();
    results.check("the header's New app button opens Silicon Apps too", ((await headerNew.getAttribute("href")) ?? "").replace(/\/$/, "") === appsUrl);

    // The command palette on the developer home knows the owner's apps.
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("Open Commit", { delay: 20 });
    await sleep(300);
    await page.keyboard.press("Enter");
    await page.waitForURL(`${env.site}/developer/commit`, { timeout: 10_000 }).catch(() => undefined);
    results.check("the command palette's \"Open Commit\" opens commit's developer pages", page.url() === `${env.site}/developer/commit`, page.url());
    await page.goto(`${env.site}/developer`);
    await list.waitFor({ timeout: 20_000 });

    // A tile opens the app: its header and the overview's facts match what the API stores.
    await list.getByRole("link", { name: /^Remind \(remind\)/ }).click();
    await page.waitForURL(`${env.site}/developer/remind`, { timeout: 20_000 });
    await page.getByRole("heading", { level: 1, name: "Remind" }).waitFor({ timeout: 20_000 });
    const detail = await asSession<{ config_version: number; owner: { id: string } | null; status: string; source: string }>(page, env, "GET", "/v1/apps/remind");
    // The overview is its own chunk: its skeleton first, then the facts.
    await page.getByRole("tabpanel").getByText("About this app").waitFor({ timeout: 20_000 }).catch(() => undefined);
    const overview = (await page.getByRole("tabpanel").innerText()).replace(/\s+/g, " ");
    results.check("the overview names the owner (c:saket) and the stored sign-in setup version", overview.includes("c:saket") && overview.includes(`Version ${detail.body.config_version}`), `v${detail.body.config_version} ${overview.slice(0, 160)}`);
    const header = (await page.getByRole("main").locator("header").innerText()).replace(/\s+/g, " ");
    results.check("the header shows the app id, Active and its source (a stand-in until Silicon Apps)", header.includes("remind") && /Active/.test(header) && /Stand-in app/.test(header) && detail.body.status === "active" && detail.body.source === "fake", header.slice(0, 120));
    await shot(env, page, "dvb-a-02-remind-overview");

    // The owner's photo: a local stack must not send pages to the internet for it (the harness suite checks the same
    // for Carbons who sign up on the site).
    const [[ownerPhoto] = []] = await sql(env, "select pfp_url from accounts where handle = 'c:saket'");
    results.check("the seeded owner's default photo is on this stack's mock Iris, so no page reaches the internet for it", !!ownerPhoto?.startsWith(env.iris) && askedProductionIris.length === 0, `c:saket pfp_url ${ownerPhoto}; the owner's pages asked production Iris ${askedProductionIris.length} times (answered from the mock Iris by this journey)`);

    // CSRF: the owner's own cookie still needs the site's Origin to change anything.
    const noOrigin = await page.request.fetch(`${env.site}/v1/apps/remind/signin-config`, { method: "PATCH", headers: { "content-type": "application/json" }, data: JSON.stringify({ copy: { subtitle: `csrf ${t}` } }), failOnStatusCode: false });
    const evil = await page.request.fetch(`${env.site}/v1/apps/remind/signin-config`, { method: "PATCH", headers: { "content-type": "application/json", origin: "https://evil.example" }, data: JSON.stringify({ copy: { subtitle: `csrf ${t}` } }), failOnStatusCode: false });
    const evilBody = (await evil.json().catch(() => null)) as { error?: { code?: string } } | null;
    const after2 = await asSession<{ config_version: number; signin_config: { copy: { subtitle: string | null } } }>(page, env, "GET", "/v1/apps/remind");
    results.check("a cookie PATCH without an Origin, or from another site, is refused (403 origin_not_allowed) and changes nothing", noOrigin.status() === 403 && evil.status() === 403 && evilBody?.error?.code === "origin_not_allowed" && after2.body.config_version === detail.body.config_version && after2.body.signin_config.copy.subtitle !== `csrf ${t}`, `${noOrigin.status()} ${evil.status()} ${evilBody?.error?.code}`);
    await context.close();

    // App credentials manage their own app only.
    const mismatch = await json<{ error?: { code?: string } }>(`${env.site}/v1/apps/briefcase`, { headers: { authorization: appBasic("remind") } });
    const wrongSecret = await json<{ error?: { code?: string } }>(`${env.site}/v1/apps/briefcase`, { headers: { authorization: appBasic("briefcase", `${fakeApp("briefcase").secret}x`) } });
    const right = await json<{ app_id?: string }>(`${env.site}/v1/apps/briefcase`, { headers: { authorization: appBasic("briefcase") } });
    results.check("another app's credentials get 403 app_mismatch, a wrong secret 401, the app's own credentials 200", mismatch.status === 403 && mismatch.body.error?.code === "app_mismatch" && wrongSecret.status === 401 && right.status === 200 && right.body.app_id === "briefcase", `${mismatch.status} ${mismatch.body.error?.code}, ${wrongSecret.status} ${wrongSecret.body.error?.code}, ${right.status}`);

    // A fresh Carbon owns nothing: the empty state, Silicon Apps, and walls around everyone else's apps.
    const fresh = await freshCarbonOnSite(ctx, "dvb-a-fresh", { expected: [/status of 40[34]/] });
    await fresh.page.goto(`${env.site}/developer`);
    await fresh.page.getByText("No apps yet").waitFor({ timeout: 20_000 });
    const create = fresh.page.getByRole("link", { name: /Create an app in Silicon Apps/ });
    results.check("a Carbon who owns nothing sees \"No apps yet\" and a link to create one in Silicon Apps", (await create.count()) === 1 && ((await create.getAttribute("href")) ?? "").replace(/\/$/, "") === appsUrl && (await fresh.page.getByRole("list", { name: "Your apps" }).count()) === 0);
    await shot(env, fresh.page, "dvb-a-03-fresh-empty");
    const none = await asSession<{ items: unknown[] }>(fresh.page, env, "GET", "/v1/me/owned-apps");
    results.check("GET /v1/me/owned-apps for a fresh Carbon is empty", none.status === 200 && Array.isArray(none.body.items) && none.body.items.length === 0, JSON.stringify(none.body).slice(0, 120));
    await fresh.page.goto(`${env.site}/developer/briefcase`);
    const notYours = fresh.page.getByText("You don't own briefcase");
    await notYours.waitFor({ timeout: 20_000 }).catch(() => undefined);
    results.check("someone else's app says \"You don't own briefcase\" (and shows none of its setup)", (await notYours.count()) > 0 && (await fresh.page.getByRole("tablist").count()) === 0);
    await shot(env, fresh.page, "dvb-a-04-not-yours");
    const walls: Array<[string, string, unknown?]> = [
      ["GET", "/v1/apps/briefcase"],
      ["GET", "/v1/apps/briefcase/signin-config/history"],
      ["PATCH", "/v1/apps/briefcase/signin-config", { copy: { title: `Owned by ${t}` } }],
      ["GET", "/v1/apps/briefcase/users"],
      ["GET", "/v1/apps/briefcase/webhook/deliveries"],
      ["POST", "/v1/apps/briefcase/webhook/test", {}],
      ["POST", "/v1/apps/briefcase/proofs/ata", { audiences: ["remind"] }],
      ["GET", "/v1/apps/briefcase/proofs"],
    ];
    const answers: string[] = [];
    let walled = true;
    for (const [method, path, body] of walls) {
      const answer = await asSession<{ error?: { code?: string } }>(fresh.page, env, method, path, body);
      answers.push(`${method} ${path.replace("/v1/apps/briefcase", "")} → ${answer.status} ${answer.body?.error?.code ?? ""}`);
      if (answer.status !== 403 || answer.body?.error?.code !== "not_app_owner") walled = false;
    }
    results.check("every management call on someone else's app answers 403 not_app_owner", walled, answers.join("; "));
    const [[title] = []] = await sql(env, "select config->'copy'->>'title' from app_signin_configs where app_id = 'briefcase'");
    results.check("the refused PATCH left briefcase's setup alone", title !== `Owned by ${t}`, String(title));
    await fresh.page.goto(`${env.site}/developer/no-such-app-${t}`);
    const missing = fresh.page.getByText(`No app with the id no-such-app-${t}`);
    await missing.waitFor({ timeout: 20_000 }).catch(() => undefined);
    results.check("an app id that does not exist says so", (await missing.count()) > 0);
    await fresh.context.close();
  },
};

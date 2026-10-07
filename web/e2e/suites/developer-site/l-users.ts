/**
 * The Users tab (UNDERSTANDING "The app's user base"): every Carbon and Silicon that signed into Browser, or that it
 * imported, with exactly the details each one shares with it and only the columns Silicon Accounts gives. Members made
 * fresh for this walk: a Carbon who ticked the optional timezone, one who left it unticked and then removed Browser's
 * access, a Silicon that came in with a short-lived token, and a user Browser's server imported. The owner searches
 * (on the server: name, id, email, external id), filters by status, kind and source, and opens each one's drawer (uuid,
 * membership, how they joined, what they share, recent sign-ins). An empty user base explains where users come from.
 */
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { developerApi, shot, sleep, tag } from "../../lib";
import { ownerSignIn } from "./_helpers";
import { importAsApp, joinApp, siliconJoins, siteCall, until } from "./_kit";

const APP = "browser";

interface UserView {
  uuid: string;
  membership_id: string;
  kind: string;
  id: string | null;
  display_name: string;
  email?: string | null;
  phone?: string | null;
  dob?: string | null;
  timezone?: string | null;
  status: string;
  source: string;
  external_id: string | null;
  granted_scopes: string[];
  first_signed_in_at: string | null;
  last_signed_in_at: string | null;
  [key: string]: unknown;
}

const ALLOWED_KEYS = new Set(["membership_id", "uuid", "kind", "id", "display_name", "pfp_url", "email", "phone", "dob", "timezone", "status", "account_status", "source", "external_id", "granted_scopes", "first_signed_in_at", "last_signed_in_at", "created_at", "custodian", "email_verified", "phone_verified"]);

/** The rows the table shows now (their text), once the list settled. */
async function tableRows(panel: Locator): Promise<string[]> {
  await sleep(450);
  await panel.page().waitForFunction(() => !document.querySelector('[role="tabpanel"] [aria-busy="true"]'), undefined, { timeout: 10_000 }).catch(() => undefined);
  return (await panel.locator("table tbody tr").allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim());
}

/** Adds a filter with the toolbar's Add filter menu: a field, then a value. */
async function addFilter(page: Page, panel: Locator, field: string, value: string): Promise<void> {
  await panel.getByRole("button", { name: "Add filter" }).click();
  const menu = page.getByRole("dialog", { name: "Add filter" });
  await menu.getByRole("menuitem", { name: field, exact: true }).click();
  await page.getByRole("menuitemradio", { name: value, exact: true }).click();
  await sleep(300);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Opens a user's drawer from their row's name button ("<name>, <id>") and returns its text. */
async function drawerOf(page: Page, panel: Locator, name: string, id: string): Promise<string> {
  await panel.getByRole("button", { name: new RegExp(`^${escape(name)}, ${escape(id)}$`) }).first().click();
  const drawer = page.getByRole("dialog", { name });
  await drawer.waitFor({ timeout: 10_000 });
  await drawer.getByRole("region", { name: "Recent sign-ins" }).waitFor({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForFunction(() => !document.querySelector('[role="dialog"] [aria-label="Loading sign-ins"]'), undefined, { timeout: 10_000 }).catch(() => undefined);
  await sleep(300);
  return (await drawer.innerText()).replace(/\s+/g, " ").trim();
}

async function closeDrawer(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
}

export const journey: Journey = {
  name: "developer-site-users",
  title: "the Users tab: Browser's members (a Carbon sharing its timezone, one who removed access, a Silicon in with a short-lived token, an imported user) each with only what they share; search on the server by name, id, email and external id; filters by status, kind and source; each one's drawer with uuid, membership, how they joined, what they share and recent sign-ins; the empty state",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const owner = await ownerSignIn(ctx, APP, { label: "users-owner", returnTo: `/apps/${APP}/users` });
    const { page, context } = owner;
    try {
      const panel = page.getByRole("tabpanel", { name: "Users" });
      await panel.waitFor({ timeout: 30_000 });
      const list = async (query = "") => (await developerApi<{ items?: UserView[] }>(env, page, `/apps/${APP}/users?limit=200${query}`)).body.items ?? [];

      // An empty user base says where users come from (a fresh stack: nobody has signed into Browser yet).
      const before = await list();
      if (before.length === 0) {
        await panel.getByText("No one has signed in yet").waitFor({ timeout: 15_000 }).catch(() => undefined);
        const empty = (await panel.innerText()).replace(/\s+/g, " ");
        const ways = (await panel.getByRole("button", { name: "Add sign-in to your app" }).count()) === 1 && (await panel.getByRole("button", { name: "Import users" }).count()) === 1;
        results.check("an empty user base says who appears there and offers \"Add sign-in to your app\" and \"Import users\"", /No one has signed in yet/.test(empty) && /Carbons and Silicons who sign in to Browser, and users you import, appear here/.test(empty) && ways, empty.slice(0, 200));
        await panel.getByRole("button", { name: "Import users" }).click();
        await page.waitForURL(url => url.pathname === `/apps/${APP}/import`, { timeout: 10_000 }).catch(() => undefined);
        results.check("…and \"Import users\" opens the Import tab", new URL(page.url()).pathname === `/apps/${APP}/import`, page.url());
      } else {
        results.check("the user base was not empty (a stack walked before), so its empty state is not shown", true, `${before.length} users already`);
      }

      // Four members, each in their own way.
      const ada = await joinApp(ctx, APP, "users-ada", { tick: ["timezone"] });
      const bo = await joinApp(ctx, APP, "users-bo", {});
      results.check("two fresh Carbons sign up into Browser from its own link (one ticks the optional timezone)", !!ada.uuid && !!bo.uuid && ada.account.timezone !== undefined && bo.account.timezone === undefined, `${ada.uuid} tz=${String(ada.account.timezone)}; ${bo.uuid} tz=${String(bo.account.timezone)}`);
      const silicon = await siliconJoins(ctx, ada.page, APP, `ds-users-${t}`);
      results.check("a Silicon (Ada its custodian) joins Browser with a short-lived token its server exchanges", silicon.exchange.status === 200, JSON.stringify(silicon.exchange.body).slice(0, 200));
      const importedEmail = `ds-users-imported-${t}@example.test`;
      const importedName = `Imported Ivy ${t}`;
      const job = await importAsApp(ctx, APP, [{ email: importedEmail, display_name: importedName, external_id: `crm-${t}` }]);
      results.check("Browser's server imports one user (created, waiting for their first sign-in)", job.status === "completed" && job.counts.created === 1, JSON.stringify(job.counts));
      const removed = await siteCall(bo.page, env, "DELETE", `/v1/me/apps/${APP}`);
      results.check("Bo removes Browser's access on the account site", removed.status === 204 || removed.status === 200, `${removed.status} ${JSON.stringify(removed.body).slice(0, 120)}`);

      // What the API (through the developer site) lists: each member with only what they share.
      const users = await until(async () => {
        const items = await list();
        return items.some(item => item.uuid === silicon.uuid) && items.some(item => item.display_name === importedName) && items.find(item => item.uuid === bo.uuid)?.status === "access_removed" ? items : null;
      }, 15_000, 500) ?? await list();
      const a = users.find(item => item.uuid === ada.uuid);
      const b = users.find(item => item.uuid === bo.uuid);
      const s = users.find(item => item.uuid === silicon.uuid);
      const i = users.find(item => item.display_name === importedName);
      results.check("Ada: active, joined by sign-in, membership browser:<uuid>, shares her timezone and nothing else (Browser asks for no email)", a?.status === "active" && a.source === "signin" && a.membership_id === `${APP}:${ada.uuid}` && a.kind === "carbon" && !!a.timezone && a.granted_scopes.includes("timezone") && !a.email && !a.phone && !a.dob, JSON.stringify(a));
      results.check("Bo: access removed, his timezone (never ticked) not there, and nothing of his own shown any more (name \"Access removed\", only uuid, membership and id stay)", b?.status === "access_removed" && b.display_name === "Access removed" && !b.timezone && !b.email && !(b.granted_scopes ?? []).includes("timezone") && b.id === bo.account.id && b.membership_id === `${APP}:${bo.uuid}`, JSON.stringify(b));
      results.check("the Silicon: kind silicon, joined with a short-lived token (source slt), active", s?.kind === "silicon" && s.source === "slt" && s.status === "active" && s.id === silicon.id, JSON.stringify(s));
      results.check("the imported user: imported, source import, the imported email and external id, never signed in", i?.status === "imported" && i.source === "import" && i.email === importedEmail && i.external_id === `crm-${t}` && i.first_signed_in_at === null, JSON.stringify(i));
      const extra = users.flatMap(item => Object.keys(item).filter(key => !ALLOWED_KEYS.has(key)));
      results.check("every row has only the columns Silicon Accounts gives (nothing an app could add)", extra.length === 0, extra.length ? `extra keys: ${[...new Set(extra)].join(", ")}` : `keys: ${Object.keys(a ?? {}).join(", ")}`);

      // The table.
      await page.goto(`${env.developer}/apps/${APP}/users`);
      await panel.waitFor({ timeout: 30_000 });
      await panel.locator("table").waitFor({ timeout: 20_000 });
      const all = await tableRows(panel);
      const rowOf = (name: string) => all.find(row => row.includes(name)) ?? "";
      const adaName = String(ada.account.display_name ?? "");
      const adaId = String(ada.account.id ?? "");
      // An account that removed the app's access keeps its row as history, without its name (crates/apps/src/users.rs).
      const boName = "Access removed";
      const boId = String(bo.account.id ?? "");
      const boRealName = String(bo.account.display_name ?? "");
      results.check("the table lists them with kind, status, contact and how they joined", /Carbon/.test(rowOf(adaName)) && /Active/.test(rowOf(adaName)) && /Not shared/.test(rowOf(adaName)) && /Sign-in/.test(rowOf(adaName)) && /Access removed/.test(rowOf(boId)) && !rowOf(boId).includes(boRealName) && /Silicon/.test(rowOf(silicon.id)) && /Silicon token/.test(rowOf(silicon.id)) && /Imported/.test(rowOf(importedName)) && rowOf(importedName).includes(importedEmail) && /Import/.test(rowOf(importedName)) && /Never/.test(rowOf(importedName)), [rowOf(adaName), rowOf(boId), rowOf(silicon.id), rowOf(importedName)].join(" | "));
      const headers = (await panel.locator("table thead th").allInnerTexts()).map(text => text.trim());
      results.check("…under the columns Name, Kind, Status, Email or phone, Joined through, Last sign-in", headers.join("|") === "Name|Kind|Status|Email or phone|Joined through|Last sign-in", headers.join(" | "));
      const count = (await panel.getByText(/users? shown/).innerText().catch(() => "")).trim();
      results.check("…and counts the users shown", new RegExp(`^${all.length} users? shown`).test(count), `${count} (${all.length} rows)`);
      await shot(env, page, "ds-l-01-users");

      // Search runs on the server.
      const search = panel.getByRole("searchbox", { name: "Search users" });
      const searchFor = async (text: string) => {
        await search.fill(text);
        await sleep(700);
        return tableRows(panel);
      };
      const byName = await searchFor(adaName);
      const byEmail = await searchFor(importedEmail);
      const byExternal = await searchFor(`crm-${t}`);
      const bySiliconId = await searchFor(silicon.id);
      const none = await searchFor(`nobody-${t}`);
      results.check("search finds by name, by imported email, by external id and by si:id (one row each)", byName.length === 1 && byName[0]!.includes(adaName) && byEmail.length === 1 && byEmail[0]!.includes(importedName) && byExternal.length === 1 && byExternal[0]!.includes(importedName) && bySiliconId.length === 1 && bySiliconId[0]!.includes(silicon.id), [byName, byEmail, byExternal, bySiliconId].map(rows => `${rows.length}: ${rows[0]?.slice(0, 40) ?? ""}`).join(" | "));
      results.check("…and says so when nothing matches", none.length === 1 && /No user matches this search and these filters/.test(none[0] ?? ""), none.join(" | "));
      const viaApi = await list(`&q=${encodeURIComponent(`crm-${t}`)}`);
      results.check("the same search through the API answers the same row", viaApi.length === 1 && viaApi[0]?.display_name === importedName, `${viaApi.length}`);
      await panel.getByRole("button", { name: "Clear search" }).click();
      await sleep(600);

      // Filters, applied on the server.
      await addFilter(page, panel, "Kind", "Silicon");
      const silicons = await tableRows(panel);
      results.check("Kind · Silicon shows only Silicons", silicons.length >= 1 && silicons.every(row => /Silicon/.test(row)) && silicons.some(row => row.includes(silicon.id)) && !silicons.some(row => row.includes(adaName)), silicons.map(row => row.slice(0, 40)).join(" | "));
      await panel.getByRole("button", { name: "Clear all" }).click();
      await addFilter(page, panel, "Status", "Imported");
      const imported = await tableRows(panel);
      results.check("Status · Imported shows only imported users", imported.length >= 1 && imported.every(row => /Imported/.test(row)) && imported.some(row => row.includes(importedName)), imported.map(row => row.slice(0, 40)).join(" | "));
      await addFilter(page, panel, "Source", "Sign-in");
      const both = await tableRows(panel);
      results.check("Status · Imported with Source · Sign-in shows nobody (filters combine)", both.length === 1 && /No user matches/.test(both[0] ?? ""), both.join(" | "));
      await panel.getByRole("button", { name: "Remove Status: Imported" }).click();
      const signins = await tableRows(panel);
      results.check("removing the status chip leaves Source · Sign-in: the Carbons who signed in", signins.some(row => row.includes(adaName)) && signins.some(row => row.includes(boId)) && !signins.some(row => row.includes(importedName) || row.includes(silicon.id)), signins.map(row => row.slice(0, 40)).join(" | "));
      await panel.getByRole("button", { name: "Clear all" }).click();
      await sleep(500);

      // Each one's drawer.
      const adaDrawer = await drawerOf(page, panel, adaName, adaId);
      await shot(env, page, "ds-l-02-drawer");
      results.check("Ada's drawer: uuid, membership, joined through Sign-in, shares Timezone with its value, first and last sign-in", adaDrawer.includes(ada.uuid) && adaDrawer.includes(`${APP}:${ada.uuid}`) && /Joined through Sign-in/.test(adaDrawer) && /Shares (Profile )?Timezone/.test(adaDrawer) && adaDrawer.includes(String(a?.timezone)) && !/First signed in Not yet/.test(adaDrawer), adaDrawer.slice(0, 400));
      results.check("…and her recent sign-ins (the email code that made her account)", /Recent sign-ins/.test(adaDrawer) && /Email code/.test(adaDrawer) && /(New account|Signed in)/.test(adaDrawer), adaDrawer.slice(adaDrawer.indexOf("Recent sign-ins"), adaDrawer.indexOf("Recent sign-ins") + 160));
      await closeDrawer(page);
      const boDrawer = await drawerOf(page, panel, boName, boId);
      results.check("Bo's drawer: Access removed and why, his id and uuid, no name, timezone or contact of his", /Access removed/.test(boDrawer) && /Signed out of the app or removed its access/.test(boDrawer) && boDrawer.includes(bo.uuid) && boDrawer.includes(boId) && !boDrawer.includes(boRealName) && !/Timezone/.test(boDrawer), boDrawer.slice(0, 300));
      await closeDrawer(page);
      const siliconDrawer = await drawerOf(page, panel, `Silicon ds-users-${t}`, silicon.id);
      results.check("the Silicon's drawer: a Silicon, joined with a Silicon token, its short-lived token sign-in", /Silicon/.test(siliconDrawer) && /Joined through Silicon token/.test(siliconDrawer) && /Short-lived token/.test(siliconDrawer) && siliconDrawer.includes(silicon.uuid), siliconDrawer.slice(0, 400));
      await closeDrawer(page);
      const importedDrawer = await drawerOf(page, panel, importedName, String(i?.id ?? ""));
      results.check("the imported user's drawer: Imported (becomes active at first sign-in), the imported email, the external id, never signed in", /Imported/.test(importedDrawer) && /becomes active the first time they sign in/.test(importedDrawer) && importedDrawer.includes(`Email (imported) ${importedEmail}`) && importedDrawer.includes(`External id crm-${t}`) && /First signed in Not yet/.test(importedDrawer) && /No sign-ins to Browser yet: imported users appear here after their first sign-in/.test(importedDrawer), importedDrawer.slice(0, 500));
      await closeDrawer(page);

      // The drawer's read of one user goes through the BFF too, with the same view.
      const one = await developerApi<{ uuid?: string; history?: Array<{ method?: string }> }>(env, page, `/apps/${APP}/users/${ada.uuid}`);
      results.check("GET /apps/browser/users/{uuid} through the developer site: Ada with her sign-in history", one.status === 200 && one.body.uuid === ada.uuid && (one.body.history ?? []).some(entry => entry.method === "email"), `${one.status} ${JSON.stringify(one.body).slice(0, 200)}`);
      await Promise.all([ada.context.close(), bo.context.close()]);
    } finally {
      await context.close();
    }
  },
};

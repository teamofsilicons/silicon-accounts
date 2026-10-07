/**
 * commit's user base as its owner sees it, after six fresh members of every kind arrive: two Carbons who signed in
 * (one also shared their timezone), one who later removed commit's access, two imported users (one with a phone)
 * and a Silicon that signed in with a short-lived token. The table lists them with kind, status, contact and source;
 * search finds them by name, c:id, email, phone and external id, but never by data the app may no longer see (the
 * member who removed access stays as history, listed as "Access removed" with their id and none of their own data:
 * not their name, nor their email); the status, kind and source filters narrow them; each row's drawer shows the
 * membership, what it shares and its sign-ins. The overview's numbers move with them.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { json, shot, sleep, tag } from "../../lib";
import { apiSignUp, appBasic, asApiBrowser, asApp, asSession, ownerSignIn, randomPhone, until, type ApiSignIn } from "./_helpers";

const APP = "commit";

interface AppUser {
  uuid: string;
  id: string | null;
  display_name: string;
  kind: string;
  status: string;
  source: string;
  email?: string;
  phone?: string;
  timezone?: string;
  external_id: string | null;
  granted_scopes: string[];
}

interface Stats {
  users: number;
  active_last_30d: number;
  imported_unclaimed: number;
}

/** The rows in the table now (after the debounce and the request), as their names say them: "<name>, <id>". */
async function rowNames(page: Page): Promise<string[]> {
  // Each row's name button is labelled "<name>, <id>" (what it shows; it used to be "Open <name> (<id>)").
  return page.locator("table tbody tr [data-open-user]").evaluateAll(buttons => buttons.map(button => (button.getAttribute("aria-label") ?? "").replace(/^Open /, "")));
}

/** The display name an app sees for an account that removed its access (crates/apps users.rs). */
const ACCESS_REMOVED = "Access removed";

export const journey: Journey = {
  name: "developer-branding-users",
  title: "user base: six fresh members (sign-in, timezone, access removed, two imports, a Silicon by SLT) listed with kind/status/contact/source; search by name, id, email, phone, external id but never by hidden contacts; status/kind/source filters; drawers; overview numbers",
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const statsBefore = (await asApp<{ stats: Stats }>(ctx, APP, `/v1/apps/${APP}`)).body.stats;

    // Six new members.
    const setupStarted = Date.now();
    const ada = await apiSignUp(ctx, APP, { displayName: `Ada Lovelace ${t}`, email: `dvb.ada.${t}@example.test` });
    const brook = await apiSignUp(ctx, APP, { displayName: `Brook Leaving ${t}`, email: `dvb.brook.${t}@example.test` });
    const cara = await apiSignUp(ctx, APP, { displayName: `Cara Zones ${t}`, email: `dvb.cara.${t}@example.test`, optionalScopes: ["timezone"] });
    const removed = await asApiBrowser(brook, "DELETE", `/v1/me/apps/${APP}`);
    results.check("one member removes commit's access on the account site (204)", removed.status === 204, String(removed.status));
    const importPhone = randomPhone();
    const imported = await asApp<{ job: { id: string } }>(ctx, APP, `/v1/apps/${APP}/imports`, {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      json: { rows: [
        { external_id: `crm-${t}-1`, email: `dvb.imp1.${t}@example.test`, display_name: `Imported One ${t}`, phone: importPhone },
        { external_id: `crm-${t}-2`, email: `dvb.imp2.${t}@example.test`, display_name: `Imported Two ${t}`, username: `dvb-imp2-${t}` },
      ], options: {} },
    });
    const jobId = imported.body.job?.id ?? "";
    const job = await until(async () => {
      const answer = await asApp<{ job?: { status: string }; status?: string }>(ctx, APP, `/v1/apps/${APP}/imports/${jobId}`);
      const status = answer.body.job?.status ?? answer.body.status;
      return status === "completed" || status === "failed" ? status : null;
    }, 30_000, 300);
    results.check("commit imports two users (job completed)", imported.status === 202 && job === "completed", `${imported.status} ${job}`);
    // A Silicon, created by a fresh custodian, signs in to commit with a short-lived token.
    const custodian = await apiSignUp(ctx, "accounts", { displayName: `Custodian ${t}` });
    const created = await asApiBrowser<{ silicon?: { uuid: string; id: string }; stk?: string }>(custodian, "POST", "/v1/me/silicons", { id: `si:dvb-scout-${t}`, display_name: `Scout Silicon ${t}` });
    const stk = created.body.stk ?? "";
    const login = await json<{ access_token?: string }>(`${env.site}/v1/silicons/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ctx.ip }, body: JSON.stringify({ id: `si:dvb-scout-${t}`, stk }) });
    const slt = await json<{ slt?: string }>(`${env.site}/v1/me/short-lived-tokens`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${login.body.access_token ?? ""}` }, body: JSON.stringify({ app_id: APP }) });
    const exchanged = await json<{ account?: { uuid: string } }>(`${env.site}/v1/oauth/token`, { method: "POST", headers: { authorization: appBasic(APP), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:silicon:params:oauth:grant-type:slt", slt: slt.body.slt ?? "" }).toString() });
    results.check("a Silicon signs in to commit with a short-lived token (created → login → SLT → exchange)", created.status === 201 && login.status === 200 && (slt.status === 200 || slt.status === 201) && exchanged.status === 200 && exchanged.body.account?.uuid === created.body.silicon?.uuid, `${created.status} ${login.status} ${slt.status} ${exchanged.status}`);
    results.metric("user base setup (3 sign-ins, 1 removal, 2 imports, 1 Silicon)", Date.now() - setupStarted);
    const siliconUuid = created.body.silicon?.uuid ?? "";

    // The API's view of the same people (what the table shows comes from here). The tag is in every new member's id,
    // so it finds Brook too (by id: Brook's name is no longer the app's to see).
    const listed = (await asApp<{ items: AppUser[] }>(ctx, APP, `/v1/apps/${APP}/users?q=${t}&limit=50`)).body.items ?? [];
    const by = (needle: string) => listed.find(user => user.display_name.includes(needle));
    const brookRow = listed.find(user => user.uuid === brook.uuid);
    results.check("the user base lists all six, each with the right kind, status and source", listed.length === 6 && by("Ada")?.status === "active" && brookRow?.status === "access_removed" && by("Imported One")?.status === "imported" && by("Imported One")?.source === "import" && by("Scout")?.kind === "silicon" && by("Scout")?.source === "slt" && by("Cara")?.source === "signin", listed.map(user => `${user.display_name}:${user.kind}/${user.status}/${user.source}`).join(", "));
    results.check("contact fields follow what each member shares: Ada's email; Cara's email and timezone; Brook nothing any more; the import's own values; the Silicon none", by("Ada")?.email === ada.email && !by("Ada")?.timezone && by("Cara")?.timezone === "Asia/Kolkata" && !!brookRow && brookRow.email === undefined && brookRow.phone === undefined && brookRow.timezone === undefined && by("Imported One")?.phone === importPhone && by("Scout")?.email === undefined, JSON.stringify(listed.map(user => [user.display_name, user.email ?? null, user.phone ?? null, user.timezone ?? null])).slice(0, 400));
    results.check(`the member who removed access stays listed as "${ACCESS_REMOVED}" with their id, and none of their own data (not their name)`, !!brookRow && brookRow.display_name === ACCESS_REMOVED && brookRow.id === brook.id && !JSON.stringify(brookRow).includes(`Brook Leaving ${t}`) && !JSON.stringify(brookRow).includes(brook.email), JSON.stringify(brookRow ?? null).slice(0, 300));

    // The owner's table.
    const owner = await ownerSignIn(ctx, APP, "dvb-i-owner");
    const { page } = owner;
    await page.goto(`${env.site}/developer/${APP}/users`);
    const search = page.getByRole("searchbox").first();
    await search.waitFor({ timeout: 20_000 });
    // The table keeps the previous rows while the next search runs (after a 260 ms pause in typing), so a search is
    // done when the rows are the ones wanted (or, when it never gets there, after 10 s: the check then shows them).
    const searchFor = async (text: string, wanted: string[]): Promise<{ names: string[]; ms: number }> => {
      const started = Date.now();
      await search.fill(text);
      let names: string[] = [];
      for (let attempt = 0; attempt < 40; attempt++) {
        await sleep(250);
        names = await rowNames(page);
        const busy = await page.locator("[aria-busy='true']").count();
        if (!busy && names.length === wanted.length && wanted.every(name => names.some(row => row.includes(name)))) break;
      }
      return { names, ms: Date.now() - started };
    };
    // Rows are named "<name>, <id>"; Brook's says "Access removed, <Brook's id>".
    const six = ["Ada", brook.id, "Cara", "Imported One", "Imported Two", "Scout"];
    const all = await searchFor(t, six);
    results.check("searching the run's tag shows the six new members", all.names.length === 6 && six.every(name => all.names.some(row => row.includes(name))), all.names.join(" | "));
    results.check(`the row of the member who removed access reads "${ACCESS_REMOVED}, ${brook.id}"`, all.names.includes(`${ACCESS_REMOVED}, ${brook.id}`) && !all.names.some(row => row.includes("Brook Leaving")), all.names.find(row => row.includes(brook.id)) ?? "no row");
    results.metric("user search (typing → rows)", all.ms);
    const table = (await page.locator("table tbody").innerText()).replace(/\s+/g, " ");
    results.check("the rows show kind, status, contact and source in words (Silicon, Imported, Access removed, Not shared, Import, Silicon token)", /Silicon/.test(table) && /Imported/.test(table) && /Access removed/.test(table) && /Not shared/.test(table) && /Silicon token/.test(table) && /Import/.test(table) && table.includes(ada.email), table.slice(0, 300));
    results.check(`the footer counts them ("6 users shown")`, (await page.getByText("6 users shown").count()) > 0);
    await shot(env, page, "dvb-i-01-users", true);

    const finds = async (what: string, text: string, wanted: string[]) => {
      const found = await searchFor(text, wanted);
      results.check(`search by ${what} finds ${wanted.length ? wanted.join(", ") : "no one"}`, found.names.length === wanted.length && wanted.every(name => found.names.some(row => row.includes(name))), `"${text}" → ${found.names.join(" | ") || "none"}`);
    };
    await finds("email", ada.email, ["Ada"]);
    await finds("c:id", ada.id, ["Ada"]);
    await finds("display name", `Imported Two ${t}`, ["Imported Two"]);
    await finds("external id", `crm-${t}-1`, ["Imported One"]);
    await finds("the imported phone", importPhone, ["Imported One"]);
    await finds("the email of a member who removed access (the app may no longer see it)", brook.email, []);
    results.check("with no match the table says so", (await page.getByText("No user matches this search and these filters.").count()) > 0);
    await finds("the former name of a member who removed access (the app may no longer see it)", `Brook Leaving ${t}`, []);
    await finds("the id of a member who removed access (it stays the app's to see)", brook.id, [brook.id]);

    // Filters, on top of the tag search.
    await searchFor(t, six);
    const filterBy = async (field: string, value: string, wanted: string[]) => {
      await page.getByRole("button", { name: "Add filter" }).click();
      await page.getByRole("menuitem", { name: field }).click();
      await page.getByRole("menuitemradio", { name: value }).click();
      let names: string[] = [];
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(250);
        names = await rowNames(page);
        if (names.length === wanted.length && wanted.every(name => names.some(row => row.includes(name))) && !(await page.locator("[aria-busy='true']").count())) break;
      }
      results.check(`filter ${field} = ${value} leaves ${wanted.join(", ")}`, names.length === wanted.length && wanted.every(name => names.some(row => row.includes(name))), names.join(" | ") || "none");
      await page.getByRole("button", { name: `Remove ${field}: ${value}` }).click();
      // Back to the six before the next filter (the table keeps the filtered rows until the new answer is in).
      for (let attempt = 0; attempt < 40 && (await rowNames(page)).length !== 6; attempt++) await sleep(250);
    };
    await filterBy("Status", "Imported", ["Imported One", "Imported Two"]);
    await filterBy("Status", "Access removed", [brook.id]);
    await filterBy("Kind", "Silicon", ["Scout"]);
    await filterBy("Source", "Import", ["Imported One", "Imported Two"]);
    await filterBy("Source", "Silicon token", ["Scout"]);
    await sleep(600);
    results.check("removing the filters brings back all six", (await rowNames(page)).length === 6);

    // Drawers.
    const openDrawer = async (who: ApiSignIn | { uuid: string; displayName: string }) => {
      // The previous drawer slides out first; a click during that lands on its overlay.
      await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
      await page.locator(`[data-open-user="${who.uuid}"]`).click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("heading").first().waitFor({ timeout: 10_000 });
      // The membership's sign-ins load on their own (a skeleton first): wait for the list or its "none yet" line.
      await drawer.getByRole("region", { name: "Recent sign-ins" }).locator("ol li, p").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      await sleep(400);
      return (await drawer.innerText()).replace(/\s+/g, " ");
    };
    const adaDrawer = await openDrawer(ada);
    results.check("Ada's drawer: membership commit:<uuid>, uuid, joined through Sign-in, shares Email, her address, and her sign-in", adaDrawer.includes(`${APP}:${ada.uuid}`) && adaDrawer.includes(ada.uuid) && /Joined through Sign-in/.test(adaDrawer) && adaDrawer.includes(ada.email) && /Email code/.test(adaDrawer), adaDrawer.slice(0, 400));
    await shot(env, page, "dvb-i-02-drawer-ada");
    await page.keyboard.press("Escape");
    const importedUser = listed.find(user => user.display_name.includes("Imported One"));
    if (importedUser) {
      const importDrawer = await openDrawer({ uuid: importedUser.uuid, displayName: importedUser.display_name });
      results.check("an imported user's drawer: the external id, the imported email and phone, and no sign-ins yet", importDrawer.includes(`crm-${t}-1`) && /Email \(imported\)/.test(importDrawer) && /Phone \(imported\)/.test(importDrawer) && /imported users appear here after their first sign-in/.test(importDrawer), importDrawer.slice(0, 400));
      await page.keyboard.press("Escape");
    }
    const siliconDrawer = await openDrawer({ uuid: siliconUuid, displayName: `Scout Silicon ${t}` });
    results.check("the Silicon's drawer: a Silicon, joined through a Silicon token, no email or phone, its short-lived-token sign-in", /Silicon/.test(siliconDrawer) && /Joined through Silicon token/.test(siliconDrawer) && !/Email/.test(siliconDrawer.replace(/Email code/g, "")) && /Short-lived token/.test(siliconDrawer), siliconDrawer.slice(0, 400));
    await page.keyboard.press("Escape");
    const brookDrawer = await openDrawer(brook);
    results.check("the removed member's drawer: Access removed, their id, and none of their data (name, contact details)", /Access removed/.test(brookDrawer) && brookDrawer.includes(brook.id) && !brookDrawer.includes(brook.email) && !brookDrawer.includes(`Brook Leaving ${t}`), brookDrawer.slice(0, 300));
    await page.keyboard.press("Escape");

    // The overview's numbers moved by exactly the new live members.
    const statsAfter = (await asSession<{ stats: Stats }>(page, env, "GET", `/v1/apps/${APP}`)).body.stats;
    results.check("users +5 (live: Ada, Cara, two imports, the Silicon), imported-unclaimed +2, active in 30 days +3", statsAfter.users - statsBefore.users === 5 && statsAfter.imported_unclaimed - statsBefore.imported_unclaimed === 2 && statsAfter.active_last_30d - statsBefore.active_last_30d === 3, `${JSON.stringify(statsBefore)} → ${JSON.stringify(statsAfter)}`);
    await page.getByRole("tab", { name: /^Overview/ }).click();
    await page.getByRole("tabpanel").getByText("Imported, not claimed").waitFor({ timeout: 15_000 }).catch(() => undefined);
    await sleep(1500);
    const metrics = (await page.getByRole("tabpanel").innerText()).replace(/\s+/g, " ");
    results.check("the overview cards show the same numbers", metrics.includes(`Users ${statsAfter.users}`) && metrics.includes(`Imported, not claimed ${statsAfter.imported_unclaimed}`), metrics.slice(0, 200));
    await owner.context.close();
    for (const user of [ada, brook, cara, custodian]) await user.browser.dispose();
  },
};

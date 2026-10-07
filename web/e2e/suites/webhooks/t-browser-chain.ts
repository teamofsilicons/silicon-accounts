/**
 * The whole chain in the browser, as a Carbon does it (UNDERSTANDING.md v2 "What's shared with the app", "Webhooks",
 * "accounts.teamofsilicons.com: see every app they've signed into, and remove an app's access"):
 *
 * 1. briefcase's own "Sign in with Silicon Accounts" link → the hosted pages: email code, Create account, briefcase's
 *    what's-shared page where the Carbon ticks the optional timezone → back at briefcase, which got the timezone;
 * 2. a timezone change reaches briefcase's webhook (it was ticked), signed;
 * 3. the account site's "Apps you have signed into" shows what briefcase can see (the timezone among it), and "Remove
 *    access" there sends briefcase membership.access_removed, signed, at once; later changes reach briefcase no more;
 * 4. signing in to briefcase again (Continue as) shows its page again with the timezone unticked (the old grant ended
 *    with the access), and briefcase hears of changes again.
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { appAccount, completeDetails, newContext, shot, signInWithCode, sleep, startAtApp } from "../../lib";
import { type EventRow, checkEq, inboxEvents, sameJson, short, storedEvents, uid, waitEvent } from "./_helpers";

const APP = "briefcase";

export const journey: Journey = {
  name: "webhooks-browser-chain",
  title: "in the browser: sign up through briefcase's hosted pages ticking the optional timezone, a timezone change reaches briefcase's webhook, the account site shows what it can see and Remove access sends membership.access_removed; signing in again starts unticked and resumes the events",
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page: Page = await context.newPage();
    results.watch(page, "wh-chain");
    const email = `wh.chain+${uid()}@example.test`;
    /** A change through the account site's API with the browser's own session (as the site's pages make it). */
    const change = async (body: Record<string, unknown>): Promise<EventRow[]> => {
      const since = Date.now();
      const answer = await page.request.patch(`${env.site}/v1/me`, { data: body, headers: { origin: env.site } });
      if (answer.status() !== 200) throw new Error(`PATCH /v1/me ${JSON.stringify(body)}: HTTP ${answer.status()} ${(await answer.text()).slice(0, 300)}`);
      return storedEvents(env, { account: uuid, afterMs: since - 1 });
    };
    let uuid = "";
    try {
      // ---- 1. sign up through briefcase's hosted pages, ticking the timezone ---------------------------------------------
      await startAtApp(env, page, APP);
      await signInWithCode(env, page, { email });
      const create = page.getByRole("button", { name: "Create account" });
      await create.waitFor({ timeout: 25_000 });
      await create.click();
      const walk = await completeDetails(env, page, APP, { tick: ["timezone"], shotName: "wh-chain-01" });
      const page1 = walk.pages[0];
      const timezoneRow = page1?.rows.find(row => row.field === "timezone");
      results.check("briefcase's what's-shared page offered the timezone as optional, unticked, and the Carbon ticked it", walk.pages.length === 1 && timezoneRow?.mode === "optional" && timezoneRow.ticked === false && (page1?.shared ?? []).includes("timezone"), short(page1 && { rows: page1.rows.map(row => `${row.field}:${row.mode}:${String(row.ticked)}`), shared: page1.shared }));
      const account = await appAccount(page);
      uuid = typeof account?.uuid === "string" ? account.uuid : "";
      results.check("back at briefcase, which received the email and the ticked timezone", !!uuid && account?.email === email && typeof account?.timezone === "string", short(account, 300));
      await shot(env, page, "wh-chain-02-at-briefcase");

      // ---- 2. a change reaches briefcase's webhook -----------------------------------------------------------------------
      const rows = await change({ timezone: "Europe/Berlin" });
      checkEq(results, "a timezone change is stored for briefcase (the timezone was ticked)", rows.map(row => `${row.type}→${row.target_id}`), [`account.updated→${APP}`]);
      const updated = rows[0] ? await waitEvent(env, APP, { event_id: rows[0].event_id }) : null;
      const data = updated?.payload.data as { changed?: string[]; account?: { timezone?: string } } | undefined;
      results.check("briefcase's webhook received it, signature verified: changed [timezone], Europe/Berlin", !!data && sameJson(data.changed, ["timezone"]) && data.account?.timezone === "Europe/Berlin", short(data, 300));

      // ---- 3. the account site: what briefcase can see, then Remove access ------------------------------------------------
      await page.goto(`${env.site}/apps`);
      const card = page.locator(`article#app-${APP}`);
      await card.waitFor({ timeout: 30_000 });
      const chips = (await card.locator("ul[role=list] li").allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim());
      results.check("the account site's apps page shows what briefcase can see: name, id and photo, email and the timezone the Carbon ticked", chips.some(text => text.startsWith("Name, id and photo")) && chips.some(text => text.startsWith("Email")) && chips.some(text => text.startsWith("Timezone")), chips.join(" | "));
      await shot(env, page, "wh-chain-03-apps");
      const after = (await inboxEvents(env, APP, { uuid: "none" })).last_seq;
      await card.getByRole("button", { name: "Remove access" }).click();
      await card.getByRole("button", { name: "Remove", exact: true }).click({ timeout: 10_000 });
      const clicked = Date.now();
      const removedEvent = await waitEvent(env, APP, { type: "membership.access_removed", uuid, after });
      results.check("Remove access on the account site: briefcase's webhook receives membership.access_removed, signed, with {uuid, membership_id}", !!removedEvent && sameJson(removedEvent.payload.data, { uuid, membership_id: `${APP}:${uuid}` }), short(removedEvent?.payload, 300));
      if (removedEvent) results.metric("Remove access clicked → briefcase received access_removed", Date.parse(removedEvent.received_at) - clicked, "ms");
      const done = page.getByText("Access removed").first();
      await done.waitFor({ timeout: 15_000 }).catch(() => undefined);
      results.check("…and the page says Access removed", await done.isVisible().catch(() => false));
      await shot(env, page, "wh-chain-04-removed");
      const quiet = await change({ display_name: `WH Chain ${uid()}` });
      checkEq(results, "after the removal a rename reaches briefcase no more", quiet.map(row => `${row.type}→${row.target_id}`), []);

      // ---- 4. signing in again ---------------------------------------------------------------------------------------------
      await startAtApp(env, page, APP);
      await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
      const again = await completeDetails(env, page, APP, { shotName: "wh-chain-05" });
      const againTimezone = again.pages[0]?.rows.find(row => row.field === "timezone");
      results.check("signing in again shows briefcase's page again, the timezone unticked (the grant ended with the access)", again.pages.length === 1 && againTimezone?.ticked === false, short(again.pages.map(item => item.rows.map(row => `${row.field}:${String(row.ticked)}`))));
      await sleep(300);
      const back = await change({ display_name: `WH Chain back ${uid()}`, timezone: "Asia/Kolkata" });
      checkEq(results, "briefcase hears of the account again (a rename), and not of the timezone it was not given this time", back.map(row => `${row.type}→${row.target_id}`), [`account.updated→${APP}`]);
      const backEvent = back[0] ? await waitEvent(env, APP, { event_id: back[0].event_id }) : null;
      results.check("…signed, with changed [display_name] only", !!backEvent && sameJson((backEvent.payload.data as { changed?: string[] }).changed, ["display_name"]), short(backEvent?.payload.data, 300));
    } finally {
      await context.close();
    }
  },
};

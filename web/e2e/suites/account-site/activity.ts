/**
 * /activity: one timeline of everything that happened to the account, newest first, in the account's timezone, read
 * page by page ("Show older activity"), filtered by kind; rows with more to say open in place; the identity card's
 * "Recent activity" is its newest four.
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { api, codeFor, lastSeq, postJson, shot, sleep } from "../../lib";
import { call, newCarbon, signIntoApp, timelineRows, timezoneLabel, until } from "./_helpers";

interface Item {
  id: string;
  kind: string;
  at: string;
  title: string;
  detail: string | null;
}

/** Picks a filter of the "Show" switch and returns the rows the timeline then shows (or the empty state's text). */
async function filter(page: Page, label: string): Promise<{ rows: string[]; empty: string }> {
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: label, exact: true }).click();
  await sleep(900);
  const empty = (await page.getByText("Nothing here yet").count()) ? (await page.locator("main").innerText()).replace(/\s+/g, " ") : "";
  return { rows: empty ? [] : await timelineRows(page), empty };
}

const activity: Journey = {
  name: "account-site-activity",
  title: "the activity timeline: every kind of entry (sign-ins, id change, proofs, app access, security), newest first in the account's timezone, 50 at a time with \"Show older activity\", each filter showing only its kind, details opening in place, and the card's recent four",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await newCarbon(ctx, "acct-activity");
    const { page, probe, uuid } = carbon;
    await signIntoApp(env, page, "briefcase");
    await signIntoApp(env, page, "commit");
    // Someone else types ten wrong codes for the Carbon's email (the accounts CLI's code sign-in, from another
    // address): the lock that follows is a failed sign-in in the Carbon's activity.
    const sentAfter = await lastSeq(env);
    const attempt = await api<{ challenge_id?: string }>(ctx, "/v1/cli/login/start", { method: "POST", json: { email: carbon.email } });
    const real = await codeFor(env, carbon.email, sentAfter);
    const wrong = real === "000000" ? "111111" : "000000";
    const refusals: number[] = [];
    for (let i = 0; i < 10; i++) refusals.push((await api(ctx, "/v1/cli/login/verify", { method: "POST", json: { challenge_id: attempt.body.challenge_id, code: wrong } })).status);
    const newId = `${carbon.id}-v2`;
    const changed = await call(probe, "/v1/me/id", { method: "POST", json: { id: newId } });
    const issued = (await postJson<{ body?: { proof_id?: string } }>(`${env.apps}/briefcase/actions/issue-obo`, { uuid, receiving_app: "commit", scopes: ["files.read"] })).body.body?.proof_id ?? "";
    const revoked = await call(probe, `/v1/me/proofs/${issued}`, { method: "DELETE" });
    const removed = await call(probe, "/v1/me/apps/commit", { method: "DELETE" });
    // 55 changes Briefcase can't see (date of birth), so the history passes one page without a webhook storm.
    let patched = 0;
    for (let i = 0; i < 55; i++) patched += (await call(probe, "/v1/me", { method: "PATCH", json: { dob: i % 2 ? "1990-01-02" : "1990-01-01" } })).status === 200 ? 1 : 0;
    const zoned = await call(probe, "/v1/me", { method: "PATCH", json: { timezone: "Pacific/Auckland" } });
    results.check("setup: id change, a proof issued and revoked, Commit removed, 55 date-of-birth changes, timezone Auckland", changed.status === 200 && !!issued && revoked.status === 204 && removed.status === 204 && patched === 55 && zoned.status === 200, `${changed.status} ${revoked.status} ${removed.status} ${patched} ${zoned.status}`);

    const all: Item[] = [];
    let cursor: string | null = null;
    do {
      const pageOf: { items: Item[]; next_cursor: string | null } = (await call<{ items: Item[]; next_cursor: string | null }>(probe, `/v1/me/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
      all.push(...pageOf.items);
      cursor = pageOf.next_cursor;
    } while (cursor && all.length < 1000);
    const kinds = new Set(all.map(item => item.kind));
    results.check("the API history has every kind this account did (signin, id_change, proof, app_access, security)", ["signin", "id_change", "proof", "app_access", "security"].every(kind => kinds.has(kind)) && all.length > 60, `${all.length} entries; ${[...kinds].join(", ")}`);
    results.check("…and its pages hold each entry once", new Set(all.map(item => item.id)).size === all.length);
    const failed = all.filter(item => item.kind === "signin" && item.title.startsWith("Failed sign-in"));
    results.check("ten wrong codes for the Carbon's email from another address are one failed sign-in in its history, saying from where", attempt.status === 200 && refusals.every(status => status >= 400) && failed.length === 1 && /with an email code/.test(failed[0]?.title ?? "") && (failed[0]?.detail ?? "").includes(`from ${ctx.ip}`), `${attempt.status} ${refusals.join(",")}: ${JSON.stringify(failed).slice(0, 300)}`);

    // The page: newest first, 50 at a time, in Auckland time.
    const started = Date.now();
    await page.goto(`${env.site}/activity`);
    const firstPage = await until(() => timelineRows(page), rows => rows.length >= 50, 20_000);
    results.metric("/activity first page visible after navigation", Date.now() - started);
    await sleep(600);
    await shot(env, page, "acct-activity-01-all");
    const header = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    results.check("the page says days and times are in the account's timezone (Auckland)", header.includes(`Days and times are in ${timezoneLabel("Pacific/Auckland")}, your timezone.`), header.slice(0, 200));
    results.check("the first page is the newest 50, in the API's order", firstPage.length === 50 && all.slice(0, 50).every((item, index) => (firstPage[index] ?? "").startsWith(item.title.slice(0, 24))), `${firstPage.length} rows; first: ${firstPage[0]} / ${all[0]?.title}`);
    results.check("the newest entry is the timezone change", /^Profile updated/.test(firstPage[0] ?? "") && /timezone/.test(firstPage[0] ?? ""), firstPage[0] ?? "");
    const when = new Date(all[0]?.at ?? Date.now());
    const aucklandTime = new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Auckland", hour: "numeric", minute: "2-digit" }).format(when);
    const aucklandDay = new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Auckland", weekday: "long", month: "long", day: "numeric" }).format(when);
    results.check("its time reads in Auckland time (the account's timezone, not the browser's)", (firstPage[0] ?? "").includes(aucklandTime) && (firstPage[0] ?? "").includes(aucklandDay), `want "${aucklandDay}" "${aucklandTime}" in: ${firstPage[0]}`);
    const more = page.getByRole("button", { name: "Show older activity" });
    results.check("\"Show older activity\" is offered", (await more.count()) === 1);
    while ((await more.count()) === 1) {
      await more.click();
      await sleep(900);
    }
    const everything = await timelineRows(page);
    results.check("reading on shows every entry, and the button goes at the end", everything.length === all.length && (await more.count()) === 0, `${everything.length} rows of ${all.length}`);
    results.check("the oldest entry is the account's creation", (everything[everything.length - 1] ?? "").startsWith(`Signed up`) || everything.slice(-3).some(row => row.startsWith(`Account created with the id ${carbon.id}`)), everything.slice(-3).join(" | "));
    const days = await page.getByRole("region", { name: "Account activity" }).getByRole("heading").allInnerTexts();
    results.check("entries are grouped under day headings", days.length >= 1, days.join(", "));

    // Each filter shows only its kind.
    const ids = await filter(page, "Id changes");
    results.check("Id changes: the change and the creation, nothing else", ids.rows.length === 2 && ids.rows[0]?.startsWith(`Id changed from ${carbon.id} to ${newId}`) === true && ids.rows[1]?.startsWith(`Account created with the id ${carbon.id}`) === true, ids.rows.join(" | "));
    const signins = await filter(page, "Sign-ins");
    results.check("Sign-ins: only sign-ins and the sign-up", signins.rows.length >= 3 && signins.rows.every(row => /^(Signed (in|up)|Failed sign-in)/.test(row)) && signins.rows.some(row => row.startsWith("Signed in to Briefcase")) && signins.rows.some(row => row.startsWith("Signed in to Commit")), signins.rows.join(" | ").slice(0, 300));
    results.check("…including the failed sign-in, as the history words it", signins.rows.some(row => row.startsWith(failed[0]?.title ?? "Failed sign-in")), signins.rows.filter(row => row.startsWith("Failed")).join(" | ") || "no failed sign-in row");
    const proofs = await filter(page, "Proofs");
    results.check("Proofs: issued and revoked", proofs.rows.length === 2 && proofs.rows.some(row => row.startsWith("Briefcase got a proof to act for you at Commit")) && proofs.rows.some(row => row.startsWith("Proof for Briefcase to act for you at Commit revoked")), proofs.rows.join(" | "));
    const access = await filter(page, "App access");
    results.check("App access: started using each app, Commit's removal", access.rows.some(row => row.startsWith("Started using Briefcase")) && access.rows.some(row => row.startsWith("Started using Commit")) && access.rows.some(row => row.startsWith("Removed Commit's access")) && access.rows.every(row => /^(Started using|Removed)/.test(row)), access.rows.join(" | "));
    const custodian = await filter(page, "Custodian");
    results.check("Custodian: nothing yet, and it says what would show there", custodian.rows.length === 0 && custodian.empty.includes("Silicons you take on, hand over or are asked to look after show up here."), custodian.empty.slice(0, 200));
    const security = await filter(page, "Security");
    results.check("Security: the profile changes, 50 at a time", security.rows.length === 50 && security.rows.every(row => /^(Profile updated|Session created|[^ ]+ account|Email|Phone|A (browser|CLI))/.test(row)) && (await page.getByRole("button", { name: "Show older activity" }).count()) === 1, `${security.rows.length} rows; ${security.rows.slice(0, 2).join(" | ")}`);

    // A row with details opens in place.
    await filter(page, "Proofs");
    const trigger = page.getByRole("region", { name: "Account activity" }).locator("[data-timeline-trigger]").first();
    const hasDetail = (await trigger.count()) === 1;
    if (hasDetail) {
      await trigger.click();
      await sleep(600);
      const expanded = await trigger.getAttribute("aria-expanded");
      const detail = (await page.getByRole("region", { name: "Account activity" }).locator("dl").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      results.check("a proof row opens its details in place", expanded === "true" && detail.length > 0, detail.slice(0, 200));
      await shot(env, page, "acct-activity-02-detail");
    } else {
      results.check("a proof row opens its details in place", false, "no row with details");
    }

    // The identity card's recent activity is the newest four.
    await page.goto(`${env.site}/`);
    const glance = page.getByRole("complementary", { name: "At a glance" });
    const recent = await until(async () => (await glance.getByRole("list").last().locator("li").allInnerTexts().catch(() => [] as string[])).map(text => text.replace(/\s+/g, " ")), rows => rows.length === 4, 15_000);
    results.check("the card's recent activity: the newest four, linking to All activity", recent.length === 4 && all.slice(0, 4).every((item, index) => (recent[index] ?? "").startsWith(item.title.slice(0, 24))) && (await glance.getByRole("link", { name: "All activity" }).getAttribute("href")) === "/activity", recent.join(" | "));
    await carbon.context.close();
  },
};

export const journey = activity;

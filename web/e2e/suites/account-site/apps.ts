/**
 * /apps: every app the Carbon signed into and what each can see (with the values): exactly what the Carbon shared on
 * the app's details page (UNDERSTANDING.md "What's shared with the app": required details always, optional ones only
 * when ticked). Removing an app's access: the app is told (membership.access_removed, signed), its refresh and access
 * token stop working, its user base shows nothing about the Carbon any more, it hears nothing more about the account,
 * the other apps keep theirs, and signing in again asks to share again and gives the access back.
 */
import type { Journey } from "../../context";
import { api, shot, sleep, sql, type DetailRowSeen } from "../../lib";
import { appAuth, appName, appRefresh, appUserinfo, call, codeOf, confirmMorph, deliveredAfter, formatDate, getMe, inbox, newCarbon, queuedEvents, requestSent, rowsSeen, signIntoAppSeen, timezoneLabel, until, userBaseRow, waitEvent } from "./_helpers";

interface MyApp {
  app: { app_id: string; name: string };
  membership_id: string;
  status: string;
  granted_scopes: string[];
  access_removed_at: string | null;
  active_sessions: number;
  first_signed_in_at: string | null;
  last_signed_in_at: string | null;
}

const apps: Journey = {
  name: "account-site-apps",
  title: "apps on /apps: what each app can see is what was shared on its details page (Briefcase's optional timezone left unticked, Commit's ticked), removing Briefcase's access (told, refresh and token die, its user base shows nothing about the Carbon, it hears nothing more; Commit keeps working), refusals, signing in again asks again and restores access, an importing app listed and removable",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await newCarbon(ctx, "acct-apps");
    const { page, probe, uuid } = carbon;
    const refusedAtStart = (await inbox(env, "briefcase")).rejected.length + (await inbox(env, "commit")).rejected.length;
    // Both require the email and offer the timezone as optional (unticked until ticked): left unticked for Briefcase,
    // ticked for Commit.
    const briefcase = await signIntoAppSeen(env, page, "briefcase", { shotName: "acct-apps-00-briefcase" });
    const commit = await signIntoAppSeen(env, page, "commit", { tick: ["timezone"] });
    results.check("setup: signed into Briefcase and Commit", briefcase.account?.uuid === uuid && commit.account?.uuid === uuid);
    const bPage = briefcase.walk.pages[0];
    const cPage = commit.walk.pages[0];
    const row = (rows: DetailRowSeen[], field: string) => rows.find(entry => entry.field === field);
    results.check(
      "Briefcase's details page: the profile and the email required (locked), the timezone optional and unticked",
      briefcase.walk.pages.length === 1 && !!bPage && row(bPage.rows, "email")?.mode === "required" && row(bPage.rows, "timezone")?.mode === "optional" && row(bPage.rows, "timezone")?.ticked === false && JSON.stringify(bPage.shared) === '["profile","email"]',
      `${briefcase.walk.pages.length} page(s): ${rowsSeen(bPage?.rows ?? [])}; shared ${JSON.stringify(bPage?.shared)}`,
    );
    results.check("Commit's page starts the same way, and the Carbon ticks the timezone", !!cPage && row(cPage.rows, "timezone")?.ticked === false && JSON.stringify(cPage.shared) === '["profile","email","timezone"]', `${rowsSeen(cPage?.rows ?? [])}; shared ${JSON.stringify(cPage?.shared)}`);
    results.check("Briefcase received the email and no timezone; Commit received both", briefcase.account?.email === carbon.email && briefcase.account?.timezone === undefined && commit.account?.email === carbon.email && typeof commit.account?.timezone === "string", `briefcase ${JSON.stringify({ email: briefcase.account?.email, timezone: briefcase.account?.timezone })}; commit ${JSON.stringify({ email: commit.account?.email, timezone: commit.account?.timezone })}`);
    const me = await getMe(probe);

    const list = async () => (await call<{ items: MyApp[] }>(probe, "/v1/me/apps")).body.items;
    const started = Date.now();
    await page.goto(`${env.site}/apps`);
    const withAccess = page.getByRole("list", { name: "Apps with access" });
    await withAccess.waitFor({ timeout: 30_000 });
    results.metric("/apps list visible after navigation", Date.now() - started);
    await sleep(900);
    await shot(env, page, "acct-apps-01-list", true);
    results.check("the switch counts 2 apps with access and none removed", (await page.getByRole("button", { name: "With access (2)" }).getAttribute("aria-pressed")) === "true" && (await page.getByRole("button", { name: "Access removed (0)" }).count()) === 1);
    const card = page.locator("#app-briefcase");
    const cardText = (await card.innerText()).replace(/\s+/g, " ");
    results.check("Briefcase's card: what it can see, with the values it gets (no timezone: left unticked)", cardText.includes("It can see") && cardText.includes("Name, id and photo") && cardText.includes(`${me.display_name} · ${me.id}`) && cardText.includes("Email") && cardText.includes(carbon.email) && !cardText.includes("Timezone"), cardText.slice(0, 300));
    results.check("…signed in, one active session, its membership id", /Signed in/.test(cardText) && /1 active session/.test(cardText) && cardText.includes(`briefcase:${uuid}`), cardText.slice(-200));
    results.check("…first and last sign-in", cardText.includes(`First signed in ${formatDate(Date.now())}`) && /Last signed in (just now|\d+ (second|minute)s? ago)/.test(cardText), cardText.match(/Last signed in [^F]*/)?.[0] ?? "");

    // The optional timezone is shared only with Commit, which then hears its changes; Briefcase never does.
    const scopesOf = (items: MyApp[], app: string) => items.find(item => item.app.app_id === app)?.granted_scopes ?? [];
    const granted = await list();
    results.check("the optional timezone was granted to Commit (ticked) and not to Briefcase (left unticked)", scopesOf(granted, "commit").includes("timezone") && !scopesOf(granted, "briefcase").includes("timezone"), `commit: ${scopesOf(granted, "commit").join(" ")}; briefcase: ${scopesOf(granted, "briefcase").join(" ")}`);
    const commitCard = page.locator("#app-commit");
    const commitText = (await commitCard.innerText()).replace(/\s+/g, " ");
    results.check("Commit's card lists the timezone with its value; Briefcase's does not", commitText.includes("Timezone") && commitText.includes(timezoneLabel(me.timezone)) && !cardText.includes("Timezone"), commitText.slice(0, 300));
    const commitRow = await userBaseRow(ctx, "commit", uuid);
    const briefcaseRow = await userBaseRow(ctx, "briefcase", uuid);
    results.check("the apps' user bases agree: Commit sees the email and the timezone, Briefcase the email only", commitRow.row?.email === carbon.email && commitRow.row?.timezone === me.timezone && briefcaseRow.row?.email === carbon.email && !briefcaseRow.row?.timezone, `commit ${commitRow.status} ${JSON.stringify({ email: commitRow.row?.email, timezone: commitRow.row?.timezone })}; briefcase ${briefcaseRow.status} ${JSON.stringify({ email: briefcaseRow.row?.email, timezone: briefcaseRow.row?.timezone })}`);
    const beforeZone = { commit: (await inbox(env, "commit")).last_seq };
    const zoned = await call(probe, "/v1/me", { method: "PATCH", json: { timezone: "America/Sao_Paulo" } });
    const zoneEvent = await waitEvent(env, "commit", "account.updated", uuid, { after: beforeZone.commit });
    const zoneData = zoneEvent?.payload.data as { changed?: string[]; account?: { timezone?: string } } | undefined;
    results.check("a timezone change tells Commit (account.updated, changed [timezone], the new zone) and nothing goes to Briefcase", zoned.status === 200 && JSON.stringify(zoneData?.changed) === '["timezone"]' && zoneData?.account?.timezone === "America/Sao_Paulo" && (await queuedEvents(env, "briefcase", uuid, "account.updated", "and payload->'data'->'changed' ? 'timezone'")) === 0, `${zoned.status} ${JSON.stringify(zoneData ?? null).slice(0, 200)}`);
    await page.reload();
    await withAccess.waitFor({ timeout: 30_000 });
    const shownZone = await until(async () => (await commitCard.innerText().catch(() => "")).replace(/\s+/g, " "), text => text.includes(timezoneLabel("America/Sao_Paulo")), 10_000);
    results.check("…and Commit's card shows the new timezone", shownZone.includes(timezoneLabel("America/Sao_Paulo")), shownZone.slice(0, 300));
    const zoneBack = await call(probe, "/v1/me", { method: "PATCH", json: { timezone: me.timezone } });
    results.check("setup: the timezone is back", zoneBack.status === 200);
    await page.reload();
    await withAccess.waitFor({ timeout: 30_000 });
    await sleep(600);

    // Remove Briefcase's access.
    const before = (await inbox(env, "briefcase")).last_seq;
    const removeSent = requestSent(page, "DELETE", "/v1/me/apps/briefcase");
    await confirmMorph(card, "Remove access", "Remove");
    const event = await waitEvent(env, "briefcase", "membership.access_removed", uuid, { after: before });
    results.metric("remove-access DELETE sent → Briefcase received membership.access_removed", deliveredAfter(event, await removeSent));
    results.check("Briefcase got membership.access_removed (signed) for this membership", !!event && event.payload.data.membership_id === `briefcase:${uuid}` && event.payload.app_id === "briefcase", JSON.stringify(event?.payload ?? null).slice(0, 240));
    const refresh = await appRefresh(env, "briefcase", uuid);
    results.check("Briefcase's refresh token no longer works (invalid_grant)", refresh.status === 400 && refresh.error === "invalid_grant", JSON.stringify(refresh));
    const info = await appUserinfo(env, "briefcase", uuid);
    results.check("Briefcase's access token no longer works on /v1/userinfo (401)", info.status === 401, String(info.status));
    // The app's own user base keeps the membership as history, without any of the Carbon's data.
    const removedRow = await userBaseRow(ctx, "briefcase", uuid);
    results.check(
      "Briefcase's user base no longer shows anything about the Carbon: status access_removed, \"Access removed\" for a name, no email, phone, date of birth or timezone",
      removedRow.status === 200 && removedRow.row?.status === "access_removed" && removedRow.row.display_name === "Access removed" && !removedRow.row.email && !removedRow.row.phone && !removedRow.row.dob && !removedRow.row.timezone && removedRow.row.membership_id === `briefcase:${uuid}`,
      `${removedRow.status} ${JSON.stringify({ status: removedRow.row?.status, display_name: removedRow.row?.display_name, email: removedRow.row?.email, phone: removedRow.row?.phone, dob: removedRow.row?.dob, timezone: removedRow.row?.timezone, membership_id: removedRow.row?.membership_id })}`,
    );
    const byName = await api<{ items?: Array<{ uuid: string }> }>(ctx, `/v1/apps/briefcase/users?q=${encodeURIComponent(me.display_name)}`, { headers: { authorization: appAuth("briefcase") } });
    const byEmail = await api<{ items?: Array<{ uuid: string }> }>(ctx, `/v1/apps/briefcase/users?q=${encodeURIComponent(carbon.email)}`, { headers: { authorization: appAuth("briefcase") } });
    results.check("…and its search can't find the Carbon by name or email any more", byName.status === 200 && byEmail.status === 200 && !(byName.body.items ?? []).some(item => item.uuid === uuid) && !(byEmail.body.items ?? []).some(item => item.uuid === uuid), `by name ${byName.status} ${(byName.body.items ?? []).length} rows; by email ${byEmail.status} ${(byEmail.body.items ?? []).length} rows`);
    // The uuid always resolves to the current id (UNDERSTANDING.md "Identifiers"). The lookup answers the account's
    // public identity (docs/reference/api/accounts.md: id, display name, photo), which every app may read whether or
    // not the Carbon signed into it; the detail records what Briefcase still reads there.
    const lookup = await api<{ id?: string; display_name?: string; pfp_url?: string }>(ctx, `/v1/accounts/${uuid}`, { headers: { authorization: appAuth("briefcase") } });
    results.check("Briefcase's lookup of the uuid still resolves the current id", lookup.status === 200 && lookup.body.id === me.id, `${lookup.status} ${JSON.stringify({ id: lookup.body.id, display_name: lookup.body.display_name, pfp_url: lookup.body.pfp_url })}`);
    const commitRefresh = await appRefresh(env, "commit", uuid);
    results.check("Commit's sign-in is untouched (its refresh works)", commitRefresh.status === 200, JSON.stringify(commitRefresh));
    const items = await list();
    const b = items.find(item => item.app.app_id === "briefcase");
    const c = items.find(item => item.app.app_id === "commit");
    results.check("/v1/me/apps: Briefcase access_removed (with when, no sessions), Commit active", b?.status === "access_removed" && !!b.access_removed_at && b.active_sessions === 0 && c?.status === "active", JSON.stringify({ b: b && { status: b.status, at: b.access_removed_at, sessions: b.active_sessions }, c: c?.status }));

    // The page: the card leaves "With access" for "Access removed".
    await until(async () => page.getByRole("button", { name: "Access removed (1)" }).count(), n => n === 1, 8_000);
    results.check("the switch now counts 1 with access, 1 removed", (await page.getByRole("button", { name: "With access (1)" }).count()) === 1 && (await page.getByRole("button", { name: "Access removed (1)" }).count()) === 1);
    await page.getByRole("button", { name: "Access removed (1)" }).click();
    const removedList = page.getByRole("list", { name: "Apps whose access you removed" });
    await removedList.waitFor({ timeout: 10_000 });
    await sleep(800);
    await shot(env, page, "acct-apps-02-removed", true);
    const removedText = (await removedList.innerText()).replace(/\s+/g, " ");
    results.check("the removed view: Briefcase can no longer see anything, since when, and how to give access back", removedText.includes("Briefcase") && removedText.includes(`It can no longer see anything about you, since ${formatDate(b?.access_removed_at ?? Date.now())}. Sign in to it again to give it access.`) && (await removedList.getByRole("button", { name: "Remove access" }).count()) === 0, removedText.slice(0, 260));

    // The identity card keeps a stamp only for apps with access.
    await page.goto(`${env.site}/`);
    const stamps = page.getByRole("list", { name: "Apps you have signed into" });
    await stamps.waitFor({ timeout: 30_000 });
    const names = await stamps.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("aria-label")));
    results.check("the identity card has a stamp for Commit only", JSON.stringify(names) === '["Commit"]', JSON.stringify(names));

    // It hears nothing more: an id change and a name change reach Commit, not Briefcase; its user base stays blank.
    const beforeCommit = (await inbox(env, "commit")).last_seq;
    const newId = `${me.id}-x`;
    const changed = await call(probe, "/v1/me/id", { method: "POST", json: { id: newId } });
    const toCommit = await waitEvent(env, "commit", "account.id_changed", uuid, { after: beforeCommit });
    results.check("after the removal an id change reaches Commit", changed.status === 200 && !!toCommit, `${changed.status}`);
    const updatesBefore = await queuedEvents(env, "briefcase", uuid, "account.updated");
    const renamed = await call(probe, "/v1/me", { method: "PATCH", json: { display_name: `Renamed After ${uuid}` } });
    await waitEvent(env, "commit", "account.updated", uuid, { after: beforeCommit });
    const updatesAfter = await queuedEvents(env, "briefcase", uuid, "account.updated");
    results.check("…and nothing is queued for Briefcase (no id change, no profile update)", renamed.status === 200 && (await queuedEvents(env, "briefcase", uuid, "account.id_changed")) === 0 && updatesAfter === updatesBefore, `id changes ${await queuedEvents(env, "briefcase", uuid, "account.id_changed")}, profile updates ${updatesBefore} → ${updatesAfter}`);
    const stillBlank = await userBaseRow(ctx, "briefcase", uuid);
    results.check("…and Briefcase's user base still shows no name for the Carbon after it changed", stillBlank.row?.display_name === "Access removed" && !stillBlank.row.email, JSON.stringify({ display_name: stillBlank.row?.display_name, email: stillBlank.row?.email }));

    // Removing again changes nothing; the site itself, the developer platform and unknown apps are refused.
    const again = await call(probe, "/v1/me/apps/briefcase", { method: "DELETE" });
    results.check("removing it again answers 204 and tells Briefcase nothing more", again.status === 204 && (await queuedEvents(env, "briefcase", uuid, "membership.access_removed")) === 1, `${again.status}`);
    const self = await call(probe, "/v1/me/apps/silicon-accounts", { method: "DELETE" });
    results.check("Silicon Accounts itself can't lose access (400 first_party_app)", self.status === 400 && codeOf(self.body) === "first_party_app", `${self.status} ${codeOf(self.body)}`);
    const unknown = await call(probe, "/v1/me/apps/no-such-app", { method: "DELETE" });
    results.check("an app never signed into is refused (404 membership_not_found)", unknown.status === 404 && codeOf(unknown.body) === "membership_not_found", `${unknown.status} ${codeOf(unknown.body)}`);
    const neverSigned = await call(probe, "/v1/me/apps/waveform", { method: "DELETE" });
    results.check("…so is a real app this Carbon never signed into", neverSigned.status === 404 && codeOf(neverSigned.body) === "membership_not_found", `${neverSigned.status} ${codeOf(neverSigned.body)}`);

    // Signing in again asks to share again (nothing is granted after a removal), and gives the access back.
    const back = await signIntoAppSeen(env, page, "briefcase", { shotName: "acct-apps-03-briefcase-again" });
    const again1 = back.walk.pages[0];
    results.check("signing into Briefcase again shows its details page again, the timezone unticked (nothing granted any more)", back.walk.pages.length === 1 && !!again1 && row(again1.rows, "email")?.mode === "required" && row(again1.rows, "timezone")?.ticked === false, `${back.walk.pages.length} page(s): ${rowsSeen(again1?.rows ?? [])}`);
    results.check("…and Briefcase gets the account again, with the new id", back.account?.uuid === uuid && back.account?.id === newId, JSON.stringify(back.account).slice(0, 160));
    const restored = (await list()).find(item => item.app.app_id === "briefcase");
    results.check("…the membership is active again with a session", restored?.status === "active" && restored.active_sessions === 1, JSON.stringify(restored && { status: restored.status, sessions: restored.active_sessions }));
    const refreshAgain = await appRefresh(env, "briefcase", uuid);
    results.check("…Briefcase's new tokens refresh", refreshAgain.status === 200, JSON.stringify(refreshAgain));
    const shownAgain = await userBaseRow(ctx, "briefcase", uuid);
    results.check("…and its user base shows the Carbon again (name and email)", shownAgain.row?.status === "active" && shownAgain.row.display_name === `Renamed After ${uuid}` && shownAgain.row.email === carbon.email, JSON.stringify({ status: shownAgain.row?.status, display_name: shownAgain.row?.display_name, email: shownAgain.row?.email }));
    await page.goto(`${env.site}/apps`);
    await withAccess.waitFor({ timeout: 30_000 });
    await sleep(600);
    results.check("/apps lists both with access again", (await page.getByRole("button", { name: "With access (2)" }).count()) === 1 && (await page.locator("#app-briefcase").count()) === 1);

    // An app that imported the Carbon (Legacy CRM's import of its old records matched the email) is listed too: it
    // holds data about the Carbon, so its access can be removed like any other's.
    const crm = appName("legacy-crm");
    const imported = await api<{ job?: { id: string } }>(ctx, "/v1/apps/legacy-crm/imports", { method: "POST", json: { rows: [{ email: carbon.email, external_id: `crm-${uuid}`, display_name: "Imported Name" }], options: {} }, headers: { authorization: appAuth("legacy-crm"), "idempotency-key": `acct-apps-${uuid}` } });
    const job = await until(async () => (await api<{ job?: { status: string; counts?: Record<string, number> } }>(ctx, `/v1/apps/legacy-crm/imports/${imported.body.job?.id}`, { headers: { authorization: appAuth("legacy-crm") } })).body.job, value => value?.status === "completed" || value?.status === "failed", 20_000, 300);
    results.check("setup: Legacy CRM's import matched the Carbon's email", imported.status === 202 && job?.status === "completed" && job.counts?.matched === 1, `${imported.status} ${JSON.stringify(job)}`);
    const crmItem = (await list()).find(item => item.app.app_id === "legacy-crm");
    results.check("/v1/me/apps lists Legacy CRM as imported (never signed in)", crmItem?.status === "imported" && crmItem.last_signed_in_at === null, JSON.stringify(crmItem && { status: crmItem.status, last: crmItem.last_signed_in_at }));
    await page.reload();
    await withAccess.waitFor({ timeout: 30_000 });
    await sleep(800);
    const crmCard = page.locator("#app-legacy-crm");
    const crmText = (await crmCard.innerText().catch(() => "")).replace(/\s+/g, " ");
    await shot(env, page, "acct-apps-04-imported", true);
    results.check("its card says it imported you, holds what it imported, and gets nothing more until you sign in", crmText.includes("Imported you") && crmText.includes(`${crm} imported your account, so it holds what it imported. It gets nothing more until you sign in to it.`) && /Last signed in Never/.test(crmText), crmText.slice(0, 300));
    const beforeCrm = (await inbox(env, "legacy-crm")).last_seq;
    await confirmMorph(crmCard, "Remove access", "Remove");
    const crmRemoved = await waitEvent(env, "legacy-crm", "membership.access_removed", uuid, { after: beforeCrm });
    results.check("removing the importing app's access tells it too (membership.access_removed)", !!crmRemoved && (await list()).find(item => item.app.app_id === "legacy-crm")?.status === "access_removed", JSON.stringify(crmRemoved?.payload.data ?? null));
    const crmRow = await userBaseRow(ctx, "legacy-crm", uuid);
    results.check("…and its user base drops what it imported about the Carbon too (no name, no email)", crmRow.row?.status === "access_removed" && crmRow.row.display_name === "Access removed" && !crmRow.row.email && !crmRow.row.phone, JSON.stringify({ status: crmRow.row?.status, display_name: crmRow.row?.display_name, email: crmRow.row?.email, phone: crmRow.row?.phone, external_id: crmRow.row?.external_id }));
    const [[signins] = []] = await sql(env, `select count(*) from signin_history where account_uuid = '${uuid}' and app_id = 'briefcase' and outcome = 'success'`);
    results.check("the sign-in history per app has both Briefcase sign-ins", Number(signins) >= 2, String(signins));

    const refused = (await inbox(env, "briefcase")).rejected.length + (await inbox(env, "commit")).rejected.length - refusedAtStart;
    results.check("no webhook delivery was refused by the apps' signature checks", refused === 0, String(refused));
    const titles = (await call<{ items: Array<{ title: string }> }>(probe, "/v1/me/history?kind=app_access&limit=50")).body.items.map(item => item.title);
    results.check("history: started using each app, the import, and the removals", titles.includes("Removed Briefcase's access") && titles.includes("Started using Briefcase") && titles.includes("Started using Commit") && titles.includes(`${crm} imported your account from its existing records`) && titles.includes(`Removed ${crm}'s access`), titles.join(" | "));
    await carbon.context.close();
  },
};

export const journey = apps;

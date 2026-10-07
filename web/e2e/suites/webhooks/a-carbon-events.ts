/**
 * App webhooks about a Carbon: every change reaches exactly the apps it should, signed (the fake apps only list events
 * whose v1 signature they verified), with the payload the contract describes and nothing the app may not see.
 *
 * The Carbon signs into briefcase (granted profile + email: optional timezone refused), remind (profile + timezone),
 * dm (profile + phone + email: optional email accepted, timezone refused) and spacestation (no webhook). Which apps an
 * event goes to is read from the database right after the change (events are stored in the change's transaction), so
 * "this app gets nothing" is exact instead of a timeout.
 */
import type { Ctx, Journey } from "../../context";
import { codeFor, lastSeq } from "../../lib";
import {
  type AppSession,
  type Carbon,
  type InboxEvent,
  appCall,
  checkEq,
  createSilicon,
  envelopeProblems,
  inboxEvents,
  must,
  newCarbon,
  randomPhone,
  sameJson,
  short,
  signIntoApp,
  storedEvents,
  uid,
  until,
  waitEvent,
} from "./_helpers";

const BASE_KEYS = ["display_name", "id", "kind", "membership_id", "pfp_url", "updated_at", "uuid", "version"];
/** The AccountForApp keys each app may see, by its granted scopes. */
const VISIBLE: Record<string, string[]> = {
  briefcase: [...BASE_KEYS, "email", "email_verified"].sort(),
  remind: [...BASE_KEYS, "timezone"].sort(),
  dm: [...BASE_KEYS, "email", "email_verified", "phone", "phone_verified"].sort(),
};

/** Targets of the events stored for `uuid` of `type` since `since` (ms). */
async function targetsSince(ctx: Ctx, uuid: string, type: string, since: number): Promise<string[]> {
  return (await storedEvents(ctx.env, { account: uuid, type, afterMs: since - 1 })).map(row => row.target_id).sort();
}

/** The event each app received for `uuid` of `type` (newest match after `afterSeq` of that app's inbox). */
async function receivedBy(ctx: Ctx, apps: string[], uuid: string, type: string, after: Record<string, number>): Promise<Record<string, InboxEvent | null>> {
  const out: Record<string, InboxEvent | null> = {};
  await Promise.all(apps.map(async app => (out[app] = await waitEvent(ctx.env, app, { type, uuid, after: after[app] ?? 0 }))));
  return out;
}

async function seqs(ctx: Ctx, apps: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const app of apps) out[app] = (await inboxEvents(ctx.env, app, { uuid: "none" })).last_seq;
  return out;
}

const profileJourney: Journey = {
  name: "webhooks-carbon-profile",
  title: "a Carbon's id, profile and contact changes reach exactly the member apps that may see them, signed, with payloads cut to each app's scopes (account.id_changed, account.updated)",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await newCarbon(ctx, "profile");
    const sessions: Record<string, AppSession> = {};
    sessions.briefcase = await signIntoApp(ctx, carbon, "briefcase", { optionalScopes: [] });
    sessions.remind = await signIntoApp(ctx, carbon, "remind", { optionalScopes: [] });
    const phone = randomPhone();
    sessions.dm = await signIntoApp(ctx, carbon, "dm", { optionalScopes: ["email"], phone });
    sessions.spacestation = await signIntoApp(ctx, carbon, "spacestation");
    const scopes = Object.fromEntries(Object.entries(sessions).map(([app, s]) => [app, s.scope.split(" ").sort()]));
    checkEq(results, "setup: the scopes granted are briefcase profile+email, remind profile+timezone, dm profile+phone+email", { briefcase: scopes.briefcase, remind: scopes.remind, dm: scopes.dm }, { briefcase: ["email", "profile"], remind: ["profile", "timezone"], dm: ["email", "phone", "profile"] });
    checkEq(results, "signing into four apps (and adding dm's required phone) sent no webhook event yet", await storedEvents(env, { account: carbon.uuid }), []);
    const apps = ["briefcase", "dm", "remind"];

    // ---- account.id_changed ---------------------------------------------------------------------------------------
    let after = await seqs(ctx, apps);
    let since = Date.now();
    const newId = `c:wh-renamed-${uid()}`;
    must("change the id", await carbon.visitor.call("POST", "/v1/me/id", { json: { id: newId } }), 200);
    const idRows = await storedEvents(env, { account: carbon.uuid, type: "account.id_changed" });
    checkEq(results, "id change: one account.id_changed per member app with a webhook (briefcase, dm, remind; spacestation has no webhook)", idRows.map(row => row.target_id).sort(), apps);
    results.check("id change: every app's event has its own event_id", new Set(idRows.map(row => row.event_id)).size === idRows.length, idRows.map(row => row.event_id).join(", "));
    let got = await receivedBy(ctx, apps, carbon.uuid, "account.id_changed", after);
    for (const app of apps) {
      const event = got[app];
      results.check(`id change: ${app} received account.id_changed with a valid signature`, !!event, event ? `${Date.parse(event.received_at) - since} ms after the change` : "nothing within 25 s");
      if (!event) continue;
      const problems = envelopeProblems(event.payload, { type: "account.id_changed", app_id: app, silicon: null });
      results.check(`id change: ${app}'s envelope is {event_id (UUIDv7), type, occurred_at, app_id: ${app}, silicon: null, data}`, problems.length === 0, problems.join("; ") || short(event.payload, 300));
      checkEq(results, `id change: ${app}'s data is {uuid, membership_id, kind, old_id, new_id}`, event.payload.data, { uuid: carbon.uuid, membership_id: `${app}:${carbon.uuid}`, kind: "carbon", old_id: carbon.id, new_id: newId });
      const row = idRows.find(candidate => candidate.target_id === app);
      results.check(`id change: ${app} got exactly the stored body (same event_id, same JSON)`, !!row && row.event_id === event.event_id && sameJson(row.payload, event.payload), row ? `${row.event_id} vs ${event.event_id}` : "no stored row");
      results.metric(`id change → ${app} received`, Date.parse(event.received_at) - since, "ms");
    }

    // ---- account.updated: a field every app sees ----------------------------------------------------------------------
    after = await seqs(ctx, apps);
    since = Date.now();
    const name = `WH Renamed ${uid()}`;
    must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: name } }), 200);
    checkEq(results, "display name: account.updated is stored for briefcase, dm and remind", await targetsSince(ctx, carbon.uuid, "account.updated", since), apps);
    got = await receivedBy(ctx, apps, carbon.uuid, "account.updated", after);
    const versions: Record<string, number[]> = { briefcase: [], dm: [], remind: [] };
    for (const app of apps) {
      const event = got[app];
      if (!results.check(`display name: ${app} received account.updated with a valid signature`, !!event)) continue;
      const data = event!.payload.data as { uuid?: string; membership_id?: string; changed?: string[]; account?: Record<string, unknown> };
      const problems = envelopeProblems(event!.payload, { type: "account.updated", app_id: app, silicon: null });
      results.check(`display name: ${app}'s envelope is right`, problems.length === 0, problems.join("; "));
      checkEq(results, `display name: ${app}'s data is {uuid, membership_id, changed: [display_name], account}`, { uuid: data.uuid, membership_id: data.membership_id, changed: data.changed, keys: Object.keys(data).sort() }, { uuid: carbon.uuid, membership_id: `${app}:${carbon.uuid}`, changed: ["display_name"], keys: ["account", "changed", "membership_id", "uuid"] });
      const account = data.account ?? {};
      checkEq(results, `display name: ${app}'s account object holds exactly the fields its scopes allow`, Object.keys(account).sort(), VISIBLE[app]);
      results.check(`display name: ${app}'s account shows the new name and the current id`, account.display_name === name && account.id === newId && account.membership_id === `${app}:${carbon.uuid}`, short(account, 400));
      if (app !== "remind") results.check(`display name: ${app} sees the primary email, verified`, account.email === carbon.email && account.email_verified === true, `${String(account.email)} ${String(account.email_verified)}`);
      if (app === "dm") results.check("display name: dm sees the phone it required, verified", account.phone === phone && account.phone_verified === true, `${String(account.phone)} ${String(account.phone_verified)}`);
      if (app === "remind") results.check("display name: remind sees the timezone (its required scope)", account.timezone === "Asia/Kolkata", String(account.timezone));
      versions[app]!.push(Number(account.version));
    }

    // ---- account.updated: a field only one app may see -----------------------------------------------------------------
    after = await seqs(ctx, apps);
    since = Date.now();
    must("change the timezone", await carbon.visitor.call("PATCH", "/v1/me", { json: { timezone: "Europe/Berlin" } }), 200);
    checkEq(results, "timezone: only remind (the one app granted timezone) gets account.updated; briefcase refused the optional scope, dm never had it", await targetsSince(ctx, carbon.uuid, "account.updated", since), ["remind"]);
    const tz = (await receivedBy(ctx, ["remind"], carbon.uuid, "account.updated", after)).remind;
    const tzData = tz?.payload.data as { changed?: string[]; account?: Record<string, unknown> } | undefined;
    results.check("timezone: remind received changed [timezone] with the new timezone", sameJson(tzData?.changed, ["timezone"]) && tzData?.account?.timezone === "Europe/Berlin", short(tzData, 300));
    if (tzData?.account) versions.remind!.push(Number(tzData.account.version));

    // ---- a field no app may see -------------------------------------------------------------------------------------
    since = Date.now();
    must("change the date of birth", await carbon.visitor.call("PATCH", "/v1/me", { json: { dob: "1990-05-17" } }), 200);
    checkEq(results, "date of birth: no member app was granted dob, so no event at all", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`), []);

    // ---- several fields at once: each app hears only of what it may see ---------------------------------------------
    after = await seqs(ctx, apps);
    since = Date.now();
    const name2 = `WH Both ${uid()}`;
    must("rename and move", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: name2, timezone: "America/Chicago" } }), 200);
    got = await receivedBy(ctx, apps, carbon.uuid, "account.updated", after);
    const changed = Object.fromEntries(apps.map(app => [app, ((got[app]?.payload.data as { changed?: string[] } | undefined)?.changed ?? []).slice().sort()]));
    checkEq(results, "name + timezone at once: briefcase and dm hear [display_name], remind [display_name, timezone]", changed, { briefcase: ["display_name"], dm: ["display_name"], remind: ["display_name", "timezone"] });
    for (const app of apps) {
      const account = (got[app]?.payload.data as { account?: Record<string, unknown> } | undefined)?.account;
      if (account) versions[app]!.push(Number(account.version));
      if (app !== "remind") results.check(`name + timezone at once: ${app}'s account object still has no timezone`, !!account && !("timezone" in account), short(account, 300));
    }

    // ---- primary email: briefcase and dm (scope email), not remind -------------------------------------------------------
    const email2 = `wh.second+${uid()}@example.test`;
    let seq = await lastSeq(env);
    const challenge = must("add a second email", await carbon.visitor.call<{ challenge_id: string }>("POST", "/v1/me/emails", { json: { email: email2 } }), [200, 201]).body;
    since = Date.now();
    must("verify the second email", await carbon.visitor.call("POST", "/v1/me/emails/verify", { json: { challenge_id: challenge.challenge_id, code: await codeFor(env, email2, seq) } }), 200);
    checkEq(results, "adding a second (not primary) email changes nothing an app sees: no event", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`), []);
    after = await seqs(ctx, apps);
    since = Date.now();
    must("make it primary", await carbon.visitor.call("POST", `/v1/me/emails/${encodeURIComponent(email2)}/primary`), 200);
    checkEq(results, "new primary email: account.updated for briefcase and dm (scope email), not remind", await targetsSince(ctx, carbon.uuid, "account.updated", since), ["briefcase", "dm"]);
    got = await receivedBy(ctx, ["briefcase", "dm"], carbon.uuid, "account.updated", after);
    for (const app of ["briefcase", "dm"]) {
      const data = got[app]?.payload.data as { changed?: string[]; account?: Record<string, unknown> } | undefined;
      results.check(`new primary email: ${app} hears changed [email] and the new address, verified`, sameJson(data?.changed, ["email"]) && data?.account?.email === email2 && data?.account?.email_verified === true, short(data, 400));
      if (data?.account) versions[app]!.push(Number(data.account.version));
    }

    // ---- primary phone: only dm (scope phone) ------------------------------------------------------------------------------
    const phone2 = randomPhone();
    seq = await lastSeq(env);
    const phoneChallenge = must("add a second phone", await carbon.visitor.call<{ challenge_id: string }>("POST", "/v1/me/phones", { json: { phone: phone2 } }), [200, 201]).body;
    must("verify the second phone", await carbon.visitor.call("POST", "/v1/me/phones/verify", { json: { challenge_id: phoneChallenge.challenge_id, code: await codeFor(env, phone2, seq) } }), 200);
    after = await seqs(ctx, ["dm"]);
    since = Date.now();
    must("make the phone primary", await carbon.visitor.call("POST", `/v1/me/phones/${encodeURIComponent(phone2)}/primary`), 200);
    checkEq(results, "new primary phone: account.updated only for dm (the one app granted phone)", await targetsSince(ctx, carbon.uuid, "account.updated", since), ["dm"]);
    const phoneEvent = (await receivedBy(ctx, ["dm"], carbon.uuid, "account.updated", after)).dm;
    const phoneData = phoneEvent?.payload.data as { changed?: string[]; account?: Record<string, unknown> } | undefined;
    results.check("new primary phone: dm hears changed [phone] and the new number", sameJson(phoneData?.changed, ["phone"]) && phoneData?.account?.phone === phone2, short(phoneData, 400));
    if (phoneData?.account) versions.dm!.push(Number(phoneData.account.version));

    // ---- ordering and integrity ----------------------------------------------------------------------------------------------
    const increasing = Object.entries(versions).every(([, list]) => list.every((value, index) => index === 0 || value > list[index - 1]!));
    results.check("account.version only grows from one account.updated to the next (apps can drop stale updates)", increasing, JSON.stringify(versions));
    // Five renames at once: deliveries may arrive in any order, so the version is what tells the app which is current.
    const burstSince = Date.now();
    const names = Array.from({ length: 5 }, (_, index) => `WH Burst ${index} ${uid()}`);
    await Promise.all(names.map(burstName => carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: burstName } })));
    const finalName = must("me", await carbon.visitor.call<{ display_name: string }>("GET", "/v1/me"), 200).body.display_name;
    const burstRows = await until(async () => {
      const rows = (await storedEvents(env, { account: carbon.uuid, type: "account.updated", target: "remind", afterMs: burstSince - 1 })).filter(row => row.status === "delivered");
      return rows.length >= 5 ? rows : null;
    }, 20_000);
    const burstVersions = (burstRows ?? []).map(row => Number((row.payload.data as { account?: { version?: number } }).account?.version));
    const newest = (burstRows ?? []).reduce<{ version: number; name: string }>((best, row) => {
      const account = (row.payload.data as { account?: { version?: number; display_name?: string } }).account;
      return Number(account?.version) > best.version ? { version: Number(account?.version), name: String(account?.display_name) } : best;
    }, { version: -1, name: "" });
    results.check("five concurrent renames: five events for remind, five distinct versions, and the highest version carries the name the account ended with", (burstRows?.length ?? 0) === 5 && new Set(burstVersions).size === 5 && newest.name === finalName, `versions ${burstVersions.join(",")}; newest "${newest.name}" vs final "${finalName}"`);
    const mine = new Set((await storedEvents(env, { account: carbon.uuid })).map(row => row.event_id));
    let refused = 0;
    let duplicates = 0;
    for (const app of apps) {
      const list = await inboxEvents(env, app, { uuid: carbon.uuid });
      refused += (list.rejected ?? []).filter(entry => entry.event_id && mine.has(entry.event_id)).length;
      duplicates += list.items.reduce((sum, item) => sum + item.duplicate_count, 0);
    }
    results.check("no delivery about this Carbon was refused by a fake app (every signature verified, every body matched its headers)", refused === 0, `${refused} refused`);
    results.check("and none arrived twice", duplicates === 0, `${duplicates} duplicates`);
    await until(async () => (await storedEvents(env, { account: carbon.uuid })).every(row => row.status === "delivered"), 15_000);
    const stored = await storedEvents(env, { account: carbon.uuid });
    checkEq(results, `all ${stored.length} deliveries about this Carbon ended delivered`, stored.filter(row => row.status !== "delivered").map(row => `${row.type}→${row.target_id}: ${row.status}`), []);
  },
};

/** Removes access, has an app sign the Carbon out, then deletes the account. */
const endsJourney: Journey = {
  name: "webhooks-carbon-ends",
  title: "access removed, signed out (app_revoked) and account deleted reach only the apps concerned, with {uuid, membership_id[, reason]} and no account data; deleting is refused (and silent) while custodian of a Silicon",
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const carbon: Carbon = await newCarbon(ctx, "ends");
    const briefcase = await signIntoApp(ctx, carbon, "briefcase");
    await signIntoApp(ctx, carbon, "remind");
    await signIntoApp(ctx, carbon, "dm", { phone: randomPhone() });

    // ---- membership.access_removed -------------------------------------------------------------------------------------
    let since = Date.now();
    let after = (await inboxEvents(env, "remind", { uuid: "none" })).last_seq;
    must("remove remind's access", await carbon.visitor.call("DELETE", "/v1/me/apps/remind"), [200, 204]);
    checkEq(results, "access removed: membership.access_removed is stored for remind only", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`), ["membership.access_removed→remind"]);
    const removed = await waitEvent(env, "remind", { type: "membership.access_removed", uuid: carbon.uuid, after });
    results.check("access removed: remind received it with a valid signature", !!removed);
    if (removed) {
      const problems = envelopeProblems(removed.payload, { type: "membership.access_removed", app_id: "remind", silicon: null });
      results.check("access removed: the envelope is right", problems.length === 0, problems.join("; "));
      checkEq(results, "access removed: data is exactly {uuid, membership_id}", removed.payload.data, { uuid: carbon.uuid, membership_id: `remind:${carbon.uuid}` });
    }
    const myApps = must("my apps", await carbon.visitor.call<{ items: Array<{ app: { app_id: string }; status: string }> }>("GET", "/v1/me/apps?limit=200"), 200).body.items;
    checkEq(results, "access removed: only remind's membership is access_removed", Object.fromEntries(myApps.map(item => [item.app.app_id, item.status])), { briefcase: "active", dm: "active", remind: "access_removed" });

    // A later change no longer reaches remind.
    since = Date.now();
    must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH After ${uid()}` } }), 200);
    checkEq(results, "after access removal: a rename reaches briefcase and dm, never remind", (await storedEvents(env, { account: carbon.uuid, type: "account.updated", afterMs: since - 1 })).map(row => row.target_id).sort(), ["briefcase", "dm"]);
    since = Date.now();
    must("remove remind's access again", await carbon.visitor.call("DELETE", "/v1/me/apps/remind"), [200, 204, 404, 409]);
    checkEq(results, "removing an already removed access sends nothing again", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`), []);

    // ---- membership.signed_out (app_revoked) --------------------------------------------------------------------------
    since = Date.now();
    after = (await inboxEvents(env, "briefcase", { uuid: "none" })).last_seq;
    must("briefcase revokes its refresh token", await appCall(env, "briefcase", "POST", "/v1/oauth/revoke", { form: { token: briefcase.refreshToken } }), 200);
    const signedOut = await waitEvent(env, "briefcase", { type: "membership.signed_out", uuid: carbon.uuid, after });
    results.check("signed out: briefcase received membership.signed_out with a valid signature", !!signedOut);
    if (signedOut) checkEq(results, "signed out: data is {uuid, membership_id, reason: app_revoked}", signedOut.payload.data, { uuid: carbon.uuid, membership_id: `briefcase:${carbon.uuid}`, reason: "app_revoked" });
    must("revoke again", await appCall(env, "briefcase", "POST", "/v1/oauth/revoke", { form: { token: briefcase.refreshToken } }), 200);
    checkEq(results, "signed out: revoking the same sign-in again tells briefcase nothing new", (await storedEvents(env, { account: carbon.uuid, type: "membership.signed_out", afterMs: since - 1 })).map(row => row.target_id), ["briefcase"]);
    since = Date.now();
    must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH Still ${uid()}` } }), 200);
    checkEq(results, "signed out is not access removed: briefcase (membership still active) keeps getting account.updated", (await storedEvents(env, { account: carbon.uuid, type: "account.updated", afterMs: since - 1 })).map(row => row.target_id).sort(), ["briefcase", "dm"]);

    // ---- deletion refused while custodian: nothing is sent -----------------------------------------------------------
    const keeper = await newCarbon(ctx, "keeper");
    await signIntoApp(ctx, keeper, "briefcase");
    const silicon = await createSilicon(keeper, "kept");
    since = Date.now();
    const refusedDelete = await keeper.visitor.call<{ error?: { code?: string } }>("DELETE", "/v1/me", { json: { confirm: keeper.id } });
    results.check("a custodian can't delete their account (409 custodian_of_silicons)", refusedDelete.status === 409 && refusedDelete.body.error?.code === "custodian_of_silicons", `${refusedDelete.status} ${short(refusedDelete.body, 200)}`);
    checkEq(results, "…and the refused deletion sent no account.deleted", (await storedEvents(env, { account: keeper.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`), []);
    results.check("(the Silicon it keeps)", !!silicon.uuid, silicon.id);

    // ---- account.deleted ----------------------------------------------------------------------------------------------
    const afterApps = { briefcase: (await inboxEvents(env, "briefcase", { uuid: "none" })).last_seq, dm: (await inboxEvents(env, "dm", { uuid: "none" })).last_seq };
    since = Date.now();
    const me = must("me", await carbon.visitor.call<{ id: string }>("GET", "/v1/me"), 200).body;
    must("delete the account", await carbon.visitor.call("DELETE", "/v1/me", { json: { confirm: me.id } }), [200, 204]);
    checkEq(results, "deleted: account.deleted is stored for briefcase and dm, not remind (access removed) and nothing else", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`).sort(), ["account.deleted→briefcase", "account.deleted→dm"]);
    for (const app of ["briefcase", "dm"] as const) {
      const event = await waitEvent(env, app, { type: "account.deleted", uuid: carbon.uuid, after: afterApps[app] });
      results.check(`deleted: ${app} received account.deleted with a valid signature`, !!event);
      if (!event) continue;
      const problems = envelopeProblems(event.payload, { type: "account.deleted", app_id: app, silicon: null });
      results.check(`deleted: ${app}'s envelope is right`, problems.length === 0, problems.join("; "));
      checkEq(results, `deleted: ${app}'s data is exactly {uuid, membership_id} (no account data)`, event.payload.data, { uuid: carbon.uuid, membership_id: `${app}:${carbon.uuid}` });
    }
    const lookup = await appCall(env, "briefcase", "GET", `/v1/accounts/${carbon.uuid}`);
    results.check("deleted: briefcase can no longer look the account up (404)", lookup.status === 404, String(lookup.status));
  },
};

export const journeys: Journey[] = [profileJourney, endsJourney];

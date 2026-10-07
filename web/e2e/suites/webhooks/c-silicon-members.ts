/**
 * App webhooks about a Silicon that signed into apps with short-lived tokens (briefcase, remind), and the matching
 * events on the Silicon's own webhook: its si:id changed by the custodian (account.id_changed kind silicon +
 * silicon.id_changed), its details changed (account.updated with the custodian, never email/phone + silicon.updated),
 * a transfer accepted (silicon.custodian_changed to apps + silicon.custodian.changed to the Silicon), its STK rotated
 * (membership.signed_out reason stk_rotated, once per app + silicon.stk_rotated) and its deletion (account.deleted).
 */
import type { Ctx, Journey } from "../../context";
import {
  type InboxEvent,
  appCall,
  bearerCall,
  checkEq,
  createSilicon,
  envelopeProblems,
  inboxEvents,
  must,
  newCarbon,
  sameJson,
  setInboxSecret,
  short,
  siliconIntoApp,
  siliconLogin,
  storedEvents,
  uid,
  waitEvent,
} from "./_helpers";

const APPS = ["briefcase", "remind"];
const SUMMARY_KEYS = ["display_name", "id", "kind", "pfp_url", "status", "uuid"];

async function lastSeqs(ctx: Ctx, inboxes: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const inbox of inboxes) out[inbox] = (await inboxEvents(ctx.env, inbox, { uuid: "none" })).last_seq;
  return out;
}

export const journey: Journey = {
  name: "webhooks-silicon-members",
  title: "app webhooks about a Silicon member: id change, detail change (custodian shown, no email/phone), transfer (silicon.custodian_changed), STK rotation (signed_out stk_rotated) and deletion, each paired with the Silicon's own event",
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const keeper = await newCarbon(ctx, "keeper");
    const heir = await newCarbon(ctx, "heir");
    const sink = `hooks/wh-member-${uid()}`;
    const silicon = await createSilicon(keeper, "member", { webhookUrl: `${env.apps}/${sink}` });
    results.check("setup: creating the Silicon with a webhook returned its signing secret once", /^whsec_[A-Za-z0-9_-]{43}$/.test(silicon.webhookSecret ?? ""), String(silicon.webhookSecret?.slice(0, 10)));
    await setInboxSecret(env, sink, silicon.webhookSecret);
    const created = await waitEvent(env, sink, { type: "silicon.created", uuid: silicon.uuid });
    results.check("the Silicon's own webhook got silicon.created (custodian-made: status active, no request)", !!created && (created.payload.data as { status?: string }).status === "active" && (created.payload.data as { request?: unknown }).request === null, short(created?.payload.data, 300));

    const token = await siliconLogin(env, silicon.id, silicon.stk);
    const sessions = { briefcase: await siliconIntoApp(env, token, "briefcase"), remind: await siliconIntoApp(env, token, "remind") };
    for (const app of APPS) {
      const account = sessions[app as keyof typeof sessions].account;
      results.check(`setup: ${app}'s view of the Silicon has its custodian and no email/phone`, sameJson(account.custodian, { uuid: keeper.uuid, id: keeper.id }) && !("email" in account) && !("phone" in account), short(account, 300));
    }
    checkEq(results, "signing into apps with short-lived tokens sent the apps nothing", (await storedEvents(env, { account: silicon.uuid, afterMs: Date.now() - 60_000 })).filter(row => row.target_kind === "app").length, 0);
    const scopes = Object.fromEntries(APPS.map(app => [app, sessions[app as keyof typeof sessions].scope.split(" ")]));

    // ---- id change by the custodian --------------------------------------------------------------------------------
    let after = await lastSeqs(ctx, [...APPS, sink]);
    let since = Date.now();
    const newId = `si:wh-member2-${uid()}`;
    must("the custodian changes the si:id", await keeper.visitor.call("POST", `/v1/me/silicons/${silicon.uuid}/id`, { json: { id: newId } }), 200);
    checkEq(results, "si:id change: account.id_changed for briefcase and remind, silicon.id_changed for the Silicon", (await storedEvents(env, { account: silicon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_kind}:${row.target_kind === "app" ? row.target_id : "self"}`).sort(), ["account.id_changed→app:briefcase", "account.id_changed→app:remind", "silicon.id_changed→silicon:self"]);
    for (const app of APPS) {
      const event = await waitEvent(env, app, { type: "account.id_changed", uuid: silicon.uuid, after: after[app] });
      results.check(`si:id change: ${app} received account.id_changed (signature verified)`, !!event);
      if (event) checkEq(results, `si:id change: ${app}'s data says kind silicon, old and new si:id`, event.payload.data, { uuid: silicon.uuid, membership_id: `${app}:${silicon.uuid}`, kind: "silicon", old_id: silicon.id, new_id: newId });
    }
    const idChanged = await waitEvent(env, sink, { type: "silicon.id_changed", uuid: silicon.uuid, after: after[sink] });
    results.check("si:id change: the Silicon's own webhook got silicon.id_changed (signature verified)", !!idChanged);
    if (idChanged) {
      const problems = envelopeProblems(idChanged.payload, { type: "silicon.id_changed", app_id: null, silicon: silicon.uuid });
      results.check("si:id change: the Silicon's envelope has app_id null and silicon = its uuid", problems.length === 0, problems.join("; "));
      checkEq(results, "si:id change: silicon.id_changed data is {uuid, old_id, new_id}", idChanged.payload.data, { uuid: silicon.uuid, old_id: silicon.id, new_id: newId });
    }

    // ---- details changed by the custodian ------------------------------------------------------------------------------
    after = await lastSeqs(ctx, [...APPS, sink]);
    since = Date.now();
    const name = `WH Member ${uid()}`;
    must("the custodian renames the Silicon", await keeper.visitor.call("PATCH", `/v1/me/silicons/${silicon.uuid}`, { json: { display_name: name } }), 200);
    for (const app of APPS) {
      const event = await waitEvent(env, app, { type: "account.updated", uuid: silicon.uuid, after: after[app] });
      if (!results.check(`detail change: ${app} received account.updated`, !!event)) continue;
      const data = event!.payload.data as { changed?: string[]; account?: Record<string, unknown> };
      const account = data.account ?? {};
      const expectedKeys = ["custodian", "display_name", "id", "kind", "membership_id", "pfp_url", "updated_at", "uuid", "version", ...(scopes[app]!.includes("timezone") ? ["timezone"] : []), ...(scopes[app]!.includes("dob") ? ["dob"] : [])].sort();
      checkEq(results, `detail change: ${app} hears changed [display_name] and sees exactly ${expectedKeys.join(", ")} (a Silicon never shows email or phone)`, { changed: data.changed, keys: Object.keys(account).sort() }, { changed: ["display_name"], keys: expectedKeys });
      checkEq(results, `detail change: ${app}'s view names the custodian {uuid, id}`, account.custodian, { uuid: keeper.uuid, id: keeper.id });
      results.check(`detail change: ${app}'s view is kind silicon with the new name and si:id`, account.kind === "silicon" && account.display_name === name && account.id === newId, short(account, 300));
    }
    const updated = await waitEvent(env, sink, { type: "silicon.updated", uuid: silicon.uuid, after: after[sink] });
    const updatedData = updated?.payload.data as { uuid?: string; id?: string; changed?: string[]; silicon?: Record<string, unknown> } | undefined;
    results.check("detail change: the Silicon's own webhook got silicon.updated {uuid, id, changed: [display_name], silicon (its full view)}", !!updatedData && updatedData.uuid === silicon.uuid && updatedData.id === newId && sameJson(updatedData.changed, ["display_name"]) && updatedData.silicon?.display_name === name, short(updatedData, 400));

    // ---- transfer to another Carbon ---------------------------------------------------------------------------------------
    const transfer = must("transfer the Silicon", await keeper.visitor.call<{ request: { id: string } }>("POST", `/v1/me/silicons/${silicon.uuid}/transfer`, { json: { to: heir.id } }), 201).body.request;
    checkEq(results, "a transfer that is only requested tells nobody", (await storedEvents(env, { account: silicon.uuid, afterMs: Date.now() - 2_000 })).filter(row => row.type.includes("custodian")).length, 0);
    after = await lastSeqs(ctx, [...APPS, sink]);
    since = Date.now();
    must("the heir accepts", await heir.visitor.call("POST", `/v1/me/custodian-requests/${transfer.id}/accept`), [200, 204]);
    checkEq(results, "transfer accepted: silicon.custodian_changed to briefcase and remind, silicon.custodian.changed to the Silicon", (await storedEvents(env, { account: silicon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_kind === "app" ? row.target_id : "self"}`).sort(), ["silicon.custodian.changed→self", "silicon.custodian_changed→briefcase", "silicon.custodian_changed→remind"]);
    for (const app of APPS) {
      const event = await waitEvent(env, app, { type: "silicon.custodian_changed", uuid: silicon.uuid, after: after[app] });
      if (!results.check(`transfer: ${app} received silicon.custodian_changed (signature verified)`, !!event)) continue;
      const problems = envelopeProblems(event!.payload, { type: "silicon.custodian_changed", app_id: app, silicon: null });
      results.check(`transfer: ${app}'s envelope is right`, problems.length === 0, problems.join("; "));
      const data = event!.payload.data as { uuid?: string; membership_id?: string; from?: Record<string, unknown>; to?: Record<string, unknown> };
      checkEq(results, `transfer: ${app}'s data is {uuid, membership_id, from, to} with full account summaries`, { keys: Object.keys(data).sort(), uuid: data.uuid, membership_id: data.membership_id, fromKeys: Object.keys(data.from ?? {}).sort(), toKeys: Object.keys(data.to ?? {}).sort() }, { keys: ["from", "membership_id", "to", "uuid"], uuid: silicon.uuid, membership_id: `${app}:${silicon.uuid}`, fromKeys: SUMMARY_KEYS, toKeys: SUMMARY_KEYS });
      checkEq(results, `transfer: ${app} learns it moved from the old custodian to the new one`, { from: [data.from?.uuid, data.from?.id, data.from?.kind], to: [data.to?.uuid, data.to?.id, data.to?.kind] }, { from: [keeper.uuid, keeper.id, "carbon"], to: [heir.uuid, heir.id, "carbon"] });
    }
    const own = await waitEvent(env, sink, { type: "silicon.custodian.changed", uuid: silicon.uuid, after: after[sink] });
    const ownData = own?.payload.data as { uuid?: string; id?: string; from?: { uuid?: string }; to?: { uuid?: string } } | undefined;
    results.check("transfer: the Silicon's own webhook got silicon.custodian.changed {uuid, id, from, to}", !!ownData && ownData.uuid === silicon.uuid && ownData.id === newId && ownData.from?.uuid === keeper.uuid && ownData.to?.uuid === heir.uuid, short(ownData, 400));
    after = await lastSeqs(ctx, APPS);
    must("the new custodian renames it", await heir.visitor.call("PATCH", `/v1/me/silicons/${silicon.uuid}`, { json: { display_name: `${name} II` } }), 200);
    const afterTransfer = await waitEvent(env, "briefcase", { type: "account.updated", uuid: silicon.uuid, after: after.briefcase });
    checkEq(results, "after the transfer, apps' account.updated names the new custodian", (afterTransfer?.payload.data as { account?: { custodian?: unknown } } | undefined)?.account?.custodian, { uuid: heir.uuid, id: heir.id });
    since = Date.now();
    const stranger = await keeper.visitor.call("PATCH", `/v1/me/silicons/${silicon.uuid}`, { json: { display_name: "Not mine any more" } });
    checkEq(results, "the old custodian can no longer change it (404), and nothing is sent", { status: stranger.status, events: (await storedEvents(env, { account: silicon.uuid, afterMs: since - 1 })).length }, { status: 404, events: 0 });

    // ---- STK rotation --------------------------------------------------------------------------------------------------------
    after = await lastSeqs(ctx, [...APPS, sink]);
    since = Date.now();
    must("the new custodian rotates the STK", await heir.visitor.call("POST", `/v1/me/silicons/${silicon.uuid}/stk`, { json: {} }), 200);
    checkEq(results, "STK rotated: membership.signed_out once per app (briefcase, remind) and silicon.stk_rotated for the Silicon", (await storedEvents(env, { account: silicon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_kind === "app" ? row.target_id : "self"}`).sort(), ["membership.signed_out→briefcase", "membership.signed_out→remind", "silicon.stk_rotated→self"]);
    for (const app of APPS) {
      const event: InboxEvent | null = await waitEvent(env, app, { type: "membership.signed_out", uuid: silicon.uuid, after: after[app] });
      results.check(`STK rotated: ${app} received membership.signed_out`, !!event);
      if (event) checkEq(results, `STK rotated: ${app}'s data is {uuid, membership_id, reason: stk_rotated}`, event.payload.data, { uuid: silicon.uuid, membership_id: `${app}:${silicon.uuid}`, reason: "stk_rotated" });
      const refresh = await appCall<{ error?: string }>(env, app, "POST", "/v1/oauth/token", { form: { grant_type: "refresh_token", refresh_token: sessions[app as keyof typeof sessions].refreshToken } });
      results.check(`STK rotated: ${app}'s refresh token is dead`, refresh.status === 400 && refresh.body.error === "invalid_grant", String(refresh.status));
    }
    const rotated = await waitEvent(env, sink, { type: "silicon.stk_rotated", uuid: silicon.uuid, after: after[sink] });
    const rotatedData = rotated?.payload.data as { uuid?: string; id?: string; rotated_at?: string; rotated_by?: { uuid?: string; id?: string } } | undefined;
    results.check("STK rotated: the Silicon's own webhook got silicon.stk_rotated {uuid, id, rotated_at, rotated_by: the new custodian}", !!rotatedData && rotatedData.uuid === silicon.uuid && rotatedData.id === newId && /Z$/.test(rotatedData.rotated_at ?? "") && rotatedData.rotated_by?.uuid === heir.uuid, short(rotatedData, 400));
    const oldToken = await bearerCall(env, token, "GET", "/v1/me");
    results.check("STK rotated: the Silicon's old session is dead (401)", oldToken.status === 401, String(oldToken.status));
    results.check("STK rotated: the payloads carry no STK", !JSON.stringify(rotated?.payload ?? {}).includes("stk-"), "");

    // ---- deletion ------------------------------------------------------------------------------------------------------------
    after = await lastSeqs(ctx, APPS);
    since = Date.now();
    must("the custodian deletes the Silicon", await heir.visitor.call("DELETE", `/v1/me/silicons/${silicon.uuid}`, { json: { confirm: newId } }), [200, 204]);
    checkEq(results, "Silicon deleted: account.deleted to briefcase and remind (no other app event)", (await storedEvents(env, { account: silicon.uuid, afterMs: since - 1 })).filter(row => row.target_kind === "app").map(row => `${row.type}→${row.target_id}`).sort(), ["account.deleted→briefcase", "account.deleted→remind"]);
    for (const app of APPS) {
      const event = await waitEvent(env, app, { type: "account.deleted", uuid: silicon.uuid, after: after[app] });
      results.check(`Silicon deleted: ${app} received account.deleted {uuid, membership_id}`, !!event && sameJson(event.payload.data, { uuid: silicon.uuid, membership_id: `${app}:${silicon.uuid}` }), short(event?.payload.data));
    }
  },
};

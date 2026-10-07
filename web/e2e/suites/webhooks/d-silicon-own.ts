/**
 * A Silicon's own webhook (UNDERSTANDING "Silicon webhook"): created, custodian accepted / declined / didn't accept
 * within the 2 weeks, any change to its account (details, si:id, STK rotated), custodian changed (c-silicon-members),
 * set or moved by the Silicon or its custodian, removed, test pings. "Silicon webhooks are separate from app webhooks
 * but follow these same rules": signed, retried until they succeed (here: a fault, then the 72-hour window), and
 * failed deliveries can be replayed. Every Silicon gets its own sink on the fake app server (/hooks/<key>), told the
 * secret its creation or webhook change returned.
 */
import { randomUUID } from "node:crypto";
import type { Ctx, Journey } from "../../context";
import { randomIp, sleep, sql } from "../../lib";
import {
  type Carbon,
  ageDelivery,
  bearerCall,
  checkEq,
  createSilicon,
  envelopeProblems,
  inboxEvents,
  must,
  newCarbon,
  publicCall,
  retryNow,
  sameJson,
  setFaults,
  setInboxSecret,
  short,
  siliconLogin,
  sqlRows,
  storedEvents,
  uid,
  waitAttempts,
  waitEvent,
} from "./_helpers";

interface SelfCreated {
  silicon: { uuid: string; id: string; status: string };
  stk: string | null;
  request: { id: string; kind: string; status: string; expires_at: string; custodian: string };
  request_token: string;
  webhook_secret: string | null;
}

const newSink = (label: string) => `hooks/wh-${label}-${uid()}`;

/** A Silicon creates its own account naming `custodian`, with its webhook on `sink`, and the sink learns the secret. */
async function selfCreate(ctx: Ctx, label: string, custodian: string, sink: string): Promise<SelfCreated> {
  const answer = must(
    "a Silicon creates its own account",
    await publicCall<SelfCreated>(ctx.env, "POST", "/v1/silicons", {
      json: { id: `si:wh-${label}-${uid()}`, display_name: `WH ${label}`, custodian, webhook_url: `${ctx.env.apps}/${sink}` },
      idempotencyKey: randomUUID(),
      ip: randomIp(),
    }),
    201,
  ).body;
  await setInboxSecret(ctx.env, sink, answer.webhook_secret);
  return answer;
}

const seqOf = async (ctx: Ctx, sink: string) => (await inboxEvents(ctx.env, sink, { uuid: "none" })).last_seq;

const lifecycle: Journey = {
  name: "webhooks-silicon-lifecycle",
  title: "a self-created Silicon's webhook: silicon.created, silicon.custodian.accepted, silicon.updated and silicon.id_changed (by itself), ping, silicon.stk_rotated, moving the webhook (new secret, new URL) by the Silicon and by its custodian, and silence once removed",
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const guardian: Carbon = await newCarbon(ctx, "guardian");
    const sinkA = newSink("own-a");
    const created = await selfCreate(ctx, "own", guardian.id, sinkA);
    const uuid = created.silicon.uuid;
    results.check("self-create: 201 with a generated STK, a pending request, a request token and the webhook secret (shown once)", /^stk-[0-9a-f]{12}$/.test(created.stk ?? "") && created.request.status === "pending" && /^sarq_/.test(created.request_token) && /^whsec_/.test(created.webhook_secret ?? ""), short({ ...created, stk: "…", request_token: "…", webhook_secret: "…" }));

    const born = await waitEvent(env, sinkA, { type: "silicon.created", uuid });
    results.check("silicon.created reached the Silicon's webhook with a valid signature", !!born, born ? `recovered=${born.recovered}` : "nothing in 25 s");
    if (born) {
      const problems = envelopeProblems(born.payload, { type: "silicon.created", app_id: null, silicon: uuid });
      results.check("silicon.created: envelope with app_id null and silicon = its uuid", problems.length === 0, problems.join("; "));
      const data = born.payload.data as { uuid?: string; id?: string; status?: string; silicon?: Record<string, unknown>; request?: Record<string, unknown> };
      checkEq(results, "silicon.created: data is {uuid, id, status pending_custodian, silicon, request {id, kind, status, expires_at, custodian}}", { keys: Object.keys(data).sort(), uuid: data.uuid, id: data.id, status: data.status, request: data.request }, { keys: ["id", "request", "silicon", "status", "uuid"], uuid, id: created.silicon.id, status: "pending_custodian", request: { id: created.request.id, kind: "initial", status: "pending", expires_at: created.request.expires_at, custodian: guardian.id } });
      results.check("silicon.created: its silicon view shows the webhook URL and the pending status", data.silicon?.webhook_url === `${env.apps}/${sinkA}` && data.silicon?.status === "pending_custodian", short(data.silicon, 300));
      results.check("silicon.created: no secret travels in the event (no STK, request token or webhook secret)", !/stk-[0-9a-f]{6}|sarq_|whsec_/.test(JSON.stringify(born.payload)), "");
    }

    // ---- the custodian accepts --------------------------------------------------------------------------------------
    let after = await seqOf(ctx, sinkA);
    must("the guardian accepts", await guardian.visitor.call("POST", `/v1/me/custodian-requests/${created.request.id}/accept`), [200, 204]);
    const accepted = await waitEvent(env, sinkA, { type: "silicon.custodian.accepted", uuid, after });
    const acceptedData = accepted?.payload.data as { uuid?: string; id?: string; request_id?: string; custodian?: Record<string, unknown>; silicon?: Record<string, unknown> } | undefined;
    results.check("silicon.custodian.accepted reached the webhook (signature verified)", !!accepted);
    checkEq(results, "silicon.custodian.accepted: {uuid, id, request_id, custodian: the Carbon's summary, silicon: now active}", { keys: Object.keys(acceptedData ?? {}).sort(), uuid: acceptedData?.uuid, request_id: acceptedData?.request_id, custodian: [acceptedData?.custodian?.uuid, acceptedData?.custodian?.id, acceptedData?.custodian?.kind], status: acceptedData?.silicon?.status }, { keys: ["custodian", "id", "request_id", "silicon", "uuid"], uuid, request_id: created.request.id, custodian: [guardian.uuid, guardian.id, "carbon"], status: "active" });

    // ---- the Silicon changes its own details and id ---------------------------------------------------------------------
    const token = await siliconLogin(env, created.silicon.id, created.stk!);
    after = await seqOf(ctx, sinkA);
    const name = `WH Own ${uid()}`;
    must("the Silicon renames itself", await bearerCall(env, token, "PATCH", "/v1/me", { json: { display_name: name, timezone: "Europe/Paris" } }), 200);
    const updated = await waitEvent(env, sinkA, { type: "silicon.updated", uuid, after });
    const updatedData = updated?.payload.data as { uuid?: string; id?: string; changed?: string[]; silicon?: Record<string, unknown> } | undefined;
    checkEq(results, "silicon.updated (by the Silicon): {uuid, id, changed [display_name, timezone], silicon with both}", { keys: Object.keys(updatedData ?? {}).sort(), uuid: updatedData?.uuid, changed: [...(updatedData?.changed ?? [])].sort(), name: updatedData?.silicon?.display_name, tz: updatedData?.silicon?.timezone }, { keys: ["changed", "id", "silicon", "uuid"], uuid, changed: ["display_name", "timezone"], name, tz: "Europe/Paris" });
    after = await seqOf(ctx, sinkA);
    const newId = `si:wh-own2-${uid()}`;
    must("the Silicon changes its own si:id", await bearerCall(env, token, "POST", "/v1/me/id", { json: { id: newId } }), 200);
    const renamed = await waitEvent(env, sinkA, { type: "silicon.id_changed", uuid, after });
    checkEq(results, "silicon.id_changed (by the Silicon): {uuid, old_id, new_id}", renamed?.payload.data, { uuid, old_id: created.silicon.id, new_id: newId });

    // ---- test ping ---------------------------------------------------------------------------------------------------
    after = await seqOf(ctx, sinkA);
    const ping = must("the Silicon sends a test ping", await bearerCall<{ event_id: string; delivery_id: string; type: string; url: string; superseded_pings: number }>(env, token, "POST", "/v1/me/webhook/test"), 202).body;
    results.check("test ping: 202 {event_id, delivery_id, type ping, url, superseded_pings 0}", ping.type === "ping" && ping.url === `${env.apps}/${sinkA}` && ping.superseded_pings === 0 && !!ping.event_id && !!ping.delivery_id, short(ping));
    const pinged = await waitEvent(env, sinkA, { type: "ping", event_id: ping.event_id, after });
    const pingProblems = envelopeProblems(pinged?.payload, { type: "ping", app_id: null, silicon: uuid });
    results.check("test ping: the webhook received it signed, {…, app_id null, silicon uuid, data {}}", !!pinged && pingProblems.length === 0 && sameJson(pinged.payload.data, {}), pingProblems.join("; "));

    // ---- the Silicon moves its webhook: new URL, new secret --------------------------------------------------------------
    const badUrl = await bearerCall<{ error?: { code?: string; details?: { fields?: Record<string, string> } } }>(env, token, "PUT", "/v1/me/webhook", { json: { url: "ftp://example.com/hooks" } });
    const stillA = must("me", await bearerCall<{ webhook_url?: string }>(env, token, "GET", "/v1/me"), 200).body.webhook_url;
    results.check("an invalid webhook URL is refused (422, reason on url) and the webhook stays as it was", badUrl.status === 422 && !!badUrl.body.error?.details?.fields?.url && stillA === `${env.apps}/${sinkA}`, `${badUrl.status} ${short(badUrl.body.error?.details?.fields)}; ${stillA}`);
    const sinkB = newSink("own-b");
    const moved = must("the Silicon moves its webhook", await bearerCall<{ webhook_url: string; webhook_secret: string }>(env, token, "PUT", "/v1/me/webhook", { json: { url: `${env.apps}/${sinkB}` } }), 200).body;
    results.check("moving the webhook returns the new URL and a new secret", moved.webhook_url === `${env.apps}/${sinkB}` && /^whsec_/.test(moved.webhook_secret) && moved.webhook_secret !== created.webhook_secret, moved.webhook_url);
    await setInboxSecret(env, sinkB, moved.webhook_secret);
    const seqA = await seqOf(ctx, sinkA);
    const afterB = await seqOf(ctx, sinkB);
    must("the guardian rotates the STK", await guardian.visitor.call("POST", `/v1/me/silicons/${uuid}/stk`, { json: {} }), 200);
    const rotated = await waitEvent(env, sinkB, { type: "silicon.stk_rotated", uuid, after: afterB });
    const rotatedData = rotated?.payload.data as { uuid?: string; id?: string; rotated_at?: string; rotated_by?: { uuid?: string } } | undefined;
    results.check("after the move: silicon.stk_rotated arrives at the new URL, signed with the new secret (the new sink knows only that one)", !!rotatedData && rotatedData.uuid === uuid && rotatedData.id === newId && rotatedData.rotated_by?.uuid === guardian.uuid, short(rotatedData));
    await sleep(1500);
    checkEq(results, "after the move: the old URL hears nothing more", (await inboxEvents(env, sinkA, { uuid, after: seqA })).items.map(item => item.type), []);

    // ---- the custodian moves it, then removes it -----------------------------------------------------------------------
    const sinkC = newSink("own-c");
    const byCustodian = must("the guardian sets the webhook", await guardian.visitor.call<{ webhook_url: string; webhook_secret: string }>("PUT", `/v1/me/silicons/${uuid}/webhook`, { json: { url: `${env.apps}/${sinkC}` } }), 200).body;
    results.check("the custodian setting the webhook gets yet another secret", /^whsec_/.test(byCustodian.webhook_secret) && byCustodian.webhook_secret !== moved.webhook_secret, "");
    await setInboxSecret(env, sinkC, byCustodian.webhook_secret);
    const afterC = await seqOf(ctx, sinkC);
    must("the guardian renames it", await guardian.visitor.call("PATCH", `/v1/me/silicons/${uuid}`, { json: { display_name: `${name} by guardian` } }), 200);
    const byGuardian = await waitEvent(env, sinkC, { type: "silicon.updated", uuid, after: afterC });
    results.check("a change made by the custodian reaches the Silicon too (silicon.updated at the custodian's URL)", !!byGuardian && sameJson((byGuardian.payload.data as { changed?: string[] }).changed, ["display_name"]), short(byGuardian?.payload.data, 200));
    must("the guardian removes the webhook", await guardian.visitor.call("DELETE", `/v1/me/silicons/${uuid}/webhook`), 204);
    const since = Date.now();
    must("the guardian renames it again", await guardian.visitor.call("PATCH", `/v1/me/silicons/${uuid}`, { json: { display_name: `${name} quiet` } }), 200);
    checkEq(results, "with the webhook removed, a change stores no event for the Silicon at all", (await storedEvents(env, { target: uuid, afterMs: since - 1 })).map(row => row.type), []);
    const noHook = await guardian.visitor.call<{ silicon?: { webhook_url?: unknown } } & Record<string, unknown>>("GET", `/v1/me/silicons/${uuid}`);
    results.check("…and the Silicon shows no webhook URL", noHook.status === 200 && (noHook.body.webhook_url ?? null) === null, short(noHook.body, 200));
  },
};

const requests: Journey = {
  name: "webhooks-silicon-requests",
  title: "a self-created Silicon is told when its custodian declines (id released), when nobody accepts within 14 days (time travel: silicon.custodian.expired) and when the Carbon it named deletes their account (declined, custodian_account_deleted); a custodian named by email stays masked",
  timeoutMs: 4 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const asked = await newCarbon(ctx, "asked");

    // ---- declined ----------------------------------------------------------------------------------------------------
    const sinkD = newSink("declined");
    const declined = await selfCreate(ctx, "declined", asked.id, sinkD);
    results.check("decline: silicon.created arrived first", !!(await waitEvent(env, sinkD, { type: "silicon.created", uuid: declined.silicon.uuid })));
    let after = await seqOf(ctx, sinkD);
    must("the Carbon declines", await asked.visitor.call("POST", `/v1/me/custodian-requests/${declined.request.id}/decline`), [200, 204]);
    const told = await waitEvent(env, sinkD, { type: "silicon.custodian.declined", uuid: declined.silicon.uuid, after });
    const toldData = told?.payload.data as Record<string, unknown> | undefined;
    results.check("decline: silicon.custodian.declined reached the webhook (signature verified)", !!told);
    checkEq(results, "decline: {uuid, id, request_id, custodian, decided_at, reason declined, released true}", { keys: Object.keys(toldData ?? {}).sort(), uuid: toldData?.uuid, id: toldData?.id, request_id: toldData?.request_id, custodian: toldData?.custodian, reason: toldData?.reason, released: toldData?.released, decided: /Z$/.test(String(toldData?.decided_at)) }, { keys: ["custodian", "decided_at", "id", "reason", "released", "request_id", "uuid"], uuid: declined.silicon.uuid, id: declined.silicon.id, request_id: declined.request.id, custodian: asked.id, reason: "declined", released: true, decided: true });
    const free = await publicCall<{ available?: boolean }>(env, "GET", `/v1/ids/available?id=${encodeURIComponent(declined.silicon.id)}`, { ip: randomIp() });
    results.check("decline: the si:id is free again at once (no reservation for a Silicon that never became active)", free.body.available === true, short(free.body));

    // ---- expired (14 days, by time travel) ----------------------------------------------------------------------------------
    const sinkE = newSink("expired");
    const expiring = await selfCreate(ctx, "expired", asked.id, sinkE);
    results.check("expire: silicon.created arrived first", !!(await waitEvent(env, sinkE, { type: "silicon.created", uuid: expiring.silicon.uuid })));
    const daysLeft = (Date.parse(expiring.request.expires_at) - Date.now()) / 86_400_000;
    results.check("expire: a custodian request lasts 14 days", daysLeft > 13.9 && daysLeft <= 14.01, `${daysLeft.toFixed(3)} days`);
    after = await seqOf(ctx, sinkE);
    await sql(env, `update custodian_requests set expires_at = now() - interval '1 second' where id = '${expiring.request.id}'`);
    const status = await publicCall<{ status?: string }>(env, "GET", `/v1/silicons/requests/${expiring.request.id}`, { headers: { authorization: `Bearer ${expiring.request_token}` } });
    results.check("expire: the Silicon polling its request sees it expired", status.body.status === "expired", short(status.body));
    const expired = await waitEvent(env, sinkE, { type: "silicon.custodian.expired", uuid: expiring.silicon.uuid, after });
    const expiredData = expired?.payload.data as Record<string, unknown> | undefined;
    results.check("expire: silicon.custodian.expired reached the webhook (signature verified)", !!expired);
    checkEq(results, "expire: {uuid, id, request_id, custodian, expired_at, released true}", { keys: Object.keys(expiredData ?? {}).sort(), uuid: expiredData?.uuid, id: expiredData?.id, request_id: expiredData?.request_id, custodian: expiredData?.custodian, released: expiredData?.released, expiredAt: /Z$/.test(String(expiredData?.expired_at)) }, { keys: ["custodian", "expired_at", "id", "released", "request_id", "uuid"], uuid: expiring.silicon.uuid, id: expiring.silicon.id, request_id: expiring.request.id, custodian: asked.id, released: true, expiredAt: true });
    await sleep(500);
    checkEq(results, "expire: told exactly once (the read and the minute sweep don't both send it)", (await storedEvents(env, { target: expiring.silicon.uuid, type: "silicon.custodian.expired" })).length, 1);

    // ---- the named Carbon deletes their account -------------------------------------------------------------------------
    const vanishing = await newCarbon(ctx, "vanishing");
    const sinkF = newSink("orphan");
    const orphan = await selfCreate(ctx, "orphan", vanishing.id, sinkF);
    results.check("orphan: silicon.created arrived first", !!(await waitEvent(env, sinkF, { type: "silicon.created", uuid: orphan.silicon.uuid })));
    after = await seqOf(ctx, sinkF);
    must("the named Carbon deletes their account", await vanishing.visitor.call("DELETE", "/v1/me", { json: { confirm: vanishing.id } }), [200, 204]);
    const orphaned = await waitEvent(env, sinkF, { type: "silicon.custodian.declined", uuid: orphan.silicon.uuid, after });
    const orphanedData = orphaned?.payload.data as Record<string, unknown> | undefined;
    checkEq(results, "orphan: the Silicon is told silicon.custodian.declined with reason custodian_account_deleted, released", { reason: orphanedData?.reason, released: orphanedData?.released, request_id: orphanedData?.request_id, uuid: orphanedData?.uuid }, { reason: "custodian_account_deleted", released: true, request_id: orphan.request.id, uuid: orphan.silicon.uuid });

    // ---- named by an email nobody has: masked in every event ---------------------------------------------------------------
    const sinkG = newSink("byemail");
    const email = `wh.nobody+${uid()}@example.test`;
    const byEmail = await selfCreate(ctx, "byemail", email, sinkG);
    const createdByEmail = await waitEvent(env, sinkG, { type: "silicon.created", uuid: byEmail.silicon.uuid });
    const label = (createdByEmail?.payload.data as { request?: { custodian?: string } } | undefined)?.request?.custodian ?? "";
    results.check("named by email: silicon.created shows the email masked (never the full address)", /^w\*\*\*@example\.test$/.test(label) && !JSON.stringify(createdByEmail?.payload ?? {}).includes(email), label);
  },
};

const delivery: Journey = {
  name: "webhooks-silicon-delivery",
  title: "Silicon webhooks follow the app rules: a failed delivery is retried on the 10 s / 30 s schedule until it succeeds, gives up after 72 hours (time travel), and can be replayed; a new test ping supersedes a failing one; 10 test pings an hour, then 429",
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const custodian = await newCarbon(ctx, "retrier");
    const sink = newSink("retry");
    const silicon = await createSilicon(custodian, "retry", { webhookUrl: `${env.apps}/${sink}` });
    await setInboxSecret(env, sink, silicon.webhookSecret);
    results.check("silicon.created (custodian-made) reached the sink", !!(await waitEvent(env, sink, { type: "silicon.created", uuid: silicon.uuid })));
    const deliveryOf = async (type: string, since: number) => (await storedEvents(env, { target: silicon.uuid, type, afterMs: since - 1 })).at(-1);

    // ---- a fault, then the retry schedule --------------------------------------------------------------------------------
    await setFaults(env, sink, 2, 500);
    let since = Date.now();
    must("rename", await custodian.visitor.call("PATCH", `/v1/me/silicons/${silicon.uuid}`, { json: { display_name: `WH retry ${uid()}` } }), 200);
    const row = await deliveryOf("silicon.updated", since);
    if (!row) throw new Error("no silicon.updated was stored");
    const first = await waitAttempts(env, row.delivery_id, 1);
    const [timing1] = await sqlRows<{ gap: number }>(env, `select extract(epoch from (next_attempt_at - last_attempt_at))::float as gap from webhook_deliveries where id = '${row.delivery_id}'`);
    results.check("Silicon delivery: the first failure (HTTP 500) is retried 10 s later", first?.status === "pending" && first.last_status === 500 && Math.abs((timing1?.gap ?? 0) - 10) < 1.5, `${short(first)} gap ${timing1?.gap}`);
    await retryNow(env, row.delivery_id);
    await waitAttempts(env, row.delivery_id, 2);
    const [timing2] = await sqlRows<{ gap: number; status: string }>(env, `select status, extract(epoch from (next_attempt_at - last_attempt_at))::float as gap from webhook_deliveries where id = '${row.delivery_id}'`);
    results.check("Silicon delivery: the second failure waits 30 s", timing2?.status === "pending" && Math.abs((timing2?.gap ?? 0) - 30) < 1.5, short(timing2));
    await retryNow(env, row.delivery_id);
    const third = await waitAttempts(env, row.delivery_id, 3);
    const arrived = await waitEvent(env, sink, { type: "silicon.updated", event_id: row.event_id });
    results.check("Silicon delivery: the third attempt is delivered, once, with the same event_id", third?.status === "delivered" && !!arrived && arrived.deliveries === 1, `${short(third)} deliveries=${arrived?.deliveries}`);

    // ---- the 72-hour window ----------------------------------------------------------------------------------------------
    await setFaults(env, sink, 1000, 503);
    since = Date.now();
    must("rename", await custodian.visitor.call("PATCH", `/v1/me/silicons/${silicon.uuid}`, { json: { display_name: `WH window ${uid()}` } }), 200);
    const late = await deliveryOf("silicon.updated", since);
    if (!late) throw new Error("no silicon.updated was stored");
    await waitAttempts(env, late.delivery_id, 1);
    await ageDelivery(env, late.delivery_id, 72);
    const gaveUp = await waitAttempts(env, late.delivery_id, 2);
    results.check("Silicon delivery: still failing 72 hours after it was created, it is failed for good", gaveUp?.status === "failed" && gaveUp.last_status === 503, short(gaveUp));
    await setFaults(env, sink, 0);

    // UNDERSTANDING: "failed deliveries can be replayed" and Silicon webhooks "follow these same rules". The app API has
    // GET …/webhook/deliveries and POST …/webhook/replay; a Silicon (or its custodian) needs the same for its webhook.
    const token = await siliconLogin(env, silicon.id, silicon.stk);
    const probes = [
      { who: "Silicon", list: await bearerCall(env, token, "GET", "/v1/me/webhook/deliveries?status=failed"), replay: await bearerCall(env, token, "POST", "/v1/me/webhook/replay", { json: { delivery_ids: [late.delivery_id] }, idempotencyKey: randomUUID() }) },
      { who: "custodian", list: await custodian.visitor.call("GET", `/v1/me/silicons/${silicon.uuid}/webhook/deliveries?status=failed`), replay: await custodian.visitor.call("POST", `/v1/me/silicons/${silicon.uuid}/webhook/replay`, { json: { delivery_ids: [late.delivery_id] }, idempotencyKey: randomUUID() }) },
    ];
    const replayedEvent = await waitEvent(env, sink, { type: "silicon.updated", event_id: late.event_id }, 8_000);
    results.check(
      "Silicon delivery: a failed delivery of the Silicon's webhook can be listed and replayed (by the Silicon or its custodian) and arrives with the same event_id",
      probes.some(probe => probe.replay.status >= 200 && probe.replay.status < 300) && !!replayedEvent,
      probes.map(probe => `${probe.who}: list ${probe.list.status}, replay ${probe.replay.status} ${short(probe.replay.body, 160)}`).join(" | ") + ` | arrived: ${!!replayedEvent}`,
    );

    // ---- test pings: a newer ping supersedes a failing one ------------------------------------------------------------
    await setFaults(env, sink, 1000, 500);
    const ping1 = must("ping 1", await bearerCall<{ event_id: string; delivery_id: string; superseded_pings: number }>(env, token, "POST", "/v1/me/webhook/test"), 202).body;
    await waitAttempts(env, ping1.delivery_id, 1);
    const ping2 = must("ping 2", await bearerCall<{ event_id: string; delivery_id: string; superseded_pings: number }>(env, token, "POST", "/v1/me/webhook/test"), 202).body;
    const [p1] = await sqlRows<{ status: string; last_error: string | null }>(env, `select status, last_error from webhook_deliveries where id = '${ping1.delivery_id}'`);
    results.check("ping: a new test ping supersedes the failing one (superseded_pings 1, the old one failed with the reason)", ping2.superseded_pings === 1 && p1?.status === "failed" && /Superseded by a newer test ping/.test(p1.last_error ?? ""), `${ping2.superseded_pings} ${short(p1)}`);
    await waitAttempts(env, ping2.delivery_id, 1);
    await setFaults(env, sink, 0);
    await retryNow(env, ping2.delivery_id);
    results.check("ping: the newest ping is delivered", !!(await waitEvent(env, sink, { type: "ping", event_id: ping2.event_id })));
    await sleep(1500);
    checkEq(results, "ping: the superseded ping is never sent again", (await inboxEvents(env, sink, { event_id: ping1.event_id })).items.length, 0);

    // ---- 10 test pings an hour --------------------------------------------------------------------------------------------
    const statuses: number[] = [];
    let refused: { status: number; retryAfter: string | null; body: unknown } | null = null;
    for (let i = 0; i < 12 && !refused; i++) {
      const answer = await bearerCall(env, token, "POST", "/v1/me/webhook/test");
      statuses.push(answer.status);
      if (answer.status === 429) refused = { status: answer.status, retryAfter: answer.headers.get("retry-after"), body: answer.body };
    }
    results.check("ping limit: the 11th test ping within the hour is refused with 429 and Retry-After (2 + 8 accepted before it)", statuses.filter(code => code === 202).length === 8 && !!refused && Number(refused.retryAfter) > 0, `${statuses.join(",")} ${short(refused)}`);
    const pings = await sqlRows<{ n: number }>(env, `select count(*)::int as n from webhook_events where target_id = '${silicon.uuid}' and type = 'ping'`);
    checkEq(results, "ping limit: a refused ping queues nothing (10 pings stored)", pings[0]?.n, 10);
    must("remove the webhook", await bearerCall(env, token, "DELETE", "/v1/me/webhook"), 204);
    const none = await bearerCall<{ error?: { code?: string } }>(env, token, "POST", "/v1/me/webhook/test");
    results.check("ping without a webhook: 409 webhook_not_set", none.status === 409 && none.body.error?.code === "webhook_not_set", `${none.status} ${short(none.body, 200)}`);
  },
};

export const journeys: Journey[] = [lifecycle, requests, delivery];

/**
 * Replaying a Silicon's own webhook deliveries (UNDERSTANDING "Webhooks": "failed deliveries can be replayed. Silicon
 * webhooks … follow these same rules"), through the API the Silicon (GET /v1/me/webhook/deliveries…, POST
 * /v1/me/webhook/replay) and its custodian (/v1/me/silicons/{uuid}/webhook/…) have:
 *
 * - two silicon.updated deliveries and a test ping fail for good (the sink answers 503, time travel ends their 72 h);
 * - the list (newest first, status filter, cursors, precise errors) and one delivery (its attempts, the exact payload);
 * - the Silicon moves its webhook, then replays: the event arrives at the new URL with the same event_id and payload,
 *   signed with the new secret (the new sink knows no other); idempotent; a key reused with another body is refused;
 * - test pings are never replayed (skipped test_ping, counted not_replayable), by id or by status;
 * - the custodian replays by status, `since` filtering on creation; by uuid or si:id; a stranger, the Silicon on the
 *   custodian's routes, a Carbon on the Silicon's routes, a call without the site's Origin: all refused;
 * - a pending delivery is skipped already_pending, an unknown one, another Silicon's or an app's delivery not_found;
 * - with the webhook removed a pending delivery fails at its next attempt, saying why, and replay answers 409
 *   webhook_not_set; once a URL is set again the replay goes there;
 * - a replay gets a fresh 72 hours; the replays are in the history of the Silicon and of the custodian who asked;
 * - after a transfer the old custodian loses the deliveries and the new one has them.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { sleep, sql } from "../../lib";
import {
  type Delivery,
  type DeliveryDetail,
  type EventRow,
  type Json,
  RFC3339_MS,
  ageDelivery,
  appCall,
  bearerCall,
  checkEq,
  createSilicon,
  developerToken,
  inboxEvents,
  must,
  newCarbon,
  publicCall,
  retryNow,
  sameJson,
  secondsBetween,
  setFaults,
  setInboxSecret,
  short,
  siliconLogin,
  storedEvents,
  uid,
  until,
  waitAttempts,
  waitEvent,
} from "./_helpers";

interface ReplayAnswer {
  replayed: string[];
  skipped: Array<{ delivery_id: string; reason: string; message: string; event_id?: string; type?: string }>;
  remaining: number;
  not_replayable: number;
  url: string;
}

interface ErrorBody {
  error?: { code?: string; message?: string; hint?: string; details?: { fields?: Record<string, string> } };
}

interface Page {
  items: Delivery[];
  next_cursor: string | null;
}

interface HistoryItem {
  kind: string;
  title: string;
  meta?: { action?: string; details?: { by?: string; replayed?: number; skipped?: number } };
}

const DELIVERY_KEYS = ["account_uuid", "attempts", "created_at", "delivered_at", "event_id", "id", "last_attempt_at", "last_error", "last_status", "manual_replays", "next_attempt_at", "status", "type", "url"];

const newSink = (label: string) => `hooks/wh-${label}-${uid()}`;
const codeOf = (body: unknown) => (body as ErrorBody | null)?.error?.code;

export const journey: Journey = {
  name: "webhooks-silicon-replay",
  title: "a Silicon and its custodian list, inspect and replay the Silicon's own webhook deliveries: same event_id and payload, current URL and secret, fresh 72 h; pings never replayed; idempotent; pending / unknown / foreign ids skipped; 409 without a webhook; only the Silicon and its current custodian",
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const keeper = await newCarbon(ctx, "sikeeper");
    const stranger = await newCarbon(ctx, "sistranger");
    const sinkA = newSink("rp-a");
    const sinkB = newSink("rp-b");
    const sinkC = newSink("rp-c");
    const silicon = await createSilicon(keeper, "replay", { webhookUrl: `${env.apps}/${sinkA}` });
    await setInboxSecret(env, sinkA, silicon.webhookSecret);
    results.check("setup: silicon.created reached the Silicon's webhook", !!(await waitEvent(env, sinkA, { type: "silicon.created", uuid: silicon.uuid })));
    const token = await siliconLogin(env, silicon.id, silicon.stk);
    const own = <T = Json>(method: string, path: string, init: { json?: unknown; idempotencyKey?: string } = {}) => bearerCall<T>(env, token, method, `/v1/me/webhook${path}`, init);
    const byKeeper = <T = Json>(method: string, path: string, init: { json?: unknown; idempotencyKey?: string; origin?: string | null } = {}) => keeper.visitor.call<T>(method, `/v1/me/silicons/${silicon.uuid}/webhook${path}`, init);
    const ownDelivery = async (id: string) => must(`the Silicon reads delivery ${id}`, await own<DeliveryDetail>("GET", `/deliveries/${id}`), 200).body;
    const waitOwn = async (id: string, done: (d: DeliveryDetail) => boolean, timeoutMs = 25_000): Promise<DeliveryDetail | null> => {
      let last: DeliveryDetail | null = null;
      const ok = await until(async () => {
        last = await ownDelivery(id);
        return done(last);
      }, timeoutMs, 300);
      return ok ? last : null;
    };
    const latest = async (type: string, since: number): Promise<EventRow> => {
      const row = (await storedEvents(env, { target: silicon.uuid, type, afterMs: since - 1 })).at(-1);
      if (!row) throw new Error(`no ${type} was stored for the Silicon`);
      return row;
    };

    // Another Silicon of the same custodian and an app's delivery: ids that must never cross over.
    const sinkD = newSink("rp-d");
    const sibling = await createSilicon(keeper, "sibling", { webhookUrl: `${env.apps}/${sinkD}` });
    await setInboxSecret(env, sinkD, sibling.webhookSecret);
    const siblingDelivery = (await storedEvents(env, { target: sibling.uuid, type: "silicon.created" }))[0]?.delivery_id ?? randomUUID();
    const appDelivery = must("briefcase pings its own webhook", await appCall<{ delivery_id: string }>(env, "briefcase", "POST", "/v1/apps/briefcase/webhook/test"), 202).body.delivery_id;

    try {
      // ---- two events and a test ping fail for good -------------------------------------------------------------------
      await setFaults(env, sinkA, 1000, 503);
      let since = Date.now();
      must("the custodian renames the Silicon", await keeper.visitor.call("PATCH", `/v1/me/silicons/${silicon.uuid}`, { json: { display_name: `WH Replay ${uid()}` } }), 200);
      const e1 = await latest("silicon.updated", since);
      since = Date.now();
      must("the Silicon changes its own timezone", await bearerCall(env, token, "PATCH", "/v1/me", { json: { timezone: "Europe/Paris" } }), 200);
      const e2 = await latest("silicon.updated", since);
      const ping = must("the Silicon sends a test ping", await bearerCall<{ event_id: string; delivery_id: string }>(env, token, "POST", "/v1/me/webhook/test"), 202).body;
      const doomed = [e1.delivery_id, e2.delivery_id, ping.delivery_id];
      for (const id of doomed) await waitAttempts(env, id, 1);
      for (const id of doomed) await ageDelivery(env, id, 72);
      const ended = await Promise.all(doomed.map(id => waitAttempts(env, id, 2)));
      results.check("setup: two silicon.updated deliveries and a test ping failed for good (two 503s, 72 hours)", ended.every(row => row?.status === "failed" && row.last_status === 503), short(ended));

      // ---- the list ------------------------------------------------------------------------------------------------------
      const all = must("the Silicon lists its deliveries", await own<Page>("GET", "/deliveries?limit=100"), 200).body;
      const created = all.items.map(item => item.created_at);
      results.check("list: {items, next_cursor null}; the Silicon's four deliveries, every one about the Silicon, newest first", all.next_cursor === null && all.items.length === 4 && all.items.every(item => item.account_uuid === silicon.uuid || item.type === "ping") && created.every((at, i) => i === 0 || Date.parse(created[i - 1]!) >= Date.parse(at)), short(all.items.map(item => [item.type, item.status, item.created_at])));
      const item1 = all.items.find(item => item.id === e1.delivery_id);
      checkEq(results, "list: a delivery has the app delivery's fields", Object.keys(item1 ?? {}).sort(), DELIVERY_KEYS);
      results.check(
        "list: the failed one shows its event, URL, 2 attempts, HTTP 503 with the reason, no next attempt, no replay yet",
        !!item1 && item1.event_id === e1.event_id && item1.type === "silicon.updated" && item1.url === `${env.apps}/${sinkA}` && item1.status === "failed" && item1.attempts === 2 && item1.last_status === 503 && /503/.test(item1.last_error ?? "") && item1.next_attempt_at === null && item1.delivered_at === null && item1.manual_replays === 0 && RFC3339_MS.test(item1.created_at) && RFC3339_MS.test(item1.last_attempt_at ?? ""),
        short(item1),
      );
      const failedOnly = must("list failed", await own<Page>("GET", "/deliveries?status=failed"), 200).body.items.map(item => item.id);
      checkEq(results, "list ?status=failed: exactly the three that failed", [...failedOnly].sort(), [...doomed].sort());
      const deliveredOnly = must("list delivered", await own<Page>("GET", "/deliveries?status=delivered"), 200).body.items.map(item => item.type);
      checkEq(results, "list ?status=delivered: only silicon.created", deliveredOnly, ["silicon.created"]);
      const page1 = must("page 1", await own<Page>("GET", "/deliveries?limit=3"), 200).body;
      const page2 = page1.next_cursor ? must("page 2", await own<Page>("GET", `/deliveries?limit=3&cursor=${encodeURIComponent(page1.next_cursor)}`), 200).body : { items: [], next_cursor: null };
      checkEq(results, "list: limit 3 gives a cursor, the next page continues without gap or overlap and ends", { ids: [...page1.items, ...page2.items].map(item => item.id), lengths: [page1.items.length, page2.items.length], end: page2.next_cursor }, { ids: all.items.map(item => item.id), lengths: [3, 1], end: null });
      const lost = await own<ErrorBody>("GET", "/deliveries?status=lost");
      results.check("list ?status=lost: 400 invalid_query naming the value", lost.status === 400 && codeOf(lost.body) === "invalid_query" && /'lost'/.test(lost.body.error?.message ?? ""), `${lost.status} ${short(lost.body, 300)}`);

      // ---- one delivery -------------------------------------------------------------------------------------------------
      const one = await ownDelivery(e1.delivery_id);
      results.check(
        "one delivery: attempt_count 2 and both attempts (HTTP 503, the reason, a duration)",
        one.attempt_count === 2 && one.attempts.length === 2 && one.attempts.every(attempt => attempt.status_code === 503 && /503/.test(attempt.error ?? "") && typeof attempt.duration_ms === "number" && RFC3339_MS.test(attempt.attempted_at)),
        short(one.attempts),
      );
      results.check("one delivery: the payload is exactly the stored body (app_id null, silicon = its uuid), nothing withheld", sameJson(one.payload, e1.payload) && one.payload.silicon === silicon.uuid && one.payload.app_id === null && one.payload_redacted === false, short({ payload: one.payload, redacted: one.payload_redacted }, 400));
      const notFound: string[] = [];
      for (const [label, id] of [["unknown", randomUUID()], ["not a uuid", "nope"], ["another Silicon's", siblingDelivery], ["an app's", appDelivery]] as const) {
        const answer = await own<ErrorBody>("GET", `/deliveries/${id}`);
        notFound.push(`${label}: ${answer.status} ${codeOf(answer.body)} ${/GET \/v1\/me\/webhook\/deliveries/.test(answer.body.error?.hint ?? "") ? "hint" : "no hint"}`);
      }
      results.check("one delivery: an unknown id, a non-uuid, another Silicon's and an app's delivery are all 404 delivery_not_found, the hint naming the list", notFound.every(line => / 404 delivery_not_found hint$/.test(line)), notFound.join(" | "));
      const crossed = await appCall<ErrorBody>(env, "briefcase", "GET", `/v1/apps/briefcase/webhook/deliveries/${e1.delivery_id}`);
      results.check("…and an app can't read the Silicon's delivery through its own route (404)", crossed.status === 404, `${crossed.status} ${codeOf(crossed.body)}`);

      // ---- the Silicon moves its webhook, then replays ------------------------------------------------------------------------
      const moved = must("the Silicon moves its webhook", await bearerCall<{ webhook_url: string; webhook_secret: string }>(env, token, "PUT", "/v1/me/webhook", { json: { url: `${env.apps}/${sinkB}` } }), 200).body;
      await setInboxSecret(env, sinkB, moved.webhook_secret);
      const key = randomUUID();
      const replayStarted = Date.now();
      const first = must("the Silicon replays e1", await own<ReplayAnswer>("POST", "/replay", { json: { delivery_ids: [e1.delivery_id] }, idempotencyKey: key }), 200);
      checkEq(results, "replay by id (the Silicon): {replayed [e1], skipped [], remaining 0, not_replayable 0, url: the current URL}", first.body, { replayed: [e1.delivery_id], skipped: [], remaining: 0, not_replayable: 0, url: `${env.apps}/${sinkB}` });
      const arrived = await waitEvent(env, sinkB, { event_id: e1.event_id });
      results.check("replay: e1 arrives at the current URL with the same event_id, signed with the current secret (the new sink knows only that one)", !!arrived && arrived.event_id === e1.event_id && !arrived.recovered, arrived ? `${Date.parse(arrived.received_at) - replayStarted} ms after the replay` : "nothing in 25 s");
      results.check("replay: the payload is the original one, unchanged (the name and timezone of that moment)", !!arrived && sameJson(arrived.payload, e1.payload), short(arrived?.payload, 300));
      if (arrived) results.metric("Silicon replay → received", Date.parse(arrived.received_at) - replayStarted, "ms");
      const r1 = await waitOwn(e1.delivery_id, d => d.status === "delivered");
      results.check("replay: delivered; attempts counted from the replay (1), manual_replays 1, sent to the new URL, all 3 attempts listed", !!r1 && r1.attempt_count === 1 && r1.manual_replays === 1 && r1.url === `${env.apps}/${sinkB}` && r1.attempts.length === 3 && r1.attempts.at(-1)?.status_code === 200 && !!r1.delivered_at, short(r1 && { attempts: r1.attempt_count, listed: r1.attempts.length, manual_replays: r1.manual_replays, url: r1.url }));
      const again = await own<ReplayAnswer>("POST", "/replay", { json: { delivery_ids: [e1.delivery_id] }, idempotencyKey: key });
      results.check("the same Idempotency-Key: the same answer, Idempotent-Replayed, nothing re-queued (manual_replays stays 1)", again.status === 200 && again.headers.get("idempotent-replayed") === "true" && sameJson(again.body, first.body) && (await ownDelivery(e1.delivery_id)).manual_replays === 1, `${again.status} ${again.headers.get("idempotent-replayed")}`);
      const reused = await own<ErrorBody>("POST", "/replay", { json: { delivery_ids: [e2.delivery_id] }, idempotencyKey: key });
      results.check("the same Idempotency-Key with another body: 409 idempotency_key_reused", reused.status === 409 && codeOf(reused.body) === "idempotency_key_reused", `${reused.status} ${short(reused.body, 200)}`);

      // ---- test pings are never replayed ----------------------------------------------------------------------------------------
      const pingReplay = must("the Silicon replays the failed ping", await own<ReplayAnswer>("POST", "/replay", { json: { delivery_ids: [ping.delivery_id] }, idempotencyKey: randomUUID() }), 200).body;
      results.check(
        "a failed test ping is not replayed: skipped test_ping (send a new one with POST /v1/me/webhook/test), not_replayable 1",
        pingReplay.replayed.length === 0 && pingReplay.skipped.length === 1 && pingReplay.skipped[0]?.delivery_id === ping.delivery_id && pingReplay.skipped[0]?.reason === "test_ping" && /POST \/v1\/me\/webhook\/test/.test(pingReplay.skipped[0]?.message ?? "") && pingReplay.not_replayable === 1,
        short(pingReplay),
      );

      // ---- the custodian replays by status ------------------------------------------------------------------------------------
      const recent = must("the custodian replays what failed since the journey began", await byKeeper<ReplayAnswer>("POST", "/replay", { json: { status: "failed", since: startedAt }, idempotencyKey: randomUUID() }), 200).body;
      checkEq(results, "replay {status: failed, since}: since filters on creation (these were created 72 h ago), so nothing is picked", { replayed: recent.replayed, remaining: recent.remaining, not_replayable: recent.not_replayable }, { replayed: [], remaining: 0, not_replayable: 0 });
      const byStatus = must("the custodian replays every failed delivery", await byKeeper<ReplayAnswer>("POST", "/replay", { json: { status: "failed" }, idempotencyKey: randomUUID() }), 200).body;
      checkEq(results, "replay {status: failed} (the custodian): e2 only, never the ping (not_replayable 1), to the current URL", byStatus, { replayed: [e2.delivery_id], skipped: [], remaining: 0, not_replayable: 1, url: `${env.apps}/${sinkB}` });
      const arrived2 = await waitEvent(env, sinkB, { event_id: e2.event_id });
      results.check("…and e2 arrives with its own event_id and payload (the change the Silicon made itself)", !!arrived2 && sameJson(arrived2.payload, e2.payload) && sameJson((arrived2.payload.data as { changed?: string[] }).changed, ["timezone"]), short(arrived2?.payload.data, 200));
      const pingAfter = await ownDelivery(ping.delivery_id);
      results.check("the ping stays failed after both replays", pingAfter.status === "failed" && pingAfter.manual_replays === 0, short({ status: pingAfter.status, manual_replays: pingAfter.manual_replays }));

      // ---- who may list and replay ----------------------------------------------------------------------------------------
      const bySiId = must("the custodian lists by si:id", await keeper.visitor.call<Page>("GET", `/v1/me/silicons/${encodeURIComponent(silicon.id)}/webhook/deliveries?limit=100`), 200).body;
      const byUuid = must("the custodian lists by uuid", await byKeeper<Page>("GET", "/deliveries?limit=100"), 200).body;
      results.check("the custodian lists the same deliveries by uuid and by si:id", sameJson(byUuid.items.map(item => item.id), bySiId.items.map(item => item.id)) && byUuid.items.length === 4, `${byUuid.items.length} / ${bySiId.items.length}`);
      const keeperOne = must("the custodian reads e2", await byKeeper<DeliveryDetail>("GET", `/deliveries/${e2.delivery_id}`), 200).body;
      results.check("the custodian reads one delivery with its attempts and payload", keeperOne.event_id === e2.event_id && keeperOne.attempts.length === 3 && sameJson(keeperOne.payload, e2.payload), short({ attempts: keeperOne.attempts.length }));
      const siblingThroughKeeper = await byKeeper<ErrorBody>("GET", `/deliveries/${siblingDelivery}`);
      results.check("the custodian's route for one Silicon does not show another Silicon's delivery (404 delivery_not_found)", siblingThroughKeeper.status === 404 && codeOf(siblingThroughKeeper.body) === "delivery_not_found", `${siblingThroughKeeper.status} ${codeOf(siblingThroughKeeper.body)}`);
      // A developer-platform token (aud=developer) acts only on GET /v1/me, /v1/session, /v1/me/owned-apps and the owner
      // routes of apps (build spec 06-v2 §2): never on a Silicon's webhook, even for its custodian.
      const keeperDev = await developerToken(ctx, keeper.visitor);
      const refusals = [
        ["the custodian's developer-platform token lists", await bearerCall<ErrorBody>(env, keeperDev.accessToken, "GET", `/v1/me/silicons/${silicon.uuid}/webhook/deliveries`), 401, "token_wrong_audience"],
        ["the custodian's developer-platform token replays", await bearerCall<ErrorBody>(env, keeperDev.accessToken, "POST", `/v1/me/silicons/${silicon.uuid}/webhook/replay`, { json: { status: "failed" }, idempotencyKey: randomUUID() }), 401, "token_wrong_audience"],
        ["a stranger lists", await stranger.visitor.call<ErrorBody>("GET", `/v1/me/silicons/${silicon.uuid}/webhook/deliveries`), 404, "silicon_not_found"],
        ["a stranger reads one", await stranger.visitor.call<ErrorBody>("GET", `/v1/me/silicons/${silicon.uuid}/webhook/deliveries/${e1.delivery_id}`), 404, "silicon_not_found"],
        ["a stranger replays", await stranger.visitor.call<ErrorBody>("POST", `/v1/me/silicons/${silicon.uuid}/webhook/replay`, { json: { status: "failed" }, idempotencyKey: randomUUID() }), 404, "silicon_not_found"],
        ["the Silicon on the custodian's route", await bearerCall<ErrorBody>(env, token, "GET", `/v1/me/silicons/${silicon.uuid}/webhook/deliveries`), 403, "carbon_only"],
        ["the custodian on the Silicon's route", await keeper.visitor.call<ErrorBody>("GET", "/v1/me/webhook/deliveries"), 403, "silicon_only"],
        ["the custodian replays without the site's Origin", await byKeeper<ErrorBody>("POST", "/replay", { json: { delivery_ids: [e1.delivery_id] }, idempotencyKey: randomUUID(), origin: null }), 403, null],
        ["nobody lists", await publicCall<ErrorBody>(env, "GET", "/v1/me/webhook/deliveries"), 401, null],
        ["nobody replays", await publicCall<ErrorBody>(env, "POST", "/v1/me/webhook/replay", { json: { status: "failed" } }), 401, null],
      ] as const;
      const refusalLines = refusals.map(([label, answer, status, code]) => `${label}: ${answer.status} ${codeOf(answer.body)}${answer.status === status && (code === null || codeOf(answer.body) === code) ? "" : ` (expected ${status} ${code ?? ""})`}`);
      results.check("refused: the custodian's developer-platform token (401 token_wrong_audience), a stranger (404 silicon_not_found), the Silicon on the custodian's routes (403 carbon_only), a Carbon on the Silicon's (403 silicon_only), no Origin (403), nobody (401)", refusalLines.every(line => !line.includes("expected")), refusalLines.join(" | "));
      results.check("…and none of the refused replays re-queued anything (manual_replays of e1 still 1)", (await ownDelivery(e1.delivery_id)).manual_replays === 1);

      // ---- what can't be replayed: pending, unknown, foreign ------------------------------------------------------------------
      await setFaults(env, sinkB, 1000, 500);
      since = Date.now();
      must("the custodian renames the Silicon again", await keeper.visitor.call("PATCH", `/v1/me/silicons/${silicon.uuid}`, { json: { display_name: `WH Replay ${uid()}` } }), 200);
      const e3 = await latest("silicon.updated", since);
      await waitAttempts(env, e3.delivery_id, 1);
      const unknown = randomUUID();
      const mixed = must("the Silicon replays a pending, an unknown, another Silicon's and an app's delivery", await own<ReplayAnswer>("POST", "/replay", { json: { delivery_ids: [e3.delivery_id, unknown, siblingDelivery, appDelivery] }, idempotencyKey: randomUUID() }), 200).body;
      checkEq(results, "skipped: the pending one already_pending; unknown, another Silicon's and an app's delivery not_found (nothing replayed)", { replayed: mixed.replayed, skipped: mixed.skipped.map(entry => [entry.delivery_id, entry.reason]) }, { replayed: [], skipped: [[e3.delivery_id, "already_pending"], [unknown, "not_found"], [siblingDelivery, "not_found"], [appDelivery, "not_found"]] });
      const invalid: Array<[string, unknown]> = [
        ["no body fields", {}],
        ["ids and status together", { delivery_ids: [e1.delivery_id], status: "failed" }],
        ["an empty id list", { delivery_ids: [] }],
        ["a non-uuid id", { delivery_ids: ["nope"] }],
        ["101 ids", { delivery_ids: Array.from({ length: 101 }, () => randomUUID()) }],
        ["status delivered", { status: "delivered" }],
        ["a bad since", { status: "failed", since: "yesterday" }],
        ["since with ids", { delivery_ids: [e1.delivery_id], since: startedAt }],
      ];
      const codes: string[] = [];
      for (const [label, body] of invalid) {
        const answer = await own<ErrorBody>("POST", "/replay", { json: body, idempotencyKey: randomUUID() });
        codes.push(`${label}: ${answer.status} ${codeOf(answer.body)} ${Object.keys(answer.body.error?.details?.fields ?? {}).join(",")}`);
      }
      const unknownField = await own<ErrorBody>("POST", "/replay", { json: { ids: [e1.delivery_id] }, idempotencyKey: randomUUID() });
      codes.push(`an unknown field: ${unknownField.status} ${codeOf(unknownField.body)}`);
      results.check("invalid replay bodies are refused precisely: 422 validation_failed naming the field (an unknown field 4xx)", codes.slice(0, -1).every(code => / 422 validation_failed \S/.test(code)) && /: 4\d\d /.test(codes.at(-1) ?? ""), codes.join(" | "));

      // ---- the webhook removed while e3 is pending ---------------------------------------------------------------------------
      must("the Silicon removes its webhook", await bearerCall(env, token, "DELETE", "/v1/me/webhook"), 204);
      const rightAfter = (await ownDelivery(e3.delivery_id)).status;
      await retryNow(env, e3.delivery_id);
      await waitAttempts(env, e3.delivery_id, 2);
      const d3 = await ownDelivery(e3.delivery_id);
      results.check("removed webhook: the pending delivery fails at its next attempt, nothing sent, the reason saying the endpoint is gone and to replay after setting one", d3.status === "failed" && d3.attempts.at(-1)?.status_code === null && /no webhook endpoint any more/.test(d3.last_error ?? "") && /replay/i.test(d3.last_error ?? ""), `right after the removal: ${rightAfter}; then ${short({ status: d3.status, last_error: d3.last_error })}`);
      const listedWithout = await own<Page>("GET", "/deliveries?status=failed");
      results.check("without a webhook the deliveries can still be listed", listedWithout.status === 200 && listedWithout.body.items.some(item => item.id === e3.delivery_id), String(listedWithout.status));
      const noHookOwn = await own<ErrorBody>("POST", "/replay", { json: { delivery_ids: [e3.delivery_id] }, idempotencyKey: randomUUID() });
      const noHookKeeper = await byKeeper<ErrorBody>("POST", "/replay", { json: { status: "failed" }, idempotencyKey: randomUUID() });
      results.check(
        "replay without a webhook: 409 webhook_not_set, each hint naming the caller's own route to set one",
        noHookOwn.status === 409 && codeOf(noHookOwn.body) === "webhook_not_set" && /PUT \/v1\/me\/webhook\b/.test(noHookOwn.body.error?.hint ?? "") && noHookKeeper.status === 409 && codeOf(noHookKeeper.body) === "webhook_not_set" && (noHookKeeper.body.error?.hint ?? "").includes(`PUT /v1/me/silicons/${silicon.uuid}/webhook`),
        `${noHookOwn.status} ${short(noHookOwn.body.error?.hint)} | ${noHookKeeper.status} ${short(noHookKeeper.body.error?.hint)}`,
      );
      const back = must("the custodian sets the webhook again", await keeper.visitor.call<{ webhook_url: string; webhook_secret: string }>("PUT", `/v1/me/silicons/${silicon.uuid}/webhook`, { json: { url: `${env.apps}/${sinkC}` } }), 200).body;
      await setInboxSecret(env, sinkC, back.webhook_secret);
      const r3 = must("the custodian replays e3", await byKeeper<ReplayAnswer>("POST", "/replay", { json: { delivery_ids: [e3.delivery_id] }, idempotencyKey: randomUUID() }), 200).body;
      const arrived3 = await waitEvent(env, sinkC, { event_id: e3.event_id });
      results.check("…once a URL is set again, the replay goes there, signed with the newest secret", sameJson(r3.replayed, [e3.delivery_id]) && r3.url === `${env.apps}/${sinkC}` && !!arrived3 && sameJson(arrived3.payload, e3.payload), `${short(r3)} arrived: ${!!arrived3}`);

      // ---- a replay gets a fresh 72 hours ------------------------------------------------------------------------------------
      await setFaults(env, sinkC, 1000, 500);
      must("the Silicon replays e1 (created 72 h ago) while the sink fails", await own<ReplayAnswer>("POST", "/replay", { json: { delivery_ids: [e1.delivery_id] }, idempotencyKey: randomUUID() }), 200);
      await waitAttempts(env, e1.delivery_id, 1);
      const fresh = await ownDelivery(e1.delivery_id);
      results.check("fresh window: replayed and failing again, a delivery created 72 h ago keeps retrying (pending, next attempt 10 s later)", fresh.status === "pending" && fresh.attempt_count === 1 && Math.abs(secondsBetween(fresh.attempts.at(-1)?.attempted_at, fresh.next_attempt_at) - 10) < 1.5, short({ status: fresh.status, attempts: fresh.attempt_count, next: fresh.next_attempt_at }));
      await sql(env, `update webhook_deliveries set requeued_at = now() - interval '72 hours', next_attempt_at = now() where id = '${e1.delivery_id}'`);
      const over = await waitAttempts(env, e1.delivery_id, 2);
      results.check("fresh window: 72 hours after the replay it is failed for good again", over?.status === "failed", short(over));
      await setFaults(env, sinkC, 0);
      must("the custodian replays e1 again", await byKeeper<ReplayAnswer>("POST", "/replay", { json: { delivery_ids: [e1.delivery_id] }, idempotencyKey: randomUUID() }), 200);
      const r1b = await waitOwn(e1.delivery_id, d => d.status === "delivered");
      results.check("…a third replay delivers it (manual_replays 3) at the newest URL", !!r1b && r1b.manual_replays === 3 && r1b.url === `${env.apps}/${sinkC}` && !!(await waitEvent(env, sinkC, { event_id: e1.event_id })), short(r1b && { manual_replays: r1b.manual_replays, url: r1b.url }));

      // ---- a delivered event replayed again: the receiver dedupes it by event_id ------------------------------------------
      must("the Silicon replays the delivered e1 once more", await own<ReplayAnswer>("POST", "/replay", { json: { delivery_ids: [e1.delivery_id] }, idempotencyKey: randomUUID() }), 200);
      await waitOwn(e1.delivery_id, d => d.status === "delivered" && d.manual_replays === 4);
      const dupe = await until(async () => {
        const item = (await inboxEvents(env, sinkC, { event_id: e1.event_id })).items[0];
        return item && item.duplicate_count >= 1 ? item : null;
      }, 15_000, 250);
      results.check("dedupe: a delivered event replayed again reaches the Silicon's webhook with the same event_id; the receiver records one event, one duplicate, and answered 2xx (delivered)", !!dupe && dupe.deliveries === 2 && dupe.duplicate_count === 1 && (await inboxEvents(env, sinkC, { event_id: e1.event_id })).items.length === 1, short(dupe && { deliveries: dupe.deliveries, duplicates: dupe.duplicate_count }));

      // ---- history ---------------------------------------------------------------------------------------------------------------
      const siliconHistory = must("the Silicon's history", await bearerCall<{ items: HistoryItem[] }>(env, token, "GET", "/v1/me/history?kind=security&limit=100"), 200).body.items.filter(item => item.meta?.action === "silicon.webhook.replayed");
      const keeperHistory = must("the custodian's history", await keeper.visitor.call<{ items: HistoryItem[] }>("GET", "/v1/me/history?kind=security&limit=100"), 200).body.items.filter(item => item.meta?.action === "silicon.webhook.replayed");
      const strangerHistory = must("the stranger's history", await stranger.visitor.call<{ items: HistoryItem[] }>("GET", "/v1/me/history?limit=100"), 200).body.items.filter(item => item.meta?.action === "silicon.webhook.replayed");
      const bys = (items: HistoryItem[]) => [...new Set(items.map(item => item.meta?.details?.by))].sort();
      checkEq(results, "history: the Silicon's has its own replays and its custodian's; the custodian's has its own only; the refused stranger's has none", { silicon: bys(siliconHistory), keeper: bys(keeperHistory), stranger: strangerHistory.length }, { silicon: ["custodian", "silicon"], keeper: ["custodian"], stranger: 0 });

      // ---- custody moves, and the deliveries with it -----------------------------------------------------------------------------
      const heir = await newCarbon(ctx, "siheir");
      const transfer = must("transfer the Silicon", await keeper.visitor.call<{ request: { id: string } }>("POST", `/v1/me/silicons/${silicon.uuid}/transfer`, { json: { to: heir.id } }), 201).body.request;
      since = Date.now();
      must("the heir accepts", await heir.visitor.call("POST", `/v1/me/custodian-requests/${transfer.id}/accept`), [200, 204]);
      const changed = await waitEvent(env, sinkC, { type: "silicon.custodian.changed", uuid: silicon.uuid }, 25_000);
      results.check("transfer: the Silicon's webhook gets silicon.custodian.changed", !!changed);
      const oldList = await keeper.visitor.call<ErrorBody>("GET", `/v1/me/silicons/${silicon.uuid}/webhook/deliveries`);
      const oldReplay = await keeper.visitor.call<ErrorBody>("POST", `/v1/me/silicons/${silicon.uuid}/webhook/replay`, { json: { status: "failed" }, idempotencyKey: randomUUID() });
      results.check("after the transfer the old custodian can neither list nor replay (404 silicon_not_found)", oldList.status === 404 && codeOf(oldList.body) === "silicon_not_found" && oldReplay.status === 404 && codeOf(oldReplay.body) === "silicon_not_found", `${oldList.status} ${codeOf(oldList.body)} | ${oldReplay.status} ${codeOf(oldReplay.body)}`);
      const heirList = must("the heir lists", await heir.visitor.call<Page>("GET", `/v1/me/silicons/${silicon.uuid}/webhook/deliveries?limit=100`), 200).body.items;
      results.check("…and the new custodian has them all, the transfer's own event included", [e1, e2, e3].every(row => heirList.some(item => item.id === row.delivery_id)) && heirList.some(item => item.type === "silicon.custodian.changed"), short(heirList.map(item => item.type)));
    } finally {
      for (const sink of [sinkA, sinkB, sinkC]) await setFaults(env, sink, 0).catch(() => undefined);
    }
    await sleep(500);
    const settled = await until(async () => {
      const rows = await storedEvents(env, { target: silicon.uuid });
      return rows.filter(row => row.status === "pending").length === 0 ? rows : null;
    }, 30_000, 500);
    checkEq(results, "every event of the Silicon ended delivered, except the test ping (never replayed)", (settled ?? (await storedEvents(env, { target: silicon.uuid }))).filter(row => row.status !== "delivered").map(row => `${row.type}: ${row.status}`), ["ping: failed"]);
    checkEq(results, "the first sink never accepted a replay (they all went to the URL current at the time)", (await inboxEvents(env, sinkA, { uuid: silicon.uuid })).items.map(item => item.type), ["silicon.created"]);
  },
};

/**
 * The test ping and who may touch an app's webhook (orbit-games): the app itself, its owner signed in on the account
 * site (with the site's Origin: the CSRF guard), or its owner through the developer platform (a token with
 * aud=developer, what developers.teamofsilicons.com's BFF sends), never another app, another Carbon or nobody. An Idempotency-Key makes
 * a retried ping a no-op. Deliveries list newest first with cursors and a status filter, and only the app's own. A
 * burst of pings measures delivery latency through the worker (16 at a time).
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import {
  type Delivery,
  appCall,
  bearerCall,
  checkEq,
  developerToken,
  envelopeProblems,
  fakeApp,
  inboxEvents,
  inboxUrl,
  must,
  newCarbon,
  percentile,
  publicCall,
  sameJson,
  short,
  signInCarbon,
  sqlRows,
  until,
  waitDelivery,
  waitEvent,
} from "./_helpers";

const APP = "orbit-games";
const LIST_KEYS = ["account_uuid", "attempts", "created_at", "delivered_at", "event_id", "id", "last_attempt_at", "last_error", "last_status", "manual_replays", "next_attempt_at", "status", "type", "url"];

export const journey: Journey = {
  name: "webhooks-ping",
  title: "test pings by the app or its owner (on the account site, Origin-checked, or through the developer platform's token), refused for other apps, other Carbons and anonymous callers; idempotent; 409 without a webhook; deliveries paginate newest first and stay the app's own; a 40-ping burst's latency",
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const path = `/v1/apps/${APP}/webhook/test`;
    const journeyStart = Date.now() - 1000;
    const pingsSinceStart = async () => (await sqlRows<{ n: number }>(env, `select count(*)::int as n from webhook_events where target_id = '${APP}' and type = 'ping' and occurred_at > to_timestamp(${journeyStart / 1000})`))[0]?.n ?? 0;

    // ---- the app pings ------------------------------------------------------------------------------------------------
    const sent = Date.now();
    const ping = must("the app pings", await appCall<{ event_id: string; delivery_id: string; type: string }>(env, APP, "POST", path), 202).body;
    results.check("app credentials: 202 {event_id, delivery_id, type: ping}", ping.type === "ping" && /^[0-9a-f-]{36}$/.test(ping.event_id) && /^[0-9a-f-]{36}$/.test(ping.delivery_id), short(ping));
    const received = await waitEvent(env, APP, { type: "ping", event_id: ping.event_id });
    const problems = envelopeProblems(received?.payload, { type: "ping", app_id: APP, silicon: null });
    results.check("the fake app received the ping signed: {event_id, type ping, occurred_at, app_id orbit-games, silicon null, data {}}", !!received && problems.length === 0 && sameJson(received.payload.data, {}), problems.join("; "));
    if (received) results.metric("ping → received", Date.parse(received.received_at) - sent, "ms");
    const delivered = await waitDelivery(env, APP, ping.delivery_id, d => d.status === "delivered");
    results.check("the ping's delivery: delivered on the first attempt, about no account, to the app's URL", !!delivered && delivered.attempt_count === 1 && delivered.account_uuid === null && delivered.url === inboxUrl(env, APP) && delivered.type === "ping", short(delivered && { attempts: delivered.attempt_count, account: delivered.account_uuid, url: delivered.url }));

    // ---- the owner on the account site --------------------------------------------------------------------------------------
    const owner = await signInCarbon(ctx, fakeApp(APP).owner_email);
    const byOwner = await owner.call<{ event_id?: string }>("POST", path);
    results.check("the owner (signed in on the site, same-origin): 202", byOwner.status === 202 && !!byOwner.body.event_id, `${byOwner.status} ${short(byOwner.body, 200)}`);
    if (byOwner.body.event_id) results.check("…and the fake app gets that ping", !!(await waitEvent(env, APP, { type: "ping", event_id: byOwner.body.event_id })));
    const noOrigin = await owner.call<{ error?: { code?: string } }>("POST", path, { origin: null });
    const foreign = await owner.call<{ error?: { code?: string } }>("POST", path, { origin: "https://evil.example" });
    checkEq(results, "the owner's cookie without the site's Origin (no Origin, a foreign one): 403 origin_not_allowed (CSRF guard)", [noOrigin.status, noOrigin.body.error?.code, foreign.status, foreign.body.error?.code], [403, "origin_not_allowed", 403, "origin_not_allowed"]);

    // ---- the owner through the developer platform (UNDERSTANDING.md v2: webhooks are set up on the developer site) ----
    const dev = await developerToken(ctx, owner);
    const byDeveloper = await bearerCall<{ event_id?: string }>(env, dev.accessToken, "POST", path);
    const devArrived = byDeveloper.body.event_id ? await waitEvent(env, APP, { type: "ping", event_id: byDeveloper.body.event_id }) : null;
    results.check("the owner's developer-platform token (aud=developer, as the developer site's BFF sends it): 202, and the fake app gets that ping", byDeveloper.status === 202 && !!devArrived, `${byDeveloper.status} ${short(byDeveloper.body, 200)}`);
    const devList = await bearerCall<{ items?: Delivery[] }>(env, dev.accessToken, "GET", `/v1/apps/${APP}/webhook/deliveries?limit=5`);
    const devForeign = await bearerCall<{ error?: { code?: string } }>(env, dev.accessToken, "POST", "/v1/apps/pixel-studio/webhook/test");
    checkEq(results, "…it lists the app's deliveries (200), and is refused on an app the Carbon doesn't own (403 not_app_owner)", [devList.status, (devList.body.items?.length ?? 0) > 0, devForeign.status, devForeign.body.error?.code], [200, true, 403, "not_app_owner"]);

    // ---- everyone else is refused ---------------------------------------------------------------------------------------
    const stranger = await newCarbon(ctx, "stranger");
    const notOwner = await stranger.visitor.call<{ error?: { code?: string } }>("POST", path);
    const otherApp = await appCall<{ error?: { code?: string } }>(env, "pixel-studio", "POST", path);
    const wrongSecret = await appCall<{ error?: { code?: string } }>(env, APP, "POST", path, { secret: `${fakeApp(APP).secret}x` });
    const anonymous = await publicCall<{ error?: { code?: string } }>(env, "POST", path);
    checkEq(results, "refused: another Carbon 403 not_app_owner, another app 403 app_mismatch, a wrong secret 401, nobody 401", { notOwner: [notOwner.status, notOwner.body.error?.code], otherApp: [otherApp.status, otherApp.body.error?.code], wrongSecret: wrongSecret.status, anonymous: anonymous.status }, { notOwner: [403, "not_app_owner"], otherApp: [403, "app_mismatch"], wrongSecret: 401, anonymous: 401 });
    const pingsBefore = await pingsSinceStart();
    results.check("…and a refused ping queues nothing (3 pings stored: the app's, the owner's on the account site and through the developer platform)", pingsBefore === 3, `${pingsBefore} pings stored for ${APP} during the journey`);

    // ---- idempotency ------------------------------------------------------------------------------------------------------
    const key = randomUUID();
    const once = must("ping with a key", await appCall<{ event_id: string }>(env, APP, "POST", path, { idempotencyKey: key }), 202);
    const twice = must("the same ping retried", await appCall<{ event_id: string }>(env, APP, "POST", path, { idempotencyKey: key }), 202);
    const pingsAfter = await pingsSinceStart();
    results.check("Idempotency-Key: the retried ping answers the same event_id, marked Idempotent-Replayed, and queues no second ping", once.body.event_id === twice.body.event_id && twice.headers.get("idempotent-replayed") === "true" && pingsAfter === pingsBefore + 1, `${once.body.event_id} / ${twice.body.event_id}, ${pingsAfter} pings`);
    await waitEvent(env, APP, { type: "ping", event_id: once.body.event_id });
    await new Promise(done => setTimeout(done, 1200));
    checkEq(results, "…the fake app got it exactly once", (await inboxEvents(env, APP, { event_id: once.body.event_id })).items.map(item => item.deliveries), [1]);

    // ---- no webhook ------------------------------------------------------------------------------------------------------
    const none = await appCall<{ error?: { code?: string; hint?: string } }>(env, "quill-docs", "POST", "/v1/apps/quill-docs/webhook/test");
    results.check("an app without a webhook: 409 webhook_not_set with a hint to set one", none.status === 409 && none.body.error?.code === "webhook_not_set" && /PUT \/v1\/apps\/.*\/webhook/.test(none.body.error.hint ?? ""), `${none.status} ${short(none.body, 200)}`);

    // ---- listing: the app's own deliveries, newest first, cursors, filter -------------------------------------------------
    const fresh: string[] = [];
    for (let i = 0; i < 5; i++) fresh.unshift(must("ping", await appCall<{ delivery_id: string }>(env, APP, "POST", path), 202).body.delivery_id);
    await until(async () => (await Promise.all(fresh.map(id => appCall<Delivery>(env, APP, "GET", `/v1/apps/${APP}/webhook/deliveries/${id}`)))).every(answer => answer.body.status === "delivered"), 20_000);
    const pages: Delivery[][] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const answer: { items: Delivery[]; next_cursor: string | null } = must("list", await appCall<{ items: Delivery[]; next_cursor: string | null }>(env, APP, "GET", `/v1/apps/${APP}/webhook/deliveries?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), 200).body;
      pages.push(answer.items);
      cursor = answer.next_cursor;
      if (!cursor) break;
    }
    const listed = pages.flat().map(item => item.id);
    checkEq(results, "listing with limit=2: pages of 2 with a next_cursor, newest first, no repeats (the 5 newest pings first)", { sizes: pages.map(page => page.length), first5: listed.slice(0, 5), unique: new Set(listed).size === listed.length }, { sizes: [2, 2, 2], first5: fresh, unique: true });
    checkEq(results, "a listed delivery has exactly the documented fields", Object.keys(pages[0]?.[0] ?? {}).sort(), LIST_KEYS);
    const onlyDelivered = must("delivered only", await appCall<{ items: Delivery[] }>(env, APP, "GET", `/v1/apps/${APP}/webhook/deliveries?status=delivered&limit=50`), 200).body.items;
    results.check("?status=delivered lists only delivered ones", onlyDelivered.length > 0 && onlyDelivered.every(item => item.status === "delivered"), `${onlyDelivered.length}`);
    const badFilter = await appCall<{ error?: { code?: string; message?: string } }>(env, APP, "GET", `/v1/apps/${APP}/webhook/deliveries?status=lost`);
    results.check("an unknown status filter is refused, naming the allowed values", (badFilter.status === 400 || badFilter.status === 422) && /pending, delivered, failed/.test(JSON.stringify(badFilter.body)), `${badFilter.status} ${short(badFilter.body, 200)}`);
    const crossList = await appCall<{ error?: { code?: string } }>(env, APP, "GET", "/v1/apps/pixel-studio/webhook/deliveries");
    const ownerElsewhere = await owner.call<{ error?: { code?: string } }>("GET", "/v1/apps/pixel-studio/webhook/deliveries");
    checkEq(results, "another app's deliveries: 403 app_mismatch for the app, 403 not_app_owner for this app's owner", [crossList.status, crossList.body.error?.code, ownerElsewhere.status, ownerElsewhere.body.error?.code], [403, "app_mismatch", 403, "not_app_owner"]);
    const ownerList = await owner.call<{ items?: Delivery[] }>("GET", `/v1/apps/${APP}/webhook/deliveries?limit=5`);
    results.check("the owner can list the app's deliveries on the site", ownerList.status === 200 && (ownerList.body.items?.length ?? 0) > 0, String(ownerList.status));

    // ---- a burst --------------------------------------------------------------------------------------------------------
    const burst = 40;
    const started = Date.now();
    const answers = await Promise.all(Array.from({ length: burst }, () => appCall<{ event_id: string; delivery_id: string }>(env, APP, "POST", path)));
    const accepted = answers.filter(answer => answer.status === 202).map(answer => ({ id: answer.body.event_id, at: Date.now() }));
    const queuedMs = Date.now() - started;
    results.check(`burst: ${burst} pings accepted at once`, accepted.length === burst, `${accepted.length} accepted in ${queuedMs} ms`);
    const ids = new Set(accepted.map(entry => entry.id));
    const all = await until(async () => {
      const items = (await inboxEvents(env, APP, { type: "ping" })).items.filter(item => ids.has(item.event_id));
      return items.length === ids.size ? items : null;
    }, 45_000, 300);
    const arrivedItems = all ?? (await inboxEvents(env, APP, { type: "ping" })).items.filter(item => ids.has(item.event_id));
    const latencies = arrivedItems.map(item => Date.parse(item.received_at) - started);
    results.check(`burst: all ${burst} arrived, each once, within 45 s`, arrivedItems.length === burst && arrivedItems.every(item => item.deliveries === 1), `${arrivedItems.length} arrived, last after ${Math.max(...latencies)} ms`);
    results.metric("burst of 40 pings: queued (all 202s)", queuedMs, "ms");
    results.metric("burst of 40 pings: p50 received", percentile(latencies, 50), "ms");
    results.metric("burst of 40 pings: p95 received", percentile(latencies, 95), "ms");
    results.metric("burst of 40 pings: all received", Math.max(...latencies), "ms");
  },
};

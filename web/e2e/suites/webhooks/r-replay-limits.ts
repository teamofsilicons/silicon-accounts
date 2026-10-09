/**
 * The replay limit (02-api: at most 100 deliveries per call; by status the oldest go first and `remaining` counts the
 * failed ones still waiting, so the caller calls again until it is 0), with 105 deliveries that failed for good at one
 * app. quill-docs has no webhook in the seed: the journey gives it one at its fake app for the run (nothing else ever
 * failed there, so every count is exact) and removes it again at the end. Time travel shifts the deliveries' creation
 * 72 hours back, keeping their order. Measures how long the worker takes to deliver 100 replays.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { sql } from "../../lib";
import { appCall, inboxEvents, inboxUrl, must, newCarbon, setFaults, setInboxSecret, short, signIntoApp, sqlRows, storedEvents, uid, until } from "./_helpers";

const APP = "quill-docs";
const N = 105;

interface ReplayAnswer {
  replayed: string[];
  skipped: Array<{ delivery_id: string; reason: string }>;
  remaining: number;
  not_replayable: number;
  url: string;
}

export const journey: Journey = {
  name: "webhooks-replay-limits",
  title: "105 failed deliveries: replay by status takes the oldest 100 (remaining 5), the next call the newest 5 (remaining 0), then nothing; all 105 arrive once with their event ids; the time to deliver 100 replays",
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const count = async (condition: string) => (await sqlRows<{ n: number }>(env, `select count(*)::int as n from webhook_deliveries where target_kind = 'app' and target_id = '${APP}' and ${condition}`))[0]?.n ?? 0;
    const replay = (body: unknown) => appCall<ReplayAnswer>(env, APP, "POST", `/v1/apps/${APP}/webhook/replay`, { json: body, idempotencyKey: randomUUID() });
    const carbon = await newCarbon(ctx, "limits");
    const set = must(`${APP} sets a webhook at its fake app`, await appCall<{ url: string; secret: string | null }>(env, APP, "PUT", `/v1/apps/${APP}/webhook`, { json: { url: inboxUrl(env, APP) } }), 200).body;
    // Setting the URL keeps a stored secret (secret null): rotate to know the one in use.
    const secret = set.secret ?? must(`${APP} rotates its secret`, await appCall<{ secret: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/rotate-secret`, { idempotencyKey: randomUUID() }), 200).body.secret;
    await setInboxSecret(env, APP, secret);
    try {
      await signIntoApp(ctx, carbon, APP);
      await setFaults(env, APP, 10_000, 500);
      for (let i = 0; i < N; i++) must(`rename ${i}`, await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH Limit ${i} ${uid()}` } }), 200);
      const stored = await storedEvents(env, { account: carbon.uuid, target: APP, type: "account.updated" });
      results.check(`setup: ${N} account.updated deliveries stored for ${APP}`, stored.length === N, `${stored.length}`);
      await until(async () => (await count("status = 'pending' and attempts >= 1 and (locked_until is null or locked_until <= now())")) === N, 90_000, 500);
      await sql(env, `update webhook_deliveries set created_at = created_at - interval '72 hours 1 minute', next_attempt_at = now() where target_kind = 'app' and target_id = '${APP}' and status = 'pending'`);
      await until(async () => (await count("status = 'failed'")) === N, 120_000, 500);
      const failed = await count("status = 'failed'");
      results.check(`setup: all ${N} failed for good (HTTP 500, then the 72 hours over)`, failed === N, `${failed} failed`);
      await setFaults(env, APP, 0);
      const order = (await sqlRows<{ id: string }>(env, `select id::text from webhook_deliveries where target_kind = 'app' and target_id = '${APP}' and status = 'failed' order by created_at, id`)).map(row => row.id);
      const eventOf = new Map(stored.map(row => [row.delivery_id, row.event_id]));

      const started = Date.now();
      const first = must("replay every failed delivery (1)", await replay({ status: "failed" }), 200).body;
      results.check("replay {status: failed}: 100 re-queued (the most per call), remaining 5, nothing skipped", first.replayed.length === 100 && first.remaining === N - 100 && first.skipped.length === 0 && first.not_replayable === 0, short({ replayed: first.replayed.length, remaining: first.remaining, skipped: first.skipped.length, not_replayable: first.not_replayable }));
      results.check("…the oldest 100, oldest first", JSON.stringify(first.replayed) === JSON.stringify(order.slice(0, 100)), `first ${short(first.replayed.slice(0, 2))} vs ${short(order.slice(0, 2))}`);
      const firstEvents = new Set(first.replayed.map(id => eventOf.get(id)));
      const arrivedAll = await until(async () => {
        const items = (await inboxEvents(env, APP, { uuid: carbon.uuid })).items.filter(item => firstEvents.has(item.event_id));
        return items.length === 100 ? items : null;
      }, 60_000, 250);
      const allMs = Date.now() - started;
      results.check("…and all 100 arrive at the app, each with its own event id", !!arrivedAll, `${arrivedAll?.length ?? 0} arrived in ${allMs} ms`);
      if (arrivedAll) {
        results.metric("100 replays → all received", allMs, "ms");
        const last = Math.max(...arrivedAll.map(item => Date.parse(item.received_at)));
        results.metric("100 replays → last received (app clock)", last - started, "ms");
      }
      const second = must("replay every failed delivery (2)", await replay({ status: "failed" }), 200).body;
      results.check("calling again: the newest 5, oldest first, remaining 0", JSON.stringify(second.replayed) === JSON.stringify(order.slice(100)) && second.remaining === 0, short({ replayed: second.replayed.length, remaining: second.remaining }));
      const third = must("replay every failed delivery (3)", await replay({ status: "failed" }), 200).body;
      results.check("calling a third time: nothing left to replay (replayed [], remaining 0)", third.replayed.length === 0 && third.remaining === 0 && third.not_replayable === 0, short(third));
      const everything = await until(async () => {
        const items = (await inboxEvents(env, APP, { uuid: carbon.uuid })).items.filter(item => item.type === "account.updated");
        return items.length === N ? items : null;
      }, 60_000, 250);
      results.check(`all ${N} events reached the app exactly once (no duplicates)`, !!everything && everything.every(item => item.deliveries === 1 && item.duplicate_count === 0), `${everything?.length ?? 0} events`);
      const delivered = await until(async () => ((await count("status = 'delivered' and manual_replays = 1")) === N ? N : null), 30_000, 500);
      results.check(`all ${N} deliveries are delivered, replayed once each`, delivered === N, `${await count("status = 'delivered'")} delivered`);
    } finally {
      await setFaults(env, APP, 0).catch(() => undefined);
      const removed = await appCall(env, APP, "DELETE", `/v1/apps/${APP}/webhook`).catch(() => null);
      results.check(`cleanup: ${APP} has no webhook again`, removed?.status === 204, String(removed?.status));
    }
  },
};

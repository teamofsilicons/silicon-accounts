/**
 * The 72-hour retry window and replays, at a fake app that keeps failing (pixel-studio). Time travel moves a delivery's
 * created_at (or requeued_at): a delivery still failing 72 hours after it was created becomes failed for good and is
 * left alone, while one 71 hours old keeps its retries. The app then rotates its signing secret and replays: the event
 * arrives with the same event_id and payload, signed with the current secret (the fake app knows only the new one).
 * A replay gets a fresh 72 hours. Replaying a delivered event repeats it (the fake app dedupes it by event_id). The
 * replay API's rules: idempotency, skipped pending / unknown / other apps' deliveries, validation.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { sleep, sql } from "../../lib";
import {
  type Delivery,
  ageDelivery,
  appCall,
  checkEq,
  drainApp,
  getDelivery,
  inboxEvents,
  inboxUrl,
  must,
  newCarbon,
  retryNow,
  sameJson,
  secondsBetween,
  setFaults,
  setInboxSecret,
  short,
  signIntoApp,
  storedEvents,
  uid,
  waitAttempts,
  waitDelivery,
  waitEvent,
} from "./_helpers";

const APP = "pixel-studio";

interface ReplayAnswer {
  replayed: string[];
  skipped: Array<{ delivery_id: string; reason: string; message: string; event_id?: string; type?: string }>;
  remaining: number;
  not_replayable: number;
  url: string;
}

export const journey: Journey = {
  name: "webhooks-window-replay",
  title: "after 72 hours of failures a delivery is failed for good (time travel; 71 h keeps retrying); replayed after a secret rotation it arrives with the same event_id, signed with the current secret; a replay gets a fresh 72 h; replaying a delivered event is deduped by the app; replay API rules",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const pending = await drainApp(env, APP);
    results.check(`setup: ${APP} has no pending delivery before faults go on`, pending === 0, `${pending} pending`);
    const carbon = await newCarbon(ctx, "window");
    await signIntoApp(ctx, carbon, APP);
    const rename = async () => {
      const since = Date.now();
      must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH Window ${uid()}` } }), 200);
      const [row] = await storedEvents(env, { account: carbon.uuid, type: "account.updated", target: APP, afterMs: since - 1 });
      if (!row) throw new Error(`no account.updated was stored for ${APP}`);
      return row;
    };
    const replay = (body: unknown, key = randomUUID()) => appCall<ReplayAnswer>(env, APP, "POST", `/v1/apps/${APP}/webhook/replay`, { json: body, idempotencyKey: key });

    try {
      await setFaults(env, APP, 1000, 500);
      const e1 = await rename();
      const e2 = await rename();
      await waitAttempts(env, e1.delivery_id, 1);
      await waitAttempts(env, e2.delivery_id, 1);

      // ---- the window ---------------------------------------------------------------------------------------------------
      await ageDelivery(env, e1.delivery_id, 72);
      await ageDelivery(env, e2.delivery_id, 71);
      const gone = await waitAttempts(env, e1.delivery_id, 2);
      const kept = await waitAttempts(env, e2.delivery_id, 2);
      const d1 = await getDelivery(env, APP, e1.delivery_id);
      results.check("72 h: a delivery still failing 72 hours after it was created is failed for good (no next attempt)", gone?.status === "failed" && d1.status === "failed" && d1.next_attempt_at === null && d1.last_status === 500 && d1.attempt_count === 2, short({ status: d1.status, next: d1.next_attempt_at, attempts: d1.attempt_count, last_status: d1.last_status }));
      const d2 = await getDelivery(env, APP, e2.delivery_id);
      results.check("71 h: one an hour younger keeps its retries (pending, next attempt 30 s later)", kept?.status === "pending" && d2.status === "pending" && Math.abs(secondsBetween(d2.attempts[1]?.attempted_at, d2.next_attempt_at) - 30) < 1.5, short({ status: d2.status, next: d2.next_attempt_at }));
      await ageDelivery(env, e2.delivery_id, 72);
      const gone2 = await waitAttempts(env, e2.delivery_id, 3);
      results.check("…and fails for good once it is 72 hours old too", gone2?.status === "failed", short(gone2));
      await sleep(12_000);
      const still = await getDelivery(env, APP, e1.delivery_id);
      results.check("a failed delivery is left alone: no attempt in the 12 s after it failed", still.attempt_count === 2 && still.status === "failed", `${still.attempt_count} attempts`);
      const failedList = must("list failed deliveries", await appCall<{ items: Delivery[] }>(env, APP, "GET", `/v1/apps/${APP}/webhook/deliveries?status=failed&limit=200`), 200).body.items;
      results.check("both appear under ?status=failed, with no next_attempt_at", [e1.delivery_id, e2.delivery_id].every(id => failedList.some(item => item.id === id && item.status === "failed" && item.next_attempt_at === null)), `${failedList.length} failed`);

      // ---- rotate the secret, then replay ----------------------------------------------------------------------------------
      const rotated = must("rotate the secret", await appCall<{ secret: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/rotate-secret`, { idempotencyKey: randomUUID() }), 200).body.secret;
      await setInboxSecret(env, APP, rotated, false);
      await setFaults(env, APP, 0);
      const key = randomUUID();
      const replayStarted = Date.now();
      const first = must("replay e1", await replay({ delivery_ids: [e1.delivery_id] }, key), 200);
      checkEq(results, "replay by id: {replayed [it], skipped [], remaining 0, not_replayable 0, url: the current URL}", first.body, { replayed: [e1.delivery_id], skipped: [], remaining: 0, not_replayable: 0, url: inboxUrl(env, APP) });
      const arrived = await waitEvent(env, APP, { event_id: e1.event_id });
      results.check("replay: the event arrives with the same event_id, signed with the current secret (the fake app no longer knows the old one)", !!arrived && arrived.event_id === e1.event_id && !arrived.recovered, arrived ? `${Date.now() - replayStarted} ms after the replay` : "nothing in 25 s");
      results.check("replay: the payload is the original one, unchanged", !!arrived && sameJson(arrived.payload, e1.payload), short(arrived?.payload, 300));
      if (arrived) results.metric("replay → received", Date.parse(arrived.received_at) - replayStarted, "ms");
      const r1 = await waitDelivery(env, APP, e1.delivery_id, d => d.status === "delivered");
      results.check("replay: the delivery is delivered, attempts counted from the replay (1), manual_replays 1, all 3 attempts listed", !!r1 && r1.attempt_count === 1 && r1.manual_replays === 1 && r1.attempts.length === 3 && r1.attempts.at(-1)?.status_code === 200, short(r1 && { attempts: r1.attempt_count, listed: r1.attempts.length, manual_replays: r1.manual_replays }));
      const again = await replay({ delivery_ids: [e1.delivery_id] }, key);
      results.check("replay with the same Idempotency-Key: the same answer, marked Idempotent-Replayed, and nothing re-queued", again.status === 200 && again.headers.get("idempotent-replayed") === "true" && sameJson(again.body, first.body) && (await getDelivery(env, APP, e1.delivery_id)).manual_replays === 1, `${again.status} ${again.headers.get("idempotent-replayed")}`);
      const reused = await replay({ delivery_ids: [e2.delivery_id] }, key);
      results.check("the same Idempotency-Key with another body: 409 idempotency_key_reused", reused.status === 409 && (reused.body as unknown as { error?: { code?: string } }).error?.code === "idempotency_key_reused", `${reused.status} ${short(reused.body, 200)}`);

      // ---- replay what failed since a moment ---------------------------------------------------------------------------
      // `since` is about when deliveries were created, and time travel created these 72 hours before the journey.
      const tooRecent = must("replay failed since the journey began", await replay({ status: "failed", since: startedAt }), 200).body;
      results.check("replay {status: failed, since}: since filters on creation (a delivery created 72 h ago is older than the journey)", !tooRecent.replayed.includes(e2.delivery_id), short(tooRecent));
      const byStatus = must("replay failed since 72 h before the journey", await replay({ status: "failed", since: new Date(Date.parse(startedAt) - 72 * 3_600_000 - 10 * 60_000).toISOString() }), 200).body;
      results.check("replay {status: failed, since}: re-queues the other failed delivery, nothing replayable left", byStatus.replayed.includes(e2.delivery_id) && byStatus.remaining === 0 && byStatus.not_replayable === 0, short(byStatus));
      const arrived2 = await waitEvent(env, APP, { event_id: e2.event_id });
      results.check("…and it arrives with its own event_id and payload", !!arrived2 && sameJson(arrived2.payload, e2.payload));

      // ---- a replay gets a fresh 72 hours ------------------------------------------------------------------------------------
      await setFaults(env, APP, 1000, 500);
      const e3 = await rename();
      await waitAttempts(env, e3.delivery_id, 1);
      await ageDelivery(env, e3.delivery_id, 72);
      await waitAttempts(env, e3.delivery_id, 2);
      must("replay e3 while the app still fails", await replay({ delivery_ids: [e3.delivery_id] }), 200);
      const afterReplay = await waitAttempts(env, e3.delivery_id, 1);
      const d3 = await getDelivery(env, APP, e3.delivery_id);
      results.check("fresh window: a replayed delivery that fails again keeps retrying (pending, 10 s) although it was created 72 h ago", afterReplay?.status === "pending" && d3.status === "pending" && d3.attempt_count === 1 && Math.abs(secondsBetween(d3.attempts.at(-1)?.attempted_at, d3.next_attempt_at) - 10) < 1.5, short({ status: d3.status, attempts: d3.attempt_count, next: d3.next_attempt_at }));
      await sql(env, `update webhook_deliveries set requeued_at = now() - interval '72 hours', next_attempt_at = now() where id = '${e3.delivery_id}'`);
      const over = await waitAttempts(env, e3.delivery_id, 2);
      results.check("fresh window: 72 hours after the replay it fails for good again", over?.status === "failed", short(over));
      await setFaults(env, APP, 0);
      must("replay e3 again", await replay({ delivery_ids: [e3.delivery_id] }), 200);
      const r3 = await waitDelivery(env, APP, e3.delivery_id, d => d.status === "delivered");
      results.check("…a second replay delivers it (manual_replays 2)", !!r3 && r3.manual_replays === 2 && !!(await waitEvent(env, APP, { event_id: e3.event_id })), short(r3 && { manual_replays: r3.manual_replays }));

      // ---- replaying a delivered event: the app dedupes by event_id ---------------------------------------------------
      must("replay the delivered e1", await replay({ delivery_ids: [e1.delivery_id] }), 200);
      await waitDelivery(env, APP, e1.delivery_id, d => d.status === "delivered" && d.manual_replays === 2);
      const dedupe = await (async () => {
        for (let i = 0; i < 40; i++) {
          const item = (await inboxEvents(env, APP, { event_id: e1.event_id })).items[0];
          if (item && item.duplicate_count >= 1) return item;
          await sleep(250);
        }
        return (await inboxEvents(env, APP, { event_id: e1.event_id })).items[0];
      })();
      results.check("dedupe: the fake app received e1 twice, recorded it once (duplicate_count 1) and still answered 2xx", !!dedupe && dedupe.deliveries === 2 && dedupe.duplicate_count === 1, short(dedupe && { deliveries: dedupe.deliveries, duplicates: dedupe.duplicate_count }));
      checkEq(results, "dedupe: one event in the app's list for that event_id", (await inboxEvents(env, APP, { event_id: e1.event_id })).items.length, 1);

      // ---- the replay API's rules ------------------------------------------------------------------------------------------
      await setFaults(env, APP, 1000, 500);
      const e4 = await rename();
      await waitAttempts(env, e4.delivery_id, 1);
      const busy = must("replay a pending delivery", await replay({ delivery_ids: [e4.delivery_id] }), 200).body;
      checkEq(results, "a pending delivery is not replayed: skipped already_pending", busy.skipped.map(entry => [entry.delivery_id, entry.reason]), [[e4.delivery_id, "already_pending"]]);
      await setFaults(env, APP, 0);
      await retryNow(env, e4.delivery_id);
      await waitDelivery(env, APP, e4.delivery_id, d => d.status === "delivered");
      const ping = must("briefcase pings", await appCall<{ delivery_id: string }>(env, "briefcase", "POST", "/v1/apps/briefcase/webhook/test"), 202).body;
      const unknown = randomUUID();
      const foreign = must("replay unknown and foreign ids", await replay({ delivery_ids: [unknown, ping.delivery_id] }), 200).body;
      checkEq(results, "an unknown id and another app's delivery are skipped not_found (no replay across apps)", foreign.skipped.map(entry => [entry.delivery_id, entry.reason]), [[unknown, "not_found"], [ping.delivery_id, "not_found"]]);
      const peek = await appCall(env, APP, "GET", `/v1/apps/${APP}/webhook/deliveries/${ping.delivery_id}`);
      results.check("another app's delivery can't be read either (404)", peek.status === 404, String(peek.status));
      const invalid: Array<[string, unknown]> = [
        ["no body fields", {}],
        ["ids and status together", { delivery_ids: [e1.delivery_id], status: "failed" }],
        ["an empty id list", { delivery_ids: [] }],
        ["a non-uuid id", { delivery_ids: ["nope"] }],
        ["101 ids", { delivery_ids: Array.from({ length: 101 }, () => randomUUID()) }],
        ["status delivered", { status: "delivered" }],
        ["a bad since", { status: "failed", since: "yesterday" }],
      ];
      const codes: string[] = [];
      for (const [label, body] of invalid) {
        const answer = await replay(body);
        const error = (answer.body as unknown as { error?: { code?: string; details?: { fields?: Record<string, string> } } }).error;
        codes.push(`${label}: ${answer.status} ${error?.code} ${Object.keys(error?.details?.fields ?? {}).join(",")}`);
      }
      results.check("invalid replay bodies are 422 validation_failed naming the field", codes.every(code => / 422 validation_failed \S/.test(code)), codes.join(" | "));
    } finally {
      await setFaults(env, APP, 0).catch(() => undefined);
    }
    checkEq(results, "every delivery of this journey ended delivered", (await storedEvents(env, { account: carbon.uuid })).filter(row => row.status !== "delivered").map(row => `${row.type}→${row.target_id}: ${row.status}`), []);
  },
};

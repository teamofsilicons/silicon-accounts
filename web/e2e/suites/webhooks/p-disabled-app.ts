/**
 * A disabled app's webhook (docs/learn/webhooks.md: "While an app is disabled, its deliveries are held: they keep being
 * retried and go out if the app is re-enabled within 72 hours of the event"). Silicon Apps will disable and re-enable
 * apps; until it exists the journey flips apps.status in the stack's database (the fake app commit), the way it moves
 * time. A delivery queued before the app was disabled is not sent while it is disabled (each attempt says why), goes
 * out with the same event_id once the app is enabled again, and fails for good if the app stays disabled past the 72
 * hours, after which the app replays it. A change made while the app is disabled is checked against the docs' rule for
 * who receives an app event (a live membership and a webhook URL; UNDERSTANDING: "Whenever something changes about an
 * account that has signed into that app, we tell it").
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { sql } from "../../lib";
import { appCall, checkEq, drainApp, getDelivery, inboxEvents, must, newCarbon, retryNow, ageDelivery, sameJson, setFaults, short, signIntoApp, sqlRows, storedEvents, uid, waitAttempts, waitDelivery, waitEvent } from "./_helpers";

const APP = "commit";

interface AttemptRow {
  status_code: number | null;
  error: string | null;
}

export const journey: Journey = {
  name: "webhooks-disabled-app",
  title: "a disabled app's deliveries are held (not sent, retried, saying why) and go out with the same event_id once it is enabled again, or fail for good after 72 h and are replayed; a change made while it is disabled still reaches it once enabled",
  timeoutMs: 4 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const pending = await drainApp(env, APP);
    results.check(`setup: ${APP} has no pending delivery`, pending === 0, `${pending} pending`);
    const carbon = await newCarbon(ctx, "disabled");
    await signIntoApp(ctx, carbon, APP);
    // A second member app, to tell "the app was skipped" from "no event was made".
    await signIntoApp(ctx, carbon, "remind");
    const setStatus = (status: "active" | "disabled") => sql(env, `update apps set status = '${status}' where app_id = '${APP}'`);
    const rename = async () => {
      const since = Date.now();
      const name = `WH Disabled ${uid()}`;
      must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: name } }), 200);
      const all = await storedEvents(env, { account: carbon.uuid, type: "account.updated", afterMs: since - 1 });
      return { name, rows: all.filter(row => row.target_id === APP), targets: all.map(row => row.target_id).sort() };
    };
    const attemptsOf = (deliveryId: string) => sqlRows<AttemptRow>(env, `select status_code, error from webhook_attempts where delivery_id = '${deliveryId}' order by attempted_at, id`);

    try {
      // ---- a delivery queued before the app is disabled is held -----------------------------------------------------------
      await setFaults(env, APP, 1000, 500);
      const [e1] = (await rename()).rows;
      if (!e1) throw new Error(`no account.updated was stored for ${APP}`);
      await waitAttempts(env, e1.delivery_id, 1);
      await setStatus("disabled");
      await setFaults(env, APP, 0);
      await retryNow(env, e1.delivery_id);
      const held = await waitAttempts(env, e1.delivery_id, 2);
      const heldAttempt = (await attemptsOf(e1.delivery_id)).at(-1);
      results.check(
        "disabled: the queued delivery is not sent; the attempt says the app is disabled and that delivery resumes if it is re-enabled within 72 hours",
        held?.status === "pending" && heldAttempt?.status_code === null && /is disabled/.test(heldAttempt?.error ?? "") && /re-enabled within 72 hours/.test(heldAttempt?.error ?? ""),
        short({ status: held?.status, attempt: heldAttempt }),
      );
      const [gap] = await sqlRows<{ s: number }>(env, `select extract(epoch from (next_attempt_at - last_attempt_at))::float as s from webhook_deliveries where id = '${e1.delivery_id}'`);
      results.check("disabled: it stays on the retry schedule (next attempt 30 s after the second)", Math.abs((gap?.s ?? 0) - 30) < 1.5, `${gap?.s} s`);
      checkEq(results, "disabled: the app received nothing of it", (await inboxEvents(env, APP, { event_id: e1.event_id })).items.length, 0);

      // ---- a change while the app is disabled ------------------------------------------------------------------------------
      const during = await rename();
      results.check(
        "a change made while the app is disabled is kept for it (held like the queued ones), so the app learns it once enabled",
        during.rows.length === 1,
        `account.updated stored for [${during.targets.join(", ")}] (the Carbon is a member of ${APP} and remind); docs/learn/webhooks.md: an app event goes to an app with a live membership and a webhook URL, and a disabled app's deliveries are held`,
      );

      // ---- enabled again -----------------------------------------------------------------------------------------------------
      await setStatus("active");
      await retryNow(env, e1.delivery_id);
      const sent = await waitEvent(env, APP, { event_id: e1.event_id });
      results.check("enabled again: the held delivery goes out with the same event_id and payload", !!sent && sameJson(sent.payload, e1.payload), sent?.event_id ?? "nothing in 25 s");
      const d1 = await waitDelivery(env, APP, e1.delivery_id, d => d.status === "delivered");
      results.check("…delivered on its third attempt (500, held, 200)", !!d1 && d1.attempts.length === 3 && d1.attempts[1]?.status_code === null && d1.attempts[2]?.status_code === 200, short(d1?.attempts.map(attempt => attempt.status_code)));
      const duringRow = during.rows[0];
      if (duringRow) {
        await retryNow(env, duringRow.delivery_id);
        const late = await waitEvent(env, APP, { event_id: duringRow.event_id });
        results.check("…and the change made while it was disabled reaches it too, with the name of that moment", !!late && (late.payload.data as { account?: { display_name?: string } }).account?.display_name === during.name);
      }

      // ---- disabled past the 72 hours: failed, then replayed ----------------------------------------------------------------
      await setFaults(env, APP, 1000, 500);
      const [e3] = (await rename()).rows;
      if (!e3) throw new Error(`no account.updated was stored for ${APP}`);
      await waitAttempts(env, e3.delivery_id, 1);
      await setStatus("disabled");
      await setFaults(env, APP, 0);
      await ageDelivery(env, e3.delivery_id, 72);
      const over = await waitAttempts(env, e3.delivery_id, 2);
      const overAttempt = (await attemptsOf(e3.delivery_id)).at(-1);
      results.check("disabled past 72 hours after the event: failed for good (the last attempt not sent because the app is disabled)", over?.status === "failed" && overAttempt?.status_code === null && /is disabled/.test(overAttempt?.error ?? ""), short({ status: over?.status, attempt: overAttempt }));
      await setStatus("active");
      const replay = must("the app replays it once enabled", await appCall<{ replayed: string[] }>(env, APP, "POST", `/v1/apps/${APP}/webhook/replay`, { json: { delivery_ids: [e3.delivery_id] }, idempotencyKey: randomUUID() }), 200).body;
      const replayed = await waitEvent(env, APP, { event_id: e3.event_id });
      results.check("enabled again, the app replays it and it arrives with the same event_id", sameJson(replay.replayed, [e3.delivery_id]) && !!replayed && sameJson(replayed.payload, e3.payload), short(replay));
      const d3 = await getDelivery(env, APP, e3.delivery_id);
      results.check("…delivered, manual_replays 1", d3.status === "delivered" || !!(await waitDelivery(env, APP, e3.delivery_id, d => d.status === "delivered" && d.manual_replays === 1)), short({ status: d3.status, manual_replays: d3.manual_replays }));
    } finally {
      await setStatus("active").catch(() => undefined);
      await setFaults(env, APP, 0).catch(() => undefined);
    }
    checkEq(results, "every delivery of this journey ended delivered", (await storedEvents(env, { account: carbon.uuid, target: APP })).filter(row => row.status !== "delivered").map(row => `${row.type}: ${row.status}`), []);
  },
};

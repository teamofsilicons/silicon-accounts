/**
 * Fault injection at a fake app (testkit /_webhook-faults): Silicon Accounts keeps retrying until the app answers 2xx.
 * The first case waits the real schedule (10 s, then 30 s) and checks every attempt the API records; the others skip
 * the waits by moving next_attempt_at (time travel): a timeout, statuses that must still be retried (404, 410, 429,
 * 503), a redirect, and an endpoint that refuses connections until the app points its webhook back (the retry goes to
 * the current URL, signed with the current secret). The app is interface; it has no pending delivery when faults go on.
 */
import type { Journey } from "../../context";
import {
  type DeliveryDetail,
  appCall,
  checkEq,
  drainApp,
  getDelivery,
  inboxEvents,
  inboxUrl,
  must,
  newCarbon,
  reconnectAppWebhook,
  retryNow,
  secondsBetween,
  setFaults,
  short,
  signIntoApp,
  storedEvents,
  uid,
  waitAttempts,
  waitDelivery,
  waitEvent,
} from "./_helpers";

const APP = "interface";

export const journey: Journey = {
  name: "webhooks-retries",
  title: "faults at the fake app (500s, a timeout, 404/410/429/503, a redirect, a refused connection) are retried on the 10 s / 30 s schedule until delivered, each attempt recorded; the app sees the event once",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const pending = await drainApp(env, APP);
    results.check(`setup: ${APP} has no pending delivery before faults go on`, pending === 0, `${pending} pending`);
    const carbon = await newCarbon(ctx, "retries");
    await signIntoApp(ctx, carbon, APP);
    /** Renames the Carbon and returns the new account.updated delivery for the app. */
    const rename = async () => {
      const since = Date.now();
      must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH Retry ${uid()}` } }), 200);
      const [row] = await storedEvents(env, { account: carbon.uuid, type: "account.updated", target: APP, afterMs: since - 1 });
      if (!row) throw new Error("no account.updated was stored for interface");
      return row;
    };

    try {
      // ---- two 500s, the real schedule ----------------------------------------------------------------------------------
      await setFaults(env, APP, 2, 500);
      const event = await rename();
      const first = await waitAttempts(env, event.delivery_id, 1);
      const one = await getDelivery(env, APP, event.delivery_id);
      results.check("500 #1: the delivery stays pending with attempts 1, last_status 500 and the app's answer quoted", first?.status === "pending" && one.attempt_count === 1 && one.last_status === 500 && /HTTP 500 Internal Server Error/.test(one.last_error ?? "") && /Simulated failure/.test(one.last_error ?? ""), short({ status: one.status, attempts: one.attempt_count, last_status: one.last_status, last_error: one.last_error }));
      const gap1 = secondsBetween(one.attempts[0]?.attempted_at, one.next_attempt_at);
      results.check("500 #1: the next attempt is scheduled 10 s after the first", Math.abs(gap1 - 10) < 1.5, `${gap1} s`);
      const second = await waitAttempts(env, event.delivery_id, 2, 20_000);
      const two = await getDelivery(env, APP, event.delivery_id);
      const waited1 = secondsBetween(two.attempts[0]?.attempted_at, two.attempts[1]?.attempted_at);
      const gap2 = secondsBetween(two.attempts[1]?.attempted_at, two.next_attempt_at);
      results.check("500 #2: retried about 10 s later, then scheduled 30 s after that", second?.status === "pending" && two.attempt_count === 2 && waited1 > 9 && waited1 < 16 && Math.abs(gap2 - 30) < 1.5, `waited ${waited1} s, next in ${gap2} s`);
      const third = await waitAttempts(env, event.delivery_id, 3, 40_000);
      const three: DeliveryDetail = await getDelivery(env, APP, event.delivery_id);
      const waited2 = secondsBetween(three.attempts[1]?.attempted_at, three.attempts[2]?.attempted_at);
      results.check("third attempt (30 s later) delivered: status delivered, last_status 200, last_error cleared, no next attempt", third?.status === "delivered" && three.last_status === 200 && three.last_error === null && three.next_attempt_at === null && !!three.delivered_at && waited2 > 29 && waited2 < 38, short({ status: three.status, last_status: three.last_status, last_error: three.last_error, next: three.next_attempt_at, waited2 }));
      checkEq(results, "the attempts list: HTTP 500, HTTP 500, HTTP 200", three.attempts.map(attempt => attempt.status_code), [500, 500, 200]);
      results.metric("retry 1 after a 500", waited1 * 1000, "ms");
      results.metric("retry 2 after a 500", waited2 * 1000, "ms");
      const inbox = await inboxEvents(env, APP, { event_id: event.event_id });
      const received = inbox.items[0];
      results.check("the fake app accepted the event once (deliveries 1, no duplicate) after refusing two", !!received && received.deliveries === 1 && received.duplicate_count === 0 && !received.recovered, short(received && { deliveries: received.deliveries, duplicates: received.duplicate_count, recovered: received.recovered }));
      checkEq(results, "…and its refusals are the two injected faults for this event", (inbox.rejected ?? []).filter(entry => entry.event_id === event.event_id).map(entry => `${entry.status} ${entry.reason}`), ["500 fault_injected", "500 fault_injected"]);

      // ---- a timeout -------------------------------------------------------------------------------------------------------
      await setFaults(env, APP, 1, 503, 11_000);
      const slow = await rename();
      await waitAttempts(env, slow.delivery_id, 1, 25_000);
      const slowDetail = await getDelivery(env, APP, slow.delivery_id);
      results.check("timeout: no answer within 10 s is a failed attempt (no status, \"No response within 10 seconds\"), cut at about 10 s", slowDetail.status === "pending" && slowDetail.attempts[0]?.status_code === null && /No response within 10 seconds/.test(slowDetail.attempts[0]?.error ?? "") && (slowDetail.attempts[0]?.duration_ms ?? 0) >= 9_500 && (slowDetail.attempts[0]?.duration_ms ?? 0) < 12_500, short(slowDetail.attempts[0]));
      await retryNow(env, slow.delivery_id);
      results.check("timeout: the retry is delivered", !!(await waitDelivery(env, APP, slow.delivery_id, d => d.status === "delivered")) && !!(await waitEvent(env, APP, { event_id: slow.event_id })));

      // ---- statuses that are still worth retrying, and a redirect ------------------------------------------------------------
      for (const status of [404, 410, 429, 503, 302]) {
        await setFaults(env, APP, 1, status);
        const row = await rename();
        await waitAttempts(env, row.delivery_id, 1);
        const detail = await getDelivery(env, APP, row.delivery_id);
        const describes = status === 302 ? /redirect.*not followed/i.test(detail.last_error ?? "") : new RegExp(`^HTTP ${status}`).test(detail.last_error ?? "");
        results.check(`HTTP ${status}: recorded and kept for a retry (never given up on the first answer)`, detail.status === "pending" && detail.last_status === status && describes && !!detail.next_attempt_at, short({ status: detail.status, last_status: detail.last_status, last_error: detail.last_error }));
        await retryNow(env, row.delivery_id);
        results.check(`HTTP ${status}: the retry is delivered`, !!(await waitDelivery(env, APP, row.delivery_id, d => d.status === "delivered")));
      }

      // ---- the endpoint refuses connections; the app points its webhook back ---------------------------------------------
      must("point the webhook at a closed port", await appCall(env, APP, "PUT", `/v1/apps/${APP}/webhook`, { json: { url: "http://127.0.0.1:9/closed" } }), 200);
      const lost = await rename();
      await waitAttempts(env, lost.delivery_id, 1);
      const lostDetail = await getDelivery(env, APP, lost.delivery_id);
      results.check("refused connection: a failed attempt with no status and \"Could not connect\"", lostDetail.status === "pending" && lostDetail.attempts[0]?.status_code === null && /Could not connect/.test(lostDetail.attempts[0]?.error ?? ""), short(lostDetail.attempts[0]));
      await reconnectAppWebhook(env, APP);
      await retryNow(env, lost.delivery_id);
      const found = await waitDelivery(env, APP, lost.delivery_id, d => d.status === "delivered");
      results.check("refused connection: after the app sets its webhook again, the retry goes to the current URL and is delivered", !!found && found.url === inboxUrl(env, APP), short(found && { url: found.url, attempts: found.attempt_count }));
      results.check("refused connection: …signed with the current secret (the fake app verified it)", !!(await waitEvent(env, APP, { event_id: lost.event_id })));
    } finally {
      await setFaults(env, APP, 0).catch(() => undefined);
    }
    checkEq(results, "nothing about this Carbon is left pending or failed", (await storedEvents(env, { account: carbon.uuid })).filter(row => row.status !== "delivered").map(row => `${row.type}: ${row.status}`), []);
  },
};

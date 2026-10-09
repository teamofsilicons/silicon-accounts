/**
 * The delivery protocol, checked byte for byte with the suite's own receiver instead of the testkit's: the headers
 * (event id, type, delivery id, timestamp, v1 signature, User-Agent, JSON), the HMAC over "{timestamp}.{raw body}" keyed
 * by the whole whsec_ string, the body being exactly the stored event; a retry keeping the event and delivery ids with a
 * fresh timestamp and signature (the backoff skipped by time travel); at-least-once delivery when the endpoint answers too late (the same event_id twice,
 * which receivers must dedupe); a replay of a delivered event; redirects never followed. The app is browser, whose
 * webhook points at the receiver for the journey and goes back to the fake app server at the end.
 */
import type { Journey } from "../../context";
import { sleep } from "../../lib";
import {
  type Received,
  Receiver,
  appCall,
  checkEq,
  envelopeProblems,
  getDelivery,
  must,
  newCarbon,
  reconnectAppWebhook,
  retryNow,
  sameJson,
  secondsBetween,
  short,
  signIntoApp,
  signatureFor,
  storedEvents,
  uid,
  verifySignature,
  waitAttempts,
  waitDelivery,
  waitEvent,
} from "./_helpers";

const APP = "browser";

export const journey: Journey = {
  name: "webhooks-protocol",
  title: "the wire format checked independently: headers, v1 HMAC over the raw body with the whole whsec_ key, body = stored event; retries keep ids with a fresh signature; a too-late 200 means the same event_id again; replays repeat it; redirects are not followed",
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const receiver = await Receiver.start();
    try {
      const path = `/browser-${uid()}`;
      const set = must("point browser's webhook at the receiver", await appCall<{ url: string; secret: string | null }>(env, APP, "PUT", `/v1/apps/${APP}/webhook`, { json: { url: receiver.url(path) } }), 200);
      // Setting the URL keeps a stored secret (secret null); a new one only when the app had none.
      const secret = set.body.secret ?? must("rotate browser's secret", await appCall<{ secret: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/rotate-secret`), 200).body.secret;
      results.check("setting the URL returns it (with a secret only when the app had none), not cacheable; the secret is a 32-byte whsec_", set.body.url === receiver.url(path) && /^whsec_[A-Za-z0-9_-]{43}$/.test(secret) && /no-store/.test(set.headers.get("cache-control") ?? ""), `${set.body.url} ${set.headers.get("cache-control")}`);
      const app = must("app details", await appCall<{ webhook?: { url?: string; secret_set?: boolean } }>(env, APP, "GET", `/v1/apps/${APP}`), 200);
      results.check("the app's details show the URL and secret_set, never the secret", sameJson(app.body.webhook, { url: receiver.url(path), secret_set: true }) && !app.text.includes("whsec_"), short(app.body.webhook));

      // ---- a test ping, byte for byte ---------------------------------------------------------------------------------
      const ping = must("test ping", await appCall<{ event_id: string; delivery_id: string; type: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/test`), 202).body;
      const got = await receiver.waitFor(request => request.headers["x-accounts-event-id"] === ping.event_id);
      if (!got) throw new Error(`the ping ${ping.event_id} never reached the receiver`);
      const h = got.headers;
      checkEq(results, "ping: POST to the exact URL path, Content-Type application/json, User-Agent SiliconAccounts-Webhooks/1", [got.method, got.path, h["content-type"], h["user-agent"]], ["POST", path, "application/json", "SiliconAccounts-Webhooks/1"]);
      checkEq(results, "ping: X-Accounts-Event-Id / -Event-Type / -Delivery-Id match the body and the test endpoint's answer", [h["x-accounts-event-id"], h["x-accounts-event-type"], h["x-accounts-delivery-id"], got.body?.event_id, got.body?.type], [ping.event_id, "ping", ping.delivery_id, ping.event_id, "ping"]);
      const ts = Number(h["x-accounts-timestamp"]);
      results.check("ping: X-Accounts-Timestamp is unix seconds, within a minute of now", /^\d{10}$/.test(h["x-accounts-timestamp"] ?? "") && Math.abs(ts - got.at / 1000) < 60, `${h["x-accounts-timestamp"]} vs ${Math.round(got.at / 1000)}`);
      results.check("ping: X-Accounts-Signature is v1=<64 lowercase hex>", /^v1=[0-9a-f]{64}$/.test(h["x-accounts-signature"] ?? ""), h["x-accounts-signature"]);
      results.check("ping: the signature is HMAC-SHA256(whole whsec_ secret, \"{timestamp}.{raw body}\") — verified here, not by the testkit", verifySignature(secret, h["x-accounts-timestamp"], got.raw, h["x-accounts-signature"]), "");
      const tampered = Buffer.from(got.raw);
      tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
      results.check("ping: the signature does not verify with another secret, another timestamp or one changed body byte", !verifySignature(`${secret}x`, h["x-accounts-timestamp"], got.raw, h["x-accounts-signature"]) && !verifySignature(secret, String(ts + 1), got.raw, h["x-accounts-signature"]) && !verifySignature(secret, h["x-accounts-timestamp"], tampered, h["x-accounts-signature"]) && !verifySignature(secret.slice("whsec_".length), h["x-accounts-timestamp"], got.raw, h["x-accounts-signature"]), "the key is the whole whsec_ string");
      const problems = envelopeProblems(got.body, { type: "ping", app_id: APP, silicon: null });
      results.check("ping: body {event_id (UUIDv7), type ping, occurred_at, app_id browser, silicon null, data {}}", problems.length === 0 && sameJson(got.body?.data, {}), problems.join("; ") || got.raw.toString().slice(0, 300));
      const detail = await waitDelivery(env, APP, ping.delivery_id, d => d.status === "delivered");
      results.check("ping: the body sent is exactly the stored payload (GET …/deliveries/{id})", !!detail && sameJson(detail.payload, got.body) && detail.url === receiver.url(path), short(detail?.payload));
      results.check("ping: no credential travels with a delivery (no Authorization or Cookie header)", !("authorization" in h) && !("cookie" in h), Object.keys(h).join(", "));

      // ---- an account event to the same receiver -------------------------------------------------------------------------
      const carbon = await newCarbon(ctx, "protocol");
      await signIntoApp(ctx, carbon, APP);
      const since = Date.now();
      must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH Wire ${uid()}` } }), 200);
      const [row] = await storedEvents(env, { account: carbon.uuid, type: "account.updated", afterMs: since - 1 });
      const update = row ? await receiver.waitFor(request => request.headers["x-accounts-event-id"] === row.event_id) : null;
      results.check("account.updated: delivered to the receiver with headers matching the stored event and a valid signature", !!update && update.headers["x-accounts-event-type"] === "account.updated" && update.headers["x-accounts-delivery-id"] === row?.delivery_id && verifySignature(secret, update.headers["x-accounts-timestamp"], update.raw, update.headers["x-accounts-signature"]) && sameJson(update.body, row?.payload), short(update?.headers));

      // Non-ASCII text, quotes and a backslash: the signature covers the UTF-8 bytes exactly as sent.
      const unicode = `Zoë « 漢字 » "q" \\ 🚀 ${uid()}`;
      const since2 = Date.now();
      must("rename with non-ASCII text", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: unicode } }), 200);
      const [row2] = await storedEvents(env, { account: carbon.uuid, type: "account.updated", afterMs: since2 - 1 });
      const fancy = row2 ? await receiver.waitFor(request => request.headers["x-accounts-event-id"] === row2.event_id) : null;
      const fancyName = (fancy?.body?.data as { account?: { display_name?: string } } | undefined)?.account?.display_name;
      results.check("non-ASCII body: the signature verifies over the raw UTF-8 bytes and the name arrives exactly as set", !!fancy && verifySignature(secret, fancy.headers["x-accounts-timestamp"], fancy.raw, fancy.headers["x-accounts-signature"]) && fancyName === unicode && fancy.raw.includes(Buffer.from("漢字", "utf8")), `${fancyName} (${fancy?.raw.length ?? 0} bytes)`);

      // ---- a retry: same ids and body, fresh timestamp and signature -------------------------------------------------
      // The 10 s wait is read off the delivery and skipped by time travel (f-retries.ts checks that nothing comes early).
      const isPing = (id: string) => (request: Received) => request.headers["x-accounts-event-id"] === id;
      receiver.answer({ status: 500, body: '{"error":"try later"}' }, 1, request => request.body?.type === "ping");
      const retried = must("test ping", await appCall<{ event_id: string; delivery_id: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/test`), 202).body;
      const refusedOnce = await receiver.waitCount(isPing(retried.event_id), 1, 15_000);
      await waitAttempts(env, retried.delivery_id, 1);
      const scheduled = await getDelivery(env, APP, retried.delivery_id);
      const gap = secondsBetween(scheduled.attempts[0]?.attempted_at, scheduled.next_attempt_at);
      results.check("retry: the 500 leaves the delivery pending, its next attempt scheduled 10 s later", refusedOnce[0]?.status === 500 && scheduled.status === "pending" && Math.abs(gap - 10) < 1.5, `${scheduled.status}, next in ${gap} s`);
      // Each attempt is signed when it is sent: let the clock pass the first attempt's second before the retry is due.
      const firstTs = Number(refusedOnce[0]?.headers["x-accounts-timestamp"] ?? 0);
      await sleep(Math.max(0, (firstTs + 1) * 1000 - Date.now() + 50));
      await retryNow(env, retried.delivery_id);
      const firstTwo = await receiver.waitCount(isPing(retried.event_id), 2, 15_000);
      results.check("retry: once due, the refused ping is sent again and accepted", firstTwo.length === 2 && firstTwo[0]!.status === 500 && firstTwo[1]!.status === 200, firstTwo.map(r => `${r.status}@${r.at}`).join(" → "));
      if (firstTwo.length === 2) {
        const [a, b] = firstTwo as [Received, Received];
        checkEq(results, "retry: the same event id, delivery id and body bytes", [b.headers["x-accounts-event-id"], b.headers["x-accounts-delivery-id"], b.raw.equals(a.raw)], [a.headers["x-accounts-event-id"], a.headers["x-accounts-delivery-id"], true]);
        results.check("retry: a fresh timestamp and signature, each valid for its own timestamp only", Number(b.headers["x-accounts-timestamp"]) > Number(a.headers["x-accounts-timestamp"]) && a.headers["x-accounts-signature"] !== b.headers["x-accounts-signature"] && verifySignature(secret, a.headers["x-accounts-timestamp"], a.raw, a.headers["x-accounts-signature"]) && verifySignature(secret, b.headers["x-accounts-timestamp"], b.raw, b.headers["x-accounts-signature"]) && b.headers["x-accounts-signature"] !== signatureFor(secret, a.headers["x-accounts-timestamp"]!, b.raw), `${a.headers["x-accounts-timestamp"]} → ${b.headers["x-accounts-timestamp"]}`);
        const failedAttempt = (await getDelivery(env, APP, retried.delivery_id)).attempts[0];
        results.check("retry: the failed attempt is recorded with HTTP 500 and the receiver's answer quoted", failedAttempt?.status_code === 500 && /HTTP 500 Internal Server Error/.test(failedAttempt.error ?? "") && /try later/.test(failedAttempt.error ?? ""), short(failedAttempt));
      }

      // ---- at least once: a 200 that comes after the 10 s limit counts as a failure ----------------------------------------
      receiver.answer({ status: 200, delayMs: 11_500 }, 1, request => request.body?.type === "ping");
      const slow = must("test ping", await appCall<{ event_id: string; delivery_id: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/test`), 202).body;
      const firstSlow = await waitAttempts(env, slow.delivery_id, 1, 25_000);
      const slowDetail = await getDelivery(env, APP, slow.delivery_id);
      const slowAttempt = slowDetail.attempts[0];
      results.check("too late: an answer after 10 s is a failed attempt with no status and a precise error, cut at about 10 s", firstSlow?.status === "pending" && slowAttempt?.status_code === null && /No response within 10 seconds/.test(slowAttempt.error ?? "") && (slowAttempt.duration_ms ?? 0) >= 9_500 && (slowAttempt.duration_ms ?? 0) < 12_500, short(slowAttempt));
      await retryNow(env, slow.delivery_id);
      const twice = await receiver.waitCount(isPing(slow.event_id), 2, 20_000);
      results.check("too late: the receiver got the same event_id twice (at-least-once: receivers dedupe on event_id)", twice.length === 2 && twice.every(r => r.headers["x-accounts-delivery-id"] === slow.delivery_id), `${twice.length} requests`);
      results.check("too late: the second attempt is delivered", !!(await waitDelivery(env, APP, slow.delivery_id, d => d.status === "delivered" && d.attempt_count === 2)));

      // ---- a replay of a delivered event repeats the same event_id --------------------------------------------------
      const replay = must("replay the delivered ping", await appCall<{ replayed: string[] }>(env, APP, "POST", `/v1/apps/${APP}/webhook/replay`, { json: { delivery_ids: [ping.delivery_id] }, idempotencyKey: `wh-${uid()}` }), 200).body;
      const again = await receiver.waitCount(isPing(ping.event_id), 2, 20_000);
      results.check("replay of a delivered event: sent again with the same event_id, delivery id and body, signed anew", replay.replayed.includes(ping.delivery_id) && again.length === 2 && again[1]!.raw.equals(again[0]!.raw) && again[1]!.headers["x-accounts-delivery-id"] === ping.delivery_id && verifySignature(secret, again[1]!.headers["x-accounts-timestamp"], again[1]!.raw, again[1]!.headers["x-accounts-signature"]), `${again.length} requests`);
      const replayed = await waitDelivery(env, APP, ping.delivery_id, d => d.status === "delivered" && d.manual_replays === 1);
      results.check("replay of a delivered event: the delivery shows manual_replays 1 and delivered again", !!replayed, short(replayed && { status: replayed.status, manual_replays: replayed.manual_replays, attempts: replayed.attempt_count }));

      // ---- redirects are not followed ----------------------------------------------------------------------------------
      const elsewhere = `/elsewhere-${uid()}`;
      receiver.answer({ status: 302, headers: { location: receiver.url(elsewhere) } }, 1, request => request.body?.type === "ping");
      const moved = must("test ping", await appCall<{ event_id: string; delivery_id: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/test`), 202).body;
      await waitAttempts(env, moved.delivery_id, 1);
      const movedDetail = await getDelivery(env, APP, moved.delivery_id);
      results.check("redirect: a 302 is a failed attempt that names the Location and says redirects are not followed", movedDetail.status === "pending" && movedDetail.attempts[0]?.status_code === 302 && /redirect/i.test(movedDetail.attempts[0]?.error ?? "") && (movedDetail.attempts[0]?.error ?? "").includes(elsewhere), short(movedDetail.attempts[0]));
      checkEq(results, "redirect: nothing was sent to the Location", receiver.on(elsewhere).length, 0);
      await retryNow(env, moved.delivery_id);
      results.check("redirect: the retry to the configured URL is delivered", !!(await waitDelivery(env, APP, moved.delivery_id, d => d.status === "delivered")));
    } finally {
      await reconnectAppWebhook(env, APP).catch(() => undefined);
      await receiver.close();
    }
    // The fake app server is browser's receiver again: a ping arrives there, signed with the secret it registered.
    const back = must("test ping", await appCall<{ event_id: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/test`), 202).body;
    results.check("restored: browser's own webhook receives (and verifies) the next ping", !!(await waitEvent(env, APP, { type: "ping", event_id: back.event_id })));
  },
};

/**
 * Secret rotation and the webhook's URL, checked with the suite's own receiver so every signature is verified here
 * against the exact secret expected (waveform's webhook points at it for the journey): a rotation signs everything after
 * it with the new secret only, a retry of a delivery made before the rotation included; an idempotent rotation returns
 * the same secret; setting the URL again (same or new) keeps the secret and moves pending retries to the new URL.
 * Removing the webhook fails what is pending (replayable once a URL is set again), and pings, replays and rotations
 * then answer 409 webhook_not_set. Then the fake app server gets waveform's webhook back and verifies a replay.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import {
  type Received,
  Receiver,
  appCall,
  checkEq,
  getDelivery,
  inboxEvents,
  inboxUrl,
  must,
  reconnectAppWebhook,
  retryNow,
  sameJson,
  setInboxSecret,
  short,
  uid,
  verifySignature,
  waitAttempts,
  waitDelivery,
  waitEvent,
} from "./_helpers";

const APP = "waveform";

export const journey: Journey = {
  name: "webhooks-secret-rotation",
  title: "rotating the secret signs every later attempt (a pending retry included) with the new one only; idempotent rotation; a new URL keeps the secret and gets the pending retries; removing the webhook fails pending deliveries, which replay to the next URL; URL validation",
  timeoutMs: 5 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const receiver = await Receiver.start();
    const signedBy = (request: Received | null | undefined, secret: string) => !!request && verifySignature(secret, request.headers["x-accounts-timestamp"], request.raw, request.headers["x-accounts-signature"]);
    const ping = async () => must("test ping", await appCall<{ event_id: string; delivery_id: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/test`), 202).body;
    const arrival = (eventId: string, path?: string) => receiver.waitFor(request => request.headers["x-accounts-event-id"] === eventId && (!path || request.path === path));
    const rotate = async (key?: string) => appCall<{ secret: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/rotate-secret`, key ? { idempotencyKey: key } : {});
    let removedPending: { event_id: string; delivery_id: string } | null = null;
    try {
      const pathA = `/wave-a-${uid()}`;
      const set1 = must("point waveform's webhook at the receiver", await appCall<{ secret: string | null }>(env, APP, "PUT", `/v1/apps/${APP}/webhook`, { json: { url: receiver.url(pathA) } }), 200).body;
      // Setting the URL keeps a stored secret (secret null; the fake app connected waveform's webhook before), so
      // rotate to know the one in use when none came back.
      const s1 = set1.secret ?? must("rotate to a known secret", await rotate(), 200).body.secret;
      const p1 = await ping();
      results.check("a ping is signed with the current secret", signedBy(await arrival(p1.event_id), s1));

      // ---- rotation ---------------------------------------------------------------------------------------------------------
      const r2 = must("rotate", await rotate(), 200);
      const s2 = r2.body.secret;
      results.check("rotate: a new whsec_ secret, not cacheable", /^whsec_[A-Za-z0-9_-]{43}$/.test(s2) && s2 !== s1 && /no-store/.test(r2.headers.get("cache-control") ?? ""), r2.headers.get("cache-control") ?? "");
      const p2 = await ping();
      const got2 = await arrival(p2.event_id);
      results.check("after rotating: signed with the new secret, and the old one no longer verifies", signedBy(got2, s2) && !signedBy(got2, s1), "");

      // ---- idempotent rotation ------------------------------------------------------------------------------------------------
      const key = randomUUID();
      const r3a = must("rotate with a key", await rotate(key), 200);
      const r3b = must("the same rotation retried", await rotate(key), 200);
      results.check("rotate with the same Idempotency-Key twice: the same secret, the retry marked Idempotent-Replayed (no second rotation)", r3a.body.secret === r3b.body.secret && r3b.headers.get("idempotent-replayed") === "true", `${r3b.headers.get("idempotent-replayed")}`);
      const s3 = r3a.body.secret;
      const p3 = await ping();
      results.check("…and that secret is the one in use", signedBy(await arrival(p3.event_id), s3));
      const s4 = must("rotate without a key", await rotate(), 200).body.secret;
      results.check("a rotation without a key is a new rotation", s4 !== s3, "");

      // ---- a retry made after a rotation uses the new secret --------------------------------------------------------------
      receiver.answer({ status: 500 }, 1, request => request.body?.type === "ping");
      const p5 = await ping();
      await waitAttempts(env, p5.delivery_id, 1);
      const before = receiver.on().find(request => request.headers["x-accounts-event-id"] === p5.event_id);
      const s5 = must("rotate while a retry is pending", await rotate(), 200).body.secret;
      await retryNow(env, p5.delivery_id);
      const retried = await receiver.waitCount(request => request.headers["x-accounts-event-id"] === p5.event_id, 2);
      results.check("a delivery that failed before a rotation is retried signed with the new secret (current, not the one of its first attempt)", signedBy(before, s4) && retried.length === 2 && signedBy(retried[1], s5) && !signedBy(retried[1], s4), `${retried.length} attempts`);

      // ---- setting the URL again: the secret stays, and pending retries follow the URL --------------------------------
      const again = must("set the same URL again", await appCall<{ url: string; secret: string | null }>(env, APP, "PUT", `/v1/apps/${APP}/webhook`, { json: { url: receiver.url(pathA) } }), 200).body;
      const p6 = await ping();
      results.check("setting the same URL again keeps the secret (secret null; pings still signed with it)", again.secret === null && signedBy(await arrival(p6.event_id), s5), short(again));
      receiver.answer({ status: 503 }, 1, request => request.body?.type === "ping" && request.path === pathA);
      const p7 = await ping();
      await waitAttempts(env, p7.delivery_id, 1);
      const pathB = `/wave-b-${uid()}`;
      const moved = must("move to a new URL", await appCall<{ url: string; secret: string | null }>(env, APP, "PUT", `/v1/apps/${APP}/webhook`, { json: { url: receiver.url(pathB) } }), 200).body;
      await retryNow(env, p7.delivery_id);
      const atB = await arrival(p7.event_id, pathB);
      results.check("a pending retry goes to the new URL, signed with the secret it kept", moved.secret === null && !!atB && signedBy(atB, s5), atB ? atB.path : "nothing at the new URL");
      const p7done = await waitDelivery(env, APP, p7.delivery_id, d => d.status === "delivered");
      results.check("…and the delivery records the URL it was delivered to", p7done?.url === receiver.url(pathB), p7done?.url ?? "");

      // ---- removing the webhook ----------------------------------------------------------------------------------------------
      receiver.answer({ status: 500 }, 1, request => request.body?.type === "ping");
      const p8 = await ping();
      removedPending = p8;
      await waitAttempts(env, p8.delivery_id, 1);
      must("remove the webhook", await appCall(env, APP, "DELETE", `/v1/apps/${APP}/webhook`), 204);
      const p8gone = await getDelivery(env, APP, p8.delivery_id);
      results.check("removing the webhook fails the pending delivery at once, saying why (replayable later)", p8gone.status === "failed" && /removed its webhook URL/.test(p8gone.last_error ?? ""), short({ status: p8gone.status, last_error: p8gone.last_error }));
      const details = must("app details", await appCall<{ webhook?: unknown }>(env, APP, "GET", `/v1/apps/${APP}`), 200).body;
      checkEq(results, "the app's details: no URL, no secret", details.webhook, { url: null, secret_set: false });
      const noHook = {
        ping: await appCall<{ error?: { code?: string } }>(env, APP, "POST", `/v1/apps/${APP}/webhook/test`),
        rotate: await rotate(),
        replay: await appCall<{ error?: { code?: string } }>(env, APP, "POST", `/v1/apps/${APP}/webhook/replay`, { json: { delivery_ids: [p8.delivery_id] } }),
        removeAgain: await appCall(env, APP, "DELETE", `/v1/apps/${APP}/webhook`),
      };
      checkEq(results, "without a webhook: ping, rotate and replay answer 409 webhook_not_set; removing again is a 204 no-op", { ping: [noHook.ping.status, noHook.ping.body.error?.code], rotate: [noHook.rotate.status, (noHook.rotate.body as unknown as { error?: { code?: string } }).error?.code], replay: [noHook.replay.status, noHook.replay.body.error?.code], removeAgain: noHook.removeAgain.status }, { ping: [409, "webhook_not_set"], rotate: [409, "webhook_not_set"], replay: [409, "webhook_not_set"], removeAgain: 204 });

      // ---- URL validation ----------------------------------------------------------------------------------------------------
      const invalid = ["ftp://example.com/hooks", "not a url", "http://user:secret@example.com/hooks", "", "javascript:alert(1)"];
      const verdicts: string[] = [];
      for (const url of invalid) {
        const answer = await appCall<{ error?: { code?: string; details?: { fields?: Record<string, string> } } }>(env, APP, "PUT", `/v1/apps/${APP}/webhook`, { json: { url } });
        verdicts.push(`${JSON.stringify(url)} → ${answer.status} ${answer.body.error?.code} ${answer.body.error?.details?.fields?.url ?? ""}`);
      }
      results.check("invalid webhook URLs are refused with 422 and a reason on field url (scheme, credentials, garbage)", verdicts.every(verdict => / → 422 validation_failed \S/.test(verdict)), verdicts.join(" | "));
      checkEq(results, "…and none of them was stored", must("app details", await appCall<{ webhook?: unknown }>(env, APP, "GET", `/v1/apps/${APP}`), 200).body.webhook, { url: null, secret_set: false });
    } finally {
      await receiver.close();
      // The fake app server gets waveform's webhook back (a new secret it knows).
      await reconnectAppWebhook(env, APP).catch(() => undefined);
    }

    // ---- the failed delivery replays to the URL set afterwards, signed with its secret -------------------------------------
    const listed = (await appCall<{ items: Array<{ id: string; event_id: string; status: string }> }>(env, APP, "GET", `/v1/apps/${APP}/webhook/deliveries?status=failed&limit=50`)).body.items;
    const failed = listed.find(item => item.id === removedPending?.delivery_id);
    if (!failed) throw new Error("the delivery failed by the removal is not listed under ?status=failed");
    const replayed = must("replay it", await appCall<{ replayed: string[]; url: string }>(env, APP, "POST", `/v1/apps/${APP}/webhook/replay`, { json: { delivery_ids: [failed.id] }, idempotencyKey: randomUUID() }), 200).body;
    results.check("after a URL is set again, the delivery failed by the removal replays there", replayed.replayed.includes(failed.id) && replayed.url === inboxUrl(env, APP), short(replayed));
    results.check("…and the fake app verifies its signature (the current secret) and gets the same event_id", !!(await waitEvent(env, APP, { event_id: failed.event_id })));

    // ---- a receiver that doesn't know the new secret refuses (401); Silicon Accounts keeps retrying ---------------------
    const unknownSecret = must("rotate without telling the fake app", await rotate(), 200).body.secret;
    const refusedPing = await ping();
    await waitAttempts(env, refusedPing.delivery_id, 1);
    const refusedDetail = await getDelivery(env, APP, refusedPing.delivery_id);
    const refusals = ((await inboxEvents(env, APP, { event_id: "none" })).rejected ?? []).filter(entry => entry.event_id === refusedPing.event_id);
    results.check("wrong secret: the fake app refuses the delivery (401 signature_mismatch) and it stays pending for a retry", refusedDetail.status === "pending" && refusedDetail.last_status === 401 && refusals.some(entry => entry.status === 401 && entry.reason === "signature_mismatch"), short({ status: refusedDetail.status, last_status: refusedDetail.last_status, refusals: refusals.map(entry => entry.reason) }));
    const { recovered } = await setInboxSecret(env, APP, unknownSecret);
    results.check("wrong secret: once told the current secret, the fake app verifies the refused bytes with it (they were signed with the current secret)", recovered >= 1, `recovered ${recovered}`);
    await retryNow(env, refusedPing.delivery_id);
    const settled = await waitDelivery(env, APP, refusedPing.delivery_id, d => d.status === "delivered");
    const inboxEntry = (await inboxEvents(env, APP, { event_id: refusedPing.event_id })).items[0];
    results.check("wrong secret: the retry is delivered (attempts 401 then 200), and the app holds the event once", !!settled && sameJson(settled.attempts.map(attempt => attempt.status_code), [401, 200]) && !!inboxEntry && inboxEntry.duplicate_count === 1, short({ attempts: settled?.attempts.map(attempt => attempt.status_code), duplicates: inboxEntry?.duplicate_count }));
  },
};

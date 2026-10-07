/**
 * Never replay data to an app that lost access (02-api "skipped (and reported) if the account no longer has a
 * membership with the app"). At a fake app that keeps failing (acme-notes), a Carbon's account.updated and
 * account.id_changed fail for good (time travel); the Carbon removes the app's access, so replaying them is skipped
 * (membership_inactive) while the access_removed notice itself is replayed; their detail shows the payload cut down to
 * {uuid, membership_id}. A deleted account's data is skipped too (account_deleted) while account.deleted is replayed. A
 * Carbon who signs in again gives the app its access back, and with it the replay.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { sleep } from "../../lib";
import {
  type Carbon,
  type EventRow,
  ageDelivery,
  appCall,
  checkEq,
  drainApp,
  getDelivery,
  must,
  newCarbon,
  sameJson,
  setFaults,
  short,
  signIntoApp,
  storedEvents,
  uid,
  waitAttempts,
  waitDelivery,
  waitEvent,
} from "./_helpers";

const APP = "acme-notes";

interface ReplayAnswer {
  replayed: string[];
  skipped: Array<{ delivery_id: string; reason: string; message: string; type?: string }>;
  remaining: number;
  not_replayable: number;
}

export const journey: Journey = {
  name: "webhooks-replay-access",
  title: "replay is skipped (membership_inactive / account_deleted) for failed events carrying account data once the account removed the app's access or was deleted, their payload redacted; the access_removed / deleted notices themselves replay; signing in again restores the replay",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const pending = await drainApp(env, APP);
    results.check(`setup: ${APP} has no pending delivery before faults go on`, pending === 0, `${pending} pending`);
    const replay = (body: unknown) => appCall<ReplayAnswer>(env, APP, "POST", `/v1/apps/${APP}/webhook/replay`, { json: body, idempotencyKey: randomUUID() });
    /** Waits for the first attempt of each delivery, makes them 72 hours old, and waits until they failed for good. */
    const failForGood = async (rows: EventRow[]) => {
      for (const row of rows) await waitAttempts(env, row.delivery_id, 1);
      for (const row of rows) await ageDelivery(env, row.delivery_id, 72);
      for (const row of rows) await waitAttempts(env, row.delivery_id, 2);
      return Promise.all(rows.map(row => getDelivery(env, APP, row.delivery_id)));
    };
    const latest = async (carbon: Carbon, type: string, since: number) => {
      const [row] = await storedEvents(env, { account: carbon.uuid, type, target: APP, afterMs: since - 1 });
      if (!row) throw new Error(`no ${type} was stored for ${APP}`);
      return row;
    };

    try {
      // ---- access removed ---------------------------------------------------------------------------------------------------
      const carbon = await newCarbon(ctx, "access");
      await signIntoApp(ctx, carbon, APP);
      await setFaults(env, APP, 1000, 500);
      let since = Date.now();
      must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH Access ${uid()}` } }), 200);
      const updated = await latest(carbon, "account.updated", since);
      since = Date.now();
      must("change the id", await carbon.visitor.call("POST", "/v1/me/id", { json: { id: `c:wh-access2-${uid()}` } }), 200);
      const idChanged = await latest(carbon, "account.id_changed", since);
      since = Date.now();
      must("remove the app's access", await carbon.visitor.call("DELETE", `/v1/me/apps/${APP}`), [200, 204]);
      const removed = await latest(carbon, "membership.access_removed", since);
      const failed = await failForGood([updated, idChanged, removed]);
      results.check("setup: the three deliveries failed for good", failed.every(d => d.status === "failed"), failed.map(d => `${d.type}: ${d.status}`).join(", "));
      await setFaults(env, APP, 0);

      const detailUpdated = await getDelivery(env, APP, updated.delivery_id);
      results.check("detail of a withheld delivery: payload_redacted, data cut to {uuid, membership_id}, the reason says the access was removed", detailUpdated.payload_redacted === true && sameJson(detailUpdated.payload.data, { uuid: carbon.uuid, membership_id: `${APP}:${carbon.uuid}` }) && /removed this app's access/.test(detailUpdated.payload_redacted_reason ?? ""), short({ redacted: detailUpdated.payload_redacted, data: detailUpdated.payload.data, reason: detailUpdated.payload_redacted_reason }));
      results.check("detail of a withheld delivery: no account data anywhere in it (no name, no email)", !JSON.stringify(detailUpdated).includes(carbon.email) && !JSON.stringify(detailUpdated).includes("WH Access"), "");
      const detailRemoved = await getDelivery(env, APP, removed.delivery_id);
      results.check("detail of the access_removed notice: not redacted (it carries no account data)", detailRemoved.payload_redacted === false && sameJson(detailRemoved.payload, removed.payload), short(detailRemoved.payload.data));

      const answer = must("replay all three", await replay({ delivery_ids: [updated.delivery_id, idChanged.delivery_id, removed.delivery_id] }), 200).body;
      checkEq(results, "replay after access removal: only membership.access_removed is replayed", answer.replayed, [removed.delivery_id]);
      checkEq(results, "…account.updated and account.id_changed are skipped with reason membership_inactive", answer.skipped.map(entry => [entry.delivery_id, entry.reason]).sort(), [[updated.delivery_id, "membership_inactive"], [idChanged.delivery_id, "membership_inactive"]].sort());
      results.check("…each skip says why in words (lost access, never replayed)", answer.skipped.every(entry => /removed this app's access/.test(entry.message) && /never gets account data replayed/.test(entry.message)), short(answer.skipped.map(entry => entry.message)));
      results.check("…and not_replayable counts them (2)", answer.not_replayable === 2, String(answer.not_replayable));
      results.check("the access_removed notice arrives at the app (signature verified, same event_id)", !!(await waitEvent(env, APP, { event_id: removed.event_id })));
      await sleep(2500);
      const after = await storedEvents(env, { account: carbon.uuid, target: APP });
      checkEq(results, "the withheld deliveries stay failed and never reached the app", after.filter(row => row.event_id === updated.event_id || row.event_id === idChanged.event_id).map(row => row.status), ["failed", "failed"]);
      const neverSent = await waitEvent(env, APP, { event_id: updated.event_id }, 500);
      results.check("…the app has no account.updated / account.id_changed for this account", !neverSent && !(await waitEvent(env, APP, { event_id: idChanged.event_id }, 500)), "");
      const sweep = must("replay every failed delivery", await replay({ status: "failed", since: new Date(Date.now() - 80 * 3_600_000).toISOString() }), 200).body;
      results.check("replay {status: failed}: withheld deliveries are never picked (not in replayed) and are counted as not_replayable", !sweep.replayed.includes(updated.delivery_id) && !sweep.replayed.includes(idChanged.delivery_id) && sweep.not_replayable >= 2 && sweep.remaining === 0, short(sweep));

      // ---- signing in again restores the access, and the replay --------------------------------------------------------------
      await signIntoApp(ctx, carbon, APP);
      const back = must("replay the account.updated again", await replay({ delivery_ids: [updated.delivery_id] }), 200).body;
      results.check("after the Carbon signs in again (membership active), the same account.updated replays and arrives", back.replayed.includes(updated.delivery_id) && !!(await waitEvent(env, APP, { event_id: updated.event_id })), short(back));

      // ---- a deleted account -----------------------------------------------------------------------------------------------------
      const leaving = await newCarbon(ctx, "leaving");
      await signIntoApp(ctx, leaving, APP);
      await setFaults(env, APP, 1000, 500);
      since = Date.now();
      must("rename", await leaving.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH Leaving ${uid()}` } }), 200);
      const lastWords = await latest(leaving, "account.updated", since);
      since = Date.now();
      must("delete the account", await leaving.visitor.call("DELETE", "/v1/me", { json: { confirm: leaving.id } }), [200, 204]);
      const deleted = await latest(leaving, "account.deleted", since);
      await failForGood([lastWords, deleted]);
      await setFaults(env, APP, 0);
      const gone = must("replay both", await replay({ delivery_ids: [lastWords.delivery_id, deleted.delivery_id] }), 200).body;
      checkEq(results, "deleted account: account.deleted replays, its earlier account.updated is skipped account_deleted", { replayed: gone.replayed, skipped: gone.skipped.map(entry => [entry.delivery_id, entry.reason]) }, { replayed: [deleted.delivery_id], skipped: [[lastWords.delivery_id, "account_deleted"]] });
      const deletedEvent = await waitEvent(env, APP, { event_id: deleted.event_id });
      results.check("deleted account: account.deleted arrives with only {uuid, membership_id}", !!deletedEvent && sameJson(deletedEvent.payload.data, { uuid: leaving.uuid, membership_id: `${APP}:${leaving.uuid}` }), short(deletedEvent?.payload.data));
      const detailLast = await getDelivery(env, APP, lastWords.delivery_id);
      results.check("deleted account: the withheld detail is redacted and says the account was deleted", detailLast.payload_redacted === true && /account was deleted/.test(detailLast.payload_redacted_reason ?? "") && !JSON.stringify(detailLast.payload).includes("WH Leaving"), short(detailLast.payload_redacted_reason));
      const stillFailed = await waitDelivery(env, APP, lastWords.delivery_id, d => d.status === "failed", 2_000);
      results.check("deleted account: the skipped delivery stays failed (manual_replays 0)", !!stillFailed && stillFailed.manual_replays === 0, short(stillFailed && { status: stillFailed.status, manual_replays: stillFailed.manual_replays }));
    } finally {
      await setFaults(env, APP, 0).catch(() => undefined);
    }
  },
};

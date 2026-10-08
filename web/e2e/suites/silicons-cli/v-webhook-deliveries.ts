import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { forgetRateLimits, json, sql, tag, type JsonAnswer } from "../../lib";
import {
  accounts,
  asCarbon,
  canonical,
  dataOf,
  errOf,
  freshDir,
  itemsOf,
  obj,
  setSinkSecret,
  short,
  signUpCarbon,
  siliconLogin,
  sinkFault,
  sinkInbox,
  sinkUrl,
  str,
  until,
  waitSink,
  withToken,
  type InboxEvent,
  type Json,
} from "./_helpers";

const codeOf = (answer: JsonAnswer<unknown>) => str(errOf(answer.body).code);
const said = (answer: JsonAnswer<unknown>) => `${answer.status} ${short(answer.body, 300)}`;
const ids = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
const skippedOf = (answer: JsonAnswer<Json>) => (Array.isArray(answer.body.skipped) ? (answer.body.skipped as Json[]) : []);

export const journey: Journey = {
  name: "silicons-cli-webhook-deliveries",
  title: "a Silicon's webhook deliveries follow the app rules: the Silicon and its custodian list and inspect them (attempts, the exact signed body); a delivery its endpoint keeps refusing fails after its 72 hours of retries (time travel) and is replayed, by status or by id, with the same event id, to the webhook's current URL and secret; test pings are never replayed; precise refusals; the CLI can do it too",
  // No browser: the CLI and the API only, so the engine changes nothing (the browser journeys run in WebKit too).
  engines: ["chromium"],
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "deliveries");
    const sid = `si:deliveries-${t}`;
    const stk = `stk-de11${t.replace(/[^0-9a-f]/g, "0")}00000000`.slice(0, 16);
    const made = await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: sid, display_name: `Deliveries ${t}`, stk });
    const uuid = str(obj(made.body.silicon).uuid);
    const signedIn = await siliconLogin(ctx, sid, stk);
    const token = str(signedIn.body.access_token);
    const own = <T = Json>(method: string, path: string, body?: unknown) => withToken<T>(ctx, token, method, `/v1/me/webhook${path}`, body);
    const custodian = <T = Json>(method: string, path: string, body?: unknown) => asCarbon<T>(env, carbon, method, `/v1/me/silicons/${uuid}/webhook${path}`, body);
    const keyA = `scli-dlv-a-${t}`;
    const keyB = `scli-dlv-b-${t}`;
    const set = await own("PUT", "", { url: sinkUrl(env, keyA) });
    await setSinkSecret(env, keyA, str(set.body.webhook_secret));
    results.check("setup: the custodian creates the Silicon, it signs in and sets its own webhook", made.status === 201 && signedIn.status === 200 && set.status === 200 && str(set.body.webhook_secret).startsWith("whsec_"), `${made.status} ${signedIn.status} ${set.status}`);
    const rename = (name: string) => asCarbon<Json>(env, carbon, "PATCH", `/v1/me/silicons/${uuid}`, { display_name: name });
    const named = (name: string) => (event: InboxEvent) => obj(dataOf(event).silicon).display_name === name;

    // 1. A delivered event, as the Silicon and as its custodian see it.
    const one = `Deliveries one ${t}`;
    await rename(one);
    const e1 = await waitSink(env, keyA, "silicon.updated", named(one));
    const listed = await own("GET", "/deliveries");
    const d1 = itemsOf(listed.body).find(item => item.event_id === e1?.event_id);
    results.check(
      "GET /v1/me/webhook/deliveries (the Silicon): that event's delivery, delivered (200), with its URL and the event's type",
      listed.status === 200 && !!d1 && d1.id === e1?.delivery_id && d1.type === "silicon.updated" && d1.status === "delivered" && d1.last_status === 200 && d1.url === sinkUrl(env, keyA) && d1.account_uuid === uuid && d1.next_attempt_at === null && !!d1.delivered_at && d1.manual_replays === 0,
      short(d1 ?? listed.body),
    );
    const d1Id = str(d1?.id);
    const shown = await own("GET", `/deliveries/${d1Id}`);
    const attempts1 = (Array.isArray(shown.body.attempts) ? shown.body.attempts : []) as Json[];
    results.check(
      "GET /v1/me/webhook/deliveries/{id}: its attempts, and the exact body that was signed (what the endpoint received)",
      shown.status === 200 && attempts1.length === Number(shown.body.attempt_count) && attempts1.at(-1)?.status_code === 200 && canonical(shown.body.payload) === canonical(e1?.payload) && shown.body.payload_redacted === false,
      short({ attempt_count: shown.body.attempt_count, attempts: attempts1, same_body: canonical(shown.body.payload) === canonical(e1?.payload) }),
    );
    const listedForCustodian = await custodian("GET", "/deliveries");
    const shownForCustodian = await custodian("GET", `/deliveries/${d1Id}`);
    results.check(
      "its custodian sees the same (GET /v1/me/silicons/{uuid}/webhook/deliveries[/{id}])",
      listedForCustodian.status === 200 && canonical(itemsOf(listedForCustodian.body)) === canonical(itemsOf(listed.body)) && canonical(shownForCustodian.body) === canonical(shown.body),
      `${listedForCustodian.status} ${shownForCustodian.status}`,
    );
    const stranger = await signUpCarbon(env, "deliveries-stranger");
    const foreignList = await asCarbon<Json>(env, stranger, "GET", `/v1/me/silicons/${uuid}/webhook/deliveries`);
    const foreignReplay = await asCarbon<Json>(env, stranger, "POST", `/v1/me/silicons/${uuid}/webhook/replay`, { status: "failed" });
    results.check("another Carbon gets 404 silicon_not_found (list and replay)", foreignList.status === 404 && codeOf(foreignList) === "silicon_not_found" && foreignReplay.status === 404 && codeOf(foreignReplay) === "silicon_not_found", `${said(foreignList)} | ${foreignReplay.status}`);
    const carbonOwn = await asCarbon<Json>(env, carbon, "GET", "/v1/me/webhook/deliveries");
    results.check("a Carbon has no webhook of its own: /v1/me/webhook/deliveries is for Silicons (403 silicon_only)", carbonOwn.status === 403 && codeOf(carbonOwn) === "silicon_only", said(carbonOwn));
    const onlyDelivered = await own("GET", "/deliveries?status=delivered");
    const onlyFailed = await own("GET", "/deliveries?status=failed");
    const badStatus = await own("GET", "/deliveries?status=lost");
    results.check(
      "?status= filters (delivered lists it, failed doesn't); an unknown status: 400 invalid_query naming it",
      itemsOf(onlyDelivered.body).some(item => item.id === d1Id) && !itemsOf(onlyFailed.body).some(item => item.id === d1Id) && badStatus.status === 400 && codeOf(badStatus) === "invalid_query" && str(errOf(badStatus.body).message).includes("'lost'"),
      said(badStatus),
    );
    const unknown = await own("GET", `/deliveries/${randomUUID()}`);
    const notAnId = await own("GET", "/deliveries/not-a-delivery");
    results.check("an unknown delivery, or something that isn't a delivery id: 404 delivery_not_found", unknown.status === 404 && codeOf(unknown) === "delivery_not_found" && notAnId.status === 404 && codeOf(notAnId) === "delivery_not_found", `${said(unknown)} | ${notAnId.status}`);

    // 2. The endpoint keeps refusing (HTTP 500): retried, then failed for good once its 72 hours are over (time travel).
    await sinkFault(env, keyA, 1000, 500);
    const two = `Deliveries two ${t}`;
    await rename(two);
    const ping = await own("POST", "/test", {});
    const refused = await until(async () => {
      const pending = itemsOf((await own("GET", "/deliveries?status=pending")).body);
      const update = pending.find(item => item.type === "silicon.updated" && Number(item.attempts) >= 1);
      const pinged = pending.find(item => item.type === "ping" && Number(item.attempts) >= 1);
      return update && pinged ? { update, pinged } : null;
    }, 30_000, 300);
    const d2 = refused?.update;
    const dp = refused?.pinged;
    const retryIn = (Date.parse(str(d2?.next_attempt_at)) - Date.parse(str(d2?.last_attempt_at))) / 1000;
    const expectedRetry = Number(d2?.attempts) === 1 ? 10 : 30;
    results.check(
      "a refused delivery stays pending with the refusal recorded (last_status 500, the error), retried on the schedule (10 s, then 30 s)",
      ping.status < 300 && !!d2 && d2.status === "pending" && d2.last_status === 500 && /500/.test(str(d2.last_error)) && Math.abs(retryIn - expectedRetry) < 1.5,
      short({ ping: ping.status, d2, retryIn }),
    );
    const pendingReplay = await own("POST", "/replay", { delivery_ids: [str(d2?.id)] });
    results.check(
      "replaying a delivery that is still pending re-queues nothing (skipped: already_pending)",
      pendingReplay.status === 200 && ids(pendingReplay.body.replayed).length === 0 && skippedOf(pendingReplay)[0]?.reason === "already_pending",
      said(pendingReplay),
    );
    const failing = [str(d2?.id), str(dp?.id)];
    await sql(env, `update webhook_deliveries set created_at = now() - interval '72 hours', next_attempt_at = now() where id in ('${failing[0]}', '${failing[1]}') and status = 'pending'`);
    const travelled = Date.now();
    const failedPage = await until(async () => {
      const page = itemsOf((await own("GET", "/deliveries?status=failed")).body);
      return failing.every(id => page.some(item => item.id === id)) ? page : null;
    }, 60_000, 500);
    results.metric("refused delivery failed for good after the time travel", Date.now() - travelled, "ms");
    const f2 = failedPage?.find(item => item.id === failing[0]);
    results.check(
      "past its 72 hours of retries (time travel) the next refused attempt fails it for good: failed, no next attempt, never delivered",
      !!f2 && f2.status === "failed" && f2.next_attempt_at === null && f2.delivered_at === null && Number(f2.attempts) >= 2 && f2.last_status === 500 && failedPage?.some(item => item.id === failing[1]) === true,
      short(f2 ?? failedPage),
    );

    // 3. The Silicon replays its failed deliveries: the event again (same event id), not the test ping.
    await sinkFault(env, keyA, 0);
    const replayKey = `scli-replay-${t}`;
    const replay = () =>
      json<Json>(`${env.site}/v1/me/webhook/replay`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": replayKey, "x-forwarded-for": ctx.ip },
        body: JSON.stringify({ status: "failed" }),
      });
    const replayedAt = Date.now();
    const r1 = await replay();
    results.check(
      "POST /v1/me/webhook/replay {status: failed}: the failed event is re-queued; the failed test ping is not (not_replayable 1); none remain; it goes to the current URL",
      r1.status === 200 && canonical(ids(r1.body.replayed)) === canonical([failing[0]]) && skippedOf(r1).length === 0 && r1.body.remaining === 0 && r1.body.not_replayable === 1 && r1.body.url === sinkUrl(env, keyA),
      said(r1),
    );
    const redelivered = await waitSink(env, keyA, "silicon.updated", named(two), 30_000);
    results.metric("replay → the event at the endpoint", Date.now() - replayedAt, "ms");
    const after2 = await until(async () => {
      const answer = await own("GET", `/deliveries/${failing[0]}`);
      return answer.body.status === "delivered" ? answer : null;
    }, 20_000, 300);
    const attempts2 = (Array.isArray(after2?.body.attempts) ? after2?.body.attempts : []) as Json[];
    results.check(
      "…it arrives with the same event id (signature verified), and the delivery reads delivered, replayed once",
      !!redelivered && redelivered.event_id === str(f2?.event_id) && after2?.body.manual_replays === 1 && after2?.body.last_status === 200,
      short({ event: redelivered?.event_id, expected: f2?.event_id, status: after2?.body.status, manual_replays: after2?.body.manual_replays, last_status: after2?.body.last_status }),
    );
    results.check(
      "…its attempts keep the refused ones before the one that got through",
      attempts2.length >= 3 && attempts2.slice(0, -1).every(attempt => attempt.status_code === 500) && attempts2.at(-1)?.status_code === 200,
      short(attempts2.map(attempt => attempt.status_code)),
    );
    const r2 = await replay();
    const again = await own("GET", `/deliveries/${failing[0]}`);
    results.check(
      "the same replay retried with its Idempotency-Key gives the same answer and re-queues nothing",
      r2.status === 200 && canonical(r2.body) === canonical(r1.body) && again.body.manual_replays === 1,
      `${said(r2)}; manual_replays ${String(again.body.manual_replays)}`,
    );
    const pingReplay = await own("POST", "/replay", { delivery_ids: [failing[1]] });
    results.check(
      "a test ping is never replayed, even by id (skipped: test_ping, not_replayable 1): send a new ping instead",
      pingReplay.status === 200 && ids(pingReplay.body.replayed).length === 0 && skippedOf(pingReplay)[0]?.reason === "test_ping" && /send a new one/.test(str(skippedOf(pingReplay)[0]?.message)) && pingReplay.body.not_replayable === 1,
      said(pingReplay),
    );
    const before1 = (await sinkInbox(env, keyA)).items.find(event => event.event_id === e1?.event_id);
    const byId = await own("POST", "/replay", { delivery_ids: [d1Id, ` ${d1Id} `] });
    const duplicate = await until(async () => {
      const event = (await sinkInbox(env, keyA)).items.find(candidate => candidate.event_id === e1?.event_id);
      return event && event.deliveries > (before1?.deliveries ?? 1) ? event : null;
    }, 30_000, 300);
    results.check(
      "a delivered one can be sent again by id (named twice, sent once): the same event id, so the endpoint can tell it is a duplicate",
      byId.status === 200 && canonical(ids(byId.body.replayed)) === canonical([d1Id]) && !!duplicate && duplicate.duplicate_count === (before1?.duplicate_count ?? 0) + 1,
      short({ replay: byId.body, deliveries: duplicate?.deliveries, duplicate_count: duplicate?.duplicate_count }),
    );

    // 4. The custodian replays one by id after moving the webhook: it goes to the new URL, signed with the new secret.
    await sinkFault(env, keyA, 1000, 500);
    const three = `Deliveries three ${t}`;
    await rename(three);
    const refused3 = await until(async () => itemsOf((await custodian("GET", "/deliveries?status=pending")).body).find(item => item.type === "silicon.updated" && Number(item.attempts) >= 1 && item.id !== d1Id && item.id !== failing[0]) ?? null, 30_000, 300);
    await sql(env, `update webhook_deliveries set created_at = now() - interval '72 hours', next_attempt_at = now() where id = '${str(refused3?.id)}' and status = 'pending'`);
    const failed3 = await until(async () => itemsOf((await custodian("GET", "/deliveries?status=failed")).body).find(item => item.id === refused3?.id) ?? null, 60_000, 500);
    const moved = await custodian("PUT", "", { url: sinkUrl(env, keyB) });
    await setSinkSecret(env, keyB, str(moved.body.webhook_secret));
    await sinkFault(env, keyA, 0);
    const notAnIdReplay = await custodian("POST", "/replay", { delivery_ids: [str(failed3?.id), "not-a-delivery"] });
    results.check(
      "the custodian's replay checks the ids: one that isn't a delivery id is 422 validation_failed, naming it",
      !!failed3 && moved.status === 200 && notAnIdReplay.status === 422 && codeOf(notAnIdReplay) === "validation_failed" && JSON.stringify(notAnIdReplay.body).includes("not-a-delivery"),
      `${failed3 ? "failed" : "never failed"}; ${said(notAnIdReplay)}`,
    );
    const nobody = randomUUID();
    const custodianReplayAt = Date.now();
    const byCustodian = await custodian("POST", "/replay", { delivery_ids: [str(failed3?.id), nobody] });
    results.check(
      "POST /v1/me/silicons/{uuid}/webhook/replay by id: re-queued; an id that is none of the Silicon's is skipped (not_found); the webhook's current URL",
      byCustodian.status === 200 && canonical(ids(byCustodian.body.replayed)) === canonical([str(failed3?.id)]) && skippedOf(byCustodian)[0]?.reason === "not_found" && skippedOf(byCustodian)[0]?.delivery_id === nobody && byCustodian.body.url === sinkUrl(env, keyB),
      said(byCustodian),
    );
    const atB = await waitSink(env, keyB, "silicon.updated", named(three), 30_000);
    results.metric("custodian replay → the event at the new URL", Date.now() - custodianReplayAt, "ms");
    const shown3 = await until(async () => {
      const answer = await custodian("GET", `/deliveries/${str(failed3?.id)}`);
      return answer.body.status === "delivered" ? answer : null;
    }, 20_000, 300);
    const boxB = await sinkInbox(env, keyB);
    results.check(
      "…it arrives at the new URL with the same event id, signed with the new secret (verified there, nothing refused)",
      !!atB && atB.event_id === failed3?.event_id && boxB.rejected.length === 0 && shown3?.body.url === sinkUrl(env, keyB) && shown3?.body.manual_replays === 1,
      short({ event: atB?.event_id, expected: failed3?.event_id, rejected: boxB.rejected, url: shown3?.body.url }),
    );

    // 5. Refusals.
    const empty = await own("POST", "/replay", {});
    const deliveredStatus = await own("POST", "/replay", { status: "delivered" });
    const both = await own("POST", "/replay", { status: "failed", delivery_ids: [randomUUID()] });
    const tooMany = await own("POST", "/replay", { delivery_ids: Array.from({ length: 101 }, () => randomUUID()) });
    results.check(
      "replay bodies are checked: {}, status delivered, both selectors, 101 ids: 422 validation_failed, each saying why",
      [empty, deliveredStatus, both, tooMany].every(answer => answer.status === 422 && codeOf(answer) === "validation_failed") && JSON.stringify(tooMany.body).includes("at most 100"),
      [empty, deliveredStatus, both, tooMany].map(answer => `${answer.status} ${short(errOf(answer.body).details, 120)}`).join(" | "),
    );
    const page1 = await own("GET", "/deliveries?limit=2");
    const page2 = await own("GET", `/deliveries?limit=2&cursor=${encodeURIComponent(str(page1.body.next_cursor))}`);
    const everything = itemsOf((await own("GET", "/deliveries?limit=100")).body);
    const walked = [...itemsOf(page1.body), ...itemsOf(page2.body)].map(item => str(item.id));
    results.check(
      "pages (limit, next_cursor) walk the deliveries newest first without repeating one",
      itemsOf(page1.body).length === 2 && !!page1.body.next_cursor && new Set(walked).size === walked.length && canonical(walked) === canonical(everything.slice(0, walked.length).map(item => str(item.id))),
      `${walked.length} walked of ${everything.length}`,
    );
    const removed = await own("DELETE", "");
    const noHook = await own("POST", "/replay", { status: "failed" });
    const noHookCustodian = await custodian("POST", "/replay", { status: "failed" });
    results.check(
      "with no webhook a replay has nowhere to go: 409 webhook_not_set, each caller pointed at its own way to set one",
      removed.status < 300 && noHook.status === 409 && codeOf(noHook) === "webhook_not_set" && str(errOf(noHook.body).hint).includes("PUT /v1/me/webhook") && noHookCustodian.status === 409 && str(errOf(noHookCustodian.body).hint).includes(`/v1/me/silicons/${uuid}/webhook`),
      `${said(noHook)} | ${said(noHookCustodian)}`,
    );
    results.check("…and its deliveries stay listed", itemsOf((await own("GET", "/deliveries")).body).length >= 4);

    // 6. Where the replays show.
    const siliconHistory = itemsOf((await withToken(ctx, token, "GET", "/v1/me/history?limit=100")).body);
    const custodianHistory = itemsOf((await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?limit=100")).body);
    const replays = (entries: Json[]) => entries.filter(entry => /replay/i.test(str(entry.title)) && str(entry.title).includes(sid));
    results.check(
      "each replay is in the Silicon's history, and the custodian's own in the custodian's",
      replays(siliconHistory).length >= 5 && replays(custodianHistory).length >= 1,
      short({ silicon: replays(siliconHistory).map(entry => [entry.title, entry.detail]), custodian: replays(custodianHistory).map(entry => entry.title) }, 500),
    );

    // 7. The CLI (UNDERSTANDING: everything works through the CLI first; the package and CLI expose what an account does).
    const tree = await accounts(env, ["--json"], { home: freshDir(), url: null });
    const commands = ((tree.json?.commands ?? []) as Json[]).map(entry => str(entry.command));
    const has = (prefix: string, verb: RegExp) => commands.some(command => command.startsWith(prefix) && verb.test(command.slice(prefix.length)));
    results.check(
      "the CLI lists and replays a Silicon's webhook deliveries, for the Silicon (silicon-accounts webhook …) and its custodian (silicon-accounts silicon webhook …), as it does an app's",
      has("silicon-accounts webhook ", /^deliver/) && has("silicon-accounts webhook ", /^replay/) && has("silicon-accounts silicon webhook ", /^deliver/) && has("silicon-accounts silicon webhook ", /^replay/),
      `Silicon: ${short(commands.filter(command => command.startsWith("silicon-accounts webhook ")))}; custodian: ${short(commands.filter(command => command.startsWith("silicon-accounts silicon webhook ")))}; app: ${short(commands.filter(command => command.startsWith("silicon-accounts app webhook ")))}`,
    );
  },
};

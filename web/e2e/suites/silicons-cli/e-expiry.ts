import type { Journey } from "../../context";
import { forgetRateLimits, sql, tag } from "../../lib";
import {
  COUNTING_STK_ATTEMPT,
  accounts,
  asCarbon,
  cliError,
  dataOf,
  freshDir,
  holdRows,
  idAvailable,
  loginSilicon,
  obj,
  requestRow,
  requestStatus,
  said,
  selfCreate,
  setSinkSecret,
  short,
  signUpCarbon,
  siliconLogin,
  sinkUrl,
  str,
  until,
  waitForLockWaiters,
  waitSink,
  type Json,
} from "./_helpers";

/** Moves a custodian request past its 14 days (time travel in this stack's own database). */
const overdue = (env: Parameters<typeof sql>[0], requestId: string) => sql(env, `update custodian_requests set expires_at = now() - interval '1 second' where id = '${requestId}' and status = 'pending'`);

/** 12 hex digits from the run's tag, for chosen STKs. */
const hex12 = (t: string, lead: string) => `${lead}${t.replace(/[^0-9a-f]/g, "0")}`.slice(0, 12).padEnd(12, "0");

export const journey: Journey = {
  name: "silicons-cli-expiry",
  title: "a custodian request nobody answers expires after 14 days (time travel): the minute sweep expires it and sends silicon.custodian.expired, reads expire it at once (--wait, request status, sign-in), the Silicon is released and its id freed; a sign-in racing the release still says why",
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "expiry");

    // A: left alone after time travel, so only the sweep can expire it.
    const keyA = `scli-exp-a-${t}`;
    const a = await selfCreate(ctx, { id: `si:exp-a-${t}`, display_name: `Expiring A ${t}`, custodian: carbon.id, webhook_url: sinkUrl(env, keyA) });
    await setSinkSecret(env, keyA, a.webhookSecret);
    const rowA = await requestRow(env, a.requestId);
    results.check("a fresh request expires 14 days after it was made", a.status === 201 && rowA?.ttlSeconds === 14 * 24 * 3600, `${a.status} ${short(rowA)}`);
    // B: waited for with --wait. C: read with its request token. E: signs in after the expiry. D: signs in during it.
    const keyB = `scli-exp-b-${t}`;
    let createdB: Json | null = null;
    const homeB = freshDir();
    const waitB = accounts(env, ["silicon", "create", "--id", `si:exp-b-${t}`, "--custodian", carbon.id, "--webhook", sinkUrl(env, keyB), "--wait", "--timeout", "4m", "--json"], {
      home: homeB,
      timeoutMs: 300_000,
      onEvent: event => {
        if (event.event === "silicon_created") createdB = event;
      },
    });
    const eventB = await until(async () => createdB, 30_000, 100);
    const requestB = str(obj(eventB?.request).id);
    await setSinkSecret(env, keyB, str(eventB?.webhook_secret));
    const keyC = `scli-exp-c-${t}`;
    const stkC = `stk-${hex12(t, "c0ffee")}`;
    const c = await selfCreate(ctx, { id: `si:exp-c-${t}`, display_name: `Expiring C ${t}`, custodian: carbon.id, webhook_url: sinkUrl(env, keyC), stk: stkC });
    await setSinkSecret(env, keyC, c.webhookSecret);
    const keyE = `scli-exp-e-${t}`;
    const stkE = `stk-${hex12(t, "e0e0")}`;
    const e = await selfCreate(ctx, { id: `si:exp-e-${t}`, display_name: `Expiring E ${t}`, custodian: carbon.id, webhook_url: sinkUrl(env, keyE), stk: stkE });
    await setSinkSecret(env, keyE, e.webhookSecret);
    const stkD = `stk-${hex12(t, "d0d0")}`;
    const d = await selfCreate(ctx, { id: `si:exp-d-${t}`, display_name: `Expiring D ${t}`, custodian: carbon.id, stk: stkD });
    const waitingBefore = await asCarbon<Json>(env, carbon, "GET", "/v1/me/custodian-requests");
    results.check("the requests wait for the Carbon", ((obj(waitingBefore.body).items ?? []) as Json[]).filter(item => [a.requestId, requestB, c.requestId, d.requestId, e.requestId].includes(str(item.id))).length === 5, short(waitingBefore.body, 200));

    // Fourteen days pass for A, B and C.
    const travelled = Date.now();
    await overdue(env, a.requestId);
    await overdue(env, requestB);
    await overdue(env, c.requestId);
    const waitingAfter = await asCarbon<Json>(env, carbon, "GET", "/v1/me/custodian-requests");
    results.check("past their 14 days, they are not offered to the Carbon any more", !((obj(waitingAfter.body).items ?? []) as Json[]).some(item => [a.requestId, requestB, c.requestId].includes(str(item.id))), short(waitingAfter.body, 200));

    // B: the --wait poll finds it expired.
    const doneB = await waitB;
    const errorB = cliError(doneB);
    results.check("--wait ends with exit 1 and custodian_request_expired (didn't accept within 14 days)", doneB.code === 1 && errorB.code === "custodian_request_expired" && /within 14 days/.test(str(errorB.message)), said(doneB));
    results.metric("--wait noticed the expiry after", Date.now() - travelled, "ms");
    const hookB = await waitSink(env, keyB, "silicon.custodian.expired", event => dataOf(event).request_id === requestB);
    results.check("B's webhook got silicon.custodian.expired (released)", dataOf(hookB).released === true && !!dataOf(hookB).expired_at && dataOf(hookB).custodian === carbon.id, short(hookB?.payload, 220));

    // C: reading it with the request token makes the expiry real at once; then its STK says why it can't sign in.
    const readC = await requestStatus(ctx, c.requestId, c.requestToken);
    results.check("C's request read with its token: expired, the Silicon released (no id, deleted)", readC.body.status === "expired" && obj(readC.body.silicon).id === null && obj(readC.body.silicon).status === "deleted", short(readC.body));
    const hookC = await waitSink(env, keyC, "silicon.custodian.expired", event => dataOf(event).request_id === c.requestId);
    results.check("C's webhook got silicon.custodian.expired", dataOf(hookC).released === true, short(hookC?.payload, 200));
    const loginC = await loginSilicon(env, freshDir(), `si:exp-c-${t}`, stkC);
    results.check("C's STK afterwards: exit 3, custodian_expired (the account was never activated, the id released)", loginC.code === 3 && cliError(loginC).code === "custodian_expired", said(loginC));

    // A: nobody reads it; the sweep (every minute) expires it and tells the Silicon.
    const swept = await until(async () => ((await requestRow(env, a.requestId))?.status === "expired" ? true : null), 100_000, 500);
    const sweptAt = Date.now();
    results.check("the sweep expires A on its own within about a minute", swept === true, `${Math.round((sweptAt - travelled) / 1000)} s after the time travel`);
    results.metric("sweep expired the request after", sweptAt - travelled, "ms");
    const hookA = await waitSink(env, keyA, "silicon.custodian.expired", event => dataOf(event).request_id === a.requestId, 30_000);
    results.check("A's webhook got silicon.custodian.expired from the sweep (released, signed)", dataOf(hookA).released === true && dataOf(hookA).id === `si:exp-a-${t}` && dataOf(hookA).uuid === a.uuid, short(hookA?.payload, 220));
    const statusA = await requestStatus(ctx, a.requestId, a.requestToken);
    results.check("A's request reads expired; the Silicon was released (no id, deleted)", statusA.body.status === "expired" && obj(statusA.body.silicon).id === null && obj(statusA.body.silicon).status === "deleted", short(statusA.body));
    results.check("A's si:id is free again", (await idAvailable(ctx, `si:exp-a-${t}`)).available === true);
    const loginA = await loginSilicon(env, freshDir(), `si:exp-a-${t}`, a.stk);
    results.check("A's STK: exit 3, custodian_expired", loginA.code === 3 && cliError(loginA).code === "custodian_expired", said(loginA));
    const late = await asCarbon<Json>(env, carbon, "POST", `/v1/me/custodian-requests/${a.requestId}/accept`, {});
    results.check("accepting an expired request: 410 custodian_request_expired", late.status === 410 && str(obj(obj(late.body).error).code) === "custodian_request_expired", `${late.status} ${short(late.body)}`);
    const sweptBy = await sql(env, `select count(*) from audit_log where action = 'silicon.custodian.expired' and actor_kind = 'system' and target_id = '${a.uuid}'`);
    results.check("the expiry is recorded as the system's doing", Number(sweptBy[0]?.[0]) >= 1, short(sweptBy));

    // The sweep just ran, so for most of a minute only the requests below decide what happens to E and D.
    // E: its first sign-in after the 14 days expires the request itself and says why.
    await overdue(env, e.requestId);
    const loginE = await loginSilicon(env, freshDir(), `si:exp-e-${t}`, stkE);
    results.check("E signs in right after its 14 days (nothing expired it yet): exit 3, custodian_expired, and that sign-in expires it", loginE.code === 3 && cliError(loginE).code === "custodian_expired" && (await requestRow(env, e.requestId))?.status === "expired", said(loginE));
    const hookE = await waitSink(env, keyE, "silicon.custodian.expired", event => dataOf(event).request_id === e.requestId);
    results.check("E's webhook got silicon.custodian.expired", dataOf(hookE).released === true, short(hookE?.payload, 200));

    // D: a sign-in with the right STK has read the Silicon (pending, its STK hash) when a read of its overdue request
    // releases it, before the sign-in re-reads the Silicon after checking the STK. Made deterministic with a lock on the
    // Silicon's row: the read (which expires the request, then waits to release the Silicon) lines up first, the sign-in
    // (which waits to count its attempt) second; when the lock goes, the release commits first.
    await overdue(env, d.requestId);
    const failuresBefore = Number((await sql(env, `select count(*) from signin_history where account_uuid = '${d.uuid}' and method = 'silicon_stk' and outcome = 'failed'`))[0]?.[0] ?? 0);
    const hold = await holdRows(env, "accounts", `uuid = '${d.uuid}'`);
    const reading = requestStatus(ctx, d.requestId, d.requestToken);
    const first = await waitForLockWaiters(env, 1);
    const racing = siliconLogin(ctx, `si:exp-d-${t}`, stkD);
    const lined = await waitForLockWaiters(env, 2, COUNTING_STK_ATTEMPT);
    await hold.release();
    const releasedD = await reading;
    const loginD = await racing;
    results.check("D: the read of its overdue request and its sign-in both wait behind a lock on the Silicon (read first)", !!first && !!lined, short({ first, lined }, 400));
    results.check("D's request was released by that read while its sign-in was being checked", releasedD.body.status === "expired" && obj(releasedD.body.silicon).status === "deleted", short(releasedD.body));
    results.check("…that sign-in (the right STK) still says exactly why: 403 custodian_expired, not 401 invalid_credentials", loginD.status === 403 && str(obj(loginD.body.error).code) === "custodian_expired" && /didn't accept within 14 days/.test(str(obj(loginD.body.error).message)), `${loginD.status} ${short(loginD.body)}`);
    // The sign-in that was told why is recorded against the Silicon (an id that was gone already is recorded with none).
    const failuresAfter = Number((await sql(env, `select count(*) from signin_history where account_uuid = '${d.uuid}' and method = 'silicon_stk' and outcome = 'failed'`))[0]?.[0] ?? 0);
    results.check("…and it took the late path: its failed attempt is recorded against the Silicon it checked", failuresAfter === failuresBefore + 1, `${failuresBefore} → ${failuresAfter}`);
    const againD = await siliconLogin(ctx, `si:exp-d-${t}`, stkD);
    results.check("…the same as the STK hears afterwards, once the id is gone", againD.status === 403 && str(obj(againD.body.error).code) === "custodian_expired", `${againD.status} ${short(againD.body)}`);

    const history = await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?kind=custodian");
    const expired = ((obj(history.body).items ?? []) as Json[]).filter(item => /^Custodian request of si:exp-[abcde]-/.test(str(item.title)) && str(item.title).endsWith("expired"));
    results.check("the Carbon's history lists the five expired requests", expired.length === 5 && expired.every(item => item.detail === "Nobody accepted it within 14 days"), short(expired.map(item => item.title)));
  },
};

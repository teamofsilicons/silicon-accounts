import type { Ctx, Journey } from "../../context";
import { forgetRateLimits, sql, tag, type JsonAnswer } from "../../lib";
import { COUNTING_STK_ATTEMPT, asCarbon, errOf, holdRows, idAvailable, obj, selfCreate, short, signUpCarbon, siliconLogin, str, waitForLockWaiters, type Json } from "./_helpers";

interface Race {
  /** Both requests waited behind the lock, the change first. */
  lined: boolean;
  waiting: string[] | null;
  login: JsonAnswer<Json>;
  change: JsonAnswer<unknown>;
  /** From letting go of the lock to the sign-in's answer (counting, the STK check, the re-read). */
  loginMs: number;
}

/**
 * Lines up `change` (whatever ends the Silicon or replaces its STK), then a sign-in with the right STK, behind a lock on
 * the Silicon's row, and lets both go at once. The change commits first; the sign-in read the Silicon (its status and
 * STK hash) before that, waited to count its attempt, then checks the STK it read (Argon2) and re-reads the Silicon. Its
 * answer must be about the Silicon as it is by then.
 */
async function race(ctx: Ctx, uuid: string, id: string, stk: string, change: () => Promise<JsonAnswer<unknown>>): Promise<Race> {
  const hold = await holdRows(ctx.env, "accounts", `uuid = '${uuid}'`);
  try {
    const changing = change();
    const first = await waitForLockWaiters(ctx.env, 1);
    const signing = siliconLogin(ctx, id, stk);
    const waiting = await waitForLockWaiters(ctx.env, 2, COUNTING_STK_ATTEMPT);
    await hold.release();
    const released = Date.now();
    const login = await signing;
    const loginMs = Date.now() - released;
    return { lined: !!first && !!waiting, waiting, login, change: await changing, loginMs };
  } finally {
    await hold.release();
  }
}

const said = (answer: JsonAnswer<unknown>) => `${answer.status} ${short(answer.body, 260)}`;
const codeOf = (answer: JsonAnswer<unknown>) => str(errOf(answer.body).code);
const messageOf = (answer: JsonAnswer<unknown>) => str(errOf(answer.body).message);

/** Live sign-ins (token families) of an account, and its failed STK sign-ins. */
async function record(env: Ctx["env"], uuid: string): Promise<{ live: number; failed: number }> {
  const rows = await sql(
    env,
    `select (select count(*) from token_families where account_uuid = '${uuid}' and revoked_at is null), (select count(*) from signin_history where account_uuid = '${uuid}' and method = 'silicon_stk' and outcome = 'failed')`,
  );
  return { live: Number(rows[0]?.[0] ?? -1), failed: Number(rows[0]?.[1] ?? -1) };
}

export const journey: Journey = {
  name: "silicons-cli-sign-in-races",
  title: "a sign-in with the right STK while its Silicon ends or its STK is replaced (lined up behind a lock on the Silicon's row, so the change commits while the STK is checked) answers as the Silicon is by then: declined → custodian_declined, its named Carbon gone → custodian_declined, deleted by its custodian → account_deleted, STK rotated → invalid_credentials with nothing issued",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "races");
    const hex = (lead: string) => `${lead}${t.replace(/[^0-9a-f]/g, "0")}000000000000`.slice(0, 12);

    // 1. The named Carbon declines while the Silicon's STK is being checked.
    const stk1 = `stk-${hex("dec1")}`;
    const declined = await selfCreate(ctx, { id: `si:race-decline-${t}`, display_name: "Race decline", custodian: carbon.id, stk: stk1 });
    const r1 = await race(ctx, declined.uuid, declined.id, stk1, () => asCarbon(env, carbon, "POST", `/v1/me/custodian-requests/${declined.requestId}/decline`, {}));
    results.check("declined meanwhile: the decline (204) and then the sign-in waited behind the Silicon's row", declined.status === 201 && r1.lined && r1.change.status === 204, `${declined.status} ${said(r1.change)}; waiting ${short(r1.waiting, 300)}`);
    results.check("…the right STK hears 403 custodian_declined ('declined on …'), not 401 invalid_credentials", r1.login.status === 403 && codeOf(r1.login) === "custodian_declined" && messageOf(r1.login).includes(`${declined.id} can't sign in: the Carbon it named as custodian declined on `), said(r1.login));
    results.check("…its si:id is free again", (await idAvailable(ctx, declined.id)).available === true);

    // 2. The Carbon it named deletes their account while the Silicon's STK is being checked.
    const leaving = await signUpCarbon(env, "races-leaving");
    const stk2 = `stk-${hex("0f4a")}`;
    const orphan = await selfCreate(ctx, { id: `si:race-orphan-${t}`, display_name: "Race orphan", custodian: leaving.id, stk: stk2 });
    const r2 = await race(ctx, orphan.uuid, orphan.id, stk2, () => asCarbon(env, leaving, "DELETE", "/v1/me", { confirm: leaving.id }));
    results.check("its named Carbon deleted their account meanwhile: the deletion and then the sign-in waited behind the Silicon's row", orphan.status === 201 && r2.lined && (r2.change.status === 200 || r2.change.status === 204), `${orphan.status} ${said(r2.change)}; waiting ${short(r2.waiting, 300)}`);
    results.check("…the right STK hears 403 custodian_declined: the Carbon deleted their account before accepting", r2.login.status === 403 && codeOf(r2.login) === "custodian_declined" && /deleted their account before accepting/.test(messageOf(r2.login)), said(r2.login));

    // 3. Its custodian deletes the (active) Silicon while its STK is being checked.
    const stk3 = `stk-${hex("de1e")}`;
    const id3 = `si:race-deleted-${t}`;
    const made3 = await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: id3, display_name: "Race deleted", stk: stk3 });
    const uuid3 = str(obj(made3.body.silicon).uuid);
    const before3 = await siliconLogin(ctx, id3, stk3);
    const r3 = await race(ctx, uuid3, id3, stk3, () => asCarbon(env, carbon, "DELETE", `/v1/me/silicons/${uuid3}`, { confirm: id3 }));
    const after3 = await record(env, uuid3);
    results.check("deleted by its custodian meanwhile: the deletion and then the sign-in waited behind the Silicon's row", made3.status === 201 && before3.status === 200 && r3.lined && (r3.change.status === 200 || r3.change.status === 204), `${made3.status} ${before3.status} ${said(r3.change)}; waiting ${short(r3.waiting, 300)}`);
    results.check("…the right STK hears 403 account_deleted ('was deleted on …'), not 401 invalid_credentials", r3.login.status === 403 && codeOf(r3.login) === "account_deleted" && messageOf(r3.login).includes(`${id3} belonged to a Silicon account that was deleted on `), said(r3.login));
    results.check("…and nothing was issued to it: no live sign-in is left", after3.live === 0, short(after3));

    // 4. Its custodian rotates the STK while the old one is being checked: the old STK is dead by the time it would win.
    const stk4 = `stk-${hex("a0a7")}`;
    const id4 = `si:race-rotated-${t}`;
    const made4 = await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: id4, display_name: "Race rotated", stk: stk4 });
    const uuid4 = str(obj(made4.body.silicon).uuid);
    const before4 = await record(env, uuid4);
    const r4 = await race(ctx, uuid4, id4, stk4, () => asCarbon(env, carbon, "POST", `/v1/me/silicons/${uuid4}/stk`, {}));
    const fresh = str(obj(r4.change.body).stk);
    const after4 = await record(env, uuid4);
    results.check("rotated meanwhile: the rotation (a new STK) and then the sign-in with the old one waited behind the Silicon's row", made4.status === 201 && r4.lined && r4.change.status === 200 && /^stk-[0-9a-f]{12}$/.test(fresh), `${made4.status} ${r4.change.status}; waiting ${short(r4.waiting, 300)}`);
    results.check("…the old STK (right when it was read) gets 401 invalid_credentials: the rotation wins", r4.login.status === 401 && codeOf(r4.login) === "invalid_credentials", said(r4.login));
    results.check("…no sign-in was issued from it, and the refused attempt is in the Silicon's sign-in history", after4.live === 0 && after4.failed === before4.failed + 1, `${short(before4)} → ${short(after4)}`);
    const withNew = await siliconLogin(ctx, id4, fresh);
    const withOld = await siliconLogin(ctx, id4, stk4);
    results.check("…the new STK signs in, the old one stays refused", withNew.status === 200 && withOld.status === 401, `${withNew.status} / ${withOld.status}`);
    for (const [label, entry] of [["declined", r1], ["named Carbon gone", r2], ["deleted", r3], ["rotated", r4]] as const) results.metric(`sign-in answered after the lock went (${label})`, entry.loginMs, "ms");
  },
};

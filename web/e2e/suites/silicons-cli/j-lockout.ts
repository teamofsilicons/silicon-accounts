import type { Journey } from "../../context";
import { forgetRateLimits, randomIp, sleep, sql, tag } from "../../lib";
import { asCarbon, cliError, freshDir, loginSilicon, obj, said, short, signUpCarbon, siliconLogin, str, type Json } from "./_helpers";

const wrongStk = (n: number) => `stk-${n.toString(16).padStart(12, "0")}`;

export const journey: Journey = {
  name: "silicons-cli-lockout",
  title: "10 wrong STKs in a row lock a Silicon's sign-in for a minute (423 login_locked, exit 6), even for the right STK; the lock ends on its own, a success resets the count, it is per Silicon, and parallel guesses get no more than 10 checks",
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "lockout");
    const make = async (handle: string, stk: string) => {
      const made = await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: `si:${handle}`, display_name: handle, stk });
      return str(obj(obj(made.body).silicon).uuid);
    };
    const sid = `si:locked-${t}`;
    const stk = `stk-10c4${"d".repeat(8)}`;
    const uuid = await make(`locked-${t}`, stk);
    const otherStk = `stk-07e4${"e".repeat(8)}`;
    await make(`neighbour-${t}`, otherStk);

    // 1. Nine wrong STKs: each one 401 invalid_credentials, still unlocked.
    const statuses: number[] = [];
    for (let i = 1; i <= 9; i++) statuses.push((await siliconLogin(ctx, sid, wrongStk(i))).status);
    results.check("nine wrong STKs: each refused with 401 invalid_credentials", statuses.every(status => status === 401), statuses.join(","));
    const tenth = await loginSilicon(env, freshDir(), sid, wrongStk(10));
    const error = cliError(tenth);
    const retryAfter = Number(obj(error.details).retry_after_seconds);
    results.check("the 10th wrong STK in a row locks sign-in: exit 6, login_locked, says why and for how long", tenth.code === 6 && error.code === "login_locked" && /10 wrong STKs were sent in a row/.test(str(error.message)) && retryAfter > 0 && retryAfter <= 60, said(tenth));
    const lockedAt = Date.now();
    const row = await sql(env, `select stk_failed_attempts, extract(epoch from (stk_locked_until - now()))::int from accounts where uuid = '${uuid}'`);
    results.check("the lock lasts one minute", Number(row[0]?.[1]) > 50 && Number(row[0]?.[1]) <= 60, short(row));
    const right = await loginSilicon(env, freshDir(), sid, stk);
    results.check("during the lock even the right STK is refused (exit 6, login_locked)", right.code === 6 && cliError(right).code === "login_locked", said(right));
    const neighbour = await loginSilicon(env, freshDir(), `si:neighbour-${t}`, otherStk);
    results.check("another Silicon is not affected (the lock is per Silicon)", neighbour.code === 0, said(neighbour));
    const unknown = await loginSilicon(env, freshDir(), `si:nobody-${t}`, stk);
    results.check("an si:id that doesn't exist gets the same answer as a wrong STK (exit 3, invalid_credentials)", unknown.code === 3 && cliError(unknown).code === "invalid_credentials", said(unknown));

    // 2. The lock ends on its own after the minute.
    const waitMs = Math.max(0, retryAfter * 1000 - (Date.now() - lockedAt)) + 1500;
    await sleep(waitMs);
    const afterLock = await loginSilicon(env, freshDir(), sid, stk);
    results.check("after the minute the right STK signs in again", afterLock.code === 0 && afterLock.json?.id === sid, said(afterLock));
    results.metric("lock lasted (until sign-in worked again)", Date.now() - lockedAt, "ms");

    // 3. A success resets the count: nine more wrong ones and the right one still works.
    const again: number[] = [];
    for (let i = 11; i <= 19; i++) again.push((await siliconLogin(ctx, sid, wrongStk(i))).status);
    const stillOpen = await siliconLogin(ctx, sid, stk);
    results.check("a success resets the count: 9 wrong after it, then the right STK works", again.every(status => status === 401) && stillOpen.status === 200, `${again.join(",")} then ${stillOpen.status}`);
    for (let i = 20; i <= 29; i++) await siliconLogin(ctx, sid, wrongStk(i));
    const relocked = await siliconLogin(ctx, sid, stk);
    results.check("…ten wrong in a row lock it again (423)", relocked.status === 423 && str(obj(relocked.body.error).code) === "login_locked", `${relocked.status}`);
    await sql(env, `update accounts set stk_locked_until = null where uuid = '${uuid}'`);
    const unlocked = await siliconLogin(ctx, sid, stk);
    results.check("…until the lock is over (time travel): the right STK works", unlocked.status === 200, `${unlocked.status}`);

    // 4. A burst of parallel guesses gets no more than 10 checks.
    const burstStk = `stk-b0057${"a".repeat(7)}`;
    const burstUuid = await make(`burst-${t}`, burstStk);
    await forgetRateLimits(env);
    const burst = await Promise.all(Array.from({ length: 16 }, (_, i) => siliconLogin(ctx, `si:burst-${t}`, wrongStk(100 + i), randomIp())));
    const counts = burst.reduce<Record<number, number>>((acc, answer) => ({ ...acc, [answer.status]: (acc[answer.status] ?? 0) + 1 }), {});
    results.check("16 parallel wrong guesses: at most 10 are checked (401), the rest are locked out (423)", (counts[401] ?? 0) <= 10 && (counts[401] ?? 0) + (counts[423] ?? 0) === 16 && (counts[423] ?? 0) >= 6, short(counts));
    const burstRight = await siliconLogin(ctx, `si:burst-${t}`, burstStk);
    results.check("…and it is locked afterwards", burstRight.status === 423, String(burstRight.status));
    const failures = await sql(env, `select count(*) from signin_history where account_uuid = '${burstUuid}' and method = 'silicon_stk' and outcome = 'failed'`);
    results.check("every refused attempt is in the sign-in history", Number(failures[0]?.[0]) >= 16, short(failures));
    await forgetRateLimits(env, "127.0.0.1");
  },
};

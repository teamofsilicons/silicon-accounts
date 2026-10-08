import type { Journey } from "../../context";
import { forgetRateLimits, randomIp, sql, tag } from "../../lib";
import { accounts, asCarbon, cliError, freshDir, obj, pool, said, selfCreate, short, signUpCarbon, str, type Json } from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-self-create-limits",
  title: "self-creation can't be used to spam: 10 Silicons an hour per network (failed attempts don't count), 20 waiting for the same custodian name; naming the custodian (an si:id, a malformed email, a phone number, a bare handle) is answered precisely; a retried `silicon create` with its idempotency key creates once; `--wait --timeout` gives up without losing the STK",
  // No browser: the CLI and the API only, so the engine changes nothing (the browser journeys run in WebKit too).
  engines: ["chromium"],
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env);
    const t = tag();
    const carbon = await signUpCarbon(env, "limits");

    // 1. Per network: ten successful self-creations an hour; failures first, which don't count.
    const ip = randomIp();
    const taken = await selfCreate(ctx, { id: `si:dup-${t}`, display_name: "Dup", custodian: carbon.id }, ip);
    const dup = await selfCreate(ctx, { id: `si:dup-${t}`, display_name: "Dup", custodian: carbon.id }, ip);
    const nobody = await selfCreate(ctx, { id: `si:lost-${t}`, display_name: "Lost", custodian: `c:nobody-${t}` }, ip);
    results.check("failed attempts get precise answers (409 id_taken, 404 custodian_not_found)", taken.status === 201 && dup.status === 409 && str(obj(dup.body.error).code) === "id_taken" && nobody.status === 404, `${taken.status} ${dup.status} ${nobody.status}`);
    const made: number[] = [taken.status];
    for (let i = 2; i <= 10; i++) made.push((await selfCreate(ctx, { id: `si:net${i}-${t}`, display_name: `Net ${i}`, custodian: `scli.net.${t}.${i}@example.test` }, ip)).status);
    const eleventh = await selfCreate(ctx, { id: `si:net11-${t}`, display_name: "Net 11", custodian: `scli.net.${t}.11@example.test` }, ip);
    const error = obj(eleventh.body.error);
    results.check("ten self-creations from one network succeed (the failed ones didn't count); the 11th: 429 rate_limited with retry_after_seconds", made.every(status => status === 201) && eleventh.status === 429 && error.code === "rate_limited" && Number(obj(error.details).retry_after_seconds) > 0, `${made.join(",")} then ${eleventh.status} ${short(error.message)}`);
    const other = await selfCreate(ctx, { id: `si:net11-${t}`, display_name: "Net 11", custodian: `scli.net.${t}.11@example.test` }, randomIp());
    results.check("…another network is not affected", other.status === 201, String(other.status));

    // 1b. Naming the custodian (UNDERSTANDING.md: "using their c:id or email"): what can't name one is refused, saying
    //     exactly why and how to name a Carbon instead. Each from a network of its own (refusals never count anyway).
    const naming = async (custodian: string) => {
      const answer = await selfCreate(ctx, { id: `si:named-${Math.random().toString(36).slice(2, 7)}-${t}`, display_name: "Named", custodian });
      return { custodian, status: answer.status, problem: str(obj(obj(obj(answer.body.error).details).fields).custodian) || str(obj(answer.body.error).message) };
    };
    const silicon = await naming(`si:dup-${t}`);
    results.check("an si:id as custodian: 422, says it is a Silicon id and a custodian is a Carbon (c:…)", silicon.status === 422 && /Silicon id/.test(silicon.problem) && /c:/.test(silicon.problem), `${silicon.status} ${silicon.problem}`);
    const broken = await Promise.all(["saket@", "saket@example", "@example.test"].map(naming));
    results.check("a malformed email as custodian: 422, says what is wrong with the address", broken.every(entry => entry.status === 422 && /is not a valid email address/.test(entry.problem)), short(broken.map(entry => `${entry.custodian} → ${entry.status} ${entry.problem}`), 600));
    const blank = await naming("   ");
    results.check("an empty custodian: 422, says to name the Carbon by its c:id or an email address", blank.status === 422 && /c:id/.test(blank.problem) && /email/.test(blank.problem), `${blank.status} ${blank.problem}`);
    const phones = await Promise.all(["+15005550006", "+1 500 555 0006"].map(naming));
    results.check(
      "a phone number as custodian: 422, saying a custodian is named by c:id or email (not that a 'handle' can't contain '+')",
      phones.every(entry => entry.status === 422 && /email/i.test(entry.problem) && /c:/.test(entry.problem) && !/^The handle '\+/.test(entry.problem)),
      short(phones.map(entry => `${entry.custodian} → ${entry.status} ${entry.problem}`), 700),
    );
    const bare = await selfCreate(ctx, { id: `si:bare-${t}`, display_name: "Bare", custodian: `  ${carbon.id.slice(2).toUpperCase()} ` });
    results.check("a bare handle in any case names that Carbon (c: added, lower-cased)", bare.status === 201 && obj(bare.body.request).custodian === carbon.id, `${bare.status} ${short(bare.body.request ?? bare.body.error)}`);

    // 2. At most 20 self-created Silicons wait for the same custodian name.
    const busy = await signUpCarbon(env, "busy");
    const twenty = await pool(Array.from({ length: 20 }, (_, i) => i), 5, i => selfCreate(ctx, { id: `si:q${i}-${t}`, display_name: `Queue ${i}`, custodian: busy.id }));
    const over = await selfCreate(ctx, { id: `si:q20-${t}`, display_name: "Queue 20", custodian: busy.id });
    const overError = obj(over.body.error);
    results.check("20 self-created Silicons can wait for one c:id; the 21st: 429, saying why and what to do", twenty.every(entry => entry.status === 201) && over.status === 429 && /already has 20 self-created Silicons waiting/.test(str(overError.message)) && Number(obj(overError.details).pending_requests) === 20, `${twenty.filter(entry => entry.status === 201).length} created; ${over.status} ${short(overError.message)}`);
    const byEmail = await selfCreate(ctx, { id: `si:q21-${t}`, display_name: "Queue 21", custodian: busy.email });
    results.check("…the limit is per name: naming the same Carbon by email still works (no hint which email belongs to which c:id)", byEmail.status === 201, String(byEmail.status));
    const first = twenty[0]!;
    const declined = await asCarbon<Json>(env, busy, "POST", `/v1/me/custodian-requests/${first.requestId}/decline`, {});
    const freed = await selfCreate(ctx, { id: `si:q22-${t}`, display_name: "Queue 22", custodian: busy.id });
    results.check("…a decision frees a place in the queue", declined.status === 204 && freed.status === 201, `${declined.status} ${freed.status}`);

    // 3. A retried `silicon-accounts silicon create` (same --idempotency-key) creates the Silicon once.
    await forgetRateLimits(env, "127.0.0.1");
    const key = `scli-idem-${t}`;
    const args = ["silicon", "create", "--id", `si:idem-${t}`, "--display-name", "Idem", "--custodian", carbon.id, "--idempotency-key", key, "--json"];
    const once = await accounts(env, args, { home: freshDir() });
    const again = await accounts(env, args, { home: freshDir() });
    const count = await sql(env, `select count(*) from accounts where handle = 'si:idem-${t}'`);
    const requests = await sql(env, `select count(*) from custodian_requests r join accounts a on a.uuid = r.silicon_uuid where a.handle = 'si:idem-${t}'`);
    results.check("the same `silicon create` retried with its --idempotency-key: the same Silicon, request and STK; created once", once.code === 0 && again.code === 0 && obj(once.json?.silicon).uuid === obj(again.json?.silicon).uuid && obj(once.json?.request).id === obj(again.json?.request).id && once.json?.stk === again.json?.stk && count[0]?.[0] === "1" && requests[0]?.[0] === "1", `${said(again).replace(str(again.json?.stk), "stk-…")} | ${count[0]?.[0]} account(s), ${requests[0]?.[0]} request(s)`);
    const changed = await accounts(env, [...args.slice(0, 4), "--display-name", "Different", ...args.slice(6)], { home: freshDir() });
    results.check("…the same key with a different request: exit 5, idempotency_key_reused", changed.code === 5 && cliError(changed).code === "idempotency_key_reused", said(changed));

    // 4. `--wait --timeout`: gives up with exit 1, keeps the request open, and still hands over the STK.
    const home = freshDir();
    const slow = await accounts(env, ["silicon", "create", "--id", `si:slow-${t}`, "--custodian", carbon.id, "--wait", "--timeout", "3s", "--json"], { home, timeoutMs: 60_000 });
    const timedOut = cliError(slow);
    const details = obj(timedOut.details);
    results.check("`--wait --timeout 3s` with no decision: exit 1, timed_out, how to resume", slow.code === 1 && timedOut.code === "timed_out" && str(timedOut.hint).includes(`silicon-accounts silicon request status ${str(obj(details.request).id)} --wait`), said(slow).replace(str(details.stk), "stk-…"));
    results.check("…its details still carry the new Silicon, the request and the STK (nothing is lost)", /^stk-[0-9a-f]{12}$/.test(str(details.stk)) && obj(details.silicon).id === `si:slow-${t}` && !!str(details.request_token), short(Object.keys(details)));
    const pending = await accounts(env, ["silicon", "request", "status", str(obj(details.request).id), "--json"], { home });
    results.check("…and the request is still pending (`silicon-accounts silicon request status`)", pending.code === 0 && pending.json?.status === "pending", said(pending));
  },
};

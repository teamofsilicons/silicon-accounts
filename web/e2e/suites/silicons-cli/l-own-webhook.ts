import type { Journey } from "../../context";
import { forgetRateLimits, json, sleep, sql, tag } from "../../lib";
import {
  accounts,
  cliError,
  dataOf,
  freshDir,
  loginCarbon,
  loginSilicon,
  obj,
  said,
  setSinkSecret,
  short,
  signUpCarbon,
  sinkInbox,
  sinkUrl,
  str,
  until,
  waitSink,
} from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-own-webhook",
  title: "a Silicon's own webhook: the Silicon sets, tests and removes it with the CLI, its custodian can point it elsewhere (a new secret each time); detail changes arrive as silicon.updated, signed, retried after a failure; nothing is sent once it is removed; test pings are limited",
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "hooks");
    const homeC = freshDir();
    await loginCarbon(env, homeC, carbon);
    const sid = `si:hooked-${t}`;
    const created = await accounts(env, ["silicon", "create", "--id", sid, "--json"], { home: homeC });
    const uuid = str(obj(created.json?.silicon).uuid);
    const homeS = freshDir();
    await loginSilicon(env, homeS, sid, str(created.json?.stk));
    const keyA = `scli-own-a-${t}`;
    const keyB = `scli-own-b-${t}`;

    // 1. The Silicon sets its own webhook and tests it.
    const invalid = await accounts(env, ["webhook", "set", "ftp://example.test/hooks", "--json"], { home: homeS });
    results.check("a non-http(s) URL is refused: exit 2, validation_failed on url", invalid.code === 2 && cliError(invalid).code === "validation_failed" && !!obj(obj(cliError(invalid).details).fields).url, said(invalid));
    const set = await accounts(env, ["webhook", "set", sinkUrl(env, keyA), "--json"], { home: homeS });
    const secretA = str(set.json?.webhook_secret);
    results.check("`accounts webhook set <url>` (as the Silicon): the URL and a signing secret, printed once", set.code === 0 && set.json?.webhook_url === sinkUrl(env, keyA) && secretA.startsWith("whsec_"), said(set).replace(secretA, "whsec_…"));
    await setSinkSecret(env, keyA, secretA);
    const ping = await accounts(env, ["webhook", "test", "--json"], { home: homeS });
    const pinged = await waitSink(env, keyA, "ping", event => event.event_id === ping.json?.event_id);
    results.check("`accounts webhook test`: a ping is queued (its event id printed) and arrives, signed with that secret", ping.code === 0 && str(ping.json?.event_id).length > 0 && pinged?.type === "ping", said(ping));
    results.check("the body names the Silicon and no app", pinged?.payload.silicon === uuid && pinged?.payload.app_id === null && !!pinged?.payload.occurred_at, short(pinged?.payload, 200));

    // 2. Its details change: silicon.updated.
    const renamed = await accounts(env, ["silicon", "update", sid, "--display-name", `Hooked renamed ${t}`, "--json"], { home: homeC });
    const updated = await waitSink(env, keyA, "silicon.updated", event => obj(dataOf(event).silicon).display_name === `Hooked renamed ${t}`);
    results.check("the custodian renames it (`accounts silicon update`): silicon.updated, changed [display_name], with the new view", renamed.code === 0 && JSON.stringify(dataOf(updated).changed) === '["display_name"]' && dataOf(updated).uuid === uuid, short(updated?.payload, 240));
    await accounts(env, ["silicon", "update", sid, "--timezone", "America/New_York", "--json"], { home: homeC });
    const tz = await waitSink(env, keyA, "silicon.updated", event => obj(dataOf(event).silicon).timezone === "America/New_York");
    results.check("…a timezone change too: changed [timezone]", JSON.stringify(dataOf(tz).changed) === '["timezone"]', short(dataOf(tz).changed));

    // 3. The custodian points it elsewhere: a new secret; events follow the new URL.
    const moved = await accounts(env, ["silicon", "webhook", "set", sid, sinkUrl(env, keyB), "--json"], { home: homeC });
    const secretB = str(moved.json?.webhook_secret);
    results.check("the custodian sets another URL (`accounts silicon webhook set`): a new, different secret", moved.code === 0 && secretB.startsWith("whsec_") && secretB !== secretA, said(moved).replace(secretB, "whsec_…"));
    await setSinkSecret(env, keyB, secretB);
    const beforeA = (await sinkInbox(env, keyA)).deliveries;
    await accounts(env, ["silicon", "update", sid, "--display-name", `Hooked moved ${t}`, "--json"], { home: homeC });
    const atB = await waitSink(env, keyB, "silicon.updated", event => obj(dataOf(event).silicon).display_name === `Hooked moved ${t}`);
    await sleep(1500);
    results.check("…the next event goes to the new URL only, signed with the new secret", !!atB && (await sinkInbox(env, keyA)).deliveries === beforeA, `B ${atB ? "got it" : "nothing"}, A deliveries ${beforeA} → ${(await sinkInbox(env, keyA)).deliveries}`);

    // 4. A failed delivery is retried with the same event id.
    await json(`${env.apps}/hooks/${keyB}/_webhook-faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fail_next: 1, status: 503 }) });
    const failedAt = Date.now();
    await accounts(env, ["silicon", "update", sid, "--display-name", `Hooked retried ${t}`, "--json"], { home: homeC });
    const retried = await waitSink(env, keyB, "silicon.updated", event => obj(dataOf(event).silicon).display_name === `Hooked retried ${t}`, 60_000);
    const attempts = retried ? await sql(env, `select d.attempts, d.status, coalesce(d.last_status, 0) from webhook_deliveries d where d.event_id = '${retried.event_id}'`) : [];
    results.check("a delivery the Silicon's endpoint refused (503) is retried and arrives with the same event id", !!retried && Number(attempts[0]?.[0]) >= 2 && attempts[0]?.[1] === "delivered", short(attempts));
    results.metric("Silicon webhook retry delivered after", Date.now() - failedAt, "ms");

    // 5. The Silicon removes it: nothing more is sent; a test says there is none.
    const removed = await accounts(env, ["webhook", "remove", "--json"], { home: homeS });
    results.check("`accounts webhook remove` (as the Silicon)", removed.code === 0 && removed.json?.removed === true, said(removed));
    const quietBefore = (await sinkInbox(env, keyB)).deliveries;
    await accounts(env, ["silicon", "update", sid, "--display-name", `Hooked silent ${t}`, "--json"], { home: homeC });
    await sleep(4000);
    results.check("…after which a change sends nothing", (await sinkInbox(env, keyB)).deliveries === quietBefore, `${quietBefore} → ${(await sinkInbox(env, keyB)).deliveries}`);
    const noHook = await accounts(env, ["webhook", "test", "--json"], { home: homeS });
    results.check("`accounts webhook test` without a webhook: exit 5, webhook_not_set", noHook.code === 5 && cliError(noHook).code === "webhook_not_set", said(noHook));
    const shown = await accounts(env, ["silicon", "show", sid, "--json"], { home: homeC });
    results.check("the custodian sees it has no webhook", shown.code === 0 && !shown.json?.webhook_url, said(shown));

    // 6. Test pings are limited (10 per hour per Silicon); a newer ping supersedes older retries.
    await accounts(env, ["webhook", "set", sinkUrl(env, keyA), "--json"], { home: homeS });
    // One ping was sent in step 1 (and the one refused for lack of a webhook was not counted): nine more fit in the hour.
    const pings = [];
    for (let i = 0; i < 9; i++) pings.push(await accounts(env, ["webhook", "test", "--json"], { home: homeS }));
    const eleventh = await accounts(env, ["webhook", "test", "--json"], { home: homeS });
    results.check("ten test pings an hour; the 11th: exit 6, rate_limited, with retry_after_seconds", pings.every(run => run.code === 0) && eleventh.code === 6 && Number(obj(cliError(eleventh).details).retry_after_seconds) > 0, `${pings.filter(run => run.code === 0).length} + 1 ok, then ${said(eleventh)}`);
    const superseded = await sql(env, `select count(*) filter (where d.status = 'pending'), count(*) from webhook_deliveries d join webhook_events e on e.event_id = d.event_id where e.type = 'ping' and d.target_kind = 'silicon' and d.target_id = '${uuid}'`);
    results.check("…and at most one test ping is ever waiting for a retry", Number(superseded[0]?.[0]) <= 1 && Number(superseded[0]?.[1]) === 10, short(superseded));
    const custodianRemove = await accounts(env, ["silicon", "webhook", "remove", sid, "--json"], { home: homeC });
    results.check("the custodian can remove it too (`accounts silicon webhook remove`)", custodianRemove.code === 0 && custodianRemove.json?.removed === true, said(custodianRemove));
    const rejected = await until(async () => {
      const box = await sinkInbox(env, keyB);
      return box.rejected.filter(entry => entry.reason !== "fault_injected" && entry.recovered !== true).length === 0 ? box : null;
    }, 2000);
    results.check("no delivery failed its signature check", !!rejected, short((await sinkInbox(env, keyB)).rejected));
  },
};

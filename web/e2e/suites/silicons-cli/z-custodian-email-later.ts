import type { Journey } from "../../context";
import { forgetRateLimits, lastSeq, sql, tag } from "../../lib";
import {
  accounts,
  asCarbon,
  cliError,
  codeEmail,
  dataOf,
  freshDir,
  loginCarbon,
  obj,
  said,
  setSinkSecret,
  short,
  signUpCarbon,
  sinkUrl,
  str,
  until,
  waitSink,
  type Carbon,
  type Json,
  type Run,
} from "./_helpers";

/** `silicon-accounts email add <address>` + the code from the mailbox + `silicon-accounts email verify`. */
async function addEmail(env: Parameters<typeof accounts>[0], home: string, address: string): Promise<{ add: Run; verify: Run }> {
  const after = await lastSeq(env);
  const add = await accounts(env, ["email", "add", address, "--json"], { home });
  const code = await codeEmail(env, address, after).catch(() => "");
  const verify = await accounts(env, ["email", "verify", str(add.json?.challenge_id), code, "--json"], { home });
  return { add, verify };
}

const requestsOf = async (env: Parameters<typeof accounts>[0], home: string) => ((await accounts(env, ["custodian", "requests", "--json"], { home })).json?.items ?? []) as Json[];

export const journey: Journey = {
  name: "silicons-cli-custodian-email-later",
  title: "a Silicon names its custodian by an address that later becomes a Carbon's second email (`silicon-accounts email add` + verify): the request appears for that Carbon, goes away when the address is removed (accepting then fails), comes back when it is added again, and is accepted with the CLI; the Silicon's --wait returns signed in; the request records who answered",
  // No browser: the CLI and the API only, so the engine changes nothing (the browser journeys run in WebKit too).
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon: Carbon = await signUpCarbon(env, "second-email");
    const homeC = freshDir();
    results.check("setup: a Carbon signs in to the CLI with its own (primary) email", (await loginCarbon(env, homeC, carbon)).finish.code === 0);
    const address = `scli.second.${t}@example.test`;
    const sid = `si:second-${t}`;
    const key = `scli-second-${t}`;

    // 1. The Silicon names the address (no account has it) and waits.
    const homeS = freshDir();
    let created: Json | null = null;
    const waiting = accounts(env, ["silicon", "create", "--id", sid, "--custodian", address, "--webhook", sinkUrl(env, key), "--wait", "--timeout", "4m", "--json"], {
      home: homeS,
      timeoutMs: 300_000,
      onEvent: event => {
        if (event.event === "silicon_created") created = event;
      },
    });
    const event = await until(async () => created, 30_000, 100);
    const requestId = str(obj(event?.request).id);
    await setSinkSecret(env, key, str(event?.webhook_secret));
    results.check("the Silicon creates its account naming the address and waits (--wait)", !!requestId && obj(event?.silicon).status === "pending_custodian", short(event, 200));
    const before = await requestsOf(env, homeC);
    results.check("…the Carbon (another address) does not see the request yet", !before.some(item => item.id === requestId), `${before.length} requests`);

    // 2. The Carbon adds the address to its account: the request is now addressed to it.
    const first = await addEmail(env, homeC, address);
    const emails = ((first.verify.json?.emails ?? []) as Json[]).map(entry => `${str(entry.email)}${entry.is_primary ? " (primary)" : ""}`);
    results.check("`silicon-accounts email add` + `silicon-accounts email verify`: the address is the Carbon's second, verified email (the primary unchanged)", first.add.code === 0 && first.verify.code === 0 && emails.includes(address) && emails.includes(`${carbon.email} (primary)`), `${said(first.add)} | ${said(first.verify)}`);
    const offered = (await requestsOf(env, homeC)).find(item => item.id === requestId);
    results.check("`silicon-accounts custodian requests`: the request is there now (initial, from the Silicon)", offered?.kind === "initial" && obj(offered.silicon).id === sid, short(offered));

    // 3. The address leaves the account: the request leaves with it, and can't be accepted.
    const removed = await accounts(env, ["email", "remove", address, "--json"], { home: homeC });
    const afterRemoval = await requestsOf(env, homeC);
    results.check("`silicon-accounts email remove <address>`: the request is no longer offered to the Carbon", removed.code === 0 && !afterRemoval.some(item => item.id === requestId), `${said(removed)} | ${afterRemoval.length} requests`);
    const refused = await accounts(env, ["custodian", "accept", requestId, "--json"], { home: homeC });
    results.check("…accepting it then: exit 4, custodian_request_not_found (it isn't addressed to this Carbon any more)", refused.code === 4 && cliError(refused).code === "custodian_request_not_found", said(refused));
    const stillPending = await sql(env, `select status from custodian_requests where id = '${requestId}'`);
    results.check("…and it keeps waiting for whoever has the address", stillPending[0]?.[0] === "pending", short(stillPending));

    // 4. Added back, the Carbon accepts with the CLI; the Silicon's --wait returns.
    const second = await addEmail(env, homeC, address);
    const acceptedAt = Date.now();
    const accepted = await accounts(env, ["custodian", "accept", requestId, "--json"], { home: homeC });
    results.check("added back and verified, `silicon-accounts custodian accept <id>` accepts it", second.verify.code === 0 && accepted.code === 0, `${said(second.verify)} | ${said(accepted)}`);
    const done = await waiting;
    results.metric("accept (CLI) → --wait returned", Date.now() - acceptedAt, "ms");
    results.check("the Silicon's --wait returns: accepted, signed in", done.code === 0 && done.json?.final_status === "accepted" && done.json?.signed_in === true, said(done));
    const whoami = await accounts(env, ["whoami", "--json"], { home: homeS });
    results.check("…its custodian is the Carbon (by its c:id)", obj(whoami.json?.custodian).id === carbon.id && obj(whoami.json?.custodian).uuid === carbon.uuid, said(whoami));
    const row = await sql(env, `select status, coalesce(to_email, ''), coalesce(to_uuid, ''), coalesce(decided_by, '') from custodian_requests where id = '${requestId}'`);
    results.check("the request keeps the address it was sent to and records the Carbon who answered it", row[0]?.[0] === "accepted" && row[0]?.[1] === address && row[0]?.[2] === carbon.uuid && row[0]?.[3] === carbon.uuid, short(row));
    const hook = await waitSink(env, key, "silicon.custodian.accepted", candidate => dataOf(candidate).request_id === requestId);
    results.check("its webhook got silicon.custodian.accepted naming the Carbon", obj(dataOf(hook).custodian).id === carbon.id, short(hook?.payload, 200));
    const history = await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?kind=custodian");
    const titles = ((obj(history.body).items ?? []) as Json[]).map(item => str(item.title));
    results.check("the Carbon's history: became the custodian", titles.includes(`Became the custodian of ${sid}`), short(titles));
  },
};

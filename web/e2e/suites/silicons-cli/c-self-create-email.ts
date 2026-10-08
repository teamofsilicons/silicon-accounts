import type { Journey } from "../../context";
import { forgetRateLimits, json, newContext, shot, signInOnSite, sleep, sql, tag } from "../../lib";
import {
  accounts,
  answerOnSite,
  asCarbon,
  dataOf,
  freshDir,
  loginSilicon,
  obj,
  requestCard,
  requestRow,
  said,
  setSinkSecret,
  short,
  signUpCarbon,
  sinkUrl,
  str,
  until,
  waitSink,
  type Json,
} from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-self-create-email",
  title: "a Silicon names its custodian by an email nobody has signed up with yet: the address is invited, the request waits, the Carbon signs up later on the site, finds the request and accepts it",
  async run(ctx) {
    const { env, results, browser } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const email = `scli.later.${t}@example.test`;
    const sid = `si:later-${t}`;
    const key = `scli-later-${t}`;
    const home = freshDir();

    // 1. Self-create naming an address with no account (typed in mixed case: addresses are case-insensitive).
    const created = await accounts(env, ["silicon", "create", "--id", sid, "--custodian", `  Scli.Later.${t}@Example.TEST `, "--webhook", sinkUrl(env, key), "--json"], { home });
    const request = obj(created.json?.request);
    const requestId = str(request.id);
    const stk = str(created.json?.stk);
    results.check("`silicon-accounts silicon create --custodian <email>` (not signed in): created, pending", created.code === 0 && obj(created.json?.silicon).status === "pending_custodian" && /^stk-[0-9a-f]{12}$/.test(stk), said(created));
    results.check("the request shows the address masked, never in full", request.custodian === "s***@example.test" && !created.stdout.includes(email), str(request.custodian));
    await setSinkSecret(env, key, str(created.json?.webhook_secret));
    const row = await requestRow(env, requestId);
    const stored = await sql(env, `select coalesce(to_email, ''), coalesce(to_uuid, '') from custodian_requests where id = '${requestId}'`);
    results.check("it is addressed to the normalized address (lower case), to no account yet", stored[0]?.[0] === email && stored[0]?.[1] === "" && row?.status === "pending", short(stored));
    const invite = await until(async () => {
      const box = await json<{ items?: Json[] }>(`${env.messaging}/_messages?to=${encodeURIComponent(email)}&limit=10`);
      return (box.body.items ?? []).find(message => str(message.subject).includes(sid)) ?? null;
    }, 15_000);
    results.check("the address gets an invitation: sign up with it and the request will be waiting", str(invite?.subject) === `${sid} asked you to be its custodian on Silicon Accounts` && str(invite?.text).includes(`sign up at ${env.site}`) && str(invite?.from).includes("accounts@teamofsilicons.com"), short(invite?.subject));
    const status1 = await accounts(env, ["silicon", "request", "status", requestId, "--json"], { home });
    results.check("`silicon-accounts silicon request status <id>` (saved token): pending", status1.code === 0 && status1.json?.status === "pending" && status1.json?.custodian === "s***@example.test", said(status1));
    const elsewhere = await accounts(env, ["silicon", "request", "status", requestId, "--json"], { home: freshDir() });
    results.check("…from another home without --token: exit 2, says the token is missing and where it lives", elsewhere.code === 2 && /No request token/.test(str(obj(elsewhere.json?.error).message)), said(elsewhere));
    const withToken = await accounts(env, ["silicon", "request", "status", requestId, "--token", str(created.json?.request_token), "--json"], { home: freshDir() });
    results.check("…or with --token sarq_…: pending", withToken.code === 0 && withToken.json?.status === "pending", said(withToken));

    // 2. Nobody else sees it.
    const stranger = await signUpCarbon(env, "stranger");
    const theirs = await asCarbon<Json>(env, stranger, "GET", "/v1/me/custodian-requests");
    results.check("another Carbon does not see the request", theirs.status === 200 && !((obj(theirs.body).items ?? []) as Json[]).some(item => item.id === requestId));
    const grab = await asCarbon<Json>(env, stranger, "POST", `/v1/me/custodian-requests/${requestId}/accept`, {});
    results.check("…and can't accept it (404 custodian_request_not_found)", grab.status === 404 && str(obj(obj(grab.body).error).code) === "custodian_request_not_found", `${grab.status} ${short(grab.body)}`);

    // 3. The Carbon signs up later with that address: the request is waiting on /silicons.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "scli-later");
    await signInOnSite(env, page, email);
    const me = await (await page.request.get(`${env.site}/v1/me`)).json() as Json;
    results.check("the address signed up as a new Carbon", me.kind === "carbon" && ((me.emails ?? []) as Json[]).some(entry => entry.email === email), short({ id: me.id }));
    await page.goto(`${env.site}/silicons`);
    const card = requestCard(page, sid, "initial");
    await card.waitFor({ timeout: 30_000 }).catch(() => undefined);
    await sleep(700);
    await shot(env, page, "scli-later-01-request-waiting");
    results.check("after signing up, /silicons shows the request from the Silicon", await card.isVisible(), sid);
    const status = await answerOnSite(env, page, sid, "initial", "accept");
    results.check("accepting it: 204", status === 204, String(status));

    // 4. The Silicon is active, with the new Carbon as custodian.
    const decided = await accounts(env, ["silicon", "request", "status", requestId, "--json"], { home });
    results.check("`silicon-accounts silicon request status`: accepted", decided.json?.status === "accepted" && !!decided.json?.decided_at && obj(decided.json?.silicon).status === "active", said(decided));
    const waited = await accounts(env, ["silicon", "request", "status", requestId, "--wait", "--json"], { home, timeoutMs: 60_000 });
    results.check("`… --wait` on a decided request returns at once (exit 0)", waited.code === 0 && waited.json?.status === "accepted" && waited.ms < 15_000, said(waited));
    const login = await loginSilicon(env, home, sid, stk);
    const whoami = await accounts(env, ["whoami", "--json"], { home });
    results.check("the STK signs the Silicon in; its custodian is the new Carbon", login.code === 0 && obj(whoami.json?.custodian).id === me.id, `${said(login)} | custodian ${short(whoami.json?.custodian)}`);
    const decidedRow = await sql(env, `select status, coalesce(to_uuid, ''), coalesce(decided_by, '') from custodian_requests where id = '${requestId}'`);
    results.check("the request records who answered it (the Carbon behind the address)", decidedRow[0]?.[0] === "accepted" && decidedRow[0]?.[1] === me.uuid && decidedRow[0]?.[2] === me.uuid, short(decidedRow));
    const accepted = await waitSink(env, key, "silicon.custodian.accepted", event => dataOf(event).request_id === requestId);
    results.check("its webhook got silicon.custodian.accepted naming the new Carbon", obj(dataOf(accepted).custodian).id === me.id, short(accepted?.payload, 200));
    const history = await page.request.get(`${env.site}/v1/me/history?kind=custodian`);
    const titles = (((await history.json()) as Json).items as Json[] | undefined ?? []).map(item => str(item.title));
    results.check("the new Carbon's history: became the custodian", titles.includes(`Became the custodian of ${sid}`), short(titles));
    await page.goto(`${env.site}/silicons`);
    await page.getByRole("button", { name: new RegExp(`^Manage ${sid}`) }).waitFor({ timeout: 30_000 }).catch(() => undefined);
    await shot(env, page, "scli-later-02-accepted");
    results.check("the Silicon is in the new Carbon's list on the site", await page.getByRole("button", { name: new RegExp(`^Manage ${sid}`) }).isVisible());
    await context.close();
  },
};

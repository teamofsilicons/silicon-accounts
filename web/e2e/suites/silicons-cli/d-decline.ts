import type { Journey } from "../../context";
import { forgetRateLimits, shot, sleep, tag } from "../../lib";
import {
  accounts,
  answerOnSite,
  asCarbon,
  carbonContext,
  cliError,
  dataOf,
  freshDir,
  idAvailable,
  loginCarbon,
  loginSilicon,
  obj,
  requestStatus,
  said,
  selfCreate,
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
  name: "silicons-cli-decline",
  title: "the named Carbon declines (on the site, then with the CLI): --wait fails with custodian_declined, the Silicon is released and its si:id is free at once, its webhook hears silicon.custodian.declined",
  async run(ctx) {
    const { env, results, browser } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "decline");
    const sid = `si:declined-${t}`;
    const key = `scli-decline-${t}`;
    const home = freshDir();

    // 1. A self-created Silicon waits with --wait; the Carbon declines on the site.
    let created: Json | null = null;
    const running = accounts(env, ["silicon", "create", "--id", sid, "--custodian", carbon.id, "--webhook", sinkUrl(env, key), "--wait", "--timeout", "3m", "--json"], {
      home,
      timeoutMs: 240_000,
      onEvent: event => {
        if (event.event === "silicon_created") created = event;
      },
    });
    const event = await until(async () => created, 30_000, 100);
    const requestId = str(obj(event?.request).id);
    const token = str(event?.request_token);
    const stk = str(event?.stk);
    const uuid = str(obj(event?.silicon).uuid);
    await setSinkSecret(env, key, str(event?.webhook_secret));
    results.check("the Silicon created its account and waits (--wait)", !!requestId && obj(event?.silicon).status === "pending_custodian", short(event, 200));
    const context = await carbonContext(browser, carbon);
    const page = await context.newPage();
    results.watch(page, "scli-decline");
    await page.goto(`${env.site}/silicons`);
    await sleep(500);
    const status = await answerOnSite(env, page, sid, "initial", "decline");
    results.check("declining on the site (Decline, then confirm): 204", status === 204, String(status));
    await sleep(900);
    await shot(env, page, "scli-decline-01-declined");

    // 2. What the Silicon sees.
    const done = await running;
    const error = cliError(done);
    results.check("--wait ends with exit 1 and custodian_declined, saying the id is free again", done.code === 1 && error.code === "custodian_declined" && str(error.message).includes(`${sid} is free again`) && obj(error.details).status === "declined", said(done));
    const polled = await requestStatus(ctx, requestId, token);
    results.check("the request reads declined; the Silicon was released (no id, deleted)", polled.body.status === "declined" && obj(polled.body.silicon).id === null && obj(polled.body.silicon).status === "deleted" && !!polled.body.decided_at, short(polled.body));
    const free = await idAvailable(ctx, sid);
    results.check("its si:id is free at once (no 10-day hold for an account that never became active)", free.available === true, short(free));
    const login = await loginSilicon(env, freshDir(), sid, stk);
    results.check("its STK signs nothing in: exit 3, custodian_declined explaining the release", login.code === 3 && cliError(login).code === "custodian_declined", said(login));
    const declined = await waitSink(env, key, "silicon.custodian.declined", candidate => dataOf(candidate).request_id === requestId);
    const data = dataOf(declined);
    results.check("its webhook got silicon.custodian.declined (reason declined, released), signature verified", data.reason === "declined" && data.released === true && data.uuid === uuid && data.id === sid && data.custodian === carbon.id, short(declined?.payload, 260));
    const again = await asCarbon<Json>(env, carbon, "POST", `/v1/me/custodian-requests/${requestId}/accept`, {});
    results.check("the declined request can't be accepted afterwards (409 custodian_request_not_pending)", again.status === 409 && str(obj(obj(again.body).error).code) === "custodian_request_not_pending", `${again.status} ${short(again.body)}`);
    const history = await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?kind=custodian");
    const entry = ((obj(history.body).items ?? []) as Json[]).find(item => item.title === `Custodian request of ${sid} declined`);
    results.check("the Carbon's history: the request declined, the id released", str(entry?.detail) === `${sid} was released: the Silicon never became active`, short(entry));

    // 3. The same si:id again, at once; this time the Carbon declines with the CLI.
    const second = await selfCreate(ctx, { id: sid, display_name: `Declined again ${t}`, custodian: carbon.id });
    results.check("the released si:id can be taken again right away", second.status === 201 && second.id === sid && second.uuid !== uuid, `${second.status} ${short(second.body, 200)}`);
    const carbonHome = freshDir();
    const signedIn = await loginCarbon(env, carbonHome, carbon);
    results.check("the Carbon signs in to the CLI with an email code", signedIn.finish.code === 0 && signedIn.finish.json?.id === carbon.id, said(signedIn.finish));
    const listed = await accounts(env, ["custodian", "requests", "--json"], { home: carbonHome });
    const items = (listed.json?.items ?? []) as Json[];
    results.check("`accounts custodian requests --json` lists the new request", listed.code === 0 && items.some(item => item.id === second.requestId && obj(item.silicon).id === sid), said(listed));
    const declineCli = await accounts(env, ["custodian", "decline", second.requestId, "--json"], { home: carbonHome });
    results.check("`accounts custodian decline <id>`: declined", declineCli.code === 0 && declineCli.json?.declined === true, said(declineCli));
    const twice = await accounts(env, ["custodian", "decline", second.requestId, "--json"], { home: carbonHome });
    results.check("declining it twice: exit 5, custodian_request_not_pending", twice.code === 5 && cliError(twice).code === "custodian_request_not_pending", said(twice));
    const after = await requestStatus(ctx, second.requestId, second.requestToken);
    results.check("…and that Silicon was released too", after.body.status === "declined" && obj(after.body.silicon).status === "deleted", short(after.body));
    const empty = await accounts(env, ["custodian", "requests", "--json"], { home: carbonHome });
    results.check("nothing is waiting for the Carbon any more", ((empty.json?.items ?? []) as Json[]).length === 0, said(empty));
    const mine = await asCarbon<Json>(env, carbon, "GET", "/v1/me/silicons");
    results.check("the Carbon is custodian of neither", !((obj(mine.body).items ?? []) as Json[]).some(item => item.id === sid));
    await context.close();
  },
};

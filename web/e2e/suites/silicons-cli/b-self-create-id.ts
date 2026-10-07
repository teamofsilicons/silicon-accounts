import { statSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { forgetRateLimits, json, shot, sleep, tag } from "../../lib";
import {
  accounts,
  answerOnSite,
  asCarbon,
  carbonContext,
  dataOf,
  freshDir,
  idAvailable,
  loginSilicon,
  obj,
  requestRow,
  requestStatus,
  said,
  setSinkSecret,
  short,
  signUpCarbon,
  sinkInbox,
  sinkUrl,
  str,
  until,
  waitSink,
  type Json,
} from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-self-create-id",
  title: "a Silicon creates its own account with the CLI naming a custodian by c:id and holds with --wait: pending meanwhile (no sign-in, id held, request emailed), --wait returns once the Carbon accepts on the site, webhook events created → accepted",
  async run(ctx) {
    const { env, results, browser } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "wait");
    const sid = `si:wait-${t}`;
    const key = `scli-wait-${t}`;
    // A display name with a link in it: anyone can self-create and name anyone, so emails must never carry it.
    const lure = `Visit lure-${t}.example now`;
    const home = freshDir();

    // 1. `accounts silicon create --custodian c:… --wait`: the STK and the request are printed at once (stderr, JSON).
    let created: Json | null = null;
    const startedAt = Date.now();
    const running = accounts(env, ["silicon", "create", "--id", sid, "--display-name", lure, "--custodian", carbon.id, "--webhook", sinkUrl(env, key), "--wait", "--timeout", "3m", "--json"], {
      home,
      timeoutMs: 240_000,
      onEvent: event => {
        if (event.event === "silicon_created") created = event;
      },
    });
    const event = await until(async () => created, 30_000, 100);
    results.check("--wait prints the new Silicon at once (a silicon_created JSON line), before waiting", !!event, short(event));
    const request = obj(event?.request);
    const silicon = obj(event?.silicon);
    const requestId = str(request.id);
    const stk = str(event?.stk);
    results.check("…pending its custodian, the request names the c:id, the STK is generated (stk- + 12 hex)", silicon.status === "pending_custodian" && request.custodian === carbon.id && request.kind === "initial" && /^stk-[0-9a-f]{12}$/.test(stk), `${str(silicon.status)} ${str(request.custodian)} ${stk ? "stk-…" : "no stk"}`);
    const row = requestId ? await requestRow(env, requestId) : null;
    results.check("the request lasts exactly 14 days", row?.ttlSeconds === 14 * 24 * 3600 && row.status === "pending", short(row));
    const file = join(home, ".accounts", "requests", `${requestId}.json`);
    let mode = "";
    try {
      mode = (statSync(file).mode & 0o777).toString(8);
    } catch (error) {
      mode = String(error);
    }
    results.check("the request token is saved for later (requests/<id>.json, mode 600)", mode === "600", `${file}: ${mode}`);
    const secret = str(event?.webhook_secret);
    results.check("the webhook signing secret is printed once", secret.startsWith("whsec_"), secret ? "whsec_…" : "none");
    await setSinkSecret(env, key, secret);

    // 2. While it waits.
    const token = str(event?.request_token);
    const polled = await requestStatus(ctx, requestId, token);
    results.check("GET /v1/silicons/requests/{id} with the request token: pending", polled.status === 200 && polled.body.status === "pending" && polled.body.custodian === carbon.id && obj(polled.body.silicon).status === "pending_custodian", short(polled.body));
    const badToken = await requestStatus(ctx, requestId, "sarq_not-the-token");
    const noToken = await json<Json>(`${env.site}/v1/silicons/requests/${requestId}`);
    results.check("…another token gets 404, no token 401 (nobody else can watch the request)", badToken.status === 404 && noToken.status === 401 && obj(noToken.body.error).code === "request_token_required", `${badToken.status} ${noToken.status}`);
    const early = await loginSilicon(env, freshDir(), sid, stk);
    const earlyError = obj(early.json?.error);
    results.check("it can't sign in yet: exit 3, custodian_pending with the request to poll", early.code === 3 && earlyError.code === "custodian_pending" && obj(earlyError.details).request_id === requestId, said(early));
    const held = await idAvailable(ctx, sid);
    results.check("its si:id is held while it waits", held.available === false, short(held));
    const incoming = await asCarbon<Json>(env, carbon, "GET", "/v1/me/custodian-requests");
    const listed = ((obj(incoming.body).items ?? []) as Json[]).find(item => item.id === requestId);
    results.check("the Carbon sees the request (initial, the Silicon, addressed to its c:id)", listed?.kind === "initial" && obj(listed.silicon).id === sid && obj(listed.to).id === carbon.id, short(listed));
    const mail = await until(async () => {
      const box = await json<{ items?: Json[] }>(`${env.messaging}/_messages?to=${encodeURIComponent(carbon.email)}&limit=20`);
      return (box.body.items ?? []).find(message => str(message.subject).includes(sid)) ?? null;
    }, 15_000);
    results.check("the Carbon is emailed: '<si:id> asked you to be its custodian', with the site link", str(mail?.subject) === `${sid} asked you to be its custodian` && str(mail?.text).includes(`${env.site}/silicons`), short(mail?.subject));
    results.check("…naming the Silicon by its si:id only (its free-text display name never reaches the email)", !!mail && !`${str(mail.subject)} ${str(mail.text)} ${str(mail.html)}`.includes(`lure-${t}`), "");
    const createdHook = await waitSink(env, key, "silicon.created", candidate => dataOf(candidate).uuid === silicon.uuid);
    results.check("its webhook got silicon.created (pending, with the request), signature verified", dataOf(createdHook).status === "pending_custodian" && obj(dataOf(createdHook).request).id === requestId && createdHook?.payload.silicon === silicon.uuid, short(createdHook?.payload, 200));

    // 3. The Carbon accepts on the site; --wait returns and signs the Silicon in.
    const context = await carbonContext(browser, carbon);
    const page = await context.newPage();
    results.watch(page, "scli-wait");
    await page.goto(`${env.site}/silicons`);
    await sleep(500);
    await shot(env, page, "scli-wait-01-request");
    const acceptedAt = Date.now();
    const status = await answerOnSite(env, page, sid, "initial", "accept");
    results.check("accepting on the site: 204", status === 204, String(status));
    const done = await running;
    const waited = Date.now() - acceptedAt;
    results.metric("--wait returned after the accept", waited, "ms");
    results.metric("self-create to accepted (wall)", Date.now() - startedAt, "ms");
    results.check("--wait returns once the Carbon accepts: exit 0, final_status accepted, signed in", done.code === 0 && done.json?.final_status === "accepted" && done.json?.signed_in === true, said(done));
    results.check("…its JSON shows the request and the Silicon as they are now", obj(done.json?.request).status === "accepted" && obj(done.json?.silicon).status === "active", short({ request: done.json?.request, silicon: obj(done.json?.silicon).status }));
    const status1 = await accounts(env, ["login", "status", "--json"], { home });
    results.check("`accounts login status --json`: signed in as the Silicon", status1.code === 0 && status1.json?.authenticated === true && status1.json?.id === sid && status1.json?.kind === "silicon", said(status1));
    const whoami = await accounts(env, ["whoami", "--json"], { home });
    results.check("`accounts whoami`: active, custodian shown by its c:id", whoami.json?.status === "active" && obj(whoami.json?.custodian).id === carbon.id, said(whoami));
    const acceptedHook = await waitSink(env, key, "silicon.custodian.accepted", candidate => dataOf(candidate).request_id === requestId);
    results.check("its webhook got silicon.custodian.accepted naming the custodian", obj(dataOf(acceptedHook).custodian).id === carbon.id && obj(dataOf(acceptedHook).silicon).status === "active", short(acceptedHook?.payload, 200));
    await sleep(1200);
    await shot(env, page, "scli-wait-02-accepted");

    // 4. After the decision.
    const again = await asCarbon<Json>(env, carbon, "POST", `/v1/me/custodian-requests/${requestId}/accept`, {});
    const declineAfter = await asCarbon<Json>(env, carbon, "POST", `/v1/me/custodian-requests/${requestId}/decline`, {});
    results.check("accepting or declining it again: 409 custodian_request_not_pending", again.status === 409 && errorCode(again.body) === "custodian_request_not_pending" && declineAfter.status === 409, `${again.status} ${declineAfter.status}`);
    const decided = await requestStatus(ctx, requestId, token);
    results.check("the request reads accepted, with its decision time", decided.body.status === "accepted" && !!decided.body.decided_at, short(decided.body));
    const mine = await asCarbon<Json>(env, carbon, "GET", "/v1/me/silicons");
    results.check("it is now in the Carbon's Silicons, active", ((obj(mine.body).items ?? []) as Json[]).some(item => item.id === sid && item.status === "active"));
    const waiting = await asCarbon<Json>(env, carbon, "GET", "/v1/me/custodian-requests");
    results.check("…and no longer waiting for the Carbon", !((obj(waiting.body).items ?? []) as Json[]).some(item => item.id === requestId));
    const carbonHistory = await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?kind=custodian");
    const titles = ((obj(carbonHistory.body).items ?? []) as Json[]).map(item => str(item.title));
    results.check("the Carbon's history: asked, then became the custodian", titles.includes(`Became the custodian of ${sid}`) && titles.includes(`${sid} asked you to be its custodian`), short(titles));
    const siliconHistory = await accounts(env, ["history", "--json"], { home });
    const siliconItems = (siliconHistory.json?.items ?? []) as Json[];
    const siliconTitles = siliconItems.map(item => str(item.title));
    const own = siliconItems.find(item => item.title === `${sid} created its own account`);
    results.check("the Silicon's history: it created its own account naming the custodian, who accepted", siliconTitles.includes(`${carbon.id} accepted to be the custodian`) && str(own?.detail) === `Named ${carbon.id} as its custodian`, short(siliconItems.map(item => [item.title, item.detail])));
    const box = await sinkInbox(env, key);
    const unrecovered = box.rejected.filter(entry => entry.recovered !== true);
    results.check("every delivery to its webhook verified (the one sent before it knew its secret was recovered)", unrecovered.length === 0 && box.items.length >= 2, `${box.items.length} events, ${unrecovered.length} refused: ${short(unrecovered)}`);
    await context.close();
  },
};

function errorCode(body: unknown): string {
  return str(obj(obj(body).error).code);
}

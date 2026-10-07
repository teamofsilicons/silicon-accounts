import type { Journey } from "../../context";
import { forgetRateLimits, json, sql, tag } from "../../lib";
import {
  accounts,
  appInbox,
  appRefresh,
  appSltLogin,
  asAppForm,
  asCarbon,
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
  siliconLogin,
  sinkUrl,
  str,
  waitApp,
  waitSink,
  withToken,
  type Json,
} from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-rotate-stk",
  title: "the custodian rotates a Silicon's STK with the CLI: the old STK is dead, every sign-in (CLI sessions, app tokens, unused SLTs) is revoked, apps get membership.signed_out, the Silicon gets silicon.stk_rotated; a chosen STK; retries rotate once",
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "rotate");
    const homeC = freshDir();
    results.check("the custodian signs in to the CLI", (await loginCarbon(env, homeC, carbon)).finish.code === 0);
    const sid = `si:rotating-${t}`;
    const key = `scli-rotate-${t}`;
    const created = await accounts(env, ["silicon", "create", "--id", sid, "--webhook", sinkUrl(env, key), "--json"], { home: homeC });
    const uuid = str(obj(created.json?.silicon).uuid);
    const first = str(created.json?.stk);
    await setSinkSecret(env, key, str(created.json?.webhook_secret));
    results.check("the custodian creates the Silicon with the CLI (display name defaults from the id)", created.code === 0 && obj(created.json?.silicon).display_name === `Rotating ${t}`, said(created));

    // Every kind of sign-in the Silicon can have.
    const home1 = freshDir();
    const home2 = freshDir();
    const slt1 = await loginSilicon(env, home1, sid, first, ["--app", "remind"]);
    const login2 = await loginSilicon(env, home2, sid, first);
    const slt2 = await accounts(env, ["login", "--app", "briefcase", "--json"], { home: home2 });
    const unused = await accounts(env, ["login", "--app", "browser", "--json"], { home: home1 });
    const remind = await appSltLogin(env, "remind", str(slt1.json?.slt));
    const briefcase = await appSltLogin(env, "briefcase", str(slt2.json?.slt));
    const direct = await siliconLogin(ctx, sid, first);
    const directToken = str(direct.body.access_token);
    const remindTokens = obj(remind.body.tokens);
    results.check("before: two CLI sessions, remind and briefcase signed in, an unused SLT for browser, an API token", login2.code === 0 && remind.body.ok === true && briefcase.body.ok === true && str(unused.json?.slt).startsWith("slt_") && direct.status === 200, `${short(remind.body.error)} ${short(briefcase.body.error)} ${direct.status}`);
    const refreshBefore = await appRefresh(env, "remind", uuid);
    results.check("before: remind can refresh its tokens", refreshBefore.body.ok === true, short(refreshBefore.body));
    const familiesBefore = await sql(env, `select count(*) from token_families where account_uuid = '${uuid}' and revoked_at is null`);

    // 1. Rotate.
    const remindSeq = (await appInbox(env, "remind")).last_seq;
    const rotated = await accounts(env, ["silicon", "rotate-stk", sid, "--json"], { home: homeC });
    const second = str(rotated.json?.stk);
    results.check("`accounts silicon rotate-stk`: a new STK (stk- + 12 hex), printed once", rotated.code === 0 && /^stk-[0-9a-f]{12}$/.test(second) && second !== first && !!rotated.json?.rotated_at, said(rotated).replace(second, "stk-…"));
    const old = await loginSilicon(env, freshDir(), sid, first);
    results.check("the old STK no longer signs in (exit 3, invalid_credentials)", old.code === 3 && cliError(old).code === "invalid_credentials", said(old));
    const fresh = await loginSilicon(env, freshDir(), sid, second);
    results.check("the new STK does", fresh.code === 0 && fresh.json?.id === sid, said(fresh));
    const live = await sql(env, `select count(*) from token_families where account_uuid = '${uuid}' and revoked_at is null and created_at < (select stk_rotated_at from accounts where uuid = '${uuid}')`);
    const reasons = await sql(env, `select distinct revoke_reason from token_families where account_uuid = '${uuid}' and revoked_at is not null`);
    results.check("every sign-in from before the rotation is revoked (reason stk_rotated)", Number(familiesBefore[0]?.[0]) >= 4 && live[0]?.[0] === "0" && reasons.length === 1 && reasons[0]?.[0] === "stk_rotated", `${familiesBefore[0]?.[0]} live before, ${live[0]?.[0]} after, reasons ${short(reasons)}`);
    const status1 = await accounts(env, ["login", "status", "--json"], { home: home1 });
    results.check("a CLI session from before: `login status` says not authenticated (exit 1, session_ended)", status1.code === 1 && status1.json?.authenticated === false && status1.json?.reason === "session_ended", said(status1));
    const whoami2 = await accounts(env, ["whoami", "--json"], { home: home2 });
    results.check("another CLI session: `whoami` fails with session_ended (exit 3) and says why", whoami2.code === 3 && cliError(whoami2).code === "session_ended" && /STK was rotated/.test(str(cliError(whoami2).hint)), said(whoami2));
    const apiMe = await withToken(ctx, directToken, "GET", "/v1/me");
    results.check("an access token from before is refused at once (401)", apiMe.status === 401, `${apiMe.status} ${short(apiMe.body)}`);
    for (const app of ["remind", "briefcase"]) {
      const event = await waitApp(env, app, "membership.signed_out", candidate => dataOf(candidate).uuid === uuid);
      results.check(`${app} got membership.signed_out (reason stk_rotated), signature verified`, dataOf(event).reason === "stk_rotated" && dataOf(event).membership_id === `${app}:${uuid}`, short(event?.payload, 220));
    }
    const remindEvents = (await appInbox(env, "remind")).items.filter(event => event.seq > remindSeq && dataOf(event).uuid === uuid && event.type === "membership.signed_out");
    results.check("…exactly once per app", remindEvents.length === 1, `${remindEvents.length}`);
    const browserEvents = (await appInbox(env, "browser")).items.filter(event => dataOf(event).uuid === uuid);
    results.check("an app it never signed into (only an SLT was minted) hears nothing", browserEvents.length === 0, `${browserEvents.length}`);
    const refreshAfter = await appRefresh(env, "remind", uuid);
    results.check("remind's refresh token is dead (invalid_grant)", refreshAfter.body.ok === false && str(obj(refreshAfter.body.error).error) === "invalid_grant", short(refreshAfter.body));
    const introspected = await asAppForm(ctx, "remind", "/v1/oauth/introspect", { token: str(remindTokens.access_token) });
    results.check("remind's access token introspects as inactive", introspected.status === 200 && introspected.body.active === false, short(introspected.body));
    const late = await appSltLogin(env, "browser", str(unused.json?.slt));
    results.check("an SLT minted before the rotation can't be exchanged after it", late.body.ok !== true && late.status >= 400, short(late.body));
    const hook = await waitSink(env, key, "silicon.stk_rotated", event => dataOf(event).uuid === uuid);
    results.check("the Silicon's webhook got silicon.stk_rotated (when, and by its custodian)", obj(dataOf(hook).rotated_by).id === carbon.id && !!dataOf(hook).rotated_at && !JSON.stringify(hook?.payload).includes(second), short(hook?.payload, 220));

    // 2. A chosen STK (stdin): never echoed, and it replaces the generated one.
    const chosen = `stk-${"9f".repeat(16)}`;
    const own = await accounts(env, ["silicon", "rotate-stk", sid, "--stk-stdin", "--json"], { home: homeC, stdin: `${chosen}\n` });
    results.check("`rotate-stk --stk-stdin` with 32 hex: done, nothing echoed", own.code === 0 && own.json?.stk === null && !own.stdout.includes(chosen), said(own));
    const withChosen = await loginSilicon(env, freshDir(), sid, chosen);
    const withSecond = await loginSilicon(env, freshDir(), sid, second);
    results.check("the chosen STK signs in, the generated one is dead", withChosen.code === 0 && withSecond.code === 3, `${withChosen.code}/${withSecond.code}`);

    // 3. A retried rotation (same Idempotency-Key) rotates once and returns the same STK.
    const keyHeader = `scli-rotate-retry-${t}`;
    const retry = async () =>
      json<Json>(`${env.site}/v1/me/silicons/${uuid}/stk`, {
        method: "POST",
        headers: { cookie: `sa_session=${carbon.session}`, origin: env.site, "content-type": "application/json", "idempotency-key": keyHeader, "x-forwarded-for": carbon.ip },
        body: "{}",
      });
    const r1 = await retry();
    const stampedOnce = await sql(env, `select stk_rotated_at from accounts where uuid = '${uuid}'`);
    const r2 = await retry();
    const stampedTwice = await sql(env, `select stk_rotated_at from accounts where uuid = '${uuid}'`);
    results.check("a retried rotation with the same Idempotency-Key returns the same STK and rotates once", r1.status === 200 && r2.status === 200 && str(r1.body.stk) === str(r2.body.stk) && /^stk-[0-9a-f]{12}$/.test(str(r1.body.stk)) && stampedOnce[0]?.[0] === stampedTwice[0]?.[0], `${r1.status}/${r2.status}, ${stampedOnce[0]?.[0]} → ${stampedTwice[0]?.[0]}`);

    // 4. Only its custodian can rotate it.
    const stranger = await signUpCarbon(env, "rotate-stranger");
    const foreign = await asCarbon<Json>(env, stranger, "POST", `/v1/me/silicons/${uuid}/stk`, {});
    results.check("another Carbon can't rotate it (404 silicon_not_found)", foreign.status === 404 && str(obj(obj(foreign.body).error).code) === "silicon_not_found", `${foreign.status}`);
    const homeS = freshDir();
    await loginSilicon(env, homeS, sid, str(r1.body.stk));
    const asSilicon = await accounts(env, ["silicon", "rotate-stk", sid, "--json"], { home: homeS });
    results.check("a Silicon can't rotate its own STK (custodian only: exit 3, wrong_account_kind)", asSilicon.code === 3 && cliError(asSilicon).code === "wrong_account_kind", said(asSilicon));
    const history = await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?kind=security");
    const rotations = ((obj(history.body).items ?? []) as Json[]).filter(item => item.title === `STK of ${sid} rotated`);
    results.check("the custodian's history lists each rotation", rotations.length === 3, `${rotations.length} rotations`);
  },
};

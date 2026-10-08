import type { Journey } from "../../context";
import { forgetRateLimits, tag } from "../../lib";
import {
  accounts,
  appSltLogin,
  asCarbon,
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
  waitApp,
  waitSink,
  type Json,
} from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-custodian-gone",
  title: "custodians leaving: a Carbon who deletes their account before answering releases the Silicon that named it (silicon.custodian.declined, reason custodian_account_deleted); a custodian deletes its Silicon with the CLI (apps get account.deleted, it can't sign in, its id is held), and only then can delete its own account",
  // No browser: the CLI and the API only, so the engine changes nothing (the browser journeys run in WebKit too).
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();

    // 1. The named Carbon deletes its account before answering.
    const named = await signUpCarbon(env, "leaving");
    const key = `scli-gone-${t}`;
    const waiting = await selfCreate(ctx, { id: `si:orphan-${t}`, display_name: "Orphan", custodian: named.id, webhook_url: sinkUrl(env, key) });
    await setSinkSecret(env, key, waiting.webhookSecret);
    const deleted = await asCarbon<Json>(env, named, "DELETE", "/v1/me", { confirm: named.id });
    results.check("the named Carbon deletes its account (nothing in its custody yet)", deleted.status === 200 || deleted.status === 204, `${deleted.status} ${short(deleted.body)}`);
    const hook = await waitSink(env, key, "silicon.custodian.declined", event => dataOf(event).request_id === waiting.requestId);
    results.check("the waiting Silicon hears silicon.custodian.declined, reason custodian_account_deleted, released", dataOf(hook).reason === "custodian_account_deleted" && dataOf(hook).released === true && dataOf(hook).custodian === named.id, short(hook?.payload, 240));
    const status = await requestStatus(ctx, waiting.requestId, waiting.requestToken);
    results.check("its request reads cancelled; the Silicon was released", status.body.status === "cancelled" && obj(status.body.silicon).status === "deleted" && obj(status.body.silicon).id === null, short(status.body));
    const login = await loginSilicon(env, freshDir(), `si:orphan-${t}`, waiting.stk);
    results.check("its STK: exit 3, custodian_declined, saying the Carbon deleted their account before accepting", login.code === 3 && cliError(login).code === "custodian_declined" && /deleted their account before accepting/.test(str(cliError(login).message)), said(login));
    results.check("its si:id is free again", (await idAvailable(ctx, `si:orphan-${t}`)).available === true);
    const renamed = await selfCreate(ctx, { id: `si:orphan2-${t}`, display_name: "Orphan", custodian: named.id });
    results.check("a deleted Carbon's c:id can't be named any more (404 custodian_not_found)", renamed.status === 404 && str(obj(renamed.body.error).code) === "custodian_not_found", `${renamed.status}`);

    // 2. A custodian deletes its Silicon with the CLI.
    const keeper = await signUpCarbon(env, "keeper");
    const homeK = freshDir();
    await loginCarbon(env, homeK, keeper);
    const sid = `si:doomed-${t}`;
    const created = await accounts(env, ["silicon", "create", "--id", sid, "--json"], { home: homeK });
    const uuid = str(obj(created.json?.silicon).uuid);
    const stk = str(created.json?.stk);
    const homeS = freshDir();
    const remind = await appSltLogin(env, "remind", str((await loginSilicon(env, homeS, sid, stk, ["--app", "remind"])).json?.slt));
    const briefcase = await appSltLogin(env, "briefcase", str((await accounts(env, ["login", "--app", "briefcase", "--json"], { home: homeS })).json?.slt));
    results.check("the Silicon is signed into remind and briefcase", remind.body.ok === true && briefcase.body.ok === true);
    const blocked = await accounts(env, ["delete-account", "--confirm", keeper.id, "--json"], { home: homeK });
    results.check("its custodian can't delete its own account while custodian (exit 5, custodian_of_silicons naming it)", blocked.code === 5 && cliError(blocked).code === "custodian_of_silicons" && JSON.stringify(cliError(blocked).details).includes(sid), said(blocked));
    const noConfirm = await accounts(env, ["silicon", "delete", sid, "--json"], { home: homeK });
    results.check("`silicon-accounts silicon delete` without --confirm (no terminal): exit 2, says what to pass", noConfirm.code === 2 && str(cliError(noConfirm).message).includes(`--confirm ${sid}`), said(noConfirm));
    const wrong = await accounts(env, ["silicon", "delete", sid, "--confirm", `si:other-${t}`, "--json"], { home: homeK });
    results.check("…with the wrong id: exit 2, nothing deleted", wrong.code === 2 && (await accounts(env, ["silicon", "show", sid, "--json"], { home: homeK })).code === 0, said(wrong));
    const gone = await accounts(env, ["silicon", "delete", sid, "--confirm", sid, "--json"], { home: homeK });
    results.check("`silicon-accounts silicon delete <si> --confirm <si>`: deleted", gone.code === 0 && gone.json?.deleted === true, said(gone));
    for (const app of ["remind", "briefcase"]) {
      const event = await waitApp(env, app, "account.deleted", candidate => dataOf(candidate).uuid === uuid);
      results.check(`${app} got account.deleted (its membership id), signature verified`, dataOf(event).membership_id === `${app}:${uuid}`, short(event?.payload, 200));
    }
    const statusS = await accounts(env, ["login", "status", "--json"], { home: homeS });
    results.check("the Silicon's CLI session has ended", statusS.code === 1 && statusS.json?.authenticated === false, said(statusS));
    const loginS = await loginSilicon(env, freshDir(), sid, stk);
    results.check("its STK: exit 3, account_deleted (says the account was deleted)", loginS.code === 3 && cliError(loginS).code === "account_deleted", said(loginS));
    const held = await idAvailable(ctx, sid);
    results.check("its si:id is held for 10 days (reserved)", held.available === false && held.reason === "reserved", short(held));
    const list = await accounts(env, ["silicon", "list", "--json"], { home: homeK });
    results.check("it is gone from the custodian's list", list.code === 0 && !((list.json?.items ?? []) as Json[]).some(item => item.id === sid), said(list));
    const history = await asCarbon<Json>(env, keeper, "GET", "/v1/me/history");
    results.check("the custodian's history records the deletion", ((obj(history.body).items ?? []) as Json[]).some(item => item.title === `Silicon ${sid} deleted`), short(((obj(history.body).items ?? []) as Json[]).map(item => item.title)));
    const leave = await accounts(env, ["delete-account", "--confirm", keeper.id, "--json"], { home: homeK });
    results.check("with no Silicon left in its care, the custodian can delete its own account", leave.code === 0, said(leave));
    const after = await accounts(env, ["whoami", "--json"], { home: homeK });
    results.check("…and its CLI is signed out (exit 3)", after.code === 3, said(after));
  },
};

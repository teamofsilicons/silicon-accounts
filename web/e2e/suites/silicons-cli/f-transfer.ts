import type { Journey } from "../../context";
import { forgetRateLimits, json, shot, sleep, sql, tag } from "../../lib";
import {
  accounts,
  answerOnSite,
  appInbox,
  appSltLogin,
  asCarbon,
  carbonContext,
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
  sinkUrl,
  str,
  until,
  waitApp,
  waitSink,
  type Json,
} from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-transfer",
  title: "a custodian transfers a Silicon with the CLI: refusals (self, a Silicon, unknown, not yours, one at a time), cancel, decline, then accept on the site: custody moves, apps and the Silicon are told, every step is in the histories; transfers expire after 14 days; a transfer accepted with `accounts custodian accept` moves it back",
  async run(ctx) {
    const { env, results, browser } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const from = await signUpCarbon(env, "from");
    const to = await signUpCarbon(env, "to");
    const homeFrom = freshDir();
    const homeTo = freshDir();
    results.check("both Carbons sign in to the CLI with email codes", (await loginCarbon(env, homeFrom, from)).finish.code === 0 && (await loginCarbon(env, homeTo, to)).finish.code === 0);
    const sid = `si:moving-${t}`;
    const key = `scli-transfer-${t}`;

    // The Silicon, created with the CLI by its first custodian, signs into remind and briefcase.
    const created = await accounts(env, ["silicon", "create", "--id", sid, "--display-name", `Moving ${t}`, "--webhook", sinkUrl(env, key), "--json"], { home: homeFrom });
    const uuid = str(obj(created.json?.silicon).uuid);
    const stk = str(created.json?.stk);
    results.check("`accounts silicon create` as a Carbon: active at once, custodian = the Carbon, STK printed once", created.code === 0 && obj(created.json?.silicon).status === "active" && obj(obj(created.json?.silicon).custodian).id === from.id && /^stk-[0-9a-f]{12}$/.test(stk), said(created));
    await setSinkSecret(env, key, str(created.json?.webhook_secret));
    const homeS = freshDir();
    const remindSlt = await loginSilicon(env, homeS, sid, stk, ["--app", "remind"]);
    const briefcaseSlt = await accounts(env, ["login", "--app", "briefcase", "--json"], { home: homeS });
    const remind = await appSltLogin(env, "remind", str(remindSlt.json?.slt));
    const briefcase = await appSltLogin(env, "briefcase", str(briefcaseSlt.json?.slt));
    results.check("the Silicon signs into remind and briefcase with short-lived tokens", remind.body.ok === true && briefcase.body.ok === true && remind.body.uuid === uuid, `${short(remind.body.error ?? remind.body.id)} / ${short(briefcase.body.error ?? briefcase.body.id)}`);

    // Refusals.
    const self = await accounts(env, ["silicon", "transfer", sid, "--to", from.id, "--json"], { home: homeFrom });
    results.check("to yourself: exit 2, transfer_to_self", self.code === 2 && cliError(self).code === "transfer_to_self", said(self));
    const selfByEmail = await accounts(env, ["silicon", "transfer", sid, "--to", from.email.toUpperCase(), "--json"], { home: homeFrom });
    results.check("…also when named by your own email", selfByEmail.code === 2 && cliError(selfByEmail).code === "transfer_to_self", said(selfByEmail));
    const toSilicon = await accounts(env, ["silicon", "transfer", sid, "--to", sid, "--json"], { home: homeFrom });
    results.check("to a Silicon: exit 2, invalid (only a Carbon can be a custodian)", toSilicon.code === 2 && /Carbon/.test(JSON.stringify(cliError(toSilicon))), said(toSilicon));
    const unknown = await accounts(env, ["silicon", "transfer", sid, "--to", `c:nobody-${t}`, "--json"], { home: homeFrom });
    results.check("to an unknown c:id: exit 4, custodian_not_found", unknown.code === 4 && cliError(unknown).code === "custodian_not_found", said(unknown));
    const notMine = await accounts(env, ["silicon", "transfer", sid, "--to", from.id, "--json"], { home: homeTo });
    results.check("by a Carbon who isn't its custodian: exit 4, not one of your Silicons", notMine.code === 4, said(notMine));
    const notMineApi = await asCarbon<Json>(env, to, "POST", `/v1/me/silicons/${uuid}/transfer`, { to: to.id });
    results.check("…and the API answers 404 silicon_not_found (another Carbon's Silicon is not revealed)", notMineApi.status === 404 && str(obj(obj(notMineApi.body).error).code) === "silicon_not_found", `${notMineApi.status}`);

    // 1. Transfer, then cancel.
    const first = await accounts(env, ["silicon", "transfer", sid, "--to", to.id, "--json"], { home: homeFrom });
    const firstId = str(first.json?.id);
    results.check("`accounts silicon transfer --to c:…`: a pending transfer request, 14 days", first.code === 0 && first.json?.kind === "transfer" && first.json?.status === "pending" && obj(first.json?.to).id === to.id && obj(first.json?.from).id === from.id, said(first));
    const mail = await until(async () => {
      const box = await json<{ items?: Json[] }>(`${env.messaging}/_messages?to=${encodeURIComponent(to.email)}&limit=10`);
      return (box.body.items ?? []).find(message => str(message.subject) === `${from.id} wants to transfer ${sid} to you`) ?? null;
    }, 15_000);
    results.check("the receiving Carbon is emailed ('<c:id> wants to transfer <si:id> to you')", !!mail && str(mail.text).includes(`${env.site}/silicons`), short(mail?.subject));
    const shown = await accounts(env, ["silicon", "show", sid, "--json"], { home: homeFrom });
    results.check("`accounts silicon show`: pending_transfer to the Carbon", obj(obj(shown.json?.pending_transfer).to).id === to.id && obj(shown.json?.pending_transfer).id === firstId, said(shown));
    const offered = await accounts(env, ["custodian", "requests", "--json"], { home: homeTo });
    results.check("the receiving Carbon sees it (`accounts custodian requests`: transfer, from the custodian)", ((offered.json?.items ?? []) as Json[]).some(item => item.id === firstId && item.kind === "transfer" && obj(item.from).id === from.id), said(offered));
    const twice = await accounts(env, ["silicon", "transfer", sid, "--to", to.id, "--json"], { home: homeFrom });
    results.check("one transfer at a time: exit 5, transfer_pending naming the pending request", twice.code === 5 && cliError(twice).code === "transfer_pending" && obj(cliError(twice).details).request_id === firstId, said(twice));
    const cancel = await accounts(env, ["silicon", "cancel-transfer", sid, "--json"], { home: homeFrom });
    results.check("`accounts silicon cancel-transfer`: cancelled", cancel.code === 0 && cancel.json?.cancelled === true, said(cancel));
    const gone = await accounts(env, ["custodian", "requests", "--json"], { home: homeTo });
    results.check("…it is gone from the receiving Carbon's requests", !((gone.json?.items ?? []) as Json[]).some(item => item.id === firstId), said(gone));
    const lateAccept = await accounts(env, ["custodian", "accept", firstId, "--json"], { home: homeTo });
    results.check("…and accepting the cancelled request fails (exit 5, not pending)", lateAccept.code === 5 && cliError(lateAccept).code === "custodian_request_not_pending", said(lateAccept));
    const cancelAgain = await accounts(env, ["silicon", "cancel-transfer", sid, "--json"], { home: homeFrom });
    results.check("cancelling with nothing pending: exit 4, transfer_not_found", cancelAgain.code === 4 && cliError(cancelAgain).code === "transfer_not_found", said(cancelAgain));

    // 2. Transfer, then the receiving Carbon declines: nothing changes.
    const second = await accounts(env, ["silicon", "transfer", sid, "--to", to.email, "--json"], { home: homeFrom });
    const secondId = str(second.json?.id);
    results.check("a transfer named by the Carbon's email", second.code === 0 && obj(second.json?.to).email === to.email, said(second));
    const declined = await accounts(env, ["custodian", "decline", secondId, "--json"], { home: homeTo });
    results.check("`accounts custodian decline`: declined", declined.code === 0 && declined.json?.declined === true, said(declined));
    const stillFrom = await accounts(env, ["whoami", "--json"], { home: homeS });
    results.check("after a declined transfer nothing changed: the custodian is still the first Carbon", obj(stillFrom.json?.custodian).id === from.id, said(stillFrom));
    const quiet = [...(await appInbox(env, "remind")).items, ...(await appInbox(env, "briefcase")).items].filter(event => event.type === "silicon.custodian_changed" && dataOf(event).uuid === uuid);
    results.check("…and no app heard of a custodian change", quiet.length === 0, `${quiet.length} events`);

    // 3. Transfer, accepted on the site.
    const third = await accounts(env, ["silicon", "transfer", sid, "--to", to.id, "--json"], { home: homeFrom });
    const thirdId = str(third.json?.id);
    const context = await carbonContext(browser, to);
    const page = await context.newPage();
    results.watch(page, "scli-transfer");
    await page.goto(`${env.site}/silicons`);
    await sleep(600);
    await shot(env, page, "scli-transfer-01-offered");
    const acceptedAt = Date.now();
    const status = await answerOnSite(env, page, sid, "transfer", "accept");
    results.check("the receiving Carbon accepts the transfer on the site: 204", status === 204 && third.code === 0, `${status} ${said(third)}`);
    const nowTo = await accounts(env, ["whoami", "--json"], { home: homeS });
    results.check("the Silicon's custodian is now the receiving Carbon", obj(nowTo.json?.custodian).id === to.id && obj(nowTo.json?.custodian).uuid === to.uuid, said(nowTo));
    const fromLost = await accounts(env, ["silicon", "show", sid, "--json"], { home: homeFrom });
    const fromLostApi = await asCarbon<Json>(env, from, "GET", `/v1/me/silicons/${uuid}`);
    results.check("the former custodian can't manage it any more (CLI exit 4, API 404)", fromLost.code === 4 && fromLostApi.status === 404, `${said(fromLost)} | ${fromLostApi.status}`);
    const toList = await accounts(env, ["silicon", "list", "--json"], { home: homeTo });
    const listed = ((toList.json?.items ?? []) as Json[]).find(item => item.id === sid);
    results.check("it is in the new custodian's list, active, nothing pending", listed?.status === "active" && !listed.pending_transfer && obj(listed.custodian).id === to.id, short({ status: listed?.status, pending_transfer: listed?.pending_transfer, custodian: obj(listed?.custodian).id }));
    for (const app of ["remind", "briefcase"]) {
      const event = await waitApp(env, app, "silicon.custodian_changed", candidate => dataOf(candidate).uuid === uuid);
      const data = dataOf(event);
      results.check(`${app} got silicon.custodian_changed (from → to, its membership id), signature verified`, obj(data.from).id === from.id && obj(data.to).id === to.id && data.membership_id === `${app}:${uuid}` && event?.payload.app_id === app, short(event?.payload, 240));
    }
    results.metric("accept → apps notified", Date.now() - acceptedAt, "ms");
    const own = await waitSink(env, key, "silicon.custodian.changed", event => dataOf(event).uuid === uuid);
    results.check("the Silicon's webhook got silicon.custodian.changed (from → to)", obj(dataOf(own).from).id === from.id && obj(dataOf(own).to).id === to.id, short(own?.payload, 240));
    const refused = [...(await appInbox(env, "remind")).rejected, ...(await appInbox(env, "briefcase")).rejected].filter(entry => entry.recovered !== true);
    results.check("no delivery to the apps was refused by their signature check", refused.length === 0, short(refused));

    // History: who it moved from, to, and when.
    const custody = await sql(env, `select kind, coalesce(from_uuid, ''), to_uuid, coalesce(request_id::text, '') from custodian_history where silicon_uuid = '${uuid}' order by id`);
    results.check("custodian_history: created by the first Carbon, then transferred to the second (with the request)", custody.length === 2 && custody[0]?.[0] === "created_by_custodian" && custody[0]?.[2] === from.uuid && custody[1]?.[0] === "transfer" && custody[1]?.[1] === from.uuid && custody[1]?.[2] === to.uuid && custody[1]?.[3] === thirdId, short(custody));
    const siliconHistory = await accounts(env, ["history", "--kind", "custodian", "--json"], { home: homeS });
    const siliconTitles = ((siliconHistory.json?.items ?? []) as Json[]).map(item => str(item.title));
    results.check("the Silicon's history: the change, each request, the cancel and the decline", siliconTitles.includes(`Custodian changed from ${from.id} to ${to.id}`) && siliconTitles.filter(title => title.startsWith(`Transfer of ${sid}`) && title.endsWith("requested")).length === 3 && siliconTitles.includes(`Transfer of ${sid} cancelled`) && siliconTitles.includes(`Transfer of ${sid} declined`), short(siliconTitles));
    const fromHistory = await accounts(env, ["history", "--kind", "custodian", "--json"], { home: homeFrom });
    results.check("the former custodian's history: transferred it to the new one", ((fromHistory.json?.items ?? []) as Json[]).some(item => item.title === `Transferred ${sid} to ${to.id}`), short(((fromHistory.json?.items ?? []) as Json[]).map(item => item.title)));
    const toHistory = await accounts(env, ["history", "--kind", "custodian", "--json"], { home: homeTo });
    const change = ((toHistory.json?.items ?? []) as Json[]).find(item => item.title === `Became the custodian of ${sid} (transferred from ${from.id})`);
    results.check("the new custodian's history: became the custodian, transferred from the old one, with when", !!change && !!change.at && obj(obj(change.meta).from).id === from.id, short(change));

    // 4. The new custodian names an email nobody has yet, then cancels; then a transfer that expires.
    const invitee = `scli.invitee.${t}@example.test`;
    const invite = await accounts(env, ["silicon", "transfer", sid, "--to", invitee, "--json"], { home: homeTo });
    const inviteMail = await until(async () => {
      const box = await json<{ items?: Json[] }>(`${env.messaging}/_messages?to=${encodeURIComponent(invitee)}&limit=5`);
      return (box.body.items ?? [])[0] ?? null;
    }, 15_000);
    results.check("a transfer to an email with no account: pending, and the address is told to sign up", invite.code === 0 && obj(invite.json?.to).email === invitee && str(inviteMail?.text).includes(`sign up at ${env.site}`), `${said(invite)} | ${short(inviteMail?.subject)}`);
    await accounts(env, ["silicon", "cancel-transfer", sid, "--json"], { home: homeTo });
    const back = await accounts(env, ["silicon", "transfer", sid, "--to", from.id, "--json"], { home: homeTo });
    const backId = str(back.json?.id);
    await sql(env, `update custodian_requests set expires_at = now() - interval '1 second' where id = '${backId}'`);
    const expiredList = await accounts(env, ["custodian", "requests", "--json"], { home: homeFrom });
    results.check("a transfer past its 14 days is no longer offered", back.code === 0 && !((expiredList.json?.items ?? []) as Json[]).some(item => item.id === backId), said(expiredList));
    const expiredAccept = await accounts(env, ["custodian", "accept", backId, "--json"], { home: homeFrom });
    results.check("…accepting it: exit 2, custodian_request_expired (410)", expiredAccept.code === 2 && cliError(expiredAccept).code === "custodian_request_expired", said(expiredAccept));
    const unchanged = await accounts(env, ["whoami", "--json"], { home: homeS });
    results.check("…and the Silicon stays with its custodian", obj(unchanged.json?.custodian).id === to.id, said(unchanged));
    const anew = await accounts(env, ["silicon", "transfer", sid, "--to", from.id, "--json"], { home: homeTo });
    const anewId = str(anew.json?.id);
    results.check("a new transfer can be sent after the expired one", anew.code === 0 && anew.json?.status === "pending", said(anew));

    // A custodian can't delete their account while a Silicon is in their care (a transfer pending changes nothing).
    const deletion = await accounts(env, ["delete-account", "--confirm", to.id, "--json"], { home: homeTo });
    results.check("the custodian can't delete their account while custodian (exit 5, custodian_of_silicons)", deletion.code === 5 && cliError(deletion).code === "custodian_of_silicons", said(deletion));
    const alive = await asCarbon<Json>(env, to, "GET", "/v1/me");
    results.check("…the account is still there", alive.status === 200 && obj(alive.body).status === "active");

    // 5. This time the receiving Carbon accepts with the CLI (`accounts custodian accept`): custody moves back.
    const backAt = Date.now();
    const acceptedCli = await accounts(env, ["custodian", "accept", anewId, "--json"], { home: homeFrom });
    const backTo = await accounts(env, ["whoami", "--json"], { home: homeS });
    results.check("`accounts custodian accept <transfer id>`: accepted, and the Silicon's custodian is the first Carbon again", acceptedCli.code === 0 && obj(backTo.json?.custodian).id === from.id, `${said(acceptedCli)} | custodian ${short(backTo.json?.custodian)}`);
    const backHook = await waitSink(env, key, "silicon.custodian.changed", event => dataOf(event).uuid === uuid && obj(dataOf(event).to).id === from.id);
    results.check("…the Silicon's webhook got silicon.custodian.changed (to → from)", obj(dataOf(backHook).from).id === to.id, short(backHook?.payload, 240));
    for (const app of ["remind", "briefcase"]) {
      const event = await waitApp(env, app, "silicon.custodian_changed", candidate => dataOf(candidate).uuid === uuid && obj(dataOf(candidate).to).id === from.id);
      results.check(`…${app} got silicon.custodian_changed again (to → from)`, obj(dataOf(event).from).id === to.id, short(event?.payload, 200));
    }
    results.metric("CLI accept → apps notified", Date.now() - backAt, "ms");
    const custodyRows = await sql(env, `select kind, coalesce(from_uuid, ''), to_uuid from custodian_history where silicon_uuid = '${uuid}' order by id`);
    results.check("custodian_history now has the second transfer too: from the second Carbon back to the first", custodyRows.length === 3 && custodyRows[2]?.[0] === "transfer" && custodyRows[2]?.[1] === to.uuid && custodyRows[2]?.[2] === from.uuid, short(custodyRows));
    // (Its browser closes first: a page of a deleted account's session would only see 401s.)
    await context.close();
    const freed = await accounts(env, ["delete-account", "--confirm", to.id, "--json"], { home: homeTo });
    results.check("…and the second Carbon, custodian of nothing now, can delete its account", freed.code === 0, said(freed));
  },
};

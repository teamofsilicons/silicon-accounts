/**
 * Deleting a Carbon's account on Settings. Blocked while the Carbon is custodian of a Silicon (every Silicon always
 * has exactly one): deleting one Silicon or starting a transfer doesn't unblock it, only the last Silicon leaving does.
 * When it goes: every app with access is told (signed), its sessions, tokens and proofs end at once, its emails are
 * free, its c:id stays reserved 10 days (free after, time travel), a Silicon still waiting for it is released, and
 * the same email later signs up a brand-new account (a uuid is never reused).
 */
import type { Journey } from "../../context";
import { api, codeFor, developerApi, json, lastSeq, newContext, postJson, shot, signInOnDeveloper, signInOnSite, sleep, sql, tag } from "../../lib";
import { DEVELOPER_SESSION_ENDED, appAuth, appRefresh, appUserinfo, call, codeOf, deliveredAfter, getMe, hold, inbox, messageOf, newCarbon, probePage, queuedEvents, requestSent, signInAgain, signIntoApp, timelineRows, until, waitEvent } from "./_helpers";

interface Created {
  silicon?: { uuid: string; id: string };
}

const blocked: Journey = {
  name: "account-site-delete-blocked",
  title: "deleting the account is blocked while custodian of a Silicon: Settings explains and lists them, the hold does nothing, the API answers 409 with the Silicons; deleting one or starting a transfer doesn't unblock it; once the other Carbon accepts, it does",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const keeper = await newCarbon(ctx, "acct-keeper");
    const heir = await newCarbon(ctx, "acct-heir");
    const make = (id: string, name: string) => call<Created>(keeper.probe, "/v1/me/silicons", { method: "POST", json: { id, display_name: name } });
    const a = await make(`si:keep-a-${t}`, `Keep A ${t}`);
    const b = await make(`si:keep-b-${t}`, `Keep B ${t}`);
    const sa = a.body.silicon;
    const sb = b.body.silicon;
    results.check("setup: the Carbon created two Silicons (custodian of both)", a.status === 201 && b.status === 201 && (await getMe(keeper.probe)).custodian_of === 2, `${a.status} ${b.status}`);

    await keeper.page.goto(`${env.site}/`);
    const glance = keeper.page.getByRole("complementary", { name: "At a glance" });
    const glanceText = await until(async () => (await glance.innerText().catch(() => "")).replace(/\s+/g, " "), value => /(\d+) ?Silicons in your care/.test(value), 15_000);
    results.check("the identity page counts 2 Silicons in your care", /(^|\D)2 ?Silicons in your care/.test(glanceText), glanceText.slice(0, 200));
    const cookie = (await keeper.context.cookies(env.site)).map(entry => `${entry.name}=${entry.value}`).join("; ");
    const csrf = await api(ctx, "/v1/me", { method: "DELETE", json: { confirm: keeper.id }, headers: { cookie, origin: "http://evil.example" } });
    results.check("a deletion with the session cookie from a foreign Origin is refused (403 origin_not_allowed)", csrf.status === 403 && codeOf(csrf.body) === "origin_not_allowed" && (await getMe(keeper.probe)).status === "active", `${csrf.status} ${codeOf(csrf.body)}`);
    const section = keeper.page.getByRole("region", { name: "Delete your account" });
    const holdButton = keeper.page.getByRole("button", { name: "Hold to delete your account" });
    await keeper.page.goto(`${env.site}/settings`);
    await section.getByText(/You look after/).waitFor({ timeout: 30_000 });
    await sleep(800);
    await shot(env, keeper.page, "acct-delete-01-blocked", true);
    const text = (await section.innerText()).replace(/\s+/g, " ");
    results.check("Settings says why it can't be deleted yet", text.includes("You look after 2 Silicons. Every Silicon always has exactly one custodian, so hand each one to another Carbon, or delete it, before you delete your account."), text.slice(0, 260));
    results.check("…lists both Silicons with their ids", text.includes(`Keep A ${t}`) && text.includes(sa?.id ?? "?") && text.includes(`Keep B ${t}`) && text.includes(sb?.id ?? "?"), text.slice(0, 400));
    results.check("…the hold button is off, with the reason beside it", (await holdButton.isDisabled()) && text.includes("Unavailable while you are custodian of a Silicon."));
    results.check("…and points to the Silicons page", (await section.getByRole("link", { name: "Hand over or delete your Silicons" }).getAttribute("href")) === "/silicons");
    await hold(keeper.page, holdButton, 2600).catch(() => undefined);
    await sleep(500);
    results.check("holding the disabled button does nothing", (await getMe(keeper.probe)).status === "active" && keeper.page.url() === `${env.site}/settings`);

    const refuse = async () => call<{ error?: { details?: { silicons?: Array<{ id: string }> } } }>(keeper.probe, "/v1/me", { method: "DELETE", json: { confirm: keeper.id } });
    let refused = await refuse();
    const blockers = (answer: typeof refused) => (answer.body.error?.details?.silicons ?? []).map(item => item.id).sort();
    results.check("the API refuses: 409 custodian_of_silicons naming both", refused.status === 409 && codeOf(refused.body) === "custodian_of_silicons" && JSON.stringify(blockers(refused)) === JSON.stringify([sa?.id, sb?.id].sort()), `${refused.status} ${codeOf(refused.body)} ${JSON.stringify(blockers(refused))}`);
    const noConfirm = await call(keeper.probe, "/v1/me", { method: "DELETE", json: {} });
    const wrongConfirm = await call(keeper.probe, "/v1/me", { method: "DELETE", json: { confirm: heir.id } });
    results.check("without the confirmation, or with another id, nothing happens (422)", noConfirm.status === 422 && codeOf(noConfirm.body) === "confirmation_required" && wrongConfirm.status === 422 && codeOf(wrongConfirm.body) === "confirmation_mismatch", `${noConfirm.status} ${codeOf(noConfirm.body)} / ${wrongConfirm.status} ${codeOf(wrongConfirm.body)}`);

    // One Silicon deleted: still blocked by the other.
    const deleted = await call(keeper.probe, `/v1/me/silicons/${sa?.uuid}`, { method: "DELETE", json: { confirm: sa?.id } });
    refused = await refuse();
    results.check("after deleting one Silicon it is still blocked by the other", deleted.status === 204 && refused.status === 409 && JSON.stringify(blockers(refused)) === JSON.stringify([sb?.id]), `${deleted.status} ${refused.status} ${JSON.stringify(blockers(refused))}`);

    // A transfer that is only pending doesn't unblock it.
    const transfer = await call(keeper.probe, `/v1/me/silicons/${sb?.uuid}/transfer`, { method: "POST", json: { to: heir.id } });
    refused = await refuse();
    results.check("a pending transfer doesn't unblock it (the Silicon still has this custodian)", transfer.status === 201 && refused.status === 409, `${transfer.status} ${refused.status}`);
    await keeper.page.reload();
    await section.getByText(/You look after 1 Silicon\./).waitFor({ timeout: 30_000 }).catch(() => undefined);
    results.check("Settings now says 1 Silicon, still blocked", (await section.innerText()).includes("You look after 1 Silicon.") && (await holdButton.isDisabled()));

    // The other Carbon accepts: the Silicon is theirs, and this account can be deleted.
    const requests = (await call<{ items: Array<{ id: string; silicon: { uuid: string } }> }>(heir.probe, "/v1/me/custodian-requests")).body.items;
    const request = requests.find(item => item.silicon.uuid === sb?.uuid);
    const accepted = await call(heir.probe, `/v1/me/custodian-requests/${request?.id}/accept`, { method: "POST" });
    results.check("the other Carbon accepts the transfer", accepted.status === 204 && (await getMe(keeper.probe)).custodian_of === 0 && (await getMe(heir.probe)).custodian_of === 1, `${accepted.status}`);
    // Every custodian change is kept (UNDERSTANDING.md "Custodian", "History"): each Carbon's activity has its side.
    const custody = async (probe: typeof keeper.probe) => (await call<{ items: Array<{ title: string }> }>(probe, "/v1/me/history?kind=custodian&limit=20")).body.items.map(item => item.title);
    const keeperCustody = await custody(keeper.probe);
    const heirCustody = await custody(heir.probe);
    results.check("the keeper's activity: both Silicons created, the second transferred to the heir", keeperCustody.filter(title => title.startsWith("Created the Silicon ")).length === 2 && keeperCustody.includes(`Created the Silicon ${sb?.id}`) && keeperCustody.includes(`Transferred ${sb?.id} to ${heir.id}`), keeperCustody.join(" | "));
    results.check("the heir's activity: it became the custodian, transferred from the keeper", heirCustody.includes(`Became the custodian of ${sb?.id} (transferred from ${keeper.id})`), heirCustody.join(" | "));
    await keeper.page.goto(`${env.site}/activity`);
    await keeper.page.getByRole("group", { name: "Show" }).getByRole("button", { name: "Custodian", exact: true }).click({ timeout: 30_000 });
    const custodianRows = await until(() => timelineRows(keeper.page), rows => rows.length >= keeperCustody.length, 10_000);
    await shot(env, keeper.page, "acct-delete-01b-custodian-activity");
    results.check("…and /activity's Custodian filter shows exactly those entries, newest first (the request, then the transfer)", custodianRows.length === keeperCustody.length && keeperCustody.every((title, index) => (custodianRows[index] ?? "").startsWith(title)) && keeperCustody.includes(`Transfer of ${sb?.id} to ${heir.id} requested`), custodianRows.join(" | "));
    await keeper.page.goto(`${env.site}/settings`);
    await keeper.page.reload();
    await section.getByText(/Your account ends for good/).waitFor({ timeout: 30_000 }).catch(() => undefined);
    await sleep(600);
    await shot(env, keeper.page, "acct-delete-02-unblocked", true);
    const open = (await section.innerText()).replace(/\s+/g, " ");
    results.check("Settings now explains what deleting does, and the hold button is on", open.includes(`${keeper.id} stays reserved for 10 days before anyone can take it`) && !(await holdButton.isDisabled()), open.slice(0, 300));
    const heirRefused = await call(heir.probe, "/v1/me", { method: "DELETE", json: { confirm: heir.id } });
    results.check("the new custodian is the one blocked now", heirRefused.status === 409 && codeOf(heirRefused.body) === "custodian_of_silicons", `${heirRefused.status}`);
    const stillWrong = await call(keeper.probe, "/v1/me", { method: "DELETE", json: { confirm: `${keeper.id}x` } });
    results.check("a wrong confirmation still deletes nothing (422, account active)", stillWrong.status === 422 && (await getMe(keeper.probe)).status === "active", `${stillWrong.status} ${messageOf(stillWrong.body).slice(0, 120)}`);
    await keeper.context.close();
    await heir.context.close();
  },
};

const deletion: Journey = {
  name: "account-site-delete",
  title: "deleting the account on Settings (hold 2 s): apps with access get account.deleted (signed), sessions/CLI/app tokens/proofs end at once, an app whose access was removed hears nothing, the c:id is reserved 10 days then free, a waiting Silicon is released, the email signs up a new account with a new uuid",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    // Nothing failing is expected on the walked page: the deletion ends the session itself, so the site leaves without a
    // sign-out (round 1 found a POST /v1/session/signout answering 401 after every deletion; checked below as well).
    const leaver = await newCarbon(ctx, "acct-leaver");
    const taker = await newCarbon(ctx, "acct-taker");
    const { uuid } = leaver;
    for (const app of ["briefcase", "commit", "browser"]) {
      const account = await signIntoApp(env, leaver.page, app);
      results.check(`setup: signed into ${app}`, account?.uuid === uuid);
    }
    const removed = await call(leaver.probe, "/v1/me/apps/browser", { method: "DELETE" });
    const proof = (await postJson<{ body?: { proof_token?: string } }>(`${env.apps}/briefcase/actions/issue-obo`, { uuid, receiving_app: "commit", scopes: ["files.read"] })).body.body?.proof_token ?? "";
    const second = await signInAgain(ctx, leaver.email, "acct-leaver-2");
    // The developer site too (developer.teamofsilicons.com, the first-party app `developer`): its server holds tokens
    // for this Carbon, which the deletion must end like every other sign-in.
    const developer = await leaver.context.newPage();
    results.watch(developer, "acct-leaver-developer", [DEVELOPER_SESSION_ENDED]);
    await signInOnDeveloper(env, developer, null);
    const devBefore = await developerApi<{ uuid?: string }>(env, developer, "/me");
    const after = await lastSeq(env);
    const start = await api<{ challenge_id?: string }>(ctx, "/v1/cli/login/start", { method: "POST", json: { email: leaver.email } });
    const code = await codeFor(env, leaver.email, after);
    const cliTokens = await api<{ access_token?: string }>(ctx, "/v1/cli/login/verify", { method: "POST", json: { challenge_id: start.body.challenge_id, code, client_label: "leaver terminal" } });
    const bearer = { authorization: `Bearer ${cliTokens.body.access_token ?? ""}` };
    // A Silicon that named this Carbon as its custodian and is still waiting for the answer.
    const hook = `orphan-${t}`;
    const orphanId = `si:orphan-${t}`;
    const orphan = await api<{ request?: { id: string }; request_token?: string; webhook_secret?: string; silicon?: { uuid: string } }>(ctx, "/v1/silicons", { method: "POST", json: { id: orphanId, display_name: `Orphan ${t}`, custodian: leaver.id, webhook_url: `${env.apps}/hooks/${hook}` } });
    await postJson(`${env.apps}/hooks/${hook}/_webhook-secret`, { secret: orphan.body.webhook_secret });
    // Another Carbon is handing a Silicon over to this one, still waiting for the answer.
    const handed = await call<Created>(taker.probe, "/v1/me/silicons", { method: "POST", json: { id: `si:handover-${t}`, display_name: `Handover ${t}` } });
    const handedUuid = handed.body.silicon?.uuid ?? "";
    const handover = await call(taker.probe, `/v1/me/silicons/${handedUuid}/transfer`, { method: "POST", json: { to: leaver.id } });
    results.check("setup: Browser's access removed, a proof for Commit, a second browser, the CLI, the developer site, a Silicon waiting for this Carbon, another Carbon's Silicon being handed to it", removed.status === 204 && !!proof && cliTokens.status === 200 && devBefore.status === 200 && devBefore.body.uuid === uuid && orphan.status === 201 && handed.status === 201 && handover.status === 201, `${removed.status} ${!!proof} ${cliTokens.status} ${devBefore.status} ${orphan.status} ${handed.status} ${handover.status}`);
    const verifyProof = async () => (await postJson<{ verification?: { valid?: boolean; expires_at?: string | null } }>(`${env.apps}/commit/api/verify-proof`, { proof_token: proof })).body.verification ?? {};
    results.check("setup: the proof verifies before the deletion", (await verifyProof()).valid === true);
    const seq = { briefcase: (await inbox(env, "briefcase")).last_seq, commit: (await inbox(env, "commit")).last_seq };

    // Settings: what deleting does, then hold for 2 seconds.
    await leaver.page.goto(`${env.site}/settings`);
    const section = leaver.page.getByRole("region", { name: "Delete your account" });
    await section.getByText(/Your account ends for good/).waitFor({ timeout: 30_000 });
    const text = (await section.innerText()).replace(/\s+/g, " ");
    results.check("Settings says what deleting does: apps told, sessions and proofs end, emails freed, the id reserved 10 days", text.includes("Every app you signed into is told and loses access, your sessions and proofs end, your emails and phone numbers are freed") && text.includes(`${leaver.id} stays reserved for 10 days before anyone can take it. This cannot be undone.`), text.slice(0, 320));
    const button = leaver.page.getByRole("button", { name: "Hold to delete your account" });
    await hold(leaver.page, button, 600);
    await sleep(600);
    results.check("letting go too early deletes nothing", (await getMe(leaver.probe)).status === "active");
    const failing: string[] = [];
    const signouts: string[] = [];
    leaver.page.on("response", response => {
      if (response.url().startsWith(`${env.site}/v1/`) && response.status() >= 400) failing.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`);
    });
    leaver.page.on("request", request => {
      if (request.url().startsWith(`${env.site}/v1/session/signout`)) signouts.push(request.method());
    });
    const deleteSent = requestSent(leaver.page, "DELETE", "/v1/me");
    await hold(leaver.page, button, 2600);
    await leaver.page.waitForURL(`${env.site}/`, { timeout: 20_000 });
    const landing = await leaver.page.getByRole("link", { name: /sign in/i }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const sentAt = await deleteSent;
    results.metric("delete DELETE sent → signed-out landing page shown", Date.now() - sentAt);
    results.check("after the hold the browser lands signed out", landing);
    results.check("deleting makes no failing request, and no sign-out of a session the deletion already ended", failing.length === 0 && signouts.length === 0, `failing: ${failing.join(", ") || "none"}; sign-out requests: ${signouts.length}`);
    await shot(env, leaver.page, "acct-delete-03-gone");

    // Every way in is closed at once.
    const own = await call(leaver.probe, "/v1/session");
    const other = await call(second.probe, "/v1/session");
    const cli = await api(ctx, "/v1/me", { headers: bearer });
    results.check("this browser, the other browser and the CLI are all signed out (401)", own.status === 401 && other.status === 401 && cli.status === 401, `${own.status} ${other.status} ${cli.status}`);
    const devAfter = await developerApi<{ error?: { code?: string } }>(env, developer, "/me");
    results.check("…and so is the developer site (its next call answers 401)", devAfter.status === 401, `${devAfter.status} ${codeOf(devAfter.body)}`);
    const leftCookies = (await leaver.context.cookies(env.site)).filter(entry => /sa_session$/.test(entry.name)).map(entry => entry.name);
    results.check("…and this browser no longer holds a session cookie (the deletion cleared it)", leftCookies.length === 0, leftCookies.join(", ") || "none");
    await second.context.close();

    // Apps with access are told; their tokens and the proof are dead; the app whose access was removed hears nothing.
    const toBriefcase = await waitEvent(env, "briefcase", "account.deleted", uuid, { after: seq.briefcase });
    const toCommit = await waitEvent(env, "commit", "account.deleted", uuid, { after: seq.commit });
    results.metric("delete DELETE sent → Briefcase received account.deleted", deliveredAfter(toBriefcase, sentAt));
    results.metric("delete DELETE sent → Commit received account.deleted", deliveredAfter(toCommit, sentAt));
    results.check("Briefcase and Commit got account.deleted (signed) with their membership ids", toBriefcase?.payload.data.membership_id === `briefcase:${uuid}` && toCommit?.payload.data.membership_id === `commit:${uuid}`, `${JSON.stringify(toBriefcase?.payload.data ?? null)} ${JSON.stringify(toCommit?.payload.data ?? null)}`);
    results.check("Browser (access removed earlier) is not told", (await queuedEvents(env, "browser", uuid, "account.deleted")) === 0);
    const refresh = await appRefresh(env, "briefcase", uuid);
    const info = await appUserinfo(env, "commit", uuid);
    results.check("Briefcase's refresh fails (invalid_grant) and Commit's access token is refused (401)", refresh.status === 400 && refresh.error === "invalid_grant" && info.status === 401, `${JSON.stringify(refresh)} ${info.status}`);
    const verdict = await verifyProof();
    results.check("the proof about the account is no longer valid (exactly {valid:false, expires_at:null})", verdict.valid === false && verdict.expires_at === null, JSON.stringify(verdict));
    const byUuid = await api(ctx, `/v1/accounts/${uuid}`, { headers: { authorization: appAuth("briefcase") } });
    const byId = await api(ctx, `/v1/accounts/by-id/${encodeURIComponent(leaver.id)}`, { headers: { authorization: appAuth("briefcase") } });
    results.check("apps can no longer look the account up (404 by uuid and by id)", byUuid.status === 404 && byId.status === 404, `${byUuid.status} ${byId.status}`);

    // What is left in the database: a deleted shell, its id reserved for 10 days.
    const [[status, handle, emails, identities, live] = []] = await sql(env, `select a.status, coalesce(a.handle, 'null'), (select count(*) from account_emails where account_uuid = a.uuid), (select count(*) from identities where account_uuid = a.uuid), (select count(*) from token_families where account_uuid = a.uuid and revoked_at is null) from accounts a where a.uuid = '${uuid}'`);
    results.check("the account is deleted: no id, no emails, no identities, no live tokens", status === "deleted" && handle === "null" && emails === "0" && identities === "0" && live === "0", `${status} ${handle} emails ${emails} identities ${identities} live ${live}`);
    const [[holder, days] = []] = await sql(env, `select account_uuid, round(extract(epoch from reserved_until - now()) / 86400.0, 2) from handle_reservations where handle = '${leaver.id}'`);
    results.check("its c:id is reserved for 10 days", holder === uuid && Math.abs(Number(days) - 10) < 0.01, `${holder} ${days}`);
    const available = await api<{ available: boolean; reason: string | null }>(ctx, `/v1/ids/available?id=${encodeURIComponent(leaver.id)}`);
    const grab = await call(taker.probe, "/v1/me/id", { method: "POST", json: { id: leaver.id } });
    results.check("another Carbon can't take the id (reserved; 409 id_reserved)", available.body.available === false && available.body.reason === "reserved" && grab.status === 409 && codeOf(grab.body) === "id_reserved", `${JSON.stringify(available.body)} ${grab.status} ${codeOf(grab.body)}`);
    await sql(env, `update handle_reservations set reserved_until = now() - interval '1 second' where handle = '${leaver.id}'`);
    const taken = await call(taker.probe, "/v1/me/id", { method: "POST", json: { id: leaver.id } });
    results.check("after the 10 days (time travel) another Carbon takes it", taken.status === 200 && (await getMe(taker.probe)).id === leaver.id, `${taken.status} ${codeOf(taken.body)}`);

    // The Silicon that was waiting for this Carbon is released and told.
    const declined = await json<{ payload?: { type?: string; data?: { reason?: string; released?: boolean } } }>(`${env.apps}/hooks/${hook}/_events/wait?type=silicon.custodian.declined&timeout_ms=20000`);
    results.check("the waiting Silicon is told: silicon.custodian.declined, reason custodian_account_deleted", declined.status === 200 && declined.body.payload?.data?.reason === "custodian_account_deleted" && declined.body.payload?.data?.released === true, JSON.stringify(declined.body.payload?.data ?? declined.body).slice(0, 200));
    const status2 = await api<{ status?: string; silicon?: { status?: string; id?: string | null } }>(ctx, `/v1/silicons/requests/${orphan.body.request?.id}`, { headers: { authorization: `Bearer ${orphan.body.request_token}` } });
    results.check("its request is closed and the Silicon released", status2.status === 200 && status2.body.status !== "pending" && status2.body.silicon?.status === "deleted", JSON.stringify(status2.body).slice(0, 200));
    const orphanFree = await api<{ available: boolean }>(ctx, `/v1/ids/available?id=${encodeURIComponent(orphanId)}`);
    results.check("…its si:id is free again at once (it never became active)", orphanFree.body.available === true, JSON.stringify(orphanFree.body));

    // The Silicon being handed to it stays with the Carbon handing it over, and that hand-over is closed.
    const [[handoverStatus] = []] = await sql(env, `select status from custodian_requests where silicon_uuid = '${handedUuid}' order by created_at desc limit 1`);
    const kept = await call<{ custodian?: { uuid?: string } | null; pending_transfer?: unknown }>(taker.probe, `/v1/me/silicons/${handedUuid}`);
    const keptBy = kept.body.custodian?.uuid;
    results.check("a Silicon another Carbon was handing to it stays with that Carbon, and the hand-over is closed (no longer pending)", handoverStatus !== undefined && handoverStatus !== "pending" && kept.status === 200 && keptBy === taker.uuid && kept.body.pending_transfer === null && (await getMe(taker.probe)).custodian_of === 1, `request ${handoverStatus}; ${kept.status} custodian ${keptBy} (want ${taker.uuid}), pending_transfer ${JSON.stringify(kept.body.pending_transfer)}`);

    // The email is free: signing in with it is a sign-up, for a new account with a new uuid.
    const context = await newContext(ctx.browser);
    const page = await context.newPage();
    results.watch(page, "acct-leaver-again");
    await signInOnSite(env, page, leaver.email);
    const probe = await probePage(env, context);
    const reborn = await getMe(probe);
    results.check("signing in with the same email signs up a new account: new uuid, new id", reborn.uuid !== uuid && reborn.id !== leaver.id && reborn.emails.some(item => item.email === leaver.email), `${reborn.uuid} ${reborn.id} (was ${uuid} ${leaver.id})`);
    const [[number] = []] = await sql(env, `select count(*) from accounts where uuid = '${uuid}'`);
    results.check("the deleted uuid is not reused (its row stays, deleted)", number === "1" && reborn.uuid !== uuid);
    await context.close();
    await leaver.context.close();
    await taker.context.close();
  },
};

export const journeys: Journey[] = [blocked, deletion];

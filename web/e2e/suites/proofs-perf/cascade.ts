/**
 * Cascades: an OBO proof stands on the account's grant at the issuing app and ends with it. Removing dm's access on
 * the account site (in a real browser), dm signing the account out (its sign-in revoked), the account being deleted,
 * and a custodian rotating a Silicon's STK: each makes the proofs standing on that grant exactly invalid at once and
 * unrefreshable, while proofs standing on other grants live on.
 */
import type { Journey } from "../../context";
import { api, json, newContext, shot, sleep, sql } from "../../lib";
import {
  appListing,
  appTokens,
  basicAuth,
  errorCode,
  familyOf,
  isExactlyInvalid,
  issueObo,
  newPhone,
  refreshAs,
  row,
  short,
  signInToApp,
  verifyAs,
  watchOutside,
  type ApiErrorBody,
  type MyProofItem,
  type Verification,
} from "./_helpers";

export const journeys: Journey[] = [
  {
    name: "proofs-perf-cascade-remove-access",
    title: "the Carbon removes dm's access on /apps in the browser: every OBO proof dm holds for it is exactly invalid at once and unrefreshable (access_removed), dm can't issue new ones; proofs other apps issued live on; signing into dm again gives new proofs but never revives the old ones",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const carbon = await signInToApp(ctx, "dm");
      await signInToApp(ctx, "briefcase", { session: carbon.session });
      const dmSubject = (await appTokens(env, "dm", carbon.uuid)).access_token;
      const briefcaseSubject = (await appTokens(env, "briefcase", carbon.uuid)).access_token;
      const toBriefcase = (await issueObo(ctx, "dm", dmSubject, { receiving_app: "briefcase", scopes: ["files.write"] })).body;
      const toWaveform = (await issueObo(ctx, "dm", dmSubject, { receiving_app: "waveform", scopes: ["voice.send"] })).body;
      const fromBriefcase = (await issueObo(ctx, "briefcase", briefcaseSubject, { receiving_app: "remind", scopes: ["reminders.write"] })).body;
      const intoDm = (await issueObo(ctx, "briefcase", briefcaseSubject, { receiving_app: "dm", scopes: ["messages.send"] })).body;
      const before = await Promise.all([verifyAs(ctx, "briefcase", toBriefcase.proof_token), verifyAs(ctx, "waveform", toWaveform.proof_token), verifyAs(ctx, "remind", fromBriefcase.proof_token), verifyAs(ctx, "dm", intoDm.proof_token)]);
      results.check("before: dm's proofs (→ briefcase, → waveform) and Briefcase's (→ remind, → dm) all verify", before.every(answer => answer.body.valid === true), before.map(answer => answer.body.valid).join(", "));

      // The Carbon removes dm's access on the account site.
      const context = await newContext(browser);
      await carbon.session.into(context);
      const page = await context.newPage();
      results.watch(page, "cascade-remove-access");
      const outside = watchOutside(page);
      await page.goto(`${env.site}/apps`);
      const card = page.getByRole("list", { name: "Apps with access" }).getByRole("listitem").filter({ has: page.getByRole("heading", { name: "DM", exact: true }) });
      await card.waitFor({ timeout: 30_000 });
      await card.getByRole("button", { name: "Remove access" }).click();
      await card.getByRole("button", { name: "Remove", exact: true }).click({ timeout: 10_000 });
      const started = Date.now();
      let first = await verifyAs(ctx, "briefcase", toBriefcase.proof_token);
      for (let i = 0; i < 60 && !isExactlyInvalid(first.body); i++) {
        await sleep(150);
        first = await verifyAs(ctx, "briefcase", toBriefcase.proof_token);
      }
      results.metric("access removed on /apps → receiving app sees invalid", Date.now() - started);
      const apps = (await carbon.session.call<{ items: Array<{ app: { app_id: string }; status: string }> }>("GET", "/v1/me/apps?limit=200")).body.items ?? [];
      const status = (app: string) => apps.find(item => item.app.app_id === app)?.status ?? "missing";
      results.check("the account site removed dm's access (dm access_removed, Briefcase still active)", status("dm") === "access_removed" && status("briefcase") === "active", `dm ${status("dm")}, briefcase ${status("briefcase")}`);
      results.check("dm's proof for Briefcase → exactly invalid", isExactlyInvalid(first.body), JSON.stringify(first.body));
      const second = await verifyAs(ctx, "waveform", toWaveform.proof_token);
      results.check("dm's proof for Waveform → exactly invalid", isExactlyInvalid(second.body), JSON.stringify(second.body));
      for (const proof of [toBriefcase, toWaveform]) {
        const refresh = await refreshAs(ctx, "dm", proof.proof_refresh_token);
        results.check(`dm refreshing its proof for ${proof.receiving_app} → 410 proof_revoked, reason access_removed`, refresh.status === 410 && errorCode(refresh.body) === "proof_revoked" && refresh.body.error?.details?.reason === "access_removed", `${refresh.status} ${short(refresh.body.error)}`);
      }
      const listed = await appListing(ctx, "dm", toBriefcase.proof_id);
      results.check("dm's listing: revoked, access_removed", listed?.status === "revoked" && listed.revoke_reason === "access_removed", short(listed));
      const stored = await row(env, `select count(*) filter (where revoke_reason = 'access_removed' and revoked_by = '${carbon.uuid}'), count(*) from proof_families where account_uuid = '${carbon.uuid}' and issuing_app = 'dm'`);
      results.check("both of dm's proofs are stored revoked (access_removed, by the Carbon)", stored?.[0] === "2" && stored[1] === "2", short(stored));
      const reissue = await issueObo(ctx, "dm", dmSubject, { receiving_app: "briefcase" });
      results.check("dm can't issue a new proof with the access token it still holds → 400 invalid_subject_token (sign-in revoked) or 403 membership_inactive", (reissue.status === 400 && errorCode(reissue.body) === "invalid_subject_token") || (reissue.status === 403 && errorCode(reissue.body) === "membership_inactive"), `${reissue.status} ${short(reissue.body.error)}`);
      const survivor = await verifyAs(ctx, "remind", fromBriefcase.proof_token);
      results.check("Briefcase's proof for Remind (another grant) still verifies", survivor.body.valid === true, short(survivor.body));
      const intoDmAfter = await verifyAs(ctx, "dm", intoDm.proof_token);
      // Not in the contract either way (it ends the proofs the removed app issued): recorded, never judged.
      results.metric("observed: Briefcase's proof naming dm as receiver still valid after dm's access was removed (1 = yes)", intoDmAfter.body.valid === true ? 1 : 0, "bool");

      // The /proofs page shows why dm's proofs ended.
      await page.goto(`${env.site}/proofs`);
      await page.getByRole("button", { name: /^Ended \(\d+\)/ }).click({ timeout: 30_000 });
      const ended = page.getByRole("article", { name: "DM acts at Briefcase for you" });
      await ended.waitFor({ timeout: 10_000 });
      await sleep(1500); // the view switch animates; read and shoot the settled card
      const text = (await ended.innerText()).replace(/\s+/g, " ");
      results.check("/proofs (Ended) explains it: \"Ended when DM's access was removed\"", /Ended when DM.s access was removed/.test(text), text.slice(0, 240));
      await shot(env, page, "proofs-perf-cascade-01-ended", true);

      // Signing into dm again: new proofs work, the old ones stay dead.
      const again = await signInToApp(ctx, "dm", { session: carbon.session, phone: newPhone() });
      const newSubject = (await appTokens(env, "dm", again.uuid)).access_token;
      const fresh = await issueObo(ctx, "dm", newSubject, { receiving_app: "briefcase" });
      results.check("after signing into dm again dm gets a new proof that verifies", again.uuid === carbon.uuid && fresh.status === 201 && (await verifyAs(ctx, "briefcase", fresh.body.proof_token)).body.valid === true, `${fresh.status} ${short(fresh.body.error)}`);
      results.check("…and the old proofs stay exactly invalid (no resurrection)", isExactlyInvalid((await verifyAs(ctx, "briefcase", toBriefcase.proof_token)).body) && (await refreshAs(ctx, "dm", toBriefcase.proof_refresh_token)).status === 410);
      results.check("nothing /apps and /proofs loaded left the machine", outside().length === 0, outside().join(", ") || "none");
      await context.close();
    },
  },
  {
    name: "proofs-perf-cascade-sign-in",
    title: "dm signs the Carbon out (its sign-in revoked): that sign-in's proofs are exactly invalid and refresh → 410 sign_in_revoked, while a proof on another dm sign-in lives on; deleting the account ends its proofs; a custodian rotating a Silicon's STK ends the Silicon's proofs",
    async run(ctx) {
      const { env, results } = ctx;

      // Two dm sign-ins of one Carbon (two token families); dm signs the first one out.
      const carbon = await signInToApp(ctx, "dm");
      const first = await appTokens(env, "dm", carbon.uuid);
      const onFirst = (await issueObo(ctx, "dm", first.access_token, { receiving_app: "briefcase", scopes: ["pp.first"] })).body;
      await signInToApp(ctx, "dm", { session: carbon.session });
      const second = await appTokens(env, "dm", carbon.uuid);
      const onSecond = (await issueObo(ctx, "dm", second.access_token, { receiving_app: "briefcase", scopes: ["pp.second"] })).body;
      results.check("two sign-ins (token families) at dm, a proof on each, both verify", familyOf(first.access_token) !== familyOf(second.access_token) && (await verifyAs(ctx, "briefcase", onFirst.proof_token)).body.valid === true && (await verifyAs(ctx, "briefcase", onSecond.proof_token)).body.valid === true, `${familyOf(first.access_token)} / ${familyOf(second.access_token)}`);
      const revoke = await api<unknown>(ctx, "/v1/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth("dm") },
        body: new URLSearchParams({ token: first.refresh_token ?? "" }).toString(),
      });
      results.check("dm signs the first sign-in out (POST /v1/oauth/revoke with its refresh token) → 200", revoke.status === 200, `${revoke.status} ${short(revoke.body)}`);
      const familyRow = await row(env, `select revoked_at is not null, revoke_reason from token_families where id = '${familyOf(first.access_token)}'`);
      results.check("…which revoked that sign-in", familyRow?.[0] === "t", short(familyRow));
      const dead = await verifyAs(ctx, "briefcase", onFirst.proof_token);
      results.check("the proof on the revoked sign-in → exactly invalid at once (verify checks the sign-in live)", isExactlyInvalid(dead.body), JSON.stringify(dead.body));
      const alive = await verifyAs(ctx, "briefcase", onSecond.proof_token);
      results.check("the proof on the other dm sign-in still verifies", alive.body.valid === true, short(alive.body));
      const listedLive = await appListing(ctx, "dm", onFirst.proof_id);
      results.check("dm's listing already says revoked, sign_in_revoked (derived live, before any sweep)", listedLive?.status === "revoked" && listedLive.revoke_reason === "sign_in_revoked", short(listedLive));
      const refresh = await refreshAs(ctx, "dm", onFirst.proof_refresh_token);
      results.check("dm refreshing it → 410 proof_revoked, reason sign_in_revoked", refresh.status === 410 && errorCode(refresh.body) === "proof_revoked" && refresh.body.error?.details?.reason === "sign_in_revoked", `${refresh.status} ${short(refresh.body.error)}`);
      const storedEnd = await row(env, `select f.revoke_reason, f.revoked_by, a.details->>'sign_in_revoke_reason' from proof_families f left join audit_log a on a.target_id = f.id::text and a.action = 'proof.revoked' where f.id = '${onFirst.proof_id}'`);
      results.check("that refresh stored the end (sign_in_revoked by system) with an audit entry naming why the sign-in ended", storedEnd?.[0] === "sign_in_revoked" && storedEnd[1] === "system" && !!storedEnd[2], short(storedEnd));
      const mine = (await carbon.session.call<{ items: MyProofItem[] }>("GET", "/v1/me/proofs?limit=200")).body.items ?? [];
      const firstMine = mine.find(item => item.proof_id === onFirst.proof_id);
      const secondMine = mine.find(item => item.proof_id === onSecond.proof_id);
      results.check("the Carbon's /v1/me/proofs: the first revoked (sign_in_revoked), the second active", firstMine?.status === "revoked" && firstMine.revoke_reason === "sign_in_revoked" && secondMine?.status === "active", `${short(firstMine?.status)} ${short(firstMine?.revoke_reason)} / ${short(secondMine?.status)}`);
      const fromDeadToken = await issueObo(ctx, "dm", first.access_token, { receiving_app: "briefcase" });
      results.check("a new proof from the signed-out sign-in's access token → 400 invalid_subject_token (revoked)", fromDeadToken.status === 400 && errorCode(fromDeadToken.body) === "invalid_subject_token" && fromDeadToken.body.error?.details?.reason === "revoked", `${fromDeadToken.status} ${short(fromDeadToken.body.error)}`);

      // The account is deleted: its proofs end with it.
      const doomed = await signInToApp(ctx, "dm");
      const doomedSubject = (await appTokens(env, "dm", doomed.uuid)).access_token;
      const doomedProof = (await issueObo(ctx, "dm", doomedSubject, { receiving_app: "briefcase" })).body;
      results.check("a second Carbon's proof verifies before the account is deleted", (await verifyAs(ctx, "briefcase", doomedProof.proof_token)).body.valid === true);
      const deleted = await doomed.session.call<ApiErrorBody | null>("DELETE", "/v1/me", { confirm: doomed.id });
      results.check("the Carbon deletes its account (DELETE /v1/me with its id) → 204", deleted.status === 204, `${deleted.status} ${short(deleted.body)}`);
      const afterDelete = await verifyAs(ctx, "briefcase", doomedProof.proof_token);
      results.check("its proof → exactly invalid", isExactlyInvalid(afterDelete.body), JSON.stringify(afterDelete.body));
      const deletedRefresh = await refreshAs(ctx, "dm", doomedProof.proof_refresh_token);
      results.check("dm refreshing it → 410 proof_revoked", deletedRefresh.status === 410 && errorCode(deletedRefresh.body) === "proof_revoked", `${deletedRefresh.status} ${short(deletedRefresh.body.error)}`);
      const deletedListing = await appListing(ctx, "dm", doomedProof.proof_id);
      results.check("dm's listing: revoked (account_deleted, stored by the deletion)", deletedListing?.status === "revoked" && deletedListing.revoke_reason === "account_deleted", short(deletedListing));

      // A Silicon: signed into dm with a short-lived token, a proof on its behalf, then its custodian rotates the STK.
      const custodian = await signInToApp(ctx, "briefcase");
      const handle = `si:pp-${custodian.uuid.toLowerCase()}-${Date.now().toString(36)}`;
      const created = await custodian.session.call<{ silicon: { uuid: string; id: string }; stk: string }>("POST", "/v1/me/silicons", { id: handle, display_name: "Proof Scout" }, { "idempotency-key": crypto.randomUUID() });
      results.check("the custodian creates a Silicon (its STK shown once)", created.status === 201 && /^stk-[0-9a-f]{12}$/.test(created.body.stk ?? ""), `${created.status} ${short(created.body)}`);
      const silicon = created.body.silicon;
      const login = await json<{ access_token?: string }>(`${env.site}/v1/silicons/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ctx.ip }, body: JSON.stringify({ id: silicon.id, stk: created.body.stk }) });
      const slt = await json<{ slt?: string }>(`${env.site}/v1/me/short-lived-tokens`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${login.body.access_token ?? ""}`, "x-forwarded-for": ctx.ip }, body: JSON.stringify({ app_id: "dm" }) });
      const sltLogin = await json<{ ok?: boolean; uuid?: string }>(`${env.apps}/dm/slt-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slt: slt.body.slt }) });
      results.check("the Silicon signs in (si:id + STK), gets a short-lived token for dm, and dm exchanges it", login.status === 200 && slt.status < 300 && sltLogin.body.ok === true && sltLogin.body.uuid === silicon.uuid, `${login.status} ${slt.status} ${short(sltLogin.body)}`);
      const save = await json<{ ok?: boolean; verification?: Verification; proof?: { proof_id: string } }>(`${env.apps}/dm/actions/save-to-briefcase`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uuid: silicon.uuid, filename: "scout.txt" }) });
      results.check("dm saves a file to Briefcase on the Silicon's behalf: Briefcase verifies an OBO proof for a silicon (its si:id, dm:<uuid>)", save.body.ok === true && save.body.verification?.user?.kind === "silicon" && save.body.verification.user.id === silicon.id && save.body.verification.user.membership_id === `dm:${silicon.uuid}`, short(save.body.verification ?? save.body));
      const siliconSubject = (await appTokens(env, "dm", silicon.uuid)).access_token;
      const siliconProof = (await issueObo(ctx, "dm", siliconSubject, { receiving_app: "briefcase", scopes: ["pp.silicon"] })).body;
      results.check("…and a proof dm keeps for it verifies", (await verifyAs(ctx, "briefcase", siliconProof.proof_token)).body.valid === true);
      const rotated = await custodian.session.call<{ stk?: string }>("POST", `/v1/me/silicons/${silicon.uuid}/stk`, {});
      results.check("the custodian rotates the Silicon's STK → 200 with a new STK", rotated.status === 200 && /^stk-/.test(rotated.body.stk ?? "") && rotated.body.stk !== created.body.stk, `${rotated.status} ${short(rotated.body)}`);
      const afterRotation = await verifyAs(ctx, "briefcase", siliconProof.proof_token);
      results.check("the rotation ended the Silicon's sign-ins, so its proof is exactly invalid at once", isExactlyInvalid(afterRotation.body), JSON.stringify(afterRotation.body));
      const rotatedRefresh = await refreshAs(ctx, "dm", siliconProof.proof_refresh_token);
      results.check("dm refreshing it → 410 proof_revoked, sign_in_revoked", rotatedRefresh.status === 410 && rotatedRefresh.body.error?.details?.reason === "sign_in_revoked", `${rotatedRefresh.status} ${short(rotatedRefresh.body.error)}`);
      const why = await row(env, `select details->>'sign_in_revoke_reason' from audit_log where action = 'proof.revoked' and target_id = '${siliconProof.proof_id}'`);
      results.check("the stored end says why the sign-in ended: stk_rotated", why?.[0] === "stk_rotated", short(why));
      const [[open] = []] = await sql(env, `select count(*) from token_families where account_uuid = '${silicon.uuid}' and app_id = 'dm' and revoked_at is null`);
      results.check("no dm sign-in of the Silicon is left open", open === "0", String(open));
    },
  },
];

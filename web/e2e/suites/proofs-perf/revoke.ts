/**
 * Revocation by the issuing app (POST /v1/proofs/revoke by id, proof token or refresh token; DELETE on its proofs page
 * API) and by the account on the account site (/proofs, in a real browser): the receiving app's next verify is
 * exactly invalid, the issuing app can't refresh it, the listings and the history say who revoked it, and nobody else
 * can revoke it.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { newContext, shot, sleep, sql } from "../../lib";
import {
  appListing,
  appTokens,
  asApp,
  errorCode,
  isExactlyInvalid,
  issueAta,
  issueObo,
  refreshAs,
  revokeAs,
  row,
  short,
  signInToApp,
  SiteSession,
  verifyAs,
  type ApiErrorBody,
  type IssuedProof,
  type MyProofItem,
} from "./_helpers";

export const journeys: Journey[] = [
  {
    name: "proofs-perf-revoke-by-app",
    title: "the issuing app revokes by proof_id, proof_token or proof_refresh_token and on DELETE /v1/apps/dm/proofs/{id}: exactly invalid at once, refresh → 410 proof_revoked (revoked_by_app), repeat is a no-op; the receiving app can't revoke; bad references are refused without echoing tokens",
    async run(ctx) {
      const { env, results } = ctx;
      const carbon = await signInToApp(ctx, "dm");
      const subject = (await appTokens(env, "dm", carbon.uuid)).access_token;
      const issue = async (label: string) => (await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: [`pp.${label}`] })).body;
      const [byId, byToken, byRefresh, byPage, survivor] = [await issue("by-id"), await issue("by-token"), await issue("by-refresh"), await issue("by-page"), await issue("survivor")];
      results.check("dm issued five proofs that Briefcase verifies", (await Promise.all([byId, byToken, byRefresh, byPage, survivor].map(p => verifyAs(ctx, "briefcase", p.proof_token)))).every(answer => answer.body.valid === true));

      const references: Array<[string, IssuedProof, Record<string, string>]> = [
        ["proof_id", byId, { proof_id: byId.proof_id }],
        ["proof_token", byToken, { proof_token: byToken.proof_token }],
        ["proof_refresh_token", byRefresh, { proof_refresh_token: byRefresh.proof_refresh_token }],
      ];
      for (const [field, proof, body] of references) {
        const answer = await revokeAs(ctx, "dm", body);
        results.check(`dm revokes by ${field} → 204`, answer.status === 204, `${answer.status} ${short(answer.body)}`);
        const verdict = await verifyAs(ctx, "briefcase", proof.proof_token);
        results.check(`…Briefcase's next verify is exactly invalid (by ${field})`, isExactlyInvalid(verdict.body), JSON.stringify(verdict.body));
        const refresh = await refreshAs(ctx, "dm", proof.proof_refresh_token);
        results.check(`…dm can't refresh it: 410 proof_revoked, reason revoked_by_app, with revoked_at (by ${field})`, refresh.status === 410 && errorCode(refresh.body) === "proof_revoked" && refresh.body.error?.details?.reason === "revoked_by_app" && typeof refresh.body.error?.details?.revoked_at === "string", `${refresh.status} ${short(refresh.body.error)}`);
      }
      const listed = await appListing(ctx, "dm", byId.proof_id);
      results.check("dm's listing: revoked, revoke_reason revoked_by_app, revoked_at set", listed?.status === "revoked" && listed.revoke_reason === "revoked_by_app" && !!listed.revoked_at, short(listed));
      const mine = (await carbon.session.call<{ items: MyProofItem[] }>("GET", "/v1/me/proofs?limit=200")).body.items?.find(item => item.proof_id === byToken.proof_id);
      results.check("the Carbon's /v1/me/proofs says DM revoked it", mine?.status === "revoked" && mine.revoke_reason === "revoked_by_app", short(mine));
      const audit = await row(env, `select actor_kind, actor_id, details->>'via', account_uuid from audit_log where action = 'proof.revoked' and target_id = '${byRefresh.proof_id}'`);
      results.check("the revocation is audited: actor app dm, via proof_refresh_token, the Carbon's uuid", audit?.[0] === "app" && audit[1] === "dm" && audit[2] === "proof_refresh_token" && audit[3] === carbon.uuid, short(audit));

      // Revoking again changes nothing.
      const before = await row(env, `select revoked_at::text from proof_families where id = '${byId.proof_id}'`);
      const again = await revokeAs(ctx, "dm", { proof_id: byId.proof_id });
      const after = await row(env, `select revoked_at::text, (select count(*) from audit_log where action = 'proof.revoked' and target_id = '${byId.proof_id}') from proof_families where id = '${byId.proof_id}'`);
      results.check("revoking it again → 204, revoked_at unchanged, no second audit entry", again.status === 204 && before?.[0] === after?.[0] && after?.[1] === "1", `${again.status} ${short(before)} → ${short(after)}`);

      // The issuing app's proofs page API.
      const page = await asApp<ApiErrorBody | null>(ctx, "dm", "DELETE", `/v1/apps/dm/proofs/${byPage.proof_id}`);
      results.check("DELETE /v1/apps/dm/proofs/{id} with dm's credentials → 204 and the proof is exactly invalid", page.status === 204 && isExactlyInvalid((await verifyAs(ctx, "briefcase", byPage.proof_token)).body), `${page.status} ${short(page.body)}`);

      // Nobody but the issuing app.
      const receiverById = await revokeAs(ctx, "briefcase", { proof_id: survivor.proof_id });
      results.check("Briefcase revoking dm's proof by id → 404 proof_not_found (another app's proof ids look unknown)", receiverById.status === 404 && errorCode(receiverById.body) === "proof_not_found", `${receiverById.status} ${short(receiverById.body)}`);
      const receiverByToken = await revokeAs(ctx, "briefcase", { proof_token: survivor.proof_token });
      results.check("Briefcase revoking dm's proof by its token → 403 not_issuing_app", receiverByToken.status === 403 && errorCode(receiverByToken.body) === "not_issuing_app", `${receiverByToken.status} ${short(receiverByToken.body)}`);
      const otherPage = await asApp<ApiErrorBody | null>(ctx, "briefcase", "DELETE", `/v1/apps/dm/proofs/${survivor.proof_id}`);
      results.check("Briefcase on dm's proofs page API → refused (403/404)", otherPage.status === 403 || otherPage.status === 404, `${otherPage.status} ${short(otherPage.body)}`);
      const noAuth = await revokeAs(ctx, "dm", { proof_id: survivor.proof_id }, { secret: null });
      results.check("no app credentials → 401", noAuth.status === 401, `${noAuth.status} ${short(noAuth.body)}`);
      results.check("after all that the survivor still verifies", (await verifyAs(ctx, "briefcase", survivor.proof_token)).body.valid === true);

      // Bad references: precise, and a token is described, never echoed.
      const notUuid = await revokeAs(ctx, "dm", { proof_id: "not-a-proof-id" });
      results.check("proof_id \"not-a-proof-id\" → 400 invalid_proof_id quoting the id-shaped value", notUuid.status === 400 && errorCode(notUuid.body) === "invalid_proof_id" && /not-a-proof-id/.test((notUuid.body as ApiErrorBody).error.message), `${notUuid.status} ${short(notUuid.body)}`);
      const tokenAsId = await revokeAs(ctx, "dm", { proof_id: survivor.proof_token });
      results.check("a proof token sent as proof_id → 400 invalid_proof_id that says what it is and never repeats it", tokenAsId.status === 400 && errorCode(tokenAsId.body) === "invalid_proof_id" && /proof token/.test(JSON.stringify(tokenAsId.body)) && !JSON.stringify(tokenAsId.body).includes(survivor.proof_token.slice(4, 24)), `${tokenAsId.status} ${short(tokenAsId.body)}`);
      const both = await revokeAs(ctx, "dm", { proof_id: survivor.proof_id, proof_token: survivor.proof_token });
      results.check("two references at once → 422", both.status === 422, `${both.status} ${short(both.body)}`);
      const none = await revokeAs(ctx, "dm", {});
      results.check("no reference → 422", none.status === 422, `${none.status} ${short(none.body)}`);
      const unknownId = await revokeAs(ctx, "dm", { proof_id: randomUUID() });
      results.check("an unknown proof id → 404 proof_not_found", unknownId.status === 404 && errorCode(unknownId.body) === "proof_not_found", `${unknownId.status} ${short(unknownId.body)}`);
      const unknownToken = await revokeAs(ctx, "dm", { proof_token: `sap_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}` });
      results.check("an unknown proof token → 404 proof_not_found", unknownToken.status === 404 && errorCode(unknownToken.body) === "proof_not_found", `${unknownToken.status} ${short(unknownToken.body)}`);
      const swapped = await revokeAs(ctx, "dm", { proof_token: survivor.proof_refresh_token });
      results.check("a refresh token sent as proof_token → 422 that names it, not repeated", swapped.status === 422 && /refresh token/.test(JSON.stringify(swapped.body)) && !JSON.stringify(swapped.body).includes(survivor.proof_refresh_token.slice(5, 25)), `${swapped.status} ${short(swapped.body)}`);
      results.check("the survivor still verifies at the end", (await verifyAs(ctx, "briefcase", survivor.proof_token)).body.valid === true);
    },
  },
  {
    name: "proofs-perf-revoke-on-site",
    title: "the Carbon revokes one OBO proof on /proofs in the browser: only that proof stops verifying at once, dm can't refresh it (revoked_by_account), the card moves to Ended with the reason; another Carbon can neither see nor revoke it; ATA proofs are not the account's; a cross-site revoke is refused",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const carbon = await signInToApp(ctx, "dm");
      const subject = (await appTokens(env, "dm", carbon.uuid)).access_token;
      const mark = randomUUID().slice(0, 8);
      const keep = (await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: [`pp.keep.${mark}`] })).body;
      const gone = (await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: [`pp.revoke.${mark}`] })).body;
      const ata = (await issueAta(ctx, "commit", { audiences: ["remind"] })).body;

      const listed = (await carbon.session.call<{ items: MyProofItem[] }>("GET", "/v1/me/proofs?limit=200")).body.items ?? [];
      results.check("GET /v1/me/proofs lists both OBO proofs about the Carbon and no ATA proof", listed.some(item => item.proof_id === keep.proof_id) && listed.some(item => item.proof_id === gone.proof_id) && !listed.some(item => item.proof_id === ata.proof_id) && listed.length === 2, listed.map(item => `${item.proof_id}:${item.status}`).join(", "));

      const context = await newContext(browser);
      await carbon.session.into(context);
      const page = await context.newPage();
      results.watch(page, "revoke-on-site");
      await page.goto(`${env.site}/proofs`);
      const cardOf = (scope: string) => page.getByRole("article", { name: "DM acts at Briefcase for you" }).filter({ hasText: scope });
      const target = cardOf(`pp.revoke.${mark}`);
      await target.waitFor({ timeout: 30_000 });
      await sleep(600);
      results.check("/proofs shows two active DM → Briefcase cards", (await page.getByRole("article", { name: "DM acts at Briefcase for you" }).count()) === 2 && /Active \(2\)/.test(await page.locator("main").innerText()));
      await shot(env, page, "proofs-perf-revoke-01-before", true);
      await target.getByRole("button", { name: /^Revoke/ }).click();
      await target.getByRole("group", { name: /^Revoke .*\?$/ }).getByRole("button", { name: "Revoke", exact: true }).click({ timeout: 10_000 });
      const started = Date.now();
      let verdict = await verifyAs(ctx, "briefcase", gone.proof_token);
      for (let i = 0; i < 60 && !isExactlyInvalid(verdict.body); i++) {
        await sleep(150);
        verdict = await verifyAs(ctx, "briefcase", gone.proof_token);
      }
      results.check("after the click Briefcase's verify of that proof is exactly invalid", isExactlyInvalid(verdict.body), `${Date.now() - started} ms after the confirm: ${JSON.stringify(verdict.body)}`);
      results.metric("revoke confirmed on /proofs → receiving app sees invalid", Date.now() - started);
      results.check("the other proof still verifies", (await verifyAs(ctx, "briefcase", keep.proof_token)).body.valid === true);
      const refresh = await refreshAs(ctx, "dm", gone.proof_refresh_token);
      results.check("dm can't refresh the revoked proof: 410 proof_revoked, reason revoked_by_account", refresh.status === 410 && errorCode(refresh.body) === "proof_revoked" && refresh.body.error?.details?.reason === "revoked_by_account", `${refresh.status} ${short(refresh.body.error)}`);
      const stored = await row(env, `select revoked_by, revoke_reason from proof_families where id = '${gone.proof_id}'`);
      results.check("stored: revoked_by the Carbon's uuid, revoke_reason revoked_by_account", stored?.[0] === carbon.uuid && stored[1] === "revoked_by_account", short(stored));
      const dmView = await appListing(ctx, "dm", gone.proof_id);
      results.check("dm's own listing shows the Carbon revoked it", dmView?.status === "revoked" && dmView.revoke_reason === "revoked_by_account", short(dmView));

      // The card moves to Ended with its reason.
      await page.getByRole("button", { name: /^Ended \(1\)/ }).click({ timeout: 15_000 });
      const ended = cardOf(`pp.revoke.${mark}`);
      await ended.waitFor({ timeout: 10_000 });
      await sleep(1500); // the view switch animates; read and shoot the settled card
      const endedText = (await ended.innerText()).replace(/\s+/g, " ");
      results.check("the Ended view shows the card: Revoked, \"You revoked it\", no Revoke button", /You revoked it/.test(endedText) && /Revoked/.test(endedText) && (await ended.getByRole("button", { name: /^Revoke/ }).count()) === 0, endedText.slice(0, 240));
      await shot(env, page, "proofs-perf-revoke-02-ended", true);
      const history = (await carbon.session.call<{ items: Array<{ id: string; title: string }> }>("GET", "/v1/me/history?kind=proof&limit=50")).body.items ?? [];
      results.check("the Carbon's history has the revocation", history.some(item => item.id === `proof:${gone.proof_id}:revoked`), history.map(item => item.id).join(", ").slice(0, 300));

      // Nobody else, and nothing that is not an OBO proof about the account.
      const stranger = await signInToApp(ctx, "briefcase");
      const theirs = (await stranger.session.call<{ items: MyProofItem[] }>("GET", "/v1/me/proofs?limit=200")).body.items ?? [];
      results.check("another Carbon's /v1/me/proofs does not show these proofs", !theirs.some(item => item.proof_id === keep.proof_id), `${theirs.length} item(s)`);
      const steal = await stranger.session.call<ApiErrorBody>("DELETE", `/v1/me/proofs/${keep.proof_id}`);
      results.check("another Carbon revoking it → 404 proof_not_found, and it still verifies", steal.status === 404 && errorCode(steal.body) === "proof_not_found" && (await verifyAs(ctx, "briefcase", keep.proof_token)).body.valid === true, `${steal.status} ${short(steal.body)}`);
      const ataAsMine = await carbon.session.call<ApiErrorBody>("DELETE", `/v1/me/proofs/${ata.proof_id}`);
      results.check("an ATA proof id at /v1/me/proofs → 404 (ATA proofs are no account's), and it still verifies", ataAsMine.status === 404 && (await verifyAs(ctx, "remind", ata.proof_token)).body.valid === true, `${ataAsMine.status} ${short(ataAsMine.body)}`);
      const crossSite = await carbon.session.call<ApiErrorBody>("DELETE", `/v1/me/proofs/${keep.proof_id}`, undefined, { origin: "http://evil.example" });
      results.check("a revoke with the session cookie from a foreign Origin → 403, and the proof still verifies", crossSite.status === 403 && (await verifyAs(ctx, "briefcase", keep.proof_token)).body.valid === true, `${crossSite.status} ${short(crossSite.body)}`);
      const unauthenticated = await new SiteSession(env).call<ApiErrorBody>("DELETE", `/v1/me/proofs/${keep.proof_id}`);
      results.check("without a session → 401", unauthenticated.status === 401, `${unauthenticated.status} ${short(unauthenticated.body)}`);
      const viaApi = await carbon.session.call<ApiErrorBody | null>("DELETE", `/v1/me/proofs/${keep.proof_id}`);
      results.check("the Carbon revokes the other one through the API (DELETE /v1/me/proofs/{id}) → 204, exactly invalid", viaApi.status === 204 && isExactlyInvalid((await verifyAs(ctx, "briefcase", keep.proof_token)).body), `${viaApi.status} ${short(viaApi.body)}`);
      const [[revokedCount] = []] = await sql(env, `select count(*) from proof_families where account_uuid = '${carbon.uuid}' and revoke_reason = 'revoked_by_account'`);
      results.check("exactly the two proofs the Carbon revoked are stored as revoked_by_account", revokedCount === "2", String(revokedCount));
      await context.close();
    },
  },
];

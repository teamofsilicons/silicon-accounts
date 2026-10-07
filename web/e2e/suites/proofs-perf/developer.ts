/**
 * ATA proofs from the developer platform (UNDERSTANDING.md: on developer.teamofsilicons.com a developer can "make, see
 * and revoke the app's ATA proofs, one app at a time"), and what a developer-platform sign-in can and cannot do with
 * proofs.
 *
 * Commit's owner signs in to the developer site in the browser (its BFF: the hosted pages as the first-party app
 * `developer`, PKCE, the tokens sealed on the developer site's server) and, through the BFF, makes Commit's ATA proofs
 * for exactly one app, sees them listed with their one receiving app, and revokes one (revoked_by_owner). A Carbon who
 * does not own Commit is refused. A developer-platform token (aud = developer) manages the apps a Carbon owns, but it
 * can't read or revoke the Carbon's own OBO proofs (that is the account site's), nor issue or verify proofs (apps do).
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, developerApi, fakeApp, newContext, shot, signInOnDeveloper, sleep, sql } from "../../lib";
import {
  SiteSession,
  appListing,
  appTokens,
  asBearer,
  audienceOf,
  developerSignIn,
  errorCode,
  isExactlyInvalid,
  issueObo,
  namesOnly,
  newEmail,
  refreshAs,
  row,
  short,
  signInToApp,
  verifyAs,
  watchOutside,
  type ApiErrorBody,
  type AppProofItem,
  type IssuedProof,
  type MyProofItem,
} from "./_helpers";

export const journey: Journey = {
  name: "proofs-perf-developer-ata",
  title: "commit's owner on the developer site (signed in through its BFF) makes ATA proofs for exactly one app (a body naming several apps refused with ata_single_app), sees them with their one receiving app and revokes one (revoked_by_owner: invalid at once, unrefreshable); a Carbon who doesn't own commit is refused; a developer-platform token manages owned apps' proofs but can't read or revoke the Carbon's own OBO proofs (token_wrong_audience), issue or verify proofs",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page = await context.newPage();
    // A request that leaves the machine is judged once, by the check at the end (its outcome depends on the internet:
    // when it fails, the browser reports it too, e.g. net::ERR_BLOCKED_BY_ORB).
    results.watch(page, "developer-ata", [DEVELOPER_SIGNED_OUT, /https:\/\/iris\.teamofsilicons\.com\//]);
    const outside = watchOutside(page);
    const owner = fakeApp("commit").owner_email;
    const scope = `pp.dev.${randomUUID().slice(0, 8)}`;

    // The owner signs in to the developer site (the hosted pages as `developer`, PKCE, /auth/callback on its server).
    const started = Date.now();
    await signInOnDeveloper(env, page, owner, { returnTo: "/apps/commit/ata" });
    results.metric("developer site sign-in through its BFF", Date.now() - started);
    const me = await developerApi<{ id?: string; uuid?: string }>(env, page, "/me");
    results.check("commit's owner is signed in to the developer site (its BFF answers GET /me as c:saket)", me.status === 200 && me.body.id === "c:saket", `${me.status} ${short(me.body)}`);
    const ownerUuid = me.body.uuid ?? "";

    // One proof for one app, through the BFF (the ATA page's POST /v1/apps/commit/proofs/ata).
    const key = randomUUID();
    const made = await developerApi<IssuedProof>(env, page, "/apps/commit/proofs/ata", { json: { receiving_app: "remind", scopes: [scope], access_ttl_seconds: 600 }, headers: { "idempotency-key": key } });
    results.check("the owner makes Commit an ATA proof for remind through the developer site → 201: kind ata, issuing commit, receiving_app remind, user null", made.status === 201 && made.body.kind === "ata" && made.body.issuing_app === "commit" && namesOnly(made.body, "remind") && made.body.user === null && made.body.proof_token?.startsWith("sap_") === true, `${made.status} ${short(made.body)}`);
    const atRemind = await verifyAs(ctx, "remind", made.body.proof_token);
    const atWaveform = await verifyAs(ctx, "waveform", made.body.proof_token);
    results.check("remind verifies it (issued by commit, for remind); waveform gets exactly {valid:false, expires_at:null}", atRemind.body.valid === true && atRemind.body.issuing_app?.app_id === "commit" && atRemind.body.receiving_app?.app_id === "remind" && isExactlyInvalid(atWaveform.body), `${short(atRemind.body)} / ${JSON.stringify(atWaveform.body)}`);
    const again = await developerApi<IssuedProof>(env, page, "/apps/commit/proofs/ata", { json: { receiving_app: "remind", scopes: [scope], access_ttl_seconds: 600 }, headers: { "idempotency-key": key } });
    const [[stored] = []] = await sql(env, `select count(*) from proof_families where '${scope}' = any(scopes)`);
    results.check("the same request again with its Idempotency-Key (forwarded by the BFF) is the same proof, not a second one", again.status === 201 && again.body.proof_id === made.body.proof_id && again.body.proof_token === made.body.proof_token && stored === "1", `${again.status} ${short(again.body.proof_id)}; stored ${stored}`);
    const idemScope = await row(env, `select scope from idempotency_keys where key = '${key}'`);
    results.check("…kept under the owner's own key space (account:<uuid> POST /v1/apps/commit/proofs/ata), apart from the app's", idemScope?.[0] === `account:${ownerUuid} POST /v1/apps/commit/proofs/ata`, short(idemScope));

    // Several apps at once: refused, nothing made.
    const several = await developerApi<ApiErrorBody>(env, page, "/apps/commit/proofs/ata", { json: { audiences: ["remind", "waveform"], scopes: [`${scope}.several`] }, headers: { "idempotency-key": randomUUID() } });
    const [[severalStored] = []] = await sql(env, `select count(*) from proof_families where '${scope}.several' = any(scopes)`);
    results.check(
      "a proof for remind and waveform at once through the developer site → 422 ata_single_app, the hint naming receiving_app and POST /v1/apps/commit/proofs/ata; nothing made",
      several.status === 422 && several.body.error?.code === "ata_single_app" && /receiving_app/.test(several.body.error.hint ?? "") && (several.body.error.hint ?? "").includes("POST /v1/apps/commit/proofs/ata") && severalStored === "0",
      `${several.status} ${short(several.body, 400)}; stored ${severalStored}`,
    );
    const second = await developerApi<IssuedProof>(env, page, "/apps/commit/proofs/ata", { json: { receiving_app: "waveform", scopes: [scope] }, headers: { "idempotency-key": randomUUID() } });
    results.check("…the way to reach waveform too is a second proof, for waveform alone, which waveform verifies", second.status === 201 && namesOnly(second.body, "waveform") && second.body.proof_id !== made.body.proof_id && (await verifyAs(ctx, "waveform", second.body.proof_token)).body.valid === true, `${second.status} ${short(second.body.receiving_app ?? second.body)}`);

    // The listing the ATA page shows.
    const listing = await developerApi<{ items?: AppProofItem[] }>(env, page, "/apps/commit/proofs?kind=ata&limit=50");
    const entry = (id: string) => listing.body.items?.find(item => item.proof_id === id);
    results.check("Commit's ATA listing through the developer site has both, each with its one receiving_app (remind, waveform), active", listing.status === 200 && namesOnly(entry(made.body.proof_id), "remind") && namesOnly(entry(second.body.proof_id), "waveform") && entry(made.body.proof_id)?.status === "active", `${listing.status} ${short([entry(made.body.proof_id), entry(second.body.proof_id)])}`);
    await page.goto(`${env.developer}/apps/commit/ata`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(800);
    await shot(env, page, "proofs-perf-developer-01-ata-tab");

    // The owner revokes the proof for remind.
    const revoked = await developerApi<ApiErrorBody | null>(env, page, `/apps/commit/proofs/${made.body.proof_id}`, { method: "DELETE" });
    const afterRevoke = await verifyAs(ctx, "remind", made.body.proof_token);
    results.check("the owner revokes it on the developer site (DELETE through the BFF → 204): remind's next verify is exactly invalid", revoked.status === 204 && isExactlyInvalid(afterRevoke.body), `${revoked.status} ${short(revoked.body)}; ${JSON.stringify(afterRevoke.body)}`);
    const listed = await appListing(ctx, "commit", made.body.proof_id, "&kind=ata");
    results.check("Commit's listing says revoked, revoke_reason revoked_by_owner", listed?.status === "revoked" && listed.revoke_reason === "revoked_by_owner" && !!listed.revoked_at, short(listed));
    const storedRevoke = await row(env, `select f.revoked_by, f.revoke_reason, a.actor_kind, a.actor_id from proof_families f join audit_log a on a.target_id = f.id::text and a.action = 'proof.revoked' where f.id = '${made.body.proof_id}'`);
    results.check("stored: revoked by the owner's uuid (revoked_by_owner), audited with the owner as the actor", storedRevoke?.[0] === ownerUuid && storedRevoke[1] === "revoked_by_owner" && storedRevoke[2] === "account" && storedRevoke[3] === ownerUuid, short(storedRevoke));
    const refreshAfter = await refreshAs(ctx, "commit", made.body.proof_refresh_token);
    results.check("Commit can't refresh it → 410 proof_revoked, reason revoked_by_owner", refreshAfter.status === 410 && errorCode(refreshAfter.body) === "proof_revoked" && refreshAfter.body.error?.details?.reason === "revoked_by_owner", `${refreshAfter.status} ${short(refreshAfter.body.error)}`);
    results.check("waveform's proof is untouched and still verifies", (await verifyAs(ctx, "waveform", second.body.proof_token)).body.valid === true);
    const notProxied = await developerApi<ApiErrorBody>(env, page, "/me/proofs");
    results.check("the developer site never forwards the Carbon's own OBO proofs: GET /api/accounts/me/proofs → 404 not_proxied", notProxied.status === 404 && notProxied.body.error?.code === "not_proxied", `${notProxied.status} ${short(notProxied.body)}`);

    // The owner's developer-platform token, as the developer site's server holds it (aud = developer).
    const accountCookies = await context.cookies(env.site);
    const ownerSession = new SiteSession(env);
    for (const cookie of accountCookies) ownerSession.jar.set(cookie.name, cookie.value);
    const ownerTokens = await developerSignIn(ctx, { session: ownerSession });
    results.check("the owner's developer-platform sign-in (PKCE, no secret, Continue as) gives an access token for the audience developer", audienceOf(ownerTokens.access_token) === "developer", audienceOf(ownerTokens.access_token));
    const ownerList = await asBearer<{ items?: AppProofItem[] }>(ctx, ownerTokens.access_token, "GET", "/v1/apps/commit/proofs?kind=ata&limit=5");
    results.check("…which lists Commit's proofs (an owner route)", ownerList.status === 200 && Array.isArray(ownerList.body.items), `${ownerList.status} ${short(ownerList.body, 200)}`);
    const ownerIssue = await asBearer<IssuedProof>(ctx, ownerTokens.access_token, "POST", "/v1/apps/commit/proofs/ata", { receiving_app: "remind", scopes: [`${scope}.token`] }, { key: randomUUID() });
    results.check("…and makes Commit a proof for one app (201, receiving_app remind)", ownerIssue.status === 201 && namesOnly(ownerIssue.body, "remind"), `${ownerIssue.status} ${short(ownerIssue.body.receiving_app ?? ownerIssue.body)}`);
    const ownerVerify = await asBearer<ApiErrorBody>(ctx, ownerTokens.access_token, "POST", "/v1/proofs/verify", { proof_token: ownerIssue.body.proof_token });
    results.check("…but can't verify a proof (only apps verify, with their credentials) → 401, no verdict", ownerVerify.status === 401 && !("valid" in (ownerVerify.body as object)), `${ownerVerify.status} ${short(ownerVerify.body)}`);
    const ownerAta = await asBearer<ApiErrorBody>(ctx, ownerTokens.access_token, "POST", "/v1/proofs/ata", { receiving_app: "remind" }, { key: randomUUID() });
    results.check("…nor issue on the apps' own endpoint POST /v1/proofs/ata (app credentials only) → 401", ownerAta.status === 401, `${ownerAta.status} ${short(ownerAta.body)}`);

    // A Carbon who owns no app: signed into dm (so it has OBO proofs of its own), then into the developer platform.
    const stranger = await signInToApp(ctx, "dm", { email: newEmail("dev-stranger") });
    const strangerSubject = (await appTokens(env, "dm", stranger.uuid)).access_token;
    const theirProof = (await issueObo(ctx, "dm", strangerSubject, { receiving_app: "briefcase", scopes: ["pp.dev-stranger"] })).body;
    const strangerTokens = await developerSignIn(ctx, { session: stranger.session });
    results.check("another Carbon's developer-platform token (Continue as) has the audience developer", audienceOf(strangerTokens.access_token) === "developer", audienceOf(strangerTokens.access_token));
    const strangerMe = await asBearer<{ id?: string }>(ctx, strangerTokens.access_token, "GET", "/v1/me");
    results.check("…GET /v1/me works with it (an identity read on the developer audience's list)", strangerMe.status === 200 && strangerMe.body.id === stranger.id, `${strangerMe.status} ${short(strangerMe.body)}`);
    const strangerList = await asBearer<ApiErrorBody>(ctx, strangerTokens.access_token, "GET", "/v1/apps/commit/proofs");
    const strangerMake = await asBearer<ApiErrorBody>(ctx, strangerTokens.access_token, "POST", "/v1/apps/commit/proofs/ata", { receiving_app: "remind" }, { key: randomUUID() });
    const strangerRevoke = await asBearer<ApiErrorBody>(ctx, strangerTokens.access_token, "DELETE", `/v1/apps/commit/proofs/${second.body.proof_id}`);
    results.check(
      "…but it is not Commit's owner: listing, making and revoking Commit's proofs → 403 not_app_owner, and waveform's proof still verifies",
      [strangerList, strangerMake, strangerRevoke].every(answer => answer.status === 403 && errorCode(answer.body) === "not_app_owner") && (await verifyAs(ctx, "waveform", second.body.proof_token)).body.valid === true,
      [strangerList, strangerMake, strangerRevoke].map(answer => `${answer.status} ${errorCode(answer.body)}`).join(", "),
    );
    const myProofs = await asBearer<ApiErrorBody>(ctx, strangerTokens.access_token, "GET", "/v1/me/proofs");
    results.check("a developer-platform token can't read the Carbon's own OBO proofs: GET /v1/me/proofs → 401 token_wrong_audience (details.aud developer)", myProofs.status === 401 && errorCode(myProofs.body) === "token_wrong_audience" && myProofs.body.error.details?.aud === "developer", `${myProofs.status} ${short(myProofs.body)}`);
    const revokeMine = await asBearer<ApiErrorBody>(ctx, strangerTokens.access_token, "DELETE", `/v1/me/proofs/${theirProof.proof_id}`);
    const stillValid = await verifyAs(ctx, "briefcase", theirProof.proof_token);
    results.check("…nor revoke one: DELETE /v1/me/proofs/{id} → 401 token_wrong_audience, and Briefcase still verifies the proof", revokeMine.status === 401 && errorCode(revokeMine.body) === "token_wrong_audience" && stillValid.body.valid === true, `${revokeMine.status} ${short(revokeMine.body)}; ${short(stillValid.body)}`);
    const siteList = await stranger.session.call<{ items?: MyProofItem[] }>("GET", "/v1/me/proofs?limit=50");
    const siteRevoke = await stranger.session.call<ApiErrorBody | null>("DELETE", `/v1/me/proofs/${theirProof.proof_id}`);
    results.check("the account site's own session lists it and revokes it (204), and then it is exactly invalid", siteList.status === 200 && !!siteList.body.items?.some(item => item.proof_id === theirProof.proof_id) && siteRevoke.status === 204 && isExactlyInvalid((await verifyAs(ctx, "briefcase", theirProof.proof_token)).body), `${siteList.status} ${siteRevoke.status}`);

    // The developer site's pages showed commit's owner (a seeded account): nothing they loaded may come from outside the
    // machine (README: "Nothing a page loads should leave the machine").
    const left = outside();
    const seeded = left.length ? (await sql(env, "select handle || ' ' || pfp_url from accounts where pfp_url not like 'http://127.0.0.1:%' and pfp_url not like 'http://localhost:%' and status <> 'deleted' order by number limit 20")).map(cells => cells.join("|")) : [];
    results.check(
      "nothing the developer site's pages loaded for commit's owner left the machine (every request to localhost or 127.0.0.1)",
      left.length === 0,
      left.length ? `${left.join(", ")}; accounts whose photo is not on this stack's mock Iris: ${seeded.join(", ")} (the fake apps' owners, created by accounts-seed, which scripts/dev.sh runs with base_env: no ACCOUNTS_IRIS_BASE_URL, so the production default https://iris.teamofsilicons.com)` : "none",
    );
    await context.close();
  },
};

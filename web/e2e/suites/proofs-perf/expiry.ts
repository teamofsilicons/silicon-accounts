/**
 * Expiry, by time travel in the stack's database (never by waiting): a proof token issued with access_ttl_seconds 60
 * is stored to expire 60 s after the proof was issued, verifies while its expires_at is ahead and is exactly invalid
 * once it is behind (through the site and straight at accounts-api), and the issuing app refreshes it into a new 60 s
 * token; an expired proof token of a longer-lived proof (the proof lives on: the issuing app refreshes it), a proof past
 * its own lifetime, and an OBO proof whose sign-in expired. Every expiry answer is exactly {valid:false, expires_at:null}.
 */
import type { Journey } from "../../context";
import { sql } from "../../lib";
import { appListing, appTokens, errorCode, familyOf, isExactlyInvalid, issueObo, row, secondsBetween, short, signInToApp, refreshAs, verifyAs, type MyProofItem } from "./_helpers";

export const journey: Journey = {
  name: "proofs-perf-expiry",
  title: "a 60 s proof token (stored to expire 60 s after issue) verifies while its expires_at is ahead and is exactly invalid once it is behind, then refreshes into a new 60 s token; an expired token of a longer proof (refreshable), a proof past its lifetime (410 proof_expired) and an OBO proof whose sign-in expired — all by SQL time travel, no waiting",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await signInToApp(ctx, "dm");
    const subject = (await appTokens(env, "dm", carbon.uuid)).access_token;

    // A 60-second proof token: its stored lifetime, then its expiry moved instead of waited for.
    const short60 = await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", access_ttl_seconds: 60, scopes: ["files.read"] });
    const p60 = short60.body;
    const life = await row(env, `select extract(epoch from (t.expires_at - f.created_at)) from proof_tokens t join proof_families f on f.id = t.family_id where f.id = '${p60.proof_id}' and t.kind = 'access'`);
    results.check("access_ttl_seconds 60: the proof token expires 60 s after the proof was issued (database clock)", short60.status === 201 && Math.abs(Number(life?.[0]) - 60) < 0.05, `${short60.status} ${life?.[0]} s`);
    const left60 = secondsBetween(p60.expires_at, new Date().toISOString());
    results.check("…the issue answer's expires_at is 60 s away", left60 > 55 && left60 <= 61, `${left60.toFixed(1)} s`);
    const now60 = await verifyAs(ctx, "briefcase", p60.proof_token);
    results.check("…and it verifies right away with that expires_at", now60.body.valid === true && now60.body.expires_at === p60.expires_at, short(now60.body));
    const moveToken = (proofId: string, interval: string) => sql(env, `update proof_tokens set expires_at = now() + interval '${interval}' where family_id = '${proofId}' and kind = 'access'`);
    // 57 s later: 3 s left. Verify reads the expiry live and still says valid, naming the (moved) expires_at.
    await moveToken(p60.proof_id, "3 seconds");
    const justBefore = await verifyAs(ctx, "briefcase", p60.proof_token);
    const leftBefore = (Date.parse(justBefore.body.expires_at ?? "") - Date.now()) / 1000;
    results.check("moved to 3 s before its expires_at, it still verifies, with the moved expires_at (read live, not cached)", justBefore.body.valid === true && leftBefore > 0 && leftBefore <= 3.5, `${leftBefore.toFixed(2)} s left: ${short(justBefore.body)}`);
    // 61 s later: 1 s past it.
    await moveToken(p60.proof_id, "-1 second");
    const justAfter = await verifyAs(ctx, "briefcase", p60.proof_token);
    results.check("moved to 1 s past its expires_at, it is exactly {valid:false, expires_at:null}", isExactlyInvalid(justAfter.body), JSON.stringify(justAfter.body));
    const direct = await verifyAs(ctx, "briefcase", p60.proof_token, { direct: true });
    results.check("…straight at accounts-api too", isExactlyInvalid(direct.body), JSON.stringify(direct.body));
    const fresh = await refreshAs(ctx, "dm", p60.proof_refresh_token);
    const freshLife = fresh.status === 200 ? (Date.parse(fresh.body.expires_at) - Date.now()) / 1000 : Number.NaN;
    results.check("dm refreshes the expired 60 s proof: the same proof, a new token with the proof's own 60 s lifetime that verifies", fresh.status === 200 && fresh.body.proof_id === p60.proof_id && freshLife > 55 && freshLife <= 61 && (await verifyAs(ctx, "briefcase", fresh.body.proof_token)).body.valid === true, `${fresh.status} ${freshLife.toFixed(1)} s ${short(fresh.body.error)}`);
    results.check("…while the expired token stays exactly invalid", isExactlyInvalid((await verifyAs(ctx, "briefcase", p60.proof_token)).body));

    // Time travel 1: the proof token expired, the proof did not: verify says invalid, the issuing app refreshes it.
    const a = (await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", access_ttl_seconds: 600 })).body;
    results.check("a 600 s proof verifies", (await verifyAs(ctx, "briefcase", a.proof_token)).body.valid === true);
    await sql(env, `update proof_tokens set expires_at = now() - interval '1 second' where family_id = '${a.proof_id}' and kind = 'access'`);
    const expiredToken = await verifyAs(ctx, "briefcase", a.proof_token);
    results.check("its proof token moved past expires_at → exactly {valid:false, expires_at:null}", isExactlyInvalid(expiredToken.body), JSON.stringify(expiredToken.body));
    const listedA = await appListing(ctx, "dm", a.proof_id);
    results.check("dm's listing still has the proof active (only its token ran out), with token_expires_at in the past", listedA?.status === "active" && !!listedA.token_expires_at && Date.parse(listedA.token_expires_at) < Date.now(), short(listedA));
    const renewed = await refreshAs(ctx, "dm", a.proof_refresh_token);
    results.check("dm refreshes it: 200, the same proof, a new 600 s token", renewed.status === 200 && renewed.body.proof_id === a.proof_id && Date.parse(renewed.body.expires_at) - Date.now() > 590_000, `${renewed.status} ${short(renewed.body.error ?? renewed.body.expires_at)}`);
    results.check("the new token verifies; the expired one still does not", (await verifyAs(ctx, "briefcase", renewed.body.proof_token)).body.valid === true && isExactlyInvalid((await verifyAs(ctx, "briefcase", a.proof_token)).body));

    // Time travel 2: the proof itself past its lifetime (900 days, or the end of its sign-in).
    const b = (await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", access_ttl_seconds: 1800, scopes: ["pp.lifetime"] })).body;
    await sql(env, `update proof_families set expires_at = now() - interval '1 second' where id = '${b.proof_id}'`);
    const pastLife = await verifyAs(ctx, "briefcase", b.proof_token);
    results.check("a proof past its lifetime → exactly invalid, although its token's own expiry is 30 minutes away", isExactlyInvalid(pastLife.body), JSON.stringify(pastLife.body));
    const lateRefresh = await refreshAs(ctx, "dm", b.proof_refresh_token);
    results.check("refreshing it → 410 proof_expired with details.expires_at", lateRefresh.status === 410 && errorCode(lateRefresh.body) === "proof_expired" && typeof lateRefresh.body.error?.details?.expires_at === "string", `${lateRefresh.status} ${short(lateRefresh.body.error)}`);
    const listedB = await appListing(ctx, "dm", b.proof_id);
    results.check("dm's listing reports it expired (not revoked, no revoke reason)", listedB?.status === "expired" && listedB.revoke_reason === null && listedB.revoked_at === null, short(listedB));
    const mineB = (await carbon.session.call<{ items: MyProofItem[] }>("GET", "/v1/me/proofs?limit=200")).body.items?.find(item => item.proof_id === b.proof_id);
    results.check("the Carbon's /v1/me/proofs reports it expired", mineB?.status === "expired", short(mineB));
    const stillTokenAfterRefresh = await row(env, `select count(*) from proof_tokens where family_id = '${b.proof_id}' and used_at is not null`);
    results.check("the refused refresh did not consume the refresh token", stillTokenAfterRefresh?.[0] === "0", short(stillTokenAfterRefresh));

    // Time travel 3: an OBO proof never outlives the sign-in it stands on (a second Carbon, whose dm sign-in expires).
    const other = await signInToApp(ctx, "dm");
    const otherSubject = (await appTokens(env, "dm", other.uuid)).access_token;
    const c = (await issueObo(ctx, "dm", otherSubject, { receiving_app: "briefcase", access_ttl_seconds: 1800 })).body;
    results.check("the second Carbon's proof verifies before its sign-in ends", (await verifyAs(ctx, "briefcase", c.proof_token)).body.valid === true);
    // Its sign-in now ends in 30 s: a new proof asking for 1800 s gets a token and a lifetime that end with the sign-in.
    await sql(env, `update token_families set expires_at = now() + interval '30 seconds' where id = '${familyOf(otherSubject)}'`);
    const capped = await issueObo(ctx, "dm", otherSubject, { receiving_app: "briefcase", access_ttl_seconds: 1800 });
    const cappedToken = (Date.parse(capped.body.expires_at) - Date.now()) / 1000;
    const cappedLife = (Date.parse(capped.body.refresh_expires_at) - Date.now()) / 1000;
    results.check("a sign-in ending in 30 s caps a new proof: its 1800 s token and its whole lifetime end with the sign-in", capped.status === 201 && cappedToken > 20 && cappedToken <= 31 && cappedLife > 20 && cappedLife <= 31 && capped.body.expires_at === capped.body.refresh_expires_at, `${capped.status} token ${cappedToken.toFixed(1)} s, proof ${cappedLife.toFixed(1)} s`);
    await sql(env, `update token_families set expires_at = now() - interval '1 second' where id = '${familyOf(otherSubject)}'`);
    results.check("…and that capped proof is exactly invalid once the sign-in has ended", isExactlyInvalid((await verifyAs(ctx, "briefcase", capped.body.proof_token)).body));
    const signInGone = await verifyAs(ctx, "briefcase", c.proof_token);
    results.check("its dm sign-in expired → the proof is exactly invalid at once (no sweep needed)", isExactlyInvalid(signInGone.body), JSON.stringify(signInGone.body));
    const refreshAfterSignIn = await refreshAs(ctx, "dm", c.proof_refresh_token);
    results.check("refreshing it → 410 proof_expired, details.reason sign_in_expired", refreshAfterSignIn.status === 410 && errorCode(refreshAfterSignIn.body) === "proof_expired" && refreshAfterSignIn.body.error?.details?.reason === "sign_in_expired", `${refreshAfterSignIn.status} ${short(refreshAfterSignIn.body.error)}`);
    const listedC = await appListing(ctx, "dm", c.proof_id);
    results.check("dm's listing reports it expired", listedC?.status === "expired", short(listedC));
    const reissue = await issueObo(ctx, "dm", otherSubject, { receiving_app: "briefcase" });
    results.check("a new proof from the expired sign-in's access token → 400 invalid_subject_token (reason expired)", reissue.status === 400 && errorCode(reissue.body) === "invalid_subject_token" && reissue.body.error?.details?.reason === "expired", `${reissue.status} ${short(reissue.body.error)}`);
  },
};

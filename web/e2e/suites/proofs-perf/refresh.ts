/**
 * Refresh and reuse detection, the sign-in token logic applied to proofs: every refresh rotates both tokens of the
 * same proof; a used refresh token presented again revokes the whole proof; only the issuing app refreshes; an
 * Idempotency-Key makes a retried refresh replay instead of tripping reuse detection, even when the retries race.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { sql } from "../../lib";
import { appListing, appTokens, errorCode, isExactlyInvalid, issueObo, row, short, signInToApp, refreshAs, verifyAs, type IssuedProof, type MyProofItem } from "./_helpers";

export const journey: Journey = {
  name: "proofs-perf-refresh-reuse",
  title: "refresh rotates both tokens of the same proof (old proof tokens live out their lifetime), keeps or overrides the token lifetime, only for the issuing app; a reused refresh token revokes the proof; idempotent refreshes replay; a retry storm without a key rotates once",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await signInToApp(ctx, "dm");
    const subject = (await appTokens(env, "dm", carbon.uuid)).access_token;
    const p0 = (await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", access_ttl_seconds: 600, scopes: ["files.write"] })).body;

    // A refresh: same proof, both tokens new, the absolute lifetime unchanged.
    const r1 = await refreshAs(ctx, "dm", p0.proof_refresh_token);
    const p1 = r1.body;
    results.check("refresh → 200 with Cache-Control: no-store", r1.status === 200 && r1.headers.get("cache-control") === "no-store", `${r1.status} ${short(p1.error)}`);
    results.check("the same proof (proof_id, kind, receiving app, user, scopes) with a new proof token and a new refresh token", p1.proof_id === p0.proof_id && p1.kind === "obo" && p1.receiving_app === "briefcase" && JSON.stringify(p1.user) === JSON.stringify(p0.user) && JSON.stringify(p1.scopes) === '["files.write"]' && p1.proof_token !== p0.proof_token && p1.proof_refresh_token !== p0.proof_refresh_token, short(p1));
    results.check("refresh_expires_at is unchanged (a proof's lifetime is absolute) and the new token keeps the proof's 600 s", p1.refresh_expires_at === p0.refresh_expires_at && Math.abs((Date.parse(p1.expires_at) - Date.now()) / 1000 - 600) < 30, `${p1.refresh_expires_at} vs ${p0.refresh_expires_at}; ${p1.expires_at}`);
    const old = await verifyAs(ctx, "briefcase", p0.proof_token);
    const fresh = await verifyAs(ctx, "briefcase", p1.proof_token);
    results.check("both the new and the previous proof token verify (a proof token lives out its own lifetime, like an access token)", fresh.body.valid === true && old.body.valid === true && fresh.body.proof_id === p0.proof_id, `${short(fresh.body.valid)} / ${short(old.body.valid)}`);

    // Lifetime per refresh.
    const p2 = (await refreshAs(ctx, "dm", p1.proof_refresh_token, { access_ttl_seconds: 60 })).body;
    results.check("a refresh may ask for a different lifetime for that token only (60 s)", Math.abs((Date.parse(p2.expires_at) - Date.now()) / 1000 - 60) < 10, p2.expires_at ?? short(p2.error));
    const p3 = (await refreshAs(ctx, "dm", p2.proof_refresh_token)).body;
    results.check("the next refresh is back to the proof's own 600 s", Math.abs((Date.parse(p3.expires_at) - Date.now()) / 1000 - 600) < 30, p3.expires_at ?? short(p3.error));
    const badTtl = await refreshAs(ctx, "dm", p3.proof_refresh_token, { access_ttl_seconds: 59 });
    results.check("access_ttl_seconds 59 on a refresh → 422", badTtl.status === 422 && errorCode(badTtl.body) === "validation_failed", `${badTtl.status} ${short(badTtl.body.error)}`);

    // Only the issuing app refreshes; a refused attempt does not use the token up.
    const foreign = await refreshAs(ctx, "briefcase", p3.proof_refresh_token);
    results.check("Briefcase (the receiver) refreshing dm's proof → 403 not_issuing_app, naming the issuing app", foreign.status === 403 && errorCode(foreign.body) === "not_issuing_app" && /'dm'/.test(foreign.body.error?.message ?? ""), `${foreign.status} ${short(foreign.body.error)}`);
    const wrongKind = await refreshAs(ctx, "dm", p3.proof_token);
    results.check("a proof token instead of the refresh token → 400 invalid_proof_refresh_token, not repeated", wrongKind.status === 400 && errorCode(wrongKind.body) === "invalid_proof_refresh_token" && !JSON.stringify(wrongKind.body).includes(p3.proof_token.slice(4, 24)), `${wrongKind.status} ${short(wrongKind.body.error)}`);
    const wrapped = await refreshAs(ctx, "dm", `Bearer ${p3.proof_refresh_token}`);
    results.check('"Bearer sapr_…" → 400 invalid_proof_refresh_token that says to send the value alone, not repeated', wrapped.status === 400 && /other text around it/.test(wrapped.body.error?.message ?? "") && !JSON.stringify(wrapped.body).includes(p3.proof_refresh_token.slice(5, 25)), `${wrapped.status} ${short(wrapped.body.error)}`);
    const unknown = await refreshAs(ctx, "dm", `sapr_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`);
    results.check("an unknown refresh token → 400 invalid_proof_refresh_token", unknown.status === 400 && errorCode(unknown.body) === "invalid_proof_refresh_token", `${unknown.status} ${short(unknown.body.error)}`);
    const p4answer = await refreshAs(ctx, "dm", p3.proof_refresh_token);
    results.check("after those refusals dm's refresh token still works (200): refused attempts don't use it up", p4answer.status === 200, `${p4answer.status} ${short(p4answer.body.error)}`);
    const p4 = p4answer.body;

    // An idempotent refresh: the retry replays the first answer instead of tripping reuse detection.
    const key = randomUUID();
    const first = await refreshAs(ctx, "dm", p4.proof_refresh_token, {}, { key });
    const retry = await refreshAs(ctx, "dm", p4.proof_refresh_token, {}, { key });
    results.check("a refresh retried with the same Idempotency-Key replays the same answer (Idempotent-Replayed: true)", first.status === 200 && retry.status === 200 && retry.headers.get("idempotent-replayed") === "true" && JSON.stringify(retry.body) === JSON.stringify(first.body), `${first.status}/${retry.status} replayed=${retry.headers.get("idempotent-replayed")}`);
    const p5 = first.body;
    const stillActive = await appListing(ctx, "dm", p0.proof_id);
    results.check("…and the proof is still active", stillActive?.status === "active" && (await verifyAs(ctx, "briefcase", p5.proof_token)).body.valid === true, short(stillActive));
    const [[refreshes] = []] = await sql(env, `select count(*) from audit_log where action = 'proof.refreshed' and target_id = '${p0.proof_id}' and account_uuid is null`);
    results.check("each real refresh is audited once (5), outside the account's history; the replay is not a refresh", refreshes === "5", String(refreshes));
    const listed = await appListing(ctx, "dm", p0.proof_id);
    results.check("dm's listing shows last_refreshed_at", !!listed?.last_refreshed_at, short(listed));

    // Reuse detection: the first refresh token, used long ago, comes back → the whole proof is revoked.
    const reuse = await refreshAs(ctx, "dm", p0.proof_refresh_token);
    results.check("presenting an already used refresh token → 400 proof_refresh_token_reused (details.proof_id)", reuse.status === 400 && errorCode(reuse.body) === "proof_refresh_token_reused" && reuse.body.error?.details?.proof_id === p0.proof_id, `${reuse.status} ${short(reuse.body.error)}`);
    for (const [label, token] of [["the newest", p5.proof_token], ["an older, unexpired", p1.proof_token], ["the first", p0.proof_token]] as const) {
      const answer = await verifyAs(ctx, "briefcase", token);
      results.check(`after the reuse ${label} proof token → exactly invalid`, isExactlyInvalid(answer.body), JSON.stringify(answer.body));
    }
    const newest = await refreshAs(ctx, "dm", p5.proof_refresh_token);
    results.check("the newest refresh token → 410 proof_revoked (reason refresh_token_reuse)", newest.status === 410 && errorCode(newest.body) === "proof_revoked" && newest.body.error?.details?.reason === "refresh_token_reuse", `${newest.status} ${short(newest.body.error)}`);
    const revoked = await appListing(ctx, "dm", p0.proof_id);
    results.check("dm's listing: revoked, revoke_reason refresh_token_reuse", revoked?.status === "revoked" && revoked.revoke_reason === "refresh_token_reuse" && !!revoked.revoked_at, short(revoked));
    const mine = (await carbon.session.call<{ items: MyProofItem[] }>("GET", "/v1/me/proofs?limit=200")).body.items?.find(item => item.proof_id === p0.proof_id);
    results.check("the Carbon's /v1/me/proofs: revoked because the refresh token was reused", mine?.status === "revoked" && mine.revoke_reason === "refresh_token_reuse", short(mine));
    const audit = await row(env, `select count(*) filter (where action = 'proof.refresh_token_reused'), max(account_uuid) from audit_log where target_id = '${p0.proof_id}'`);
    results.check("the reuse is in the audit log, tied to the Carbon", audit?.[0] === "1" && audit[1] === carbon.uuid, short(audit));
    const history = (await carbon.session.call<{ items: Array<{ id: string }> }>("GET", "/v1/me/history?kind=proof&limit=50")).body.items ?? [];
    results.check("the Carbon's history shows the proof issued and revoked", history.some(item => item.id === `proof:${p0.proof_id}:issued`) && history.some(item => item.id === `proof:${p0.proof_id}:revoked`), history.map(item => item.id).join(", ").slice(0, 300));

    // A retry storm without a key: the token row lock serializes them, one rotation, one reuse, the rest find it revoked.
    const q = (await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: ["pp.storm"] })).body;
    const storm = await Promise.all(Array.from({ length: 8 }, () => refreshAs(ctx, "dm", q.proof_refresh_token)));
    const codes = storm.map(answer => (answer.status === 200 ? "200" : `${answer.status} ${errorCode(answer.body)}`)).sort();
    const count = (code: string) => codes.filter(value => value === code).length;
    results.check("8 simultaneous refreshes with one token, no key: exactly one rotates it, one is a reuse, six find the proof revoked", count("200") === 1 && count("400 proof_refresh_token_reused") === 1 && count("410 proof_revoked") === 6, codes.join(", "));
    const minted = storm.find(answer => answer.status === 200)?.body as IssuedProof | undefined;
    results.check("…so the proof minted in that race doesn't verify (the storm revoked it)", !!minted && isExactlyInvalid((await verifyAs(ctx, "briefcase", minted.proof_token)).body));

    // The same storm with one Idempotency-Key: one rotation, the rest replay it or are told it is in progress.
    const s = (await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: ["pp.storm-keyed"] })).body;
    const stormKey = randomUUID();
    const keyed = await Promise.all(Array.from({ length: 8 }, () => refreshAs(ctx, "dm", s.proof_refresh_token, {}, { key: stormKey })));
    const ok = keyed.filter(answer => answer.status === 200);
    const busy = keyed.filter(answer => answer.status === 409 && errorCode(answer.body) === "idempotency_in_progress");
    const tokens = new Set(ok.map(answer => answer.body.proof_token));
    results.check("8 simultaneous refreshes with one Idempotency-Key: every answer is the one rotation or 409 idempotency_in_progress", ok.length + busy.length === 8 && ok.length >= 1 && tokens.size === 1, keyed.map(answer => (answer.status === 200 ? `200${answer.headers.get("idempotent-replayed") ? " replay" : ""}` : `${answer.status} ${errorCode(answer.body)}`)).join(", "));
    const sListed = await appListing(ctx, "dm", s.proof_id);
    const [[used] = []] = await sql(env, `select count(*) from proof_tokens where family_id = '${s.proof_id}' and kind = 'refresh' and used_at is not null`);
    results.check("…the proof is still active, rotated exactly once, and its new token verifies", sListed?.status === "active" && used === "1" && (await verifyAs(ctx, "briefcase", [...tokens][0] ?? "")).body.valid === true, `${short(sListed?.status)} used=${used}`);
  },
};

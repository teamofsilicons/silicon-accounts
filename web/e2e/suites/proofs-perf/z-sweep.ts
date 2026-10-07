/**
 * The hourly proof sweep, part 2 of 2 (part 1: 0-sweep-setup.ts); both run only with E2E_PROOFS_SWEEP=1 (_sweep.ts). This file sorts last in the suite: it waits for the
 * stack's first sweep (120 s after accounts-api started, logged as "proof sweep" with what it did), then checks it
 * against the documented maintenance (crates/proofs store::sweep):
 *
 * 1. it stores the end of an OBO proof whose sign-in was revoked (sign_in_revoked, by system, at the moment the sign-in
 *    ended) with exactly one proof.revoked audit entry, so the account's history shows the proof revoked;
 * 2. it deletes proof tokens that expired more than a day ago, and keeps younger ones;
 * 3. it deletes every token of proofs revoked or ended more than 30 days ago, and keeps younger ones;
 *
 * and it keeps what must stay: every proof row (history: "every proof issued and revoked"), the refresh token of a
 * proof whose old proof token it deleted (still refreshable), and a live proof's used refresh token, so presenting it
 * again is still caught as reuse.
 */
import type { Journey } from "../../context";
import { sleep, sql } from "../../lib";
import { appListing, errorCode, isExactlyInvalid, refreshAs, revokeAs, row, short, verifyAs, type MyProofItem } from "./_helpers";
import { FIRST_SWEEP_AFTER_MS, SWEEP_KEY, SWEEP_WAIT_MS, sweepLines, sweepOptIn, type SweepLine, type SweepSetup } from "./_sweep";

export const journey: Journey = {
  name: "proofs-perf-sweep",
  ...sweepOptIn("the stack's first hourly proof sweep: stores the end of the OBO proof whose sign-in ended (sign_in_revoked by system, one audit entry, now in the Carbon's history), deletes proof tokens expired over a day and every token of proofs ended over 30 days, keeps the proofs themselves, younger tokens, the refresh token of a still-live proof and a live proof's used refresh token (reuse still caught)"),
  needs: [SWEEP_KEY],
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results, shared } = ctx;
    const setup = shared[SWEEP_KEY] as SweepSetup;
    if (!setup.measurable) {
      results.check("the sweep was measured: its setup was done before the stack's first sweep", false, `not measured: ${setup.why}`);
      return;
    }

    // Wait for the first sweep's log line (a sweep logs one when it stored or deleted anything, and the setup left it
    // something of each kind). The line is written after every statement of the sweep committed.
    const due = setup.listeningAt + FIRST_SWEEP_AFTER_MS;
    const deadline = due + SWEEP_WAIT_MS;
    const waitStarted = Date.now();
    let sweep: SweepLine | undefined;
    for (;;) {
      sweep = sweepLines(env).find(line => line.at >= setup.listeningAt);
      if (sweep || Date.now() > deadline) break;
      await sleep(1_000);
    }
    results.metric("sweep: waited for the first sweep", Date.now() - waitStarted);
    if (sweep) results.metric("sweep: first sweep ran after accounts-api began listening", sweep.at - setup.listeningAt);
    const afterStart = sweep ? (sweep.at - setup.listeningAt) / 1000 : Number.NaN;
    results.check(
      "the first proof sweep ran 120 s after accounts-api started and logged what it did: ≥ 1 proof end stored, ≥ 1 expired proof token and ≥ 4 tokens of long-ended proofs deleted",
      !!sweep && afterStart >= 115 && afterStart <= 150 && sweep.signInRevocationsRecorded >= 1 && sweep.expiredAccessTokens >= 1 && sweep.deadFamilyTokens >= 4,
      sweep ? `${afterStart.toFixed(1)} s after it began listening: ${sweep.line.slice(0, 300)}` : `no "proof sweep" line in accounts-api's log within ${((deadline - setup.listeningAt) / 1000).toFixed(0)} s of its start (due at ${FIRST_SWEEP_AFTER_MS / 1000} s)`,
    );

    // 1. The proof whose sign-in dm ended: its end is stored, once, at the moment the sign-in ended.
    const ended = setup.signInEnded;
    const stored = await row(env, `select f.revoked_at = tf.revoked_at, coalesce(f.revoked_by, ''), coalesce(f.revoke_reason, '') from proof_families f join token_families tf on tf.id = f.subject_family_id where f.id = '${ended.proof_id}'`);
    results.check("the sweep stored the end of B's proof: revoked_at = when the sign-in ended, revoked_by system, revoke_reason sign_in_revoked", stored?.[0] === "t" && stored[1] === "system" && stored[2] === "sign_in_revoked", short(stored));
    const auditSql = `select count(*), coalesce(min(actor_kind::text), ''), coalesce(min(details->>'via'), ''), coalesce(min(details->>'sign_in_revoke_reason'), ''), coalesce(min(account_uuid), '') from audit_log where action = 'proof.revoked' and target_id = '${ended.proof_id}'`;
    const audit = await row(env, auditSql);
    results.check(`…with exactly one proof.revoked audit entry: by system, via sign_in_revoked, naming why the sign-in ended (${setup.bSignIn.reason || "?"}), under B's account`, audit?.[0] === "1" && audit[1] === "system" && audit[2] === "sign_in_revoked" && audit[3] === setup.bSignIn.reason && audit[4] === setup.b.uuid, short(audit));
    const history = await setup.b.session.call<{ items?: Array<{ id: string; at: string; detail: string | null; meta?: { proof_id?: string; event?: string; reason?: string | null; revoked_by?: string | null } }> }>("GET", "/v1/me/history?kind=proof&limit=50");
    const revokedEntry = (history.body.items ?? []).find(item => item.meta?.proof_id === ended.proof_id && item.meta.event === "revoked");
    results.check('B\'s history (kind=proof) now shows the proof revoked: "Ended when your sign-in at DM ended" (reason sign_in_revoked, by system)', history.status === 200 && revokedEntry?.meta?.reason === "sign_in_revoked" && revokedEntry.meta.revoked_by === "system" && revokedEntry.detail === "Ended when your sign-in at DM ended", `${history.status} ${short(revokedEntry ?? history.body.items?.map(item => item.id))}`);
    const listedEnded = await appListing(ctx, "dm", ended.proof_id);
    results.check("dm's listing: revoked, sign_in_revoked, as before the sweep", listedEnded?.status === "revoked" && listedEnded.revoke_reason === "sign_in_revoked" && !!listedEnded.revoked_at, short(listedEnded));
    results.check("B's proof is still exactly invalid", isExactlyInvalid((await verifyAs(ctx, "briefcase", ended.proof_token)).body));
    const refreshEnded = await refreshAs(ctx, "dm", ended.proof_refresh_token);
    const auditAfter = await row(env, auditSql);
    results.check("dm refreshing it → 410 proof_revoked (sign_in_revoked), and its end stays stored once (still one audit entry)", refreshEnded.status === 410 && errorCode(refreshEnded.body) === "proof_revoked" && refreshEnded.body.error?.details?.reason === "sign_in_revoked" && auditAfter?.[0] === "1", `${refreshEnded.status} ${short(refreshEnded.body.error)}; audit entries ${auditAfter?.[0]}`);

    // 2. Proof tokens expired more than a day ago are deleted; the proof and its refresh token stay.
    const tokens = async (proofId: string) => {
      const [counts] = await sql(env, `select count(*) filter (where kind = 'access'), count(*) filter (where kind = 'refresh') from proof_tokens where family_id = '${proofId}'`);
      return { access: Number(counts?.[0] ?? -1), refresh: Number(counts?.[1] ?? -1) };
    };
    const stale = setup.staleToken;
    const staleLeft = await tokens(stale.proof_id);
    results.check("the proof token that expired 25 h ago is deleted; that proof's refresh token is kept", staleLeft.access === 0 && staleLeft.refresh === 1, JSON.stringify(staleLeft));
    results.check("…verifying the deleted proof token → exactly invalid", isExactlyInvalid((await verifyAs(ctx, "briefcase", stale.proof_token)).body));
    const revokeDeleted = await revokeAs(ctx, "dm", { proof_token: stale.proof_token });
    const deletedMessage = String(revokeDeleted.body?.error?.message ?? "");
    results.check("…revoking by it → 404 proof_not_found, saying such tokens are deleted a day after they expire (the token not echoed)", revokeDeleted.status === 404 && errorCode(revokeDeleted.body) === "proof_not_found" && /1 day after they expire/.test(deletedMessage) && !deletedMessage.includes(stale.proof_token.slice(4, 20)), `${revokeDeleted.status} ${short(revokeDeleted.body)}`);
    const staleRefresh = await refreshAs(ctx, "dm", stale.proof_refresh_token);
    const staleNew = staleRefresh.status === 200 ? await verifyAs(ctx, "briefcase", staleRefresh.body.proof_token) : null;
    results.check("…and the proof lives on: dm refreshes it (200, the same proof) and the new proof token verifies", staleRefresh.status === 200 && staleRefresh.body.proof_id === stale.proof_id && staleNew?.body.valid === true, `${staleRefresh.status} ${short(staleRefresh.body.error ?? staleNew?.body)}`);
    const recentLeft = await tokens(setup.recentToken.proof_id);
    results.check("the proof token that expired 23 h ago is kept (less than a day)", recentLeft.access === 1 && recentLeft.refresh === 1, JSON.stringify(recentLeft));

    // 3. Every token of a proof that ended more than 30 days ago is deleted; the proof itself is kept, as history.
    const longAgo = setup.endedLongAgo;
    const longAgoLeft = await tokens(longAgo.proof_id);
    results.check("every token of the proof dm revoked 31 days ago is deleted", longAgoLeft.access === 0 && longAgoLeft.refresh === 0, JSON.stringify(longAgoLeft));
    const listedLongAgo = await appListing(ctx, "dm", longAgo.proof_id);
    results.check("…the proof itself is kept: dm's listing still has it, revoked (revoked_by_app)", listedLongAgo?.status === "revoked" && listedLongAgo.revoke_reason === "revoked_by_app", short(listedLongAgo));
    const mine = (await setup.a.session.call<{ items?: MyProofItem[] }>("GET", "/v1/me/proofs?limit=200")).body.items ?? [];
    const mineLongAgo = mine.find(item => item.proof_id === longAgo.proof_id);
    results.check("…and so does the Carbon's /v1/me/proofs", mineLongAgo?.status === "revoked" && mineLongAgo.revoke_reason === "revoked_by_app", short(mineLongAgo));
    const [[longAgoAudit] = []] = await sql(env, `select count(*) from audit_log where target_id = '${longAgo.proof_id}' and action in ('proof.issued', 'proof.revoked')`);
    results.check("…and its audit entries (issued, revoked) are kept", longAgoAudit === "2", String(longAgoAudit));
    const longAgoRefresh = await refreshAs(ctx, "dm", longAgo.proof_refresh_token);
    results.check("…its refresh token is no longer known → 400 invalid_proof_refresh_token, saying why (deleted 30 days after the proof ended)", longAgoRefresh.status === 400 && errorCode(longAgoRefresh.body) === "invalid_proof_refresh_token" && /30 days/.test(String(longAgoRefresh.body.error?.message ?? "")), `${longAgoRefresh.status} ${short(longAgoRefresh.body.error)}`);
    results.check("…and its proof token is exactly invalid", isExactlyInvalid((await verifyAs(ctx, "briefcase", longAgo.proof_token)).body));
    const recentlyLeft = await tokens(setup.endedRecently.proof_id);
    results.check("the tokens of the proof dm revoked 29 days ago are kept", recentlyLeft.access === 1 && recentlyLeft.refresh === 1, JSON.stringify(recentlyLeft));
    const ata = setup.ataExpiredLongAgo;
    const ataLeft = await tokens(ata.proof_id);
    const listedAta = await appListing(ctx, "commit", ata.proof_id, "&kind=ata");
    results.check("every token of Commit's ATA proof whose lifetime ended 31 days ago is deleted; Commit's listing keeps the proof, expired", ataLeft.access === 0 && ataLeft.refresh === 0 && listedAta?.status === "expired", `${JSON.stringify(ataLeft)} ${short(listedAta)}`);

    // 4. The live proof is untouched, and its used refresh token is kept: reuse is still caught.
    const live = setup.live;
    const liveLeft = await tokens(live.proof_id);
    results.check("the live proof keeps all 4 tokens (2 proof tokens, the used refresh token and the current one)", liveLeft.access === 2 && liveLeft.refresh === 2, JSON.stringify(liveLeft));
    results.check("…its first and its current proof tokens both still verify", (await verifyAs(ctx, "briefcase", live.proof_token)).body.valid === true && (await verifyAs(ctx, "briefcase", setup.liveCurrent.proof_token)).body.valid === true);
    const reuse = await refreshAs(ctx, "dm", live.proof_refresh_token);
    results.check("…presenting its used refresh token again is still caught → 400 proof_refresh_token_reused", reuse.status === 400 && errorCode(reuse.body) === "proof_refresh_token_reused", `${reuse.status} ${short(reuse.body.error)}`);
    results.check("…which revokes the proof: its current proof token → exactly invalid", isExactlyInvalid((await verifyAs(ctx, "briefcase", setup.liveCurrent.proof_token)).body));
  },
};

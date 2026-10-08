/**
 * The hourly proof sweep, part 1 of 2 (part 2: z-sweep.ts); both run only with E2E_PROOFS_SWEEP=1 (_sweep.ts). This file sorts first in the suite so that it runs before
 * the stack's first sweep, 120 s after accounts-api started (_sweep.ts). It makes the proofs that sweep must store,
 * delete or keep, moving time only on its own rows:
 *
 * - B's User verification proof on a dm sign-in that dm ended (POST /v1/oauth/revoke): invalid at once, but nothing touches the proof
 *   afterwards, so its end is not stored yet (the listing derives it live); storing it is the sweep's job;
 * - A's proofs: a proof token that expired 25 h ago (deleted: more than a day) and one 23 h ago (kept); proofs dm
 *   revoked 31 days ago (every token deleted) and 29 days ago (kept); Commit's App verification proof for remind whose lifetime ended
 *   31 days ago (every token deleted); a live proof refreshed once, whose used refresh token must be kept so that reuse
 *   is still caught.
 */
import type { Journey } from "../../context";
import { api, sql } from "../../lib";
import { appListing, appTokens, basicAuth, familyOf, isExactlyInvalid, issueAppVerificationFor, issueUserVerification, refreshAs, revokeAs, row, short, signInToApp, verifyAs, type IssuedProof } from "./_helpers";
import { FIRST_SWEEP_AFTER_MS, SETUP_MARGIN_MS, SWEEP_KEY, apiListeningAt, apiLogFile, sweepOptIn, type SweepSetup } from "./_sweep";

export const journey: Journey = {
  name: "proofs-perf-sweep-setup",
  ...sweepOptIn("before the stack's first hourly proof sweep (120 s after accounts-api starts): a user verification proof whose dm sign-in dm ended (its end not stored yet), proof tokens expired 25 h and 23 h ago, proofs revoked 31 and 29 days ago, an app verification proof that ended 31 days ago, and a live proof with a used refresh token"),
  provides: [SWEEP_KEY],
  async run(ctx) {
    const { env, results, shared } = ctx;
    const listeningAt = apiListeningAt(env);
    const due = listeningAt === null ? null : listeningAt + FIRST_SWEEP_AFTER_MS;
    const notMeasurable = (why: string) => {
      console.log(`        the sweep can't be measured on this stack: ${why}`);
      shared[SWEEP_KEY] = { measurable: false, why } satisfies SweepSetup;
    };
    if (listeningAt === null || due === null) return notMeasurable(`accounts-api's log (${apiLogFile(env)}) does not say when it started listening, so when its first sweep runs is unknown`);
    results.metric("sweep setup: started after accounts-api began listening", Date.now() - listeningAt);
    if (Date.now() > due - SETUP_MARGIN_MS - 5_000) {
      return notMeasurable(`this setup started ${((Date.now() - listeningAt) / 1000).toFixed(1)} s after accounts-api began listening, too close to (or past) its first sweep at ${FIRST_SWEEP_AFTER_MS / 1000} s; the next one is an hour later (a --keep stack walked again, or a site build that waited for a build slot)`);
    }

    // Carbon A, signed into dm.
    const a = await signInToApp(ctx, "dm");
    const subjectA = (await appTokens(env, "dm", a.uuid)).access_token;
    const user_verification = async (label: string): Promise<IssuedProof> => {
      const answer = await issueUserVerification(ctx, "dm", subjectA, { receiving_app: "briefcase", scopes: [`pp.sweep.${label}`], access_ttl_seconds: 600 });
      if (answer.status !== 201) throw new Error(`issuing the ${label} proof answered ${answer.status} ${short(answer.body)}`);
      return answer.body;
    };
    const live = await user_verification("live");
    const refreshed = await refreshAs(ctx, "dm", live.proof_refresh_token);
    if (refreshed.status !== 200) throw new Error(`refreshing the live proof answered ${refreshed.status} ${short(refreshed.body)}`);
    const staleToken = await user_verification("stale-token");
    const recentToken = await user_verification("recent-token");
    const endedLongAgo = await user_verification("ended-long-ago");
    const endedRecently = await user_verification("ended-recently");
    for (const ended of [endedLongAgo, endedRecently]) {
      const revoked = await revokeAs(ctx, "dm", { proof_id: ended.proof_id });
      if (revoked.status !== 204) throw new Error(`dm revoking ${ended.proof_id} answered ${revoked.status} ${short(revoked.body)}`);
    }
    const app_verification = await issueAppVerificationFor(ctx, "commit", "remind", { scopes: ["pp.sweep.app_verification-ended-long-ago"] });
    if (app_verification.status !== 201) throw new Error(`issuing the App verification proof answered ${app_verification.status} ${short(app_verification.body)}`);

    // Time travel, on these proofs only.
    await sql(env, `update proof_tokens set expires_at = now() - interval '25 hours' where family_id = '${staleToken.proof_id}' and kind = 'access'`);
    await sql(env, `update proof_tokens set expires_at = now() - interval '23 hours' where family_id = '${recentToken.proof_id}' and kind = 'access'`);
    await sql(env, `update proof_families set created_at = now() - interval '40 days', revoked_at = now() - interval '31 days' where id = '${endedLongAgo.proof_id}'`);
    await sql(env, `update proof_families set created_at = now() - interval '40 days', revoked_at = now() - interval '29 days' where id = '${endedRecently.proof_id}'`);
    await sql(env, `update proof_families set created_at = now() - interval '931 days', expires_at = now() - interval '31 days' where id = '${app_verification.body.proof_id}'`);

    // Carbon B: dm ends B's sign-in; nothing touches B's proof afterwards.
    const b = await signInToApp(ctx, "dm");
    const tokensB = await appTokens(env, "dm", b.uuid);
    const issuedB = await issueUserVerification(ctx, "dm", tokensB.access_token, { receiving_app: "briefcase", scopes: ["pp.sweep.sign-in-ended"] });
    if (issuedB.status !== 201) throw new Error(`issuing B's proof answered ${issuedB.status} ${short(issuedB.body)}`);
    const signInEnded = issuedB.body;
    const signOut = await api<unknown>(ctx, "/v1/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth("dm") },
      body: new URLSearchParams({ token: tokensB.refresh_token ?? "" }).toString(),
    });
    const family = familyOf(tokensB.access_token);
    const signIn = await row(env, `select revoked_at is not null, coalesce(revoke_reason, '') from token_families where id = '${family}'`);
    results.check("dm ends B's sign-in (POST /v1/oauth/revoke with its refresh token → 200): the sign-in is revoked", signOut.status === 200 && signIn?.[0] === "t", `${signOut.status} ${short(signIn)}`);
    results.check("B's proof on it is exactly invalid at once (verify checks the sign-in live)", isExactlyInvalid((await verifyAs(ctx, "briefcase", signInEnded.proof_token)).body));
    const stored = await row(env, `select revoked_at is null from proof_families where id = '${signInEnded.proof_id}'`);
    const listed = await appListing(ctx, "dm", signInEnded.proof_id);
    results.check("…its end is not stored yet (revoked_at null), while dm's listing derives it live: revoked, sign_in_revoked", stored?.[0] === "t" && listed?.status === "revoked" && listed.revoke_reason === "sign_in_revoked", `proof_families.revoked_at is null: ${stored?.[0]}; listing ${short(listed)}`);
    const history = await b.session.call<{ items?: Array<{ id: string; meta?: { proof_id?: string; event?: string } }> }>("GET", "/v1/me/history?kind=proof&limit=50");
    const entries = (history.body.items ?? []).filter(item => item.meta?.proof_id === signInEnded.proof_id).map(item => item.meta?.event);
    results.check("…and B's history (kind=proof) has the proof issued, not yet revoked", history.status === 200 && entries.includes("issued") && !entries.includes("revoked"), `${history.status} ${JSON.stringify(entries)}`);

    // What the other proofs look like before the sweep.
    results.check("the proof tokens moved 25 h and 23 h into the past are exactly invalid", isExactlyInvalid((await verifyAs(ctx, "briefcase", staleToken.proof_token)).body) && isExactlyInvalid((await verifyAs(ctx, "briefcase", recentToken.proof_token)).body));
    results.check("the live proof's first and current proof tokens both verify", (await verifyAs(ctx, "briefcase", live.proof_token)).body.valid === true && (await verifyAs(ctx, "briefcase", refreshed.body.proof_token)).body.valid === true);
    const ids = [live, staleToken, recentToken, endedLongAgo, endedRecently, app_verification.body, signInEnded].map(p => p.proof_id);
    const counts = await sql(env, `select family_id, count(*) from proof_tokens where family_id in (${ids.map(id => `'${id}'`).join(", ")}) group by family_id`);
    const tokensBefore = Object.fromEntries(ids.map(id => [id, Number(counts.find(([family_id]) => family_id === id)?.[1] ?? 0)]));
    results.check("every one of these proofs still has its tokens (2 each; 4 for the live proof refreshed once)", ids.every(id => tokensBefore[id] === (id === live.proof_id ? 4 : 2)), JSON.stringify(tokensBefore));

    const doneAt = Date.now();
    results.metric("sweep setup: done after accounts-api began listening", doneAt - listeningAt);
    if (doneAt > due - SETUP_MARGIN_MS) {
      return notMeasurable(`this setup was done ${((doneAt - listeningAt) / 1000).toFixed(1)} s after accounts-api began listening, too close to its first sweep at ${FIRST_SWEEP_AFTER_MS / 1000} s (the sweep may have run during the setup)`);
    }
    shared[SWEEP_KEY] = {
      measurable: true,
      listeningAt,
      doneAt,
      a,
      b,
      bSignIn: { family, reason: signIn?.[1] ?? "" },
      live,
      liveCurrent: refreshed.body,
      staleToken,
      recentToken,
      endedLongAgo,
      endedRecently,
      ataExpiredLongAgo: app_verification.body,
      signInEnded,
      tokensBefore,
    } satisfies SweepSetup;
  },
};

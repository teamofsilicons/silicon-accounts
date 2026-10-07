/**
 * ATA (app to app): Commit gets one proof for Remind and Waveform through the fake apps, and each verifies it as its
 * own audience; nobody else can. Audience rules, the ATA page stand-in, refresh, the issuing app disabled and back,
 * and revocation for every audience at once.
 */
import type { Journey } from "../../context";
import { json, sql } from "../../lib";
import { appListing, asApp, errorCode, isExactlyInvalid, issueAta, refreshAs, revokeAs, secondsBetween, short, verifyAs, type IssuedProof, type Verification } from "./_helpers";

interface NotifyAnswer {
  ok?: boolean;
  proof?: Omit<IssuedProof, "proof_token" | "proof_refresh_token">;
  results?: Record<string, { ok: boolean; status: number; verification: Verification | null; verify_ms: number | null }>;
  timings?: { issue_ms?: number; total_ms?: number; verify_ms?: Record<string, number | null> };
}

export const journey: Journey = {
  name: "proofs-perf-ata",
  title: "ATA commit → [remind, waveform] through the fake apps: each audience verifies the one proof as its own receiver, every other app gets exactly invalid; audience rules, the ATA page stand-in, refresh, issuing app disabled and back, revocation reaches every audience",
  async run(ctx) {
    const { env, results } = ctx;
    const message = `pp ata ${Date.now()}`;

    // Through the fake apps: Commit's notify gets one proof and pings both audiences, each of which verifies it.
    const notify = await json<NotifyAnswer>(`${env.apps}/commit/actions/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audiences: ["remind", "waveform"], message }) });
    const r = notify.body.results ?? {};
    results.check("Commit's notify succeeded: one ATA proof, both pings accepted", notify.status === 200 && notify.body.ok === true && r.remind?.ok === true && r.waveform?.ok === true, short(notify.body, 600));
    for (const audience of ["remind", "waveform"] as const) {
      const v = r[audience]?.verification;
      results.check(`${audience} verified it: valid, kind ata, issuing commit, receiving ${audience}, no user, the scopes`, v?.valid === true && v.kind === "ata" && v.issuing_app?.app_id === "commit" && v.issuing_app.name === "Commit" && v.receiving_app?.app_id === audience && v.user === null && JSON.stringify(v.scopes) === '["notifications.send"]', short(v));
    }
    results.check("both verified the same proof (one proof for both audiences)", !!notify.body.proof?.proof_id && r.remind?.verification?.proof_id === notify.body.proof.proof_id && r.waveform?.verification?.proof_id === notify.body.proof.proof_id, short(notify.body.proof));
    for (const audience of ["remind", "waveform"]) {
      const state = await json<{ pings: Array<{ message: string | null; from: string | null; kind: string | null; proof_id: string | null }> }>(`${env.apps}/${audience}/_state`);
      const ping = state.body.pings?.find(item => item.message === message);
      results.check(`${audience} recorded the ping from commit under that proof`, ping?.from === "commit" && ping.kind === "ata" && ping.proof_id === notify.body.proof?.proof_id, short(ping));
    }
    for (const [name, value] of Object.entries(notify.body.timings ?? {})) {
      if (typeof value === "number") results.metric(`ATA via the fake apps: ${name}`, value);
      else for (const [audience, ms] of Object.entries(value ?? {})) if (typeof ms === "number") results.metric(`ATA via the fake apps: verify at ${audience}`, ms);
    }

    // Directly: the issue answer.
    const issued = await issueAta(ctx, "commit", { audiences: ["remind", "waveform"], scopes: ["notifications.send"], access_ttl_seconds: 300 });
    const p = issued.body;
    results.check("POST /v1/proofs/ata → 201: kind ata, receiving_apps [remind, waveform], no receiving_app, user null", issued.status === 201 && p.kind === "ata" && JSON.stringify(p.receiving_apps) === '["remind","waveform"]' && p.receiving_app === undefined && p.user === null && p.issuing_app === "commit", short(p));
    const lifeDays = secondsBetween(p.refresh_expires_at, new Date().toISOString()) / 86_400;
    results.check("an ATA proof can be refreshed for 900 days; its token lives the 300 s asked for", lifeDays > 899.9 && lifeDays <= 900.01 && Math.abs(secondsBetween(p.expires_at, new Date().toISOString()) - 300) < 30, `${lifeDays.toFixed(3)} days, ${p.expires_at}`);
    for (const audience of ["remind", "waveform"]) {
      const v = await verifyAs(ctx, audience, p.proof_token);
      results.check(`${audience} verifies the direct ATA proof as its own receiver`, v.body.valid === true && v.body.receiving_app?.app_id === audience && v.body.expires_at === p.expires_at, short(v.body));
    }
    for (const app of ["briefcase", "dm", "commit", "spacestation", "interface"]) {
      const v = await verifyAs(ctx, app, p.proof_token);
      results.check(`${app} (not an audience${app === "commit" ? ", the issuer" : ""}) → exactly invalid`, v.status === 200 && isExactlyInvalid(v.body), `${v.status} ${JSON.stringify(v.body)}`);
    }

    // Audience rules.
    const cases: Array<[string, string[], number, string]> = [
      ["no audience", [], 422, "validation_failed"],
      ["Commit itself", ["remind", "commit"], 400, "invalid_receiving_app"],
      ["Silicon Accounts itself", ["accounts"], 400, "invalid_receiving_app"],
      ["an unknown app", ["remind", "nope-pp-app"], 400, "unknown_receiving_app"],
      ["a malformed app id", ["Not An App!"], 422, "validation_failed"],
      ["21 apps", Array.from({ length: 21 }, (_, i) => `app-${i}`), 422, "validation_failed"],
    ];
    for (const [what, audiences, status, codeName] of cases) {
      const answer = await issueAta(ctx, "commit", { audiences });
      results.check(`audiences with ${what} → ${status} ${codeName}`, answer.status === status && errorCode(answer.body) === codeName, `${answer.status} ${short(answer.body.error)}`);
    }
    const unknown = await issueAta(ctx, "commit", { audiences: ["remind", "nope-pp-app"] });
    results.check("…the unknown one is named in details.app_ids", JSON.stringify(unknown.body.error?.details?.app_ids) === '["nope-pp-app"]', short(unknown.body.error?.details));
    const deduped = await issueAta(ctx, "commit", { audiences: [" Remind", "remind", "WAVEFORM"] });
    results.check("audiences are trimmed, lower-cased and de-duplicated in order", deduped.status === 201 && JSON.stringify(deduped.body.receiving_apps) === '["remind","waveform"]', `${deduped.status} ${short(deduped.body.receiving_apps ?? deduped.body.error)}`);
    await sql(env, "update apps set status = 'disabled' where app_id = 'waveform'");
    try {
      const disabled = await issueAta(ctx, "commit", { audiences: ["remind", "waveform"] });
      results.check("a disabled audience → 403 receiving_app_disabled naming it", disabled.status === 403 && errorCode(disabled.body) === "receiving_app_disabled" && JSON.stringify(disabled.body.error?.details?.app_ids) === '["waveform"]', `${disabled.status} ${short(disabled.body.error)}`);
    } finally {
      await sql(env, "update apps set status = 'active' where app_id = 'waveform'");
    }

    // The ATA page stand-in (POST /v1/apps/{app_id}/proofs/ata): for the app itself, not for another app.
    const page = await asApp<IssuedProof>(ctx, "commit", "POST", "/v1/apps/commit/proofs/ata", { audiences: ["remind"] }, { key: crypto.randomUUID() });
    results.check("the ATA page endpoint issues for Commit with Commit's credentials (201, same shape)", page.status === 201 && page.body.kind === "ata" && JSON.stringify(page.body.receiving_apps) === '["remind"]' && (await verifyAs(ctx, "remind", page.body.proof_token)).body.valid === true, `${page.status} ${short(page.body.error ?? page.body.receiving_apps)}`);
    const stranger = await asApp<IssuedProof>(ctx, "briefcase", "POST", "/v1/apps/commit/proofs/ata", { audiences: ["remind"] }, { key: crypto.randomUUID() });
    results.check("Briefcase can't use Commit's ATA page → 403", stranger.status === 403, `${stranger.status} ${short(stranger.body.error)}`);
    const listed = await appListing(ctx, "commit", p.proof_id, "&kind=ata");
    results.check("Commit's listing (kind=ata) has the proof: audiences [remind, waveform], no user, active, 300 s tokens", listed?.kind === "ata" && JSON.stringify(listed.audiences) === '["remind","waveform"]' && listed.user === null && listed.status === "active" && listed.access_ttl_seconds === 300, short(listed));

    // Refresh: a new token for every audience.
    const refreshed = await refreshAs(ctx, "commit", p.proof_refresh_token);
    results.check("Commit refreshes it: same proof, receiving_apps kept, new token verified by both audiences", refreshed.status === 200 && refreshed.body.proof_id === p.proof_id && JSON.stringify(refreshed.body.receiving_apps) === '["remind","waveform"]' && (await verifyAs(ctx, "remind", refreshed.body.proof_token)).body.valid === true && (await verifyAs(ctx, "waveform", refreshed.body.proof_token)).body.valid === true, `${refreshed.status} ${short(refreshed.body.error)}`);
    const remindRefresh = await refreshAs(ctx, "remind", refreshed.body.proof_refresh_token);
    results.check("an audience can't refresh it → 403 not_issuing_app", remindRefresh.status === 403 && errorCode(remindRefresh.body) === "not_issuing_app", `${remindRefresh.status} ${short(remindRefresh.body.error)}`);

    // The issuing app disabled, then back.
    await sql(env, "update apps set status = 'disabled' where app_id = 'commit'");
    try {
      const off = await verifyAs(ctx, "remind", refreshed.body.proof_token);
      results.check("Commit disabled → Remind's verify is exactly invalid", isExactlyInvalid(off.body), JSON.stringify(off.body));
    } finally {
      await sql(env, "update apps set status = 'active' where app_id = 'commit'");
    }
    results.check("Commit active again → valid again", (await verifyAs(ctx, "remind", refreshed.body.proof_token)).body.valid === true);

    // Revocation reaches every audience at once.
    const revoke = await revokeAs(ctx, "commit", { proof_id: p.proof_id });
    results.check("Commit revokes the proof → 204", revoke.status === 204, `${revoke.status} ${short(revoke.body)}`);
    for (const audience of ["remind", "waveform"]) {
      for (const [label, token] of [["first", p.proof_token], ["refreshed", refreshed.body.proof_token]] as const) {
        const v = await verifyAs(ctx, audience, token);
        results.check(`${audience}: the ${label} token → exactly invalid`, isExactlyInvalid(v.body), JSON.stringify(v.body));
      }
    }
    const after = await refreshAs(ctx, "commit", refreshed.body.proof_refresh_token);
    results.check("Commit can't refresh it any more → 410 proof_revoked (revoked_by_app)", after.status === 410 && errorCode(after.body) === "proof_revoked" && after.body.error?.details?.reason === "revoked_by_app", `${after.status} ${short(after.body.error)}`);
    const [[audited] = []] = await sql(env, `select count(*) from audit_log where target_id = '${p.proof_id}' and action in ('proof.issued', 'proof.refreshed', 'proof.revoked') and account_uuid is null`);
    results.check("issued, refreshed and revoked are audited for the app, tied to no account", audited === "3", String(audited));
  },
};

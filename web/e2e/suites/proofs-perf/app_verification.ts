/**
 * App verification (app to app). UNDERSTANDING.md: "An App verification proof is always for exactly one app; a proof can't be made for several
 * apps at once. If App A wants to talk to App B and App C, it makes one proof for App B and another one for App C, and
 * each of them verifies its own proof with us." So Commit → [remind, waveform] is two proofs, one per app: each app
 * verifies its own, and gets exactly {valid:false, expires_at:null} for the other's, as does every other app.
 *
 * proofs-perf-app_verification: through the fake apps (Commit's notify to one app, and to both at once, which the fake app does with
 * a proof per app), straight at the API (a proof per app), the App verification page's endpoint, the listing, refresh, the issuing
 * app disabled and back, and revocation, which ends only the proof revoked.
 *
 * proofs-perf-app_verification-single-app: every way of asking for one proof for several apps is refused precisely (422
 * app_verification_single_app, naming the one-proof-per-app way and the endpoint called) and makes nothing, on both endpoints; and the
 * receiving-app rules, one app at a time.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { json, sql, tag } from "../../lib";
import {
  ISSUED_KEYS,
  appListing,
  asApp,
  errorCode,
  isExactlyInvalid,
  issueAppVerificationFor,
  issueAppVerificationRaw,
  namesOnly,
  refreshAs,
  revokeAs,
  secondsBetween,
  short,
  verifyAs,
  type ApiErrorBody,
  type IssuedProof,
  type Verification,
} from "./_helpers";

interface NotifyAnswer {
  ok?: boolean;
  proofs?: Record<string, Omit<IssuedProof, "proof_token" | "proof_refresh_token"> | undefined>;
  results?: Record<string, { ok: boolean; status: number; verification: Verification | null; verify_ms: number | null }>;
  timings?: { issue_ms?: Record<string, number | null>; verify_ms?: Record<string, number | null>; total_ms?: number };
}

/** The two apps Commit talks to (testkit/fake-apps.json: commit's App verification receivers). */
const APPS = ["remind", "waveform"] as const;
/** Apps that are neither of them; the issuer itself among them. */
const OTHERS = ["briefcase", "dm", "commit", "spacestation", "interface"];
const other = (app: string) => (app === "remind" ? "waveform" : "remind");

export const journeys: Journey[] = [
  {
    name: "proofs-perf-app_verification",
    title: "App verification commit → [remind, waveform] is one proof per app (UNDERSTANDING.md: an App verification proof is always for exactly one app): through the fake apps (one app, and both at once as two proofs) and straight at the API each app verifies its own proof and gets exactly invalid for the other's; the App verification page endpoint, listing, refresh, issuing app disabled and back; revoking one app's proof leaves the other's",
    async run(ctx) {
      const { env, results } = ctx;
      const notify = (audiences: string[], message: string) =>
        json<NotifyAnswer>(`${env.apps}/commit/actions/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audiences, message }) });
      const verifiedOwn = (v: Verification | null | undefined, app: string) =>
        v?.valid === true && v.kind === "app_verification" && v.issuing_app?.app_id === "commit" && v.issuing_app.name === "Commit" && v.receiving_app?.app_id === app && v.user === null && JSON.stringify(v.scopes) === '["notifications.send"]';

      // 1. Through the fake apps, the contract's way: Commit talks to Remind with one proof and to Waveform with another.
      const viaApps: Record<string, string | undefined> = {};
      for (const app of APPS) {
        const message = `pp app_verification ${app} ${tag()}`;
        const answer = await notify([app], message);
        const proof = answer.body.proofs?.[app];
        const result = answer.body.results?.[app];
        results.check(
          `Commit's notify to ${app} alone: one App verification proof naming only ${app} (receiving_app "${app}"), the ping accepted`,
          answer.status === 200 && answer.body.ok === true && Object.keys(answer.body.proofs ?? {}).length === 1 && namesOnly(proof, app) && result?.ok === true,
          short(answer.body, 600),
        );
        results.check(`${app} verified it as its own: valid, kind app_verification, issuing commit, receiving ${app}, no user, the scopes`, verifiedOwn(result?.verification, app) && result?.verification?.proof_id === proof?.proof_id, short(result?.verification));
        const state = await json<{ pings: Array<{ message: string | null; from: string | null; kind: string | null; proof_id: string | null }> }>(`${env.apps}/${app}/_state`);
        const ping = state.body.pings?.find(item => item.message === message);
        results.check(`${app} recorded the ping from commit under that proof`, ping?.from === "commit" && ping.kind === "app_verification" && !!ping.proof_id && ping.proof_id === proof?.proof_id, short(ping));
        viaApps[app] = proof?.proof_id;
        const t = answer.body.timings;
        if (typeof t?.issue_ms?.[app] === "number") results.metric(`App verification via the fake apps, commit → ${app}: issue`, t.issue_ms[app]!);
        if (typeof t?.verify_ms?.[app] === "number") results.metric(`App verification via the fake apps, commit → ${app}: verify at ${app}`, t.verify_ms[app]!);
        if (typeof t?.total_ms === "number") results.metric(`App verification via the fake apps, commit → ${app}: total`, t.total_ms);
      }
      results.check("…two proofs through the fake apps, one per app", !!viaApps.remind && !!viaApps.waveform && viaApps.remind !== viaApps.waveform, JSON.stringify(viaApps));

      // 2. Commit's notify for both apps at once (its configured receivers) is two proofs, issued in parallel: each app
      // verifies its own.
      const both = await notify([...APPS], `pp app_verification both ${tag()}`);
      const bothIds = APPS.map(app => both.body.proofs?.[app]?.proof_id);
      // What each verified proof names, from Commit's own listing (a verification only says who is verifying).
      const bothListed = await Promise.all(APPS.map((_, i) => (bothIds[i] ? appListing(ctx, "commit", bothIds[i]!, "&kind=app_verification") : Promise.resolve(null))));
      results.check(
        'Commit\'s notify for [remind, waveform] at once makes two proofs, one per app: both pings accepted, each app verified its own proof, and Commit\'s listing shows each naming only that app (UNDERSTANDING.md: "it makes one proof for App B and another one for App C, and each of them verifies its own proof")',
        both.status === 200 && both.body.ok === true && APPS.every((app, i) => namesOnly(both.body.proofs?.[app], app) && verifiedOwn(both.body.results?.[app]?.verification, app) && both.body.results?.[app]?.verification?.proof_id === bothIds[i] && bothListed[i]?.receiving_app === app) && !!bothIds[0] && !!bothIds[1] && bothIds[0] !== bothIds[1],
        `${both.status} ok=${String(both.body.ok)}; remind: ${bothIds[0]} (lists ${short(bothListed[0]?.receiving_app)}), waveform: ${bothIds[1]} (lists ${short(bothListed[1]?.receiving_app)})`,
      );
      const bothTimes = both.body.timings;
      if (typeof bothTimes?.total_ms === "number") results.metric("App verification via the fake apps, commit → remind and waveform at once (two proofs in parallel): total", bothTimes.total_ms);

      // 3. Straight at the API, a proof per app: each app verifies its own and only its own.
      const issued: Record<string, IssuedProof> = {};
      for (const app of APPS) {
        const answer = await issueAppVerificationFor(ctx, "commit", app, { scopes: ["notifications.send"], access_ttl_seconds: 300 });
        issued[app] = answer.body;
        results.check(
          `an App verification proof for ${app} → 201 with exactly the contract's keys: kind app_verification, issuing commit, receiving_app "${app}", user null`,
          answer.status === 201 && JSON.stringify(Object.keys(answer.body).sort()) === JSON.stringify(ISSUED_KEYS) && answer.body.kind === "app_verification" && answer.body.issuing_app === "commit" && namesOnly(answer.body, app) && answer.body.user === null,
          `${answer.status} ${short(answer.body)}`,
        );
      }
      const toRemind = issued.remind!;
      const toWaveform = issued.waveform!;
      const lifeDays = secondsBetween(toRemind.refresh_expires_at, new Date().toISOString()) / 86_400;
      results.check("an App verification proof can be refreshed for 900 days; its token lives the 300 s asked for", lifeDays > 899.9 && lifeDays <= 900.01 && Math.abs(secondsBetween(toRemind.expires_at, new Date().toISOString()) - 300) < 30, `${lifeDays.toFixed(3)} days, ${toRemind.expires_at}`);
      const stored = await sql(env, `select array_to_string(audiences, ','), account_uuid is null from proof_families where id in ('${toRemind.proof_id}', '${toWaveform.proof_id}') order by created_at`);
      results.check("stored: each proof names its one app, and no account", JSON.stringify(stored) === JSON.stringify([["remind", "t"], ["waveform", "t"]]), JSON.stringify(stored));
      for (const app of APPS) {
        const own = issued[app]!;
        const v = await verifyAs(ctx, app, own.proof_token);
        results.check(`${app} verifies its own proof: valid, receiving_app ${app}, that proof's id and expires_at`, v.status === 200 && v.body.valid === true && v.body.receiving_app?.app_id === app && v.body.proof_id === own.proof_id && v.body.expires_at === own.expires_at, short(v.body));
        const crossed = await verifyAs(ctx, app, issued[other(app)]!.proof_token);
        results.check(`${app} verifying the proof made for ${other(app)} → exactly invalid (each app verifies only its own proof)`, crossed.status === 200 && isExactlyInvalid(crossed.body), `${crossed.status} ${JSON.stringify(crossed.body)}`);
      }
      for (const app of OTHERS) {
        const v = await verifyAs(ctx, app, toRemind.proof_token);
        results.check(`${app} (not the receiver${app === "commit" ? "; the issuer" : ""}) verifying Commit's proof for remind → exactly invalid`, v.status === 200 && isExactlyInvalid(v.body), `${v.status} ${JSON.stringify(v.body)}`);
      }

      // 4. The App verification page's endpoint (POST /v1/apps/{app_id}/proofs/app-verification): Commit's own proofs, one app at a time.
      const page = await issueAppVerificationFor(ctx, "commit", "remind", {}, { path: "/v1/apps/commit/proofs/app-verification" });
      results.check("the App verification page endpoint makes Commit a proof for remind with Commit's credentials (201, naming only remind, valid at remind)", page.status === 201 && page.body.kind === "app_verification" && namesOnly(page.body, "remind") && (await verifyAs(ctx, "remind", page.body.proof_token)).body.valid === true, `${page.status} ${short(page.body.error ?? page.body.receiving_app)}`);
      const stranger = await issueAppVerificationFor(ctx, "commit", "remind", {}, { path: "/v1/apps/commit/proofs/app-verification", as: "briefcase" });
      results.check("Briefcase can't use Commit's App verification page → 403", stranger.status === 403, `${stranger.status} ${short(stranger.body.error)}`);

      // 5. The listing.
      const listed = await appListing(ctx, "commit", toRemind.proof_id, "&kind=app_verification");
      results.check("Commit's listing (kind=app_verification) has its proof for remind: receiving_app remind (one app, no list), no user, active, 300 s tokens", listed?.kind === "app_verification" && namesOnly(listed, "remind") && listed.user === null && listed.status === "active" && listed.access_ttl_seconds === 300, short(listed));

      // 6. Refresh: still the one app's proof.
      const refreshed = await refreshAs(ctx, "commit", toRemind.proof_refresh_token);
      const atRemind = refreshed.status === 200 ? await verifyAs(ctx, "remind", refreshed.body.proof_token) : null;
      const atWaveform = refreshed.status === 200 ? await verifyAs(ctx, "waveform", refreshed.body.proof_token) : null;
      results.check(
        "Commit refreshes its proof for remind: the same proof, still remind's only (receiving_app remind; the new token is valid at remind, exactly invalid at waveform)",
        refreshed.status === 200 && refreshed.body.proof_id === toRemind.proof_id && namesOnly(refreshed.body, "remind") && atRemind?.body.valid === true && isExactlyInvalid(atWaveform?.body),
        `${refreshed.status} ${short(refreshed.body.error ?? refreshed.body.receiving_app)}; remind ${short(atRemind?.body)}; waveform ${JSON.stringify(atWaveform?.body)}`,
      );
      const remindRefresh = await refreshAs(ctx, "remind", refreshed.body.proof_refresh_token);
      results.check("the receiving app can't refresh it → 403 not_issuing_app", remindRefresh.status === 403 && errorCode(remindRefresh.body) === "not_issuing_app", `${remindRefresh.status} ${short(remindRefresh.body.error)}`);

      // 7. The issuing app disabled, then back.
      await sql(env, "update apps set status = 'disabled' where app_id = 'commit'");
      try {
        const off = await verifyAs(ctx, "remind", refreshed.body.proof_token);
        results.check("Commit disabled → remind's verify is exactly invalid", isExactlyInvalid(off.body), JSON.stringify(off.body));
      } finally {
        await sql(env, "update apps set status = 'active' where app_id = 'commit'");
      }
      results.check("Commit active again → valid again", (await verifyAs(ctx, "remind", refreshed.body.proof_token)).body.valid === true);

      // 8. Revoking one app's proof ends it alone; the App verification page's revoke ends the other.
      const revoke = await revokeAs(ctx, "commit", { proof_id: toRemind.proof_id });
      results.check("Commit revokes its proof for remind → 204", revoke.status === 204, `${revoke.status} ${short(revoke.body)}`);
      for (const [label, token] of [
        ["first", toRemind.proof_token],
        ["refreshed", refreshed.body.proof_token],
      ] as const) {
        const v = await verifyAs(ctx, "remind", token);
        results.check(`remind: the ${label} token → exactly invalid`, isExactlyInvalid(v.body), JSON.stringify(v.body));
      }
      const untouched = await verifyAs(ctx, "waveform", toWaveform.proof_token);
      results.check("waveform's own proof is untouched and still verifies (each app's proof lives and ends on its own)", untouched.body.valid === true && untouched.body.proof_id === toWaveform.proof_id, short(untouched.body));
      const after = await refreshAs(ctx, "commit", refreshed.body.proof_refresh_token);
      results.check("Commit can't refresh the revoked one any more → 410 proof_revoked (revoked_by_app)", after.status === 410 && errorCode(after.body) === "proof_revoked" && after.body.error?.details?.reason === "revoked_by_app", `${after.status} ${short(after.body.error)}`);
      const deleted = await asApp<ApiErrorBody | null>(ctx, "commit", "DELETE", `/v1/apps/commit/proofs/${toWaveform.proof_id}`);
      const gone = await verifyAs(ctx, "waveform", toWaveform.proof_token);
      results.check("the App verification page's revoke (DELETE /v1/apps/commit/proofs/{id}) ends waveform's proof: 204, then exactly invalid", deleted.status === 204 && isExactlyInvalid(gone.body), `${deleted.status} ${short(deleted.body)}; ${JSON.stringify(gone.body)}`);
      const [[audited] = []] = await sql(env, `select count(*) from audit_log where target_id = '${toRemind.proof_id}' and action in ('proof.issued', 'proof.refreshed', 'proof.revoked') and account_uuid is null`);
      results.check("issued, refreshed and revoked are audited for the app, tied to no account", audited === "3", String(audited));
      const [[issuedDetails] = []] = await sql(env, `select details->>'receiving_app' from audit_log where target_id = '${toWaveform.proof_id}' and action = 'proof.issued'`);
      results.check("the issue's audit entry names the one receiving app", issuedDetails === "waveform", String(issuedDetails));
    },
  },
  {
    name: "proofs-perf-app_verification-single-app",
    title: "an App verification proof for several apps at once is refused in every shape (audiences with two apps, one app, none, a string, beside receiving_app) with 422 app_verification_single_app naming the one-proof-per-app way and the endpoint called, on POST /v1/proofs/app-verification and on the App verification page's endpoint, making nothing and leaving the Idempotency-Key unused; receiving_app is required and is one app; the receiving-app rules (itself, Silicon Accounts, the developer platform, unknown, malformed, disabled)",
    async run(ctx) {
      const { env, results } = ctx;
      const made = async (scope: string) => (await sql(env, `select count(*) from proof_families where issuing_app = 'commit' and '${scope}' = any(scopes)`))[0]?.[0];

      // Every shape of "one proof for several apps", on both endpoints.
      const shapes: Array<[string, Record<string, unknown>, string[]]> = [
        ["audiences [remind, waveform]", { audiences: ["remind", "waveform"] }, ["remind", "waveform"]],
        ["audiences [remind] (a list of one)", { audiences: ["remind"] }, ["remind"]],
        ["audiences [] (empty)", { audiences: [] }, []],
        ['audiences "remind" (a string)', { audiences: "remind" }, []],
        ["audiences beside receiving_app", { audiences: ["waveform"], receiving_app: "remind" }, ["waveform"]],
      ];
      for (const [where, path] of [
        ["POST /v1/proofs/app-verification", "/v1/proofs/app-verification"],
        ["the App verification page's POST /v1/apps/commit/proofs/app-verification", "/v1/apps/commit/proofs/app-verification"],
      ] as const) {
        for (const [shape, body, apps] of shapes) {
          const scope = `pp.single.${tag()}`;
          const answer = await issueAppVerificationRaw(ctx, "commit", { ...body, scopes: [scope] }, { path });
          const e = answer.body.error;
          results.check(
            `${where} with ${shape} → 422 app_verification_single_app: "An App verification is for exactly one app; ask for one proof per app.", the hint naming receiving_app and ${path}, details.field audiences${apps.length ? ` and details.apps ${JSON.stringify(apps)}` : ""}; nothing stored`,
            answer.status === 422 &&
              e?.code === "app_verification_single_app" &&
              e.message === "An App verification is for exactly one app; ask for one proof per app." &&
              (e.hint ?? "").includes("receiving_app") &&
              (e.hint ?? "").includes(`POST ${path}`) &&
              e.details?.field === "audiences" &&
              JSON.stringify(e.details?.apps ?? []) === JSON.stringify(apps) &&
              (await made(scope)) === "0",
            `${answer.status} ${short(e, 500)}`,
          );
        }
      }
      // A refused request never uses its Idempotency-Key: the same key with the one-app body issues the proof.
      const key = randomUUID();
      const refused = await issueAppVerificationRaw(ctx, "commit", { audiences: ["remind", "waveform"] }, { key });
      const fixed = await issueAppVerificationFor(ctx, "commit", "remind", {}, { key });
      results.check("the same Idempotency-Key, refused with audiences and then sent with receiving_app remind → 422, then 201 (not a replay)", refused.status === 422 && fixed.status === 201 && fixed.headers.get("idempotent-replayed") === null && namesOnly(fixed.body, "remind"), `${refused.status} → ${fixed.status} ${fixed.headers.get("idempotent-replayed")} ${short(fixed.body.receiving_app ?? fixed.body.error)}`);

      // receiving_app: required, and one app.
      const missing = await issueAppVerificationRaw(ctx, "commit", { scopes: ["x"] });
      const missingFields = (missing.body.error?.details?.fields ?? {}) as Record<string, string>;
      results.check("no receiving_app → 422 validation_failed on receiving_app (\"is required: the one app that may verify the proof\")", missing.status === 422 && errorCode(missing.body) === "validation_failed" && /required/.test(missingFields.receiving_app ?? ""), `${missing.status} ${short(missing.body.error)}`);
      const list = await issueAppVerificationRaw(ctx, "commit", { receiving_app: ["remind", "waveform"] });
      results.check("receiving_app as a list → 422 (a proof names one app)", list.status === 422, `${list.status} ${short(list.body.error)}`);
      const unknownField = await issueAppVerificationRaw(ctx, "commit", { receiving_app: "remind", receiving_apps: ["waveform"] });
      results.check("an unknown body field (receiving_apps) → 422 (bodies are strict)", unknownField.status === 422, `${unknownField.status} ${short(unknownField.body.error)}`);

      // The receiving-app rules, one app at a time.
      const cases: Array<[string, string, number, string]> = [
        ["Commit itself", "commit", 400, "invalid_receiving_app"],
        ["Silicon Accounts itself", "accounts", 400, "invalid_receiving_app"],
        ["the developer platform (first-party app developer)", "developer", 400, "invalid_receiving_app"],
        ["an unknown app", "nope-pp-app", 400, "unknown_receiving_app"],
        ["a malformed app id", "Not An App!", 422, "validation_failed"],
      ];
      for (const [what, app, status, codeName] of cases) {
        const answer = await issueAppVerificationFor(ctx, "commit", app);
        results.check(`an App verification proof for ${what} → ${status} ${codeName}`, answer.status === status && errorCode(answer.body) === codeName, `${answer.status} ${short(answer.body.error)}`);
        if (codeName === "unknown_receiving_app") results.check("…the unknown app is named in details.app_ids", JSON.stringify(answer.body.error?.details?.app_ids) === '["nope-pp-app"]', short(answer.body.error?.details));
      }
      const normalized = await issueAppVerificationFor(ctx, "commit", " Remind");
      results.check('the app id is trimmed and lower-cased (" Remind" → a proof for remind)', normalized.status === 201 && namesOnly(normalized.body, "remind"), `${normalized.status} ${short(normalized.body.receiving_app ?? normalized.body.error)}`);
      await sql(env, "update apps set status = 'disabled' where app_id = 'waveform'");
      try {
        const disabled = await issueAppVerificationFor(ctx, "commit", "waveform");
        results.check("a disabled receiving app → 403 receiving_app_disabled naming it", disabled.status === 403 && errorCode(disabled.body) === "receiving_app_disabled" && JSON.stringify(disabled.body.error?.details?.app_ids) === '["waveform"]', `${disabled.status} ${short(disabled.body.error)}`);
      } finally {
        await sql(env, "update apps set status = 'active' where app_id = 'waveform'");
      }
      const back = await issueAppVerificationFor(ctx, "commit", "waveform");
      results.check("…and accepted again once it is active", back.status === 201 && namesOnly(back.body, "waveform"), `${back.status} ${short(back.body.error)}`);

      // Through the fake app's own issue-app_verification action (it sends receiving_app): one proof for the app it names.
      const viaApp = await json<{ status: number; body: IssuedProof }>(`${env.apps}/commit/actions/issue-app_verification`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_app: "waveform", scopes: ["pp.via-app"] }) });
      results.check("Commit's own issue-app_verification action gets one proof for waveform", viaApp.status === 201 && viaApp.body.status === 201 && namesOnly(viaApp.body.body, "waveform") && (await verifyAs(ctx, "waveform", viaApp.body.body.proof_token)).body.valid === true, `${viaApp.status} ${short(viaApp.body.body?.receiving_app ?? viaApp.body)}`);
    },
  },
];

/**
 * Proofs through the `silicon-accounts` CLI (UNDERSTANDING.md: "Everything should work through the CLI first, and the account
 * site is a subset of it"): an app issues, verifies, refreshes, lists and revokes proofs with `silicon-accounts app proof …`
 * and its own credentials (the secret on stdin); `--to` names exactly one app for an app verification proof; a Carbon signed in to
 * the CLI lists and revokes the User verification proofs issued on its behalf with `silicon-accounts proofs …`. Exit codes and `--json`
 * answers are what scripts and Silicons rely on.
 */
import type { Journey } from "../../context";
import { cli, cliHome, codeFor, fakeApp, lastSeq, sql, tag, type CliRun } from "../../lib";
import { appTokens, isExactlyInvalid, short, signInToApp, verifyAs } from "./_helpers";

const brief = (run: CliRun) => `exit ${run.code}: ${short(run.json ?? run.stdout.trim() ?? run.stderr.trim(), 400)}${run.code !== 0 && run.stderr.trim() ? ` | stderr ${short(run.stderr.trim(), 200)}` : ""}`;

export const journey: Journey = {
  name: "proofs-perf-cli",
  title: "the silicon-accounts CLI: an app issues (User verification and one-app App verification; `--to remind,waveform` refused), verifies (exit 0 valid, exit 2 with exactly {valid:false, expires_at:null}), refreshes (reuse caught), lists and revokes proofs with its own credentials; a Carbon signed in to the CLI lists and revokes its User verification proofs",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await signInToApp(ctx, "dm");
    const subject = (await appTokens(env, "dm", carbon.uuid)).access_token;
    const home = cliHome();
    const asApp = (app: string, args: string[], secret = fakeApp(app).secret) => cli(env, home, ["app", "proof", ...args, "--app-id", app, "--app-secret-stdin", "--json"], { stdin: `${secret}\n` });

    // User verification: dm issues for Briefcase; Briefcase verifies; another app is told exactly "not valid".
    const user_verification = await asApp("dm", ["user_verification", "--subject-token", subject, "--to", "briefcase", "--scope", "files.write", "--ttl", "300"]);
    const oboToken = String(user_verification.json?.proof_token ?? "");
    const oboId = String(user_verification.json?.proof_id ?? "");
    results.check("`silicon-accounts app proof user-verification --to briefcase` (as dm) → exit 0: kind user_verification, receiving_app briefcase, the Carbon, a sap_ token", user_verification.code === 0 && user_verification.json?.kind === "user_verification" && user_verification.json.receiving_app === "briefcase" && (user_verification.json.user as { uuid?: string } | undefined)?.uuid === carbon.uuid && oboToken.startsWith("sap_"), brief(user_verification));
    const valid = await asApp("briefcase", ["verify", oboToken]);
    results.check("`silicon-accounts app proof verify` as briefcase → exit 0 with the valid verdict (issued by dm, for the Carbon)", valid.code === 0 && valid.json?.valid === true && (valid.json.issuing_app as { app_id?: string } | undefined)?.app_id === "dm" && (valid.json.user as { uuid?: string } | undefined)?.uuid === carbon.uuid, brief(valid));
    const invalid = await asApp("remind", ["verify", oboToken]);
    results.check("…as remind (not the receiving app) → exit 2 with exactly {valid:false, expires_at:null}", invalid.code === 2 && isExactlyInvalid(invalid.json), brief(invalid));
    const wrongSecret = await asApp("briefcase", ["verify", oboToken], "sa_app_briefcase_wrong");
    results.check("…with a wrong app secret → refused (exit 3, invalid_app_credentials), never a verdict", wrongSecret.code === 3 && (wrongSecret.json?.error as { code?: string } | undefined)?.code === "invalid_app_credentials" && !("valid" in (wrongSecret.json ?? {})), brief(wrongSecret));

    // App verification: one app per proof; --to with two apps is refused before anything is sent.
    const scope = `pp.cli.${tag()}`;
    const app_verification = await asApp("commit", ["app_verification", "--to", "remind", "--scope", scope]);
    results.check("`silicon-accounts app proof app-verification --to remind` (as commit) → exit 0: kind app_verification, receiving_app remind, user null", app_verification.code === 0 && app_verification.json?.kind === "app_verification" && app_verification.json.receiving_app === "remind" && app_verification.json.user === null, brief(app_verification));
    const ataValid = await asApp("remind", ["verify", String(app_verification.json?.proof_token ?? "")]);
    const ataOther = await asApp("waveform", ["verify", String(app_verification.json?.proof_token ?? "")]);
    results.check("…remind verifies it (exit 0); waveform gets exit 2, exactly invalid", ataValid.code === 0 && ataValid.json?.valid === true && ataOther.code === 2 && isExactlyInvalid(ataOther.json), `${brief(ataValid)} / ${brief(ataOther)}`);
    const two = await asApp("commit", ["app_verification", "--to", "remind,waveform", "--scope", scope]);
    const twoError = (two.json?.error ?? {}) as { message?: string; hint?: string };
    const [[stored] = []] = await sql(env, `select count(*) from proof_families where '${scope}' = any(scopes)`);
    results.check(
      "`--to remind,waveform` → exit 2: \"An app verification proof is for exactly one app\", the hint giving one command per app; nothing issued",
      two.code === 2 && /exactly one app/.test(twoError.message ?? "") && /--to remind/.test(twoError.hint ?? "") && /--to waveform/.test(twoError.hint ?? "") && stored === "1",
      `${brief(two)}; proofs with the scope: ${stored}`,
    );

    // Refresh, then a reuse of the used refresh token (on a proof of its own), then revoke.
    const refreshed = await asApp("dm", ["refresh", String(user_verification.json?.proof_refresh_token ?? "")]);
    results.check("`silicon-accounts app proof refresh` (as dm) → exit 0: the same proof, a new proof token that Briefcase verifies", refreshed.code === 0 && refreshed.json?.proof_id === oboId && refreshed.json.proof_token !== oboToken && (await verifyAs(ctx, "briefcase", String(refreshed.json.proof_token))).body.valid === true, brief(refreshed));
    const spare = await asApp("dm", ["user_verification", "--subject-token", subject, "--to", "briefcase"]);
    const spareRefresh = String(spare.json?.proof_refresh_token ?? "");
    await asApp("dm", ["refresh", spareRefresh]);
    const reused = await asApp("dm", ["refresh", spareRefresh]);
    const reusedError = (reused.json?.error ?? {}) as { code?: string; exit_code?: number };
    results.check("refreshing with an already used refresh token → a non-zero exit with proof_refresh_token_reused (the exit code in the JSON too), and the proof is revoked", reused.code !== 0 && reusedError.code === "proof_refresh_token_reused" && reusedError.exit_code === reused.code && isExactlyInvalid((await verifyAs(ctx, "briefcase", String(spare.json?.proof_token ?? ""))).body), brief(reused));
    const revoked = await asApp("dm", ["revoke", oboId]);
    const afterRevoke = await asApp("briefcase", ["verify", String(refreshed.json?.proof_token ?? "")]);
    results.check("`silicon-accounts app proof revoke <proof_id>` (as dm) → exit 0 {revoked: true}; Briefcase's verify then exits 2", revoked.code === 0 && revoked.json?.revoked === true && afterRevoke.code === 2 && isExactlyInvalid(afterRevoke.json), `${brief(revoked)} / ${brief(afterRevoke)}`);
    const listRevoked = await asApp("dm", ["list", "--kind", "user_verification", "--status", "revoked", "--limit", "50"]);
    const items = (listRevoked.json?.items ?? []) as Array<{ proof_id?: string; receiving_app?: string; revoke_reason?: string }>;
    const mine = items.find(item => item.proof_id === oboId);
    results.check("`silicon-accounts app proof list --kind user_verification --status revoked` lists it: receiving_app briefcase, revoked_by_app", listRevoked.code === 0 && mine?.receiving_app === "briefcase" && mine.revoke_reason === "revoked_by_app", brief(listRevoked));
    const listExpired = await asApp("dm", ["list", "--status", "expired", "--limit", "5"]);
    results.check("`--status expired` is a status the listing takes too (exit 0)", listExpired.code === 0 && Array.isArray(listExpired.json?.items), brief(listExpired));

    // The Carbon's own CLI: sign in with an email code, list the User verification proofs issued on its behalf, revoke one.
    const keep = await asApp("dm", ["user_verification", "--subject-token", subject, "--to", "briefcase", "--scope", "pp.cli.keep"]);
    const keepId = String(keep.json?.proof_id ?? "");
    const after = await lastSeq(env);
    const started = await cli(env, home, ["login", "--email", carbon.email, "--json"]);
    const code = await codeFor(env, carbon.email, after);
    const login = await cli(env, home, ["login", "--email", carbon.email, "--code", code, "--json"]);
    results.check("the Carbon signs in to the CLI with an email code (`silicon-accounts login --email`, then `--code`)", started.code === 0 && started.json?.status === "code_sent" && login.code === 0, `${brief(started)} / ${brief(login)}`);
    const listed = await cli(env, home, ["proofs", "list", "--json"]);
    const own = ((listed.json?.items ?? []) as Array<{ proof_id?: string; status?: string; issuing_app?: { app_id?: string }; receiving_app?: { app_id?: string } }>);
    const keepItem = own.find(item => item.proof_id === keepId);
    results.check(
      "`silicon-accounts proofs list` shows the User verification proofs issued on its behalf: the live one active (DM at Briefcase), the revoked one revoked",
      listed.code === 0 && keepItem?.status === "active" && keepItem.issuing_app?.app_id === "dm" && keepItem.receiving_app?.app_id === "briefcase" && own.find(item => item.proof_id === oboId)?.status === "revoked",
      brief(listed),
    );
    const revokeOwn = await cli(env, home, ["proofs", "revoke", keepId, "--json"]);
    results.check("`silicon-accounts proofs revoke <proof_id>` → exit 0, and Briefcase's next verify is exactly invalid", revokeOwn.code === 0 && revokeOwn.json?.revoked === true && isExactlyInvalid((await verifyAs(ctx, "briefcase", String(keep.json?.proof_token ?? ""))).body), brief(revokeOwn));
    const [[reason] = []] = await sql(env, `select revoke_reason from proof_families where id = '${keepId}'`);
    results.check("…stored as revoked_by_account", reason === "revoked_by_account", String(reason));
    results.metric("CLI user_verification issue (process, end to end)", user_verification.ms);
    results.metric("CLI verify (process, end to end)", valid.ms);
  },
};

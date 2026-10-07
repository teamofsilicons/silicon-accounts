import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { forgetRateLimits, sql, tag } from "../../lib";
import { accounts, asCarbon, cliError, freshDir, loginCarbon, loginSilicon, obj, said, short, signUpCarbon, str, type Json } from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-login-status",
  title: "`accounts login status`: signed out it is {\"authenticated\":false} with exit 1 (JSON and text, online and --offline); signed in it says as whom; it follows a session to its end (logout, a revoked session, an expired one) and refreshes an access token about to expire",
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();

    // 1. Signed out.
    const home = freshDir();
    const out = await accounts(env, ["login", "status", "--json"], { home });
    results.check("signed out: exit 1 and exactly {\"authenticated\": false}", out.code === 1 && JSON.stringify(out.json) === '{"authenticated":false}', said(out));
    const offline = await accounts(env, ["login", "status", "--offline", "--json"], { home });
    results.check("…the same with --offline (no network)", offline.code === 1 && JSON.stringify(offline.json) === '{"authenticated":false}', said(offline));
    const text = await accounts(env, ["login", "status"], { home });
    results.check("in text mode: exit 1, 'Not signed in to <url>.' and how to sign in (stderr)", text.code === 1 && text.stdout.trim() === `Not signed in to ${env.site}.` && text.stderr.includes("accounts login --silicon si:<id> --stk-stdin"), said(text));
    const quiet = await accounts(env, ["login", "status", "-q"], { home });
    results.check("-q drops the suggestions, keeps the answer and the exit code", quiet.code === 1 && quiet.stderr.trim() === "" && quiet.stdout.includes("Not signed in"), said(quiet));
    const emptyDir = await accounts(env, ["login", "status", "--json"], { home: freshDir() });
    results.check("a brand-new home is not touched by a status check", emptyDir.code === 1, said(emptyDir));

    // 2. Signed in as a Silicon.
    const carbon = await signUpCarbon(env, "status");
    const stk = `stk-57a7${"5".repeat(8)}`;
    const made = await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: `si:status-${t}`, display_name: `Status ${t}`, stk });
    const uuid = str(obj(obj(made.body).silicon).uuid);
    await loginSilicon(env, home, `si:status-${t}`, stk);
    const inStatus = await accounts(env, ["login", "status", "--json"], { home });
    const json = inStatus.json ?? {};
    const accessIn = (Date.parse(str(json.expires_at)) - Date.now()) / 60_000;
    const refreshIn = (Date.parse(str(json.refresh_expires_at)) - Date.now()) / 86_400_000;
    results.check("signed in: exit 0, authenticated, kind silicon, its si:id and uuid, checked with the service", inStatus.code === 0 && json.authenticated === true && json.kind === "silicon" && json.id === `si:status-${t}` && json.uuid === uuid && json.verified === true && json.url === env.site, said(inStatus));
    results.check("…its access token lasts 30 minutes, the session 900 days", accessIn > 28 && accessIn <= 30.1 && refreshIn > 899 && refreshIn <= 900.01, `${accessIn.toFixed(2)} min, ${refreshIn.toFixed(3)} days`);
    const offlineIn = await accounts(env, ["login", "status", "--offline", "--json"], { home });
    results.check("--offline reports the stored session without checking it (verified: false)", offlineIn.code === 0 && offlineIn.json?.authenticated === true && offlineIn.json?.verified === false, said(offlineIn));
    const siliconHistory = await accounts(env, ["history", "--kind", "signin", "--json"], { home });
    const siliconSignin = ((siliconHistory.json?.items ?? []) as Json[]).find(item => obj(item.meta).method === "silicon_stk" && obj(item.meta).outcome === "success");
    const elsewhere = await accounts(env, ["login", "status", "--json"], { home, url: env.api });
    results.check("asked about another URL: exit 1, signed_in_elsewhere, naming where the session is", elsewhere.code === 1 && elsewhere.json?.authenticated === false && elsewhere.json?.reason === "signed_in_elsewhere" && elsewhere.json?.session_url === env.site, said(elsewhere));

    // 3. An access token about to expire is refreshed (and the refresh token rotated) by a status check.
    const sessionFile = join(home, ".accounts", "session.json");
    const stored = JSON.parse(readFileSync(sessionFile, "utf8")) as Json;
    writeFileSync(sessionFile, JSON.stringify({ ...stored, expires_at: new Date(Date.now() - 1000).toISOString() }));
    const refreshed = await accounts(env, ["login", "status", "--json"], { home });
    const after = JSON.parse(readFileSync(sessionFile, "utf8")) as Json;
    results.check("an access token past its time is refreshed by the next command (new tokens stored)", refreshed.code === 0 && refreshed.json?.authenticated === true && after.access_token !== stored.access_token && after.refresh_token !== stored.refresh_token && Date.parse(str(after.expires_at)) > Date.now() + 25 * 60_000, said(refreshed));

    // 4. Logout ends it.
    const logout = await accounts(env, ["logout", "--json"], { home });
    results.check("`accounts logout --json`: signed out, the session revoked at the service", logout.code === 0 && logout.json?.signed_out === true && logout.json?.revoked === true, said(logout));
    const afterLogout = await accounts(env, ["login", "status", "--json"], { home });
    results.check("…then status: exit 1, {\"authenticated\": false}", afterLogout.code === 1 && afterLogout.json?.authenticated === false, said(afterLogout));
    const revokedFamily = await sql(env, `select count(*) from token_families where account_uuid = '${uuid}' and revoked_at is not null and revoke_reason = 'user_signed_out'`);
    results.check("…and its sign-in is revoked at the service (user_signed_out)", Number(revokedFamily[0]?.[0]) >= 1, short(revokedFamily));
    const logoutAgain = await accounts(env, ["logout", "--json"], { home });
    results.check("logging out when signed out: exit 0, nothing to do", logoutAgain.code === 0 && logoutAgain.json?.signed_out === false, said(logoutAgain));

    // 5. A session revoked from another device ends too.
    const homeA = freshDir();
    const homeB = freshDir();
    const a = await loginCarbon(env, homeA, carbon);
    await loginCarbon(env, homeB, carbon);
    results.check("the Carbon signs in on two terminals (email codes)", a.finish.code === 0, said(a.finish));
    const listed = await accounts(env, ["sessions", "list", "--json"], { home: homeB });
    const sessions = (listed.json?.items ?? []) as Json[];
    const mine = sessions.find(item => item.current === true);
    const other = sessions.find(item => item.kind === "cli" && item.current !== true && item.origin === "cli_code");
    results.check("`accounts sessions list` shows both CLI sign-ins (cli, cli_code), the current one marked", !!mine && !!other, short(sessions.map(item => [item.kind, item.origin, item.current, item.label])));
    const revoke = await accounts(env, ["sessions", "revoke", str(other?.id), "--json"], { home: homeB });
    const statusA = await accounts(env, ["login", "status", "--json"], { home: homeA });
    results.check("revoking the other one from here: its `login status` then says not authenticated (exit 1, session_ended)", revoke.code === 0 && statusA.code === 1 && statusA.json?.authenticated === false && statusA.json?.reason === "session_ended", `${said(revoke)} | ${said(statusA)}`);
    const statusB = await accounts(env, ["login", "status", "--json"], { home: homeB });
    results.check("…while this one stays signed in", statusB.code === 0 && statusB.json?.authenticated === true, said(statusB));

    // 6. A session past its 900 days (time travel) has ended.
    await sql(env, `update token_families set expires_at = now() - interval '1 second' where account_uuid = '${carbon.uuid}' and revoked_at is null`);
    const sessionB = join(homeB, ".accounts", "session.json");
    const storedB = JSON.parse(readFileSync(sessionB, "utf8")) as Json;
    writeFileSync(sessionB, JSON.stringify({ ...storedB, expires_at: new Date(Date.now() - 1000).toISOString() }));
    const expired = await accounts(env, ["login", "status", "--json"], { home: homeB });
    results.check("a session past its end: status exit 1, session_ended", expired.code === 1 && expired.json?.reason === "session_ended", said(expired));
    const whoami = await accounts(env, ["whoami", "--json"], { home: homeB });
    results.check("…and a command that needs it: exit 3, not_signed_in (the dead session was cleared)", whoami.code === 3 && ["not_signed_in", "session_ended"].includes(str(cliError(whoami).code)), said(whoami));
    writeFileSync(sessionB, JSON.stringify({ ...storedB, refresh_expires_at: new Date(Date.now() - 1000).toISOString() }));
    const offlineEnded = await accounts(env, ["login", "status", "--offline", "--json"], { home: homeB });
    results.check("--offline knows a session whose refresh token has run out has ended (exit 1)", offlineEnded.code === 1 && offlineEnded.json?.reason === "session_ended", said(offlineEnded));

    // 7. The account's history tells the CLI sign-ins apart from browsers.
    const history = await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?kind=signin");
    const cliSignins = ((obj(history.body).items ?? []) as Json[]).filter(item => str(obj(item.meta).user_agent).startsWith("accounts-cli/"));
    results.check(
      "the history names a CLI sign-in's client as the CLI ('from 127.0.0.1 · accounts CLI <version>'), not as 'A browser'",
      cliSignins.length >= 2 && cliSignins.every(item => /^from \S+ · accounts CLI \d+\.\d+\.\d+$/.test(str(item.detail)) && !/browser/i.test(str(item.detail))),
      short(cliSignins.map(item => [item.title, item.detail, obj(item.meta).user_agent])),
    );
    const security = await asCarbon<Json>(env, carbon, "GET", "/v1/me/history?kind=security");
    const created = ((obj(security.body).items ?? []) as Json[]).filter(item => item.title === "New CLI sign-in");
    results.check("…and each new CLI sign-in is listed with its label and how it signed in ('… · with an email code')", created.length >= 2 && created.every(item => / · with an email code$/.test(str(item.detail))), short(created.map(item => item.detail)));
    results.check("the Silicon's own history names its STK sign-in from the CLI the same way", siliconSignin?.title === "Signed in to Silicon Accounts with the STK" && /^from \S+ · accounts CLI \d+\.\d+\.\d+$/.test(str(siliconSignin?.detail)), short(siliconSignin));
  },
};

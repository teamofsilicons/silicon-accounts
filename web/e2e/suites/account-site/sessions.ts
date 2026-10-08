/**
 * Settings → "Where you are signed in": every browser session, first-party (accounts CLI) sign-in and developer
 * platform sign-in (developers.teamofsilicons.com, the first-party app `developer`, 06-v2 §2) of the Carbon, with how
 * and from where; signing one out ends it at once (the other browser lands signed out, the CLI's tokens stop working
 * also after a refresh rotated them, the developer site is signed out at its next call); signing out here ends this
 * browser's own session and nothing else.
 */
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, api, codeFor, developerApi, lastSeq, shot, signInOnDeveloper, sleep, tag } from "../../lib";
import { DEVELOPER_SESSION_ENDED, call, codeOf, confirmMorph, newCarbon, rowByKey, rowsOf, signInAgain, until } from "./_helpers";

interface SessionInfo {
  id: string;
  kind: "browser" | "cli" | "developer";
  label: string | null;
  origin: string | null;
  ip: string | null;
  current: boolean;
}

const sessions: Journey = {
  name: "account-site-sessions",
  title: "sessions on Settings: this browser, another browser, an accounts CLI sign-in and a developer-site sign-in listed with how and from where; signing the other browser, the CLI and the developer site out ends each at once (refresh included); signing out here",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    // The developer site's page probes its session; once signed out there, that probe answers 401.
    const carbon = await newCarbon(ctx, "acct-sessions", { watch: [DEVELOPER_SIGNED_OUT] });
    const { page, probe } = carbon;
    // This browser's session is signed out from the first one, so its next page finds no session there (401).
    const second = await signInAgain(ctx, carbon.email, "acct-sessions-2", [/status of 401 \(Unauthorized\) @ \S+\/v1\/session$/]);

    // The accounts CLI's headless code sign-in (aud=accounts tokens), labelled.
    const label = `e2e terminal ${t}`;
    const after = await lastSeq(env);
    const start = await api<{ challenge_id?: string }>(ctx, "/v1/cli/login/start", { method: "POST", json: { email: carbon.email } });
    const code = await codeFor(env, carbon.email, after);
    const signed = await api<{ access_token?: string; refresh_token?: string }>(ctx, "/v1/cli/login/verify", { method: "POST", json: { challenge_id: start.body.challenge_id, code, client_label: label } });
    const bearer = { authorization: `Bearer ${signed.body.access_token ?? ""}` };
    const cliMe = await api<{ uuid?: string }>(ctx, "/v1/me", { headers: bearer });
    results.check("setup: the CLI is signed in as the Carbon", cliMe.status === 200 && cliMe.body.uuid === carbon.uuid, `${start.status} ${signed.status} ${cliMe.status}`);
    const refresh = (token: string) => api<{ refresh_token?: string; error?: string }>(ctx, "/v1/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: "accounts" }), headers: { "content-type": "application/x-www-form-urlencoded" } });
    const rotated = await refresh(signed.body.refresh_token ?? "");
    results.check("setup: the CLI's refresh token rotates", rotated.status === 200 && !!rotated.body.refresh_token && rotated.body.refresh_token !== signed.body.refresh_token, String(rotated.status));

    // The developer site, in this same browser: "Continue as" on the hosted pages (as the first-party app `developer`),
    // its server keeps the tokens.
    const developer = await carbon.context.newPage();
    results.watch(developer, "acct-sessions-developer", [DEVELOPER_SESSION_ENDED]);
    const devStarted = Date.now();
    const authorize = await signInOnDeveloper(env, developer, null);
    results.metric("developer site sign-in (Continue as, through its BFF)", Date.now() - devStarted);
    const devMe = await developerApi<{ uuid?: string }>(env, developer, "/me");
    results.check("setup: signed in to the developer site as the Carbon (app developer, through its BFF)", authorize.searchParams.get("app_id") === "developer" && devMe.status === 200 && devMe.body.uuid === carbon.uuid, `${authorize.searchParams.get("app_id")} ${devMe.status} ${devMe.body.uuid}`);

    const listed = (await call<{ items: SessionInfo[] }>(probe, "/v1/me/sessions")).body.items;
    const mine = listed.find(item => item.current);
    const other = listed.find(item => item.kind === "browser" && !item.current);
    const terminal = listed.find(item => item.kind === "cli");
    const platform = listed.find(item => item.kind === "developer");
    results.check("/v1/me/sessions: this browser (current), the other browser, the CLI", mine?.kind === "browser" && mine.ip === carbon.ip && other?.ip === second.ip && terminal?.label === label && terminal.origin === "cli_code" && terminal.ip === ctx.ip, JSON.stringify(listed.map(item => ({ kind: item.kind, ip: item.ip, current: item.current, label: item.label, origin: item.origin }))));
    results.check("…and the developer site: kind developer, named \"Silicon Developer (developers.teamofsilicons.com)\", not current", listed.length === 4 && platform?.label === "Silicon Developer (developers.teamofsilicons.com)" && platform.current === false, JSON.stringify(platform ?? listed.map(item => item.kind)));
    const fromSecond = (await call<{ items: SessionInfo[] }>(second.probe, "/v1/me/sessions")).body.items.find(item => item.current);
    results.check("the other browser sees its own session as the current one", fromSecond?.id === other?.id, `${fromSecond?.id} vs ${other?.id}`);
    const myApps = (await call<{ items: Array<{ app: { app_id: string } }> }>(probe, "/v1/me/apps")).body.items.map(item => item.app.app_id);
    results.check("the developer site is a session of Silicon Accounts, not an app signed into (not on /v1/me/apps)", !myApps.includes("developer") && !myApps.includes("accounts"), JSON.stringify(myApps));
    // Like Silicon Accounts itself, the developer platform is first-party: it is signed out as a session, and asking to
    // remove it as an app says so (rather than claiming the Carbon never signed into it).
    const asApp = await call<{ error?: { message?: string; hint?: string } }>(probe, "/v1/me/apps/developer", { method: "DELETE" });
    results.check("removing the developer platform as an app is refused like Silicon Accounts itself (400 first_party_app, pointing at sessions)", asApp.status === 400 && codeOf(asApp.body) === "first_party_app", `${asApp.status} ${codeOf(asApp.body)}: ${asApp.body.error?.message ?? ""} ${asApp.body.error?.hint ?? ""}`);

    // The page.
    const started = Date.now();
    await page.goto(`${env.site}/settings`);
    const list = page.getByRole("list", { name: "Signed-in sessions" });
    await list.waitFor({ timeout: 30_000 });
    results.metric("/settings sessions visible after navigation", Date.now() - started);
    await sleep(900);
    await shot(env, page, "acct-sessions-01-list", true);
    const rows = await rowsOf(page, "Signed-in sessions");
    results.check("four rows, this browser first", rows.length === 4 && /This browser/.test(rows[0] ?? "") && /Active now/.test(rows[0] ?? "") && (rows[0] ?? "").includes(`IP ${carbon.ip}`), rows.join(" || "));
    const otherRow = rowByKey(page, "Signed-in sessions", other?.id ?? "");
    const otherText = (await otherRow.innerText()).replace(/\s+/g, " ");
    results.check("the other browser's row: what it is and its address", otherText.includes(`IP ${second.ip}`) && /(Chrome|Safari|A browser)( on macOS)?/.test(otherText) && !/This browser/.test(otherText), otherText);
    const cliRow = rowByKey(page, "Signed-in sessions", terminal?.id ?? "");
    const cliText = (await cliRow.innerText()).replace(/\s+/g, " ");
    results.check("the CLI's row: its label, how it signed in and its address", cliText.includes(label) && cliText.includes("CLI sign-in with a code") && cliText.includes(`IP ${ctx.ip}`), cliText);
    const devRow = rowByKey(page, "Signed-in sessions", platform?.id ?? "");
    const devText = (await devRow.innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("the developer site's row: \"Silicon Developer\", on developers.teamofsilicons.com, never \"This browser\"", devText.startsWith("Silicon Developer") && devText.includes("developers.teamofsilicons.com") && !/This browser/.test(devText), devText);
    results.check("this browser's row signs out at once; the others ask first", (await rowByKey(page, "Signed-in sessions", mine?.id ?? "").getByRole("button", { name: "Sign out" }).count()) === 1);

    // Sign the other browser out from here.
    await confirmMorph(otherRow, "Sign out", "Sign out");
    const afterOther = await until(async () => (await call<{ items: SessionInfo[] }>(probe, "/v1/me/sessions")).body.items, items => items.length === 3, 8_000);
    results.check("the other browser's session is gone from the list", afterOther.length === 3 && !afterOther.some(item => item.id === other?.id));
    const otherSession = await call(second.probe, "/v1/session");
    results.check("…and that browser is signed out at once (401 on /v1/session)", otherSession.status === 401, String(otherSession.status));
    await second.page.goto(`${env.site}/`);
    const landing = await second.page.getByRole("link", { name: /sign in/i }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    results.check("…its next page is the signed-out landing page", landing);
    await second.context.close();

    // Sign the CLI out: its access token and its (rotated) refresh token stop working.
    await confirmMorph(cliRow, "Sign out", "Sign out");
    const cliAfter = await until(() => api(ctx, "/v1/me", { headers: bearer }), answer => answer.status === 401, 8_000);
    results.check("the CLI's access token is refused at once (401)", cliAfter.status === 401, String(cliAfter.status));
    const dead = await refresh(rotated.body.refresh_token ?? "");
    results.check("…and its refresh token too (400 invalid_grant)", dead.status === 400 && dead.body.error === "invalid_grant", `${dead.status} ${JSON.stringify(dead.body).slice(0, 160)}`);

    // Sign the developer site out from here: its server's next call is refused, and it shows its sign-in again.
    results.check("before: the developer site reads the account through its BFF", (await developerApi(env, developer, "/me")).status === 200);
    await confirmMorph(devRow, "Sign out", "Sign out");
    const devAfter = await until(() => developerApi<{ error?: { code?: string } }>(env, developer, "/me"), answer => answer.status === 401, 8_000);
    results.check("the developer site is signed out at once: its next call answers 401 (and it drops its session)", devAfter.status === 401, `${devAfter.status} ${codeOf(devAfter.body)}`);
    const devOwned = await developerApi(env, developer, "/me/owned-apps");
    results.check("…its owner calls are refused as well (401)", devOwned.status === 401, `${devOwned.status} ${codeOf(devOwned.body)}`);
    await developer.goto(`${env.developer}/`);
    const devSignIn = await developer.waitForURL(url => url.pathname.startsWith("/sign-in"), { timeout: 20_000 }).then(() => true, () => developer.getByRole("link", { name: /Continue with Silicon Accounts/ }).isVisible().catch(() => false));
    await shot(env, developer, "acct-sessions-02-developer-signed-out");
    results.check("…and its pages ask to sign in again", devSignIn, developer.url());
    await until(() => rowsOf(page, "Signed-in sessions"), current => current.length === 1, 8_000);
    results.check("only this browser is left on the page", (await rowsOf(page, "Signed-in sessions")).length === 1);
    results.check("…and this browser is still signed in to the account site", (await call(probe, "/v1/session")).status === 200);

    // Another Carbon can't sign this browser out by its session id.
    const intruder = await newCarbon(ctx, "acct-intruder");
    const across = await call(intruder.probe, `/v1/me/sessions/${mine?.id}`, { method: "DELETE" });
    const stillIn = await call(probe, "/v1/session");
    results.check("another Carbon can't sign this browser out (404 session_not_found; still signed in)", across.status === 404 && codeOf(across.body) === "session_not_found" && stillIn.status === 200, `${across.status} ${codeOf(across.body)} / ${stillIn.status}`);
    await intruder.context.close();

    // The API refuses sessions that are not this account's.
    const unknown = await call(probe, "/v1/me/sessions/01890000-0000-7000-8000-000000000000", { method: "DELETE" });
    const garbage = await call(probe, "/v1/me/sessions/not-a-session", { method: "DELETE" });
    results.check("unknown session ids are refused (404 session_not_found)", unknown.status === 404 && codeOf(unknown.body) === "session_not_found" && garbage.status === 404, `${unknown.status} ${garbage.status}`);
    const titles = (await call<{ items: Array<{ title: string }> }>(probe, "/v1/me/history?kind=security&limit=50")).body.items.map(item => item.title);
    results.check("history: the sign-outs (browser, CLI)", titles.includes("A browser session was signed out") && titles.includes("A CLI sign-in was signed out"), titles.slice(0, 6).join(" | "));
    // Three were signed out from here: the other browser, the CLI and the developer site; each named as what it was.
    const cliSignOuts = titles.filter(title => title === "A CLI sign-in was signed out").length;
    results.check("history: the developer site's sign-out is named as such (not as a second CLI sign-in)", cliSignOuts === 1 && titles.some(title => /developer/i.test(title) && /signed out/i.test(title)), titles.slice(0, 6).join(" | "));
    const signins = (await call<{ items: Array<{ title: string }> }>(probe, "/v1/me/history?kind=signin&limit=50")).body.items.map(item => item.title);
    results.check("history: the sign-ins (the site twice, the CLI, the developer site)", signins.length >= 4 && signins.some(title => title.startsWith("Signed in to Silicon Developer")), signins.join(" | "));

    // The developer site again (Continue as), so signing out of the account site can be seen to leave it alone.
    await signInOnDeveloper(env, developer, null);
    const devAgain = await developerApi<{ uuid?: string }>(env, developer, "/me");
    results.check("setup: signed in to the developer site again", devAgain.status === 200 && devAgain.body.uuid === carbon.uuid, String(devAgain.status));
    await page.goto(`${env.site}/settings`);
    await list.waitFor({ timeout: 30_000 });
    await until(() => rowsOf(page, "Signed-in sessions"), current => current.length === 2, 8_000);
    await sleep(600);

    // Sign out here: the landing page, and the session is over; the developer site keeps its own sign-in.
    await rowByKey(page, "Signed-in sessions", mine?.id ?? "").getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(`${env.site}/`, { timeout: 20_000 });
    const out = await page.getByRole("link", { name: /sign in/i }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const ended = await call(probe, "/v1/session");
    results.check("signing out here lands on the signed-out landing page and ends the session (401)", out && ended.status === 401, `${out} ${ended.status}`);
    const devKept = await developerApi<{ uuid?: string }>(env, developer, "/me");
    results.check("…and ends nothing else: the developer site's own sign-in still works", devKept.status === 200 && devKept.body.uuid === carbon.uuid, `${devKept.status} ${codeOf(devKept.body)}`);
    await carbon.context.close();
  },
};

export const journey = sessions;

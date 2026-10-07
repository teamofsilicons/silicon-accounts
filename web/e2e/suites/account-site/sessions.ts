/**
 * Settings → "Where you are signed in": every browser session and first-party (accounts CLI) sign-in of the Carbon,
 * with how and from where; signing one out ends it at once (the other browser lands signed out, the CLI's tokens stop
 * working, also after a refresh rotated them); signing out here ends this browser's own session.
 */
import type { Journey } from "../../context";
import { api, codeFor, lastSeq, shot, sleep, tag } from "../../lib";
import { call, codeOf, confirmMorph, newCarbon, rowByKey, rowsOf, signInAgain, until } from "./_helpers";

interface SessionInfo {
  id: string;
  kind: "browser" | "cli";
  label: string | null;
  origin: string | null;
  ip: string | null;
  current: boolean;
}

const sessions: Journey = {
  name: "account-site-sessions",
  title: "sessions on Settings: this browser, another browser and an accounts CLI sign-in listed with how and from where; signing the other browser and the CLI out ends them at once (refresh included); signing out here",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const carbon = await newCarbon(ctx, "acct-sessions");
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

    const listed = (await call<{ items: SessionInfo[] }>(probe, "/v1/me/sessions")).body.items;
    const mine = listed.find(item => item.current);
    const other = listed.find(item => item.kind === "browser" && !item.current);
    const terminal = listed.find(item => item.kind === "cli");
    results.check("/v1/me/sessions: this browser (current), the other browser, the CLI", listed.length === 3 && mine?.kind === "browser" && mine.ip === carbon.ip && other?.ip === second.ip && terminal?.label === label && terminal.origin === "cli_code" && terminal.ip === ctx.ip, JSON.stringify(listed.map(item => ({ kind: item.kind, ip: item.ip, current: item.current, label: item.label, origin: item.origin }))));
    const fromSecond = (await call<{ items: SessionInfo[] }>(second.probe, "/v1/me/sessions")).body.items.find(item => item.current);
    results.check("the other browser sees its own session as the current one", fromSecond?.id === other?.id, `${fromSecond?.id} vs ${other?.id}`);

    // The page.
    const started = Date.now();
    await page.goto(`${env.site}/settings`);
    const list = page.getByRole("list", { name: "Signed-in sessions" });
    await list.waitFor({ timeout: 30_000 });
    results.metric("/settings sessions visible after navigation", Date.now() - started);
    await sleep(900);
    await shot(env, page, "acct-sessions-01-list", true);
    const rows = await rowsOf(page, "Signed-in sessions");
    results.check("three rows, this browser first", rows.length === 3 && /This browser/.test(rows[0] ?? "") && /Active now/.test(rows[0] ?? "") && (rows[0] ?? "").includes(`IP ${carbon.ip}`), rows.join(" || "));
    const otherRow = rowByKey(page, "Signed-in sessions", other?.id ?? "");
    const otherText = (await otherRow.innerText()).replace(/\s+/g, " ");
    results.check("the other browser's row: what it is and its address", otherText.includes(`IP ${second.ip}`) && /(Chrome|Safari|A browser)( on macOS)?/.test(otherText) && !/This browser/.test(otherText), otherText);
    const cliRow = rowByKey(page, "Signed-in sessions", terminal?.id ?? "");
    const cliText = (await cliRow.innerText()).replace(/\s+/g, " ");
    results.check("the CLI's row: its label, how it signed in and its address", cliText.includes(label) && cliText.includes("CLI sign-in with a code") && cliText.includes(`IP ${ctx.ip}`), cliText);
    results.check("this browser's row signs out at once; the others ask first", (await rowByKey(page, "Signed-in sessions", mine?.id ?? "").getByRole("button", { name: "Sign out" }).count()) === 1);

    // Sign the other browser out from here.
    await confirmMorph(otherRow, "Sign out", "Sign out");
    const afterOther = await until(async () => (await call<{ items: SessionInfo[] }>(probe, "/v1/me/sessions")).body.items, items => items.length === 2, 8_000);
    results.check("the other browser's session is gone from the list", afterOther.length === 2 && !afterOther.some(item => item.id === other?.id));
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
    await until(() => rowsOf(page, "Signed-in sessions"), current => current.length === 1, 8_000);
    results.check("only this browser is left on the page", (await rowsOf(page, "Signed-in sessions")).length === 1);

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
    results.check("history: both sign-outs", titles.includes("A browser session was signed out") && titles.includes("A CLI sign-in was signed out"), titles.slice(0, 5).join(" | "));
    const signins = (await call<{ items: Array<{ title: string }> }>(probe, "/v1/me/history?kind=signin&limit=50")).body.items.map(item => item.title);
    results.check("history: the sign-ins (site twice, the CLI once)", signins.length >= 3, signins.join(" | "));

    // Sign out here: the landing page, and the session is over.
    await rowByKey(page, "Signed-in sessions", mine?.id ?? "").getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(`${env.site}/`, { timeout: 20_000 });
    const out = await page.getByRole("link", { name: /sign in/i }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const ended = await call(probe, "/v1/session");
    results.check("signing out here lands on the signed-out landing page and ends the session (401)", out && ended.status === 401, `${out} ${ended.status}`);
    await carbon.context.close();
  },
};

export const journey = sessions;

/**
 * The account site's own sign-in (first-party app `accounts`): no consent and no membership ever, return_to honoured
 * only on the site, a signed-in browser goes straight through (unless prompt=login), a forged `?code&state` or
 * `?error&error_description` in the address is never taken for a real return, the session cookie is HttpOnly/Lax and
 * signing out kills it on the server.
 */
import type { Journey } from "../../context";
import { codeFor, lastSeq, newContext, shot, sleep, sql, tag } from "../../lib";
import { Browserish, brief, redirectParams, sendCode, signUpVia, startSignIn } from "./_helpers";

const firstParty: Journey = {
  name: "auth-flows-first-party",
  title: "first-party sign-in on the account site: an existing Carbon with an email code lands on return_to (no consent, no membership), a signed-in browser skips the flow unless prompt=login, forged returns are ignored, the session cookie's flags, sign-out kills the session",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const owner = new Browserish(env, ctx.ip);
    const email = `site.${t}@example.test`;
    await signUpVia(owner, "spacestation", email);
    const me = (await owner.session())?.account;

    // At the API: the first-party flow never asks for consent and makes no membership.
    const api = new Browserish(env, ctx.ip);
    const s = await startSignIn(api, "accounts", { redirectUri: `${env.site}/sign-in`, pkce: "none", nonce: null });
    const sent = await sendCode(api, s.flow.id, { email });
    const verified = await api.act(s.flow.id, "verify", { code: sent.code ?? "" });
    const params = redirectParams(verified.body.flow ?? { redirect_to: null });
    results.check("an existing Carbon's code on the first-party flow → complete at once (no consent), back to /sign-in with code and state", verified.status === 200 && verified.body.flow.step === "complete" && !!params.get("code") && params.get("state") === s.state && (verified.body.flow.redirect_to ?? "").startsWith(`${env.site}/sign-in?`), brief(verified));
    results.check("…the first-party app is marked first_party in the flow view", verified.body.flow?.app.first_party === true);
    const setCookie = verified.headers.getSetCookie().find(line => line.startsWith("sa_session=")) ?? "";
    results.check("the code sets sa_session: HttpOnly, SameSite=Lax, Path=/, Max-Age 900 days", /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie) && /Path=\//.test(setCookie) && /Max-Age=77760000/.test(setCookie), setCookie.replace(/sas_[A-Za-z0-9_-]+/, "sas_…"));
    const memberships = await sql(env, `select count(*) from memberships where app_id = 'accounts' and account_uuid = '${me?.uuid}'`);
    results.check("…and no membership is ever made for the account site", memberships[0]?.[0] === "0", JSON.stringify(memberships));
    const fresh = new Browserish(env, ctx.ip);
    const fs = await startSignIn(fresh, "accounts", { redirectUri: `${env.site}/sign-in`, pkce: "none", nonce: null });
    const fsent = await sendCode(fresh, fs.flow.id, { email: `site.new.${t}@example.test` });
    const fverified = await fresh.act(fs.flow.id, "verify", { code: fsent.code ?? "" });
    const fsigned = await fresh.act(fs.flow.id, "signup", {});
    results.check("a new address on the site: signup, then complete with no consent step", fverified.body.flow?.step === "signup" && fsigned.status === 200 && fsigned.body.flow.step === "complete", brief(fsigned));

    // In the browser.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "first-party");
    const visited: string[] = [];
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
    });
    await page.goto(`${env.site}/sign-in?return_to=${encodeURIComponent("/apps")}`);
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const mark = await lastSeq(env);
    await field.fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, email, mark);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 25 });
    await page.waitForURL(`${env.site}/apps`, { timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(500);
    await shot(env, page, "auth-flows-first-party-01-apps");
    results.check("signed in with a code, the site lands on return_to (/apps), with no consent screen", new URL(page.url()).pathname === "/apps" && (await page.getByRole("button", { name: "Share and continue" }).count()) === 0, visited.join(" → "));
    const cookie = (await context.cookies(env.site)).find(entry => entry.name === "sa_session");
    const days = cookie ? (cookie.expires - Date.now() / 1000) / 86_400 : 0;
    // Browsers cap a cookie's lifetime at 400 days (RFC 6265bis §5.5; Chromium and WebKit do), whatever Max-Age says.
    results.check("the browser keeps the session cookie HttpOnly, SameSite=Lax, Path=/ (lifetime: Max-Age capped by the browser at 400 days)", !!cookie && cookie.httpOnly && cookie.sameSite === "Lax" && cookie.path === "/" && days > 399, JSON.stringify({ ...cookie, value: "…" }));
    results.metric("session cookie lifetime the browser keeps", days, "days");
    const history = await sql(env, `select method, outcome from signin_history where account_uuid = '${me?.uuid}' and app_id = 'accounts' order by at desc limit 1`);
    results.check("the sign-in is in the account's history (accounts, email, success)", JSON.stringify(history) === JSON.stringify([["email", "success"]]), JSON.stringify(history));

    // Signed in: /sign-in goes straight to return_to, no flow. A forged return in the address is ignored.
    visited.length = 0;
    await page.goto(`${env.site}/sign-in?return_to=${encodeURIComponent("/silicons")}`);
    await page.waitForURL(`${env.site}/silicons`, { timeout: 30_000 });
    results.check("a signed-in browser at /sign-in goes straight to return_to without any flow", !visited.some(path => path.startsWith("/authorize")), visited.join(" → "));
    await page.goto(`${env.site}/sign-in?return_to=${encodeURIComponent("https://evil.example/")}`);
    await page.waitForURL(url => url.origin === env.site && !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
    results.check("a return_to on another origin is ignored (the site's home instead)", new URL(page.url()).origin === env.site && new URL(page.url()).pathname === "/", page.url());
    await page.goto(`${env.site}/sign-in?code=sac_forged&state=never-saved-${t}&error_description=EVIL+TEXT+${t}`);
    await page.waitForURL(url => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
    await sleep(500);
    results.check("a forged ?code&state is not taken for a return (no error, never shows the address's text)", !(await page.locator("body").innerText()).includes(`EVIL TEXT ${t}`), page.url());

    // prompt=login asks again even though signed in.
    await page.goto(`${env.site}/sign-in?prompt=login&return_to=${encodeURIComponent("/activity")}`);
    await field.waitFor({ timeout: 30_000 });
    results.check("prompt=login shows the methods (no Continue as) although signed in", (await page.getByRole("button", { name: /^Continue as/ }).count()) === 0);
    const again = await lastSeq(env);
    await field.fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code2 = await codeFor(env, email, again);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code2, { delay: 25 });
    await page.waitForURL(`${env.site}/activity`, { timeout: 30_000 });
    results.check("…and after the code it lands on return_to as the same Carbon", (await (await page.request.get(`${env.site}/v1/session`)).json() as { account?: { uuid?: string } }).account?.uuid === me?.uuid);

    // Signing out ends the session on the server: the old cookie value is dead everywhere.
    const value = cookie?.value ?? "";
    const out = await page.evaluate(async () => (await fetch("/v1/session/signout", { method: "POST", credentials: "include" })).status);
    results.check("POST /v1/session/signout from the page → 204", out === 204, String(out));
    const after = await page.request.get(`${env.site}/v1/session`);
    results.check("…the browser is signed out (GET /v1/session → 401)", after.status() === 401, String(after.status()));
    const replay = await fetch(`${env.site}/v1/session`, { headers: { cookie: `sa_session=${value}` } });
    results.check("…and the old cookie value replayed elsewhere is refused (401): revoked on the server", replay.status === 401, String(replay.status));
    await context.close();

    // A signed-out browser with a forged error in the address: the page never repeats its text.
    const other = await newContext(browser);
    const p2 = await other.newPage();
    results.watch(p2, "first-party-forged");
    await p2.goto(`${env.site}/sign-in?error=access_denied&error_description=EVIL+TEXT+${t}&state=unknown-${t}`);
    await p2.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    results.check("signed out, a forged ?error&state starts a normal sign-in and never shows the address's text", !(await p2.locator("body").innerText()).includes(`EVIL TEXT ${t}`), p2.url());
    await other.close();
  },
};

export const journeys: Journey[] = [firstParty];

/**
 * The developer site's sign-in over time, through its BFF: the access token running out (time travel: the sealed cookie
 * says it expires now) is refreshed on the server, once, even for a request that still carries the old cookie; signing
 * out revokes the sign-in wherever its cookie was copied, and leaves the account site's own sign-in alone; the callback
 * refuses what this browser did not start, in fixed words; a sign-in only ever comes back to this site's own pages; a
 * refresh token used twice ends the whole sign-in; and without its PKCE verifier a code is worth nothing.
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { developerApi, fakeApp, newContext, shot, signInOnDeveloper, signInWithCode, sleep, tag } from "../../lib";
import { SESSION_COOKIE, SIGNIN_COOKIE, bearer, developerSecret, errorCode, ownerSignIn, readDevSession, signOutOfDeveloper, tokenCall, unseal, writeDevSession, type DevSession } from "./_helpers";

/** The sign-in card's alert (a failed sign-in) or status (signed out), as shown. */
async function cardNotice(page: Page): Promise<string> {
  const notice = page.locator("main").getByRole("alert").or(page.locator("main").getByRole("status")).first();
  await notice.waitFor({ timeout: 15_000 }).catch(() => undefined);
  return (await notice.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
}

export const journey: Journey = {
  name: "developer-site-bff-session",
  title: "the developer site's sign-in over time: an expiring access token refreshed once on the server (also for a request with the old cookie), sign-out revoking the tokens everywhere but leaving the account site signed in, the callback's fixed refusals, return_to kept on the site, a reused refresh token ending the sign-in, and PKCE required of the public client",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const appId = "quill-docs";
    const { context, page } = await ownerSignIn(ctx, appId, { label: "bff-session", expected: [/status of 400 \(Bad Request\) @ .*\/v1\/flows/] });
    await page.getByRole("list", { name: "Your apps" }).waitFor({ timeout: 30_000 });
    const developerHost = new URL(env.developer).hostname;

    // 1. The access token runs out: the cookie says it has 5 seconds left, so the next call refreshes it first.
    const first = (await readDevSession(context, env)).session as DevSession;
    await writeDevSession(context, env, { ...first, ae: Date.now() + 5_000 });
    const oldCookie = (await readDevSession(context, env)).cookie?.value ?? "";
    const started = performance.now();
    const me = await developerApi<{ id?: string }>(env, page, "/me");
    results.metric("a BFF call that refreshes the access token first", performance.now() - started);
    const second = (await readDevSession(context, env)).session as DevSession;
    results.check("an access token with under a minute left is refreshed by the BFF before the call (the call answers)", me.status === 200 && !!second && second.rt !== first.rt && second.at !== first.at, `${me.status}; refresh token ${first.rt.slice(0, 10)}… → ${second?.rt.slice(0, 10)}…`);
    results.check("…the new access token lives 30 minutes again, and the browser got it only sealed", (second.ae - Date.now()) / 60_000 > 25, `${((second.ae - Date.now()) / 60_000).toFixed(1)} min`);

    // 2. A request that left with the old cookie (another tab) gets the same new tokens instead of reusing the old one.
    const twin = await newContext(browser);
    await twin.addCookies([{ name: SESSION_COOKIE, value: oldCookie, domain: developerHost, path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }]);
    const twinPage = await twin.newPage();
    const twinMe = await developerApi(env, twinPage, "/me");
    const twinSession = (await readDevSession(twin, env)).session;
    results.check("a request still carrying the old cookie is answered with the same new tokens (single-flight refresh, no reuse)", twinMe.status === 200 && twinSession?.rt === second.rt, `${twinMe.status}; ${twinSession?.rt.slice(0, 10)}… vs ${second.rt.slice(0, 10)}…`);
    results.check("…and the sign-in goes on in the first tab", (await developerApi(env, page, "/me")).status === 200);

    // 3. Signing out revokes the sign-in, wherever its cookie was copied.
    const before = (await readDevSession(context, env)).session as DevSession;
    const beforeCookie = (await readDevSession(context, env)).cookie?.value ?? "";
    await signOutOfDeveloper(env, page);
    const notice = await cardNotice(page);
    await shot(env, page, "ds-b-01-signed-out");
    results.check("Sign out lands on the sign-in card: signed out of the developer site, the Silicon Accounts sign-in untouched", page.url() === `${env.developer}/sign-in?signed_out=1` && /You are signed out of the developer site\. Your Silicon Accounts sign-in is untouched\./.test(notice), `${page.url()} — ${notice}`);
    results.check("…the session cookie is gone", !(await readDevSession(context, env)).cookie?.value);
    const oldAccess = await bearer(ctx, before.at, "/v1/me");
    results.check("…its access token is dead at accounts-api (401)", oldAccess.status === 401 && ["token_revoked", "invalid_token"].includes(errorCode(oldAccess.body) ?? ""), `${oldAccess.status} ${errorCode(oldAccess.body)}`);
    const oldRefresh = await tokenCall<{ error?: string }>(ctx, { grant_type: "refresh_token", refresh_token: before.rt, client_id: "developer" });
    results.check("…and so is its refresh token (invalid_grant)", oldRefresh.status === 400 && oldRefresh.body.error === "invalid_grant", `${oldRefresh.status} ${JSON.stringify(oldRefresh.body).slice(0, 160)}`);
    const twinAfter = await developerApi(env, twinPage, "/me");
    results.check("…the tab holding a copy of the cookie is signed out too (401) and its cookie cleared", twinAfter.status === 401 && !(await readDevSession(twin, env)).cookie?.value, `${twinAfter.status} ${errorCode(twinAfter.body)}`);
    await twin.close();
    await context.addCookies([{ name: SESSION_COOKIE, value: beforeCookie, domain: developerHost, path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }]);
    const replayed = await developerApi(env, page, "/me");
    results.check("…a copy of the old cookie put back is refused (401) and cleared", replayed.status === 401 && !(await readDevSession(context, env)).cookie?.value, `${replayed.status} ${errorCode(replayed.body)}`);
    const accountSite = await page.request.get(`${env.site}/v1/session`);
    results.check("…while the browser stays signed in to the account site (GET /v1/session 200)", accountSite.status() === 200, String(accountSite.status()));

    // 4. The callback refuses what this browser did not start, with fixed words (never the address's own).
    await page.goto(`${env.developer}/auth/callback?code=sac_forged&state=forged-${tag()}`);
    await page.waitForURL(url => url.pathname === "/sign-in", { timeout: 20_000 });
    const mismatch = await cardNotice(page);
    results.check("a callback with a state this browser never started lands on /sign-in?error=state_mismatch with fixed words", new URL(page.url()).searchParams.get("error") === "state_mismatch" && /That sign-in was started in another tab, or took longer than 10 minutes/.test(mismatch), `${page.url()} — ${mismatch}`);
    const startOne = async (returnTo: string, headers: Record<string, string> = {}) => {
      const answer = await page.request.get(`${env.developer}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, { maxRedirects: 0, headers });
      return { status: answer.status(), location: answer.headers().location ?? "", setCookie: answer.headers()["set-cookie"] ?? "" };
    };
    const pendingList = async () => unseal<Array<{ s: string; r: string }>>((await context.cookies(env.developer)).find(cookie => cookie.name === SIGNIN_COOKIE)?.value, SIGNIN_COOKIE, developerSecret(env)) ?? [];
    const cancelled = await startOne(`/apps/${appId}`);
    const cancelState = new URL(cancelled.location).searchParams.get("state") ?? "";
    const planted = "Your account is locked, call +1 555 0100 now";
    await page.goto(`${env.developer}/auth/callback?error=access_denied&error_description=${encodeURIComponent(planted)}&state=${cancelState}`);
    await page.waitForURL(url => url.pathname === "/sign-in", { timeout: 20_000 });
    const denied = await cardNotice(page);
    const deniedText = await page.locator("body").innerText();
    await shot(env, page, "ds-b-02-cancelled");
    results.check("a sign-in the Carbon cancelled says so in the site's own words", new URL(page.url()).searchParams.get("error") === "access_denied" && /You cancelled the sign-in, so you are not signed in to the developer site/.test(denied), denied);
    results.check("…and the error_description someone put in the address is never shown", !deniedText.includes("555 0100") && !page.url().includes("555"), page.url());
    const odd = await startOne("/");
    await page.goto(`${env.developer}/auth/callback?error=${encodeURIComponent("<b>gotcha</b>")}&state=${new URL(odd.location).searchParams.get("state") ?? ""}`);
    await page.waitForURL(url => url.pathname === "/sign-in", { timeout: 20_000 });
    const generic = await cardNotice(page);
    results.check("…an error that is not a known code becomes sign_in_failed: \"The sign-in did not finish\"", new URL(page.url()).searchParams.get("error") === "sign_in_failed" && /The sign-in did not finish/.test(generic) && !(await page.locator("body").innerText()).includes("gotcha"), `${page.url()} — ${generic}`);

    // 5. Where a sign-in may come back to: this site's own pages, nothing else.
    const cases: Array<[string, string]> = [
      ["https://evil.example/steal", "/"],
      ["//evil.example/x", "/"],
      ["/\\evil.example", "/"],
      ["javascript:alert(1)", "/"],
      ["/auth/callback?code=x", "/"],
      ["/api/accounts/me", "/"],
      ["/sign-in?return_to=/", "/"],
      [`/apps/${appId}/ata?kind=all#issued`, `/apps/${appId}/ata?kind=all#issued`],
    ];
    const kept: string[] = [];
    for (const [input, expected] of cases) {
      await startOne(input);
      const last = (await pendingList()).at(-1);
      if (last?.r !== expected) kept.push(`${input} → ${last?.r}`);
    }
    results.check("return_to keeps a sign-in on this site: other origins, //host, /\\host, javascript: and /auth, /api, /sign-in all come back to /", kept.length === 0, kept.join("; ") || cases.map(([input]) => input).join(" | "));
    results.check("…and at most three sign-ins wait at once (three tabs)", (await pendingList()).length === 3, `${(await pendingList()).length} pending`);
    const prefetch = await startOne("/apps", { "next-router-prefetch": "1" });
    results.check("a router prefetch of /auth/sign-in starts nothing (204, no cookie)", prefetch.status === 204 && !prefetch.setCookie, `${prefetch.status} ${prefetch.setCookie.slice(0, 40)}`);

    // 6. Signing in again: the browser is still signed in to the account site, so the hosted page offers "Continue as".
    await signInOnDeveloper(env, page, null, { returnTo: `/apps/${appId}/ata` });
    results.check("signing in again with \"Continue as\" comes back to return_to", page.url() === `${env.developer}/apps/${appId}/ata`, page.url());
    const third = (await readDevSession(context, env)).session as DevSession;
    results.check("…as a new sign-in (new tokens)", !!third && third.rt !== before.rt && third.rt !== second.rt);

    // 7. A refresh token used twice ends the whole sign-in.
    await writeDevSession(context, env, { ...third, ae: Date.now() + 1_000 });
    await developerApi(env, page, "/me");
    const fourth = (await readDevSession(context, env)).session as DevSession;
    results.check("the BFF rotated the refresh token (time travel again)", !!fourth && fourth.rt !== third.rt);
    const reuse = await tokenCall<{ error?: string; error_description?: string }>(ctx, { grant_type: "refresh_token", refresh_token: third.rt, client_id: "developer" });
    results.check("presenting the used refresh token again is refused (invalid_grant)", reuse.status === 400 && reuse.body.error === "invalid_grant", `${reuse.status} ${reuse.body.error_description?.slice(0, 160)}`);
    const afterReuse = await developerApi(env, page, "/me");
    const fourthRefresh = await tokenCall<{ error?: string }>(ctx, { grant_type: "refresh_token", refresh_token: fourth.rt, client_id: "developer" });
    results.check("…and it ended the whole sign-in: the BFF answers 401 and the newest refresh token is dead too", afterReuse.status === 401 && fourthRefresh.status === 400, `${afterReuse.status} ${errorCode(afterReuse.body)}; newest refresh ${fourthRefresh.status} ${fourthRefresh.body.error}`);
    // The reload races the page's own move to the sign-in card (the shell sees the 401 first).
    await page.reload().catch(() => undefined);
    await page.waitForURL(url => url.pathname === "/sign-in", { timeout: 30_000 });
    results.check("…so the open page goes to the sign-in card, keeping where it was", new URL(page.url()).searchParams.get("return_to") === `/apps/${appId}/ata`, page.url());

    // 8. Without its PKCE verifier a code is worth nothing to the public client `developer`.
    let captured = "";
    await page.route(`${env.developer}/auth/callback**`, async route => {
      captured = route.request().url();
      await route.fulfill({ status: 200, contentType: "text/plain", body: "captured" });
    });
    const callbackUri = `${env.developer}/auth/callback`;
    await page.goto(`${env.site}/authorize?app_id=developer&redirect_uri=${encodeURIComponent(callbackUri)}&state=nopkce-${tag()}`);
    const continueAs = page.getByRole("button", { name: /^Continue as / });
    const field = page.getByRole("textbox", { name: "Email" });
    const first2 = await Promise.race([continueAs.waitFor({ timeout: 30_000 }).then(() => "account" as const), field.waitFor({ timeout: 30_000 }).then(() => "email" as const)]);
    if (first2 === "account") await continueAs.click();
    else await signInWithCode(env, page, { email: fakeApp(appId).owner_email });
    for (let i = 0; i < 100 && !captured; i++) await sleep(150);
    await page.unroute(`${env.developer}/auth/callback**`);
    const code = captured ? new URL(captured).searchParams.get("code") ?? "" : "";
    const redeemed = await tokenCall<{ error?: string; error_description?: string }>(ctx, { grant_type: "authorization_code", client_id: "developer", code, redirect_uri: callbackUri });
    results.check("a code from a sign-in started without PKCE is refused to the public client (invalid_grant, PKCE named)", !!code && redeemed.status === 400 && redeemed.body.error === "invalid_grant" && /PKCE/.test(redeemed.body.error_description ?? ""), `${code.slice(0, 8)}… → ${redeemed.status} ${redeemed.body.error_description?.slice(0, 200)}`);
    const slt = await tokenCall<{ error?: string }>(ctx, { grant_type: "urn:silicon:params:oauth:grant-type:slt", client_id: "developer", slt: "slt_not_real" });
    const credentials = await tokenCall<{ error?: string }>(ctx, { grant_type: "client_credentials", client_id: "developer" });
    results.check("…nor may it use a Silicon's short-lived token grant (unauthorized_client) or client credentials (unsupported_grant_type)", slt.body.error === "unauthorized_client" && credentials.body.error === "unsupported_grant_type", `${slt.status} ${slt.body.error}; ${credentials.status} ${credentials.body.error}`);
    await page.goto(`${env.site}/authorize?app_id=developer&redirect_uri=${encodeURIComponent(`${env.developer}/elsewhere`)}&state=s-${tag()}&code_challenge=${"A".repeat(43)}&code_challenge_method=S256`);
    const problem = page.getByText(/is not registered for the app 'developer'/).first();
    const shown = await problem.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    await shot(env, page, "ds-b-03-wrong-redirect");
    results.check("the hosted page refuses to send a developer sign-in anywhere but the developer site's /auth/callback, and says where it must go", shown && page.url().startsWith(env.site) && (await page.locator("body").innerText()).includes(`${env.developer}/auth/callback`), (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300));

    await context.close();
  },
};

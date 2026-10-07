/**
 * Where a sign-in may send the browser. A redirect_uri the app never registered (or an unknown app) gets an error page
 * that never redirects and never links there; the comparison is exact (only a loopback registration ignores the port);
 * mistakes found after the redirect_uri is known to be the app's offer "Back to the app" with the RFC 6749 error. The
 * code stays bound to the redirect_uri it was issued for.
 */
import type { Journey } from "../../context";
import { newContext, shot, sleep, tag } from "../../lib";
import { Browserish, brief, drive, errorCode, errorDetails, exchangeCode, redirectParams, redirectUriOf, sendCode, startSignIn } from "./_helpers";

const redirects: Journey = {
  name: "auth-flows-redirect-uri",
  title: "an unregistered redirect_uri or unknown app → an error page that never redirects (nor links) there; exact matching (loopback ports aside); later mistakes go back to the app; the code is bound to its redirect_uri",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const registered = redirectUriOf(env, "briefcase");
    const port = new URL(registered).port;

    // The browser: nothing navigates to (or links to) the unregistered address.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "redirects", [/status of 400 .*\/v1\/flows/]);
    const evilHosts = new Set<string>();
    page.on("request", request => {
      const host = new URL(request.url()).host;
      if (/evil/.test(host)) evilHosts.add(host);
    });
    const evil = `https://evil.example/steal?from=${t}`;
    await page.goto(`${env.site}/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent(evil)}&state=s-${t}&response_type=code`);
    const problem = page.locator("[data-problem]");
    await problem.waitFor({ timeout: 30_000 });
    await sleep(1_500);
    await shot(env, page, "auth-flows-redirect-uri-01-unregistered");
    const text = (await problem.innerText()).replace(/\s+/g, " ");
    const hrefs = await page.locator("a[href]").evaluateAll(anchors => anchors.map(anchor => (anchor as HTMLAnchorElement).href));
    results.check("unregistered redirect_uri → \"This sign-in link is not set up right\" (code redirect_uri_not_registered)", (await problem.getAttribute("data-problem")) === "redirect_uri_not_registered" && /This sign-in link is not set up right/.test(text), text.slice(0, 240));
    results.check("…the page stays on /authorize (no redirect), offers only \"Go to your account\"", new URL(page.url()).pathname === "/authorize" && (await page.getByRole("link", { name: "Back to the app" }).count()) === 0 && (await page.getByRole("link", { name: "Go to your account" }).count()) === 1, page.url());
    results.check("…and nothing on it links to, or loaded from, the unregistered address", !hrefs.some(href => href.includes("evil.example")) && evilHosts.size === 0, `${hrefs.filter(h => !h.startsWith(env.site)).join(", ")} | ${[...evilHosts].join(", ")}`);

    await page.goto(`${env.site}/authorize?app_id=no-such-app-${t}&redirect_uri=${encodeURIComponent(registered)}&state=x`);
    await problem.waitFor({ timeout: 30_000 });
    results.check("an unknown app → \"This app is not on Silicon Accounts\", no way back to the given address", (await problem.getAttribute("data-problem")) === "unknown_app" && (await page.getByRole("link", { name: "Back to the app" }).count()) === 0, (await problem.innerText()).replace(/\s+/g, " ").slice(0, 200));

    await page.goto(`${env.site}/authorize?app_id=briefcase&redirect_uri=${encodeURIComponent(registered)}&state=back-${t}&scope=${encodeURIComponent("email superpowers")}`);
    await problem.waitFor({ timeout: 30_000 });
    const back = page.getByRole("link", { name: "Back to the app" });
    const backHref = (await back.getAttribute("href").catch(() => null)) ?? "";
    results.check("a bad scope with a registered redirect_uri → \"Back to the app\" carrying error=invalid_scope and the state", (await problem.getAttribute("data-problem")) === "invalid_scope" && backHref.startsWith(`${registered}?`) && new URL(backHref).searchParams.get("error") === "invalid_scope" && new URL(backHref).searchParams.get("state") === `back-${t}`, backHref);
    results.check("…without going there by itself", new URL(page.url()).pathname === "/authorize", page.url());
    await page.goto(`${env.site}/authorize`);
    const nothing = page.getByRole("heading", { name: "Nothing to sign in to" });
    await nothing.waitFor({ timeout: 30_000 }).catch(() => undefined);
    results.check("/authorize without parameters → \"Nothing to sign in to\"", await nothing.isVisible());
    await context.close();

    // The API: exact matching, loopback ports aside.
    const b = new Browserish(env, ctx.ip);
    const attempt = (redirectUri: string, extra: Record<string, string> = {}, app = "briefcase") => b.createFlow({ app_id: app, redirect_uri: redirectUri, state: `st-${t}`, ...extra });
    const otherPort = `http://127.0.0.1:${Number(port) === 1 ? 2 : 1}/briefcase/callback`;
    const cases: Array<[string, string, boolean]> = [
      [registered, "exactly the registered URI", true],
      [`  ${registered}  `, "the registered URI padded with spaces", true],
      [otherPort, "the loopback URI on another port (ports are ignored for 127.0.0.1)", true],
      [registered.replace("127.0.0.1", "localhost"), "localhost instead of the registered 127.0.0.1", false],
      [registered.replace("http://", "https://"), "https instead of http", false],
      [`${registered}/`, "a trailing slash", false],
      [`${registered}?next=/admin`, "an extra query", false],
      [registered.replace("/briefcase/", "/Briefcase/"), "a path differing in case", false],
      [`${registered}#fragment`, "a fragment (RFC 6749 §3.1.2: never allowed)", false],
      [`http://127.0.0.1:${port}@evil.example/briefcase/callback`, "userinfo pointing at another host", false],
      [redirectUriOf(env, "commit"), "another app's registered URI", false],
      ["javascript:alert(1)", "a javascript: URI", false],
    ];
    for (const [uri, why, allowed] of cases) {
      const reply = await attempt(uri);
      const ok = allowed ? reply.status === 201 : reply.status === 400 && errorCode(reply) === "redirect_uri_not_registered" && errorDetails(reply).redirect_to === undefined;
      results.check(`${why} → ${allowed ? "201" : "400 redirect_uri_not_registered, no redirect_to"}`, ok, brief(reply));
    }
    const missing = await b.createFlow({ app_id: "briefcase", state: "x" });
    results.check("no redirect_uri → 400 invalid_request, no redirect_to", missing.status === 400 && errorCode(missing) === "invalid_request" && errorDetails(missing).redirect_to === undefined, brief(missing));
    const unknown = await attempt(registered, {}, `ghost-${t}`);
    results.check("an unknown app → 400 unknown_app, no redirect_to", unknown.status === 400 && errorCode(unknown) === "unknown_app" && errorDetails(unknown).redirect_to === undefined, brief(unknown));
    const alias = await b.createFlow({ client_id: "briefcase", redirect_uri: registered, state: "x" });
    results.check("client_id works as an alias of app_id", alias.status === 201 && alias.body.flow.app.app_id === "briefcase", brief(alias));
    const disagree = await b.createFlow({ app_id: "briefcase", client_id: "commit", redirect_uri: registered, state: "x" });
    results.check("app_id and client_id disagreeing → 400 invalid_request", disagree.status === 400 && errorCode(disagree) === "invalid_request", brief(disagree));
    const token = await attempt(registered, { response_type: "token" });
    const tokenRedirect = new URL(String(errorDetails(token).redirect_to ?? "http://x/"));
    results.check("response_type=token → 400 unsupported_response_type, redirect_to the registered URI with the error and state", token.status === 400 && errorCode(token) === "unsupported_response_type" && tokenRedirect.href.startsWith(registered) && tokenRedirect.searchParams.get("error") === "unsupported_response_type" && tokenRedirect.searchParams.get("state") === `st-${t}`, brief(token));
    const longState = await b.createFlow({ app_id: "briefcase", redirect_uri: registered, state: "s".repeat(1025) });
    results.check("a state over 1024 characters → 400 invalid_request (redirect_to the app)", longState.status === 400 && errorCode(longState) === "invalid_request" && String(errorDetails(longState).redirect_to ?? "").startsWith(registered), brief(longState));
    const odd = ` spaced state+&=?#é ${t} `;
    const e = new Browserish(env, ctx.ip);
    const exact = await startSignIn(e, "briefcase", { state: odd });
    const exactSent = await sendCode(e, exact.flow.id, { email: `state.${t}@example.test` });
    const exactVerified = await e.act(exact.flow.id, "verify", { code: exactSent.code ?? "" });
    const exactDone = await drive(e, exactVerified.body.flow);
    results.check("state comes back on the redirect byte for byte (spaces, +, &, =, ?, #, é)", redirectParams(exactDone).get("state") === odd, `${JSON.stringify(redirectParams(exactDone).get("state"))} vs ${JSON.stringify(odd)}`);

    // The first-party app: only the site's own origin.
    for (const [uri, allowed, why] of [
      [`${env.site}/sign-in`, true, "the site's /sign-in"],
      [`${env.site}/anything?x=1`, true, "any path on the site"],
      ["https://evil.example/sign-in", false, "another origin"],
      [`${env.site}.evil.test/sign-in`, false, "an origin that merely starts like the site's"],
      [`${env.site}/sign-in#x`, false, "a fragment"],
    ] as const) {
      const reply = await attempt(uri, {}, "accounts");
      results.check(`accounts (first-party): ${why} → ${allowed ? "201" : "400"}`, allowed ? reply.status === 201 : reply.status === 400 && errorCode(reply) === "redirect_uri_not_registered", brief(reply));
    }

    // The code is bound to the redirect_uri of its flow: another registered (loopback-port) variant is refused, and burns it.
    const c = new Browserish(env, ctx.ip);
    const s = await startSignIn(c, "briefcase", { redirectUri: otherPort });
    const sent = await sendCode(c, s.flow.id, { email: `redirect.${t}@example.test` });
    const v = await c.act(s.flow.id, "verify", { code: sent.code ?? "" });
    const done = await drive(c, v.body.flow);
    results.check("a flow with the other-port loopback URI completes there (redirect_to on that port)", done.step === "complete" && (done.redirect_to ?? "").startsWith(`${otherPort}?`), done.redirect_to ?? "");
    const code = redirectParams(done).get("code") ?? "";
    const wrong = await exchangeCode(env, "briefcase", code, registered, s.verifier);
    results.check("exchanging it with the registered (other-port) URI → 400 invalid_grant naming both URIs", wrong.status === 400 && wrong.body.error === "invalid_grant" && (wrong.body.error_description ?? "").includes(otherPort), brief(wrong));
    const right = await exchangeCode(env, "briefcase", code, otherPort, s.verifier);
    results.check("…which burned the code: the right URI afterwards → invalid_grant", right.status === 400 && right.body.error === "invalid_grant", brief(right));
  },
};

export const journeys: Journey[] = [redirects];

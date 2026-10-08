/**
 * CSRF: every cookie-authenticated mutation must come from the site's own origin (403 `origin_not_allowed`), whatever
 * the foreign Origin looks like (another site, a look-alike host, another port of the same host, the developer site —
 * a sibling site in production —, https instead of http, "null", none at all), and nothing changes when it is
 * refused: no refusal sets or clears a cookie, and a sign-out that has no live session to end clears the browser's
 * cookies only for the site's own pages (logout CSRF). The v2 hosted pages too: continuing as the browser's account,
 * adding a missing email or phone, continuing, going back, approving and cancelling the review all need the site's
 * origin. Bearer tokens are not affected (browsers never attach them on their own). Then the real thing in a browser: a
 * page on a same-site origin (cookies are sent) and on a cross-site origin (SameSite=Lax keeps them home) submits
 * forms and fetches against the signed-in victim's session, and against a signed-out browser in the middle of a
 * sign-up, which keeps its sign-up and finishes it afterwards.
 */
import type { Journey } from "../../context";
import { codeFor, lastSeq, newContext, shot, sleep, tag } from "../../lib";
import { advance, brief, call, callbackOf, createSilicon, errorOf, flowOf, flowStep, randomEmail, randomPhone, remember, siliconLogin, signInWithEmail, sparePort, startFlow, viaSite, Jar, type Reply } from "./_helpers";

export const journey: Journey = {
  name: "security-csrf",
  title: "CSRF: cookie mutations from any foreign Origin (look-alike host, other port, the developer site, https, null, none) are refused with 403 and change nothing, incl. sign-out, delete, Silicon creation, device approval, the hosted flow and its v2 details/review pages (add, verify, continue, back, approve, cancel, continue as); Bearer tokens need no Origin; a same-site and a cross-site attacker page in the browser cannot act for the signed-in Carbon",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = viaSite(ctx);
    const victim = await signInWithEmail(t, { label: "csrf" });
    remember(ctx, "session cookie", victim.jar.get("sa_session"));
    remember(ctx, "code", victim.code);
    const me = async () => (await call<{ display_name?: string; id?: string }>(`${env.site}/v1/me`, { jar: victim.jar, ip: ctx.ip })).body;
    const before = await me();
    /** Refusals of foreign-origin requests that set or cleared a cookie anyway (a browser applies them). */
    const refusalCookies: string[] = [];
    let refusals = 0;
    const noteCookies = (label: string, reply: Reply) => {
      refusals++;
      if (reply.setCookies.length) refusalCookies.push(`${label} (${reply.status}): ${reply.setCookies.map(cookie => `${cookie.name}${cookie.attributes.get("max-age") === "0" ? " cleared" : " set"}`).join(", ")}`);
    };
    const sameSite = `http://localhost:${sparePort(env, 6)}`;

    // 1. PATCH /v1/me from every kind of foreign Origin.
    const sitePort = new URL(env.site).port;
    const foreign: Array<[string, string | null]> = [
      ["another site", "https://evil.example"],
      ["a look-alike host that starts with the site's origin", `${env.site}.evil.example`],
      ["the same host on another port (same site)", sameSite],
      ["the developer site (a sibling site of the account site in production)", new URL(env.developer).origin],
      ["the site's host over https", `https://localhost:${sitePort}`],
      ["an app's origin (the fake apps)", new URL(env.apps).origin],
      ['the opaque origin "null" (sandboxed frames, file:, data:)', "null"],
      ["no Origin header at all", null],
    ];
    const refusedPatch: string[] = [];
    for (const [label, origin] of foreign) {
      const reply = await call(`${env.site}/v1/me`, { method: "PATCH", json: { display_name: `Pwned ${tag()}` }, jar: victim.jar.clone(), origin, ip: ctx.ip });
      if (reply.status !== 403 || errorOf(reply).code !== "origin_not_allowed") refusedPatch.push(`${label}: ${brief(reply)}`);
      noteCookies(`PATCH /v1/me from ${label}`, reply);
    }
    const afterPatch = await me();
    results.check(`PATCH /v1/me with the session cookie is refused 403 origin_not_allowed from ${foreign.length} kinds of foreign Origin (incl. the developer site's)`, refusedPatch.length === 0, refusedPatch.join(" | ") || foreign.map(([label]) => label).join(", "));
    results.check("…and the display name did not change", afterPatch.display_name === before.display_name, `${before.display_name} → ${afterPatch.display_name}`);

    // 2. Other mutations a forged request would want, each from a foreign origin.
    const evil = "https://evil.example";
    const newEmail = `sec.csrf.added.${tag()}@example.test`;
    const silicon = `si:csrf-${tag()}`;
    const seq = await lastSeq(env);
    // A real device code an attacker started in their own terminal: approving it for the victim would hand the
    // victim's account to the attacker's CLI (the device-flow CSRF).
    const device = await call<{ device_code?: string; user_code?: string }>(`${env.site}/v1/device/authorize`, { json: { client_label: "attacker's terminal" }, ip: ctx.ip });
    remember(ctx, "device code", device.body.device_code);
    const userCode = device.body.user_code ?? "ABCD-EFGH";
    const attempts: Array<[string, string, string, unknown]> = [
      ["sign out", "POST", "/v1/session/signout", undefined],
      ["delete the account", "DELETE", "/v1/me", { confirm: victim.id }],
      ["create a Silicon", "POST", "/v1/me/silicons", { id: silicon, display_name: "CSRF" }],
      ["add an email", "POST", "/v1/me/emails", { email: newEmail }],
      ["change the id", "POST", "/v1/me/id", { id: `c:csrf-${tag()}` }],
      ["mint a short-lived token for an app", "POST", "/v1/me/short-lived-tokens", { app_id: "remind" }],
      ["approve the attacker's CLI device code", "POST", `/v1/device/${userCode}/approve`, undefined],
      ["remove an app's access", "DELETE", "/v1/me/apps/briefcase", undefined],
      ["revoke a session", "DELETE", "/v1/me/sessions/00000000-0000-0000-0000-000000000000", undefined],
      ["revoke a user verification proof", "DELETE", "/v1/me/proofs/00000000-0000-0000-0000-000000000000", undefined],
      ["connect Google", "POST", "/v1/me/identities/google", {}],
      ["make an app verification proof as the owner of an app", "POST", "/v1/apps/briefcase/proofs/app-verification", { receiving_app: "remind" }],
      ["change an app's sign-in setup as its owner", "PATCH", "/v1/apps/briefcase/signin-config", { redirect_uris: ["https://evil.example/cb"] }],
    ];
    const notRefused: string[] = [];
    for (const [label, method, path, json] of attempts) {
      const reply = await call(`${env.site}${path}`, { method, ...(json !== undefined ? { json } : { body: "" }), jar: victim.jar.clone(), origin: evil, ip: ctx.ip, headers: { "idempotency-key": `csrf-${tag()}` } });
      if (reply.status !== 403 || errorOf(reply).code !== "origin_not_allowed") notRefused.push(`${label}: ${brief(reply)}`);
      noteCookies(label, reply);
    }
    results.check(`${attempts.length} other cookie mutations from a foreign origin (sign-out, delete, Silicon, email, id, SLT, device approval, app access, sessions, User verification proofs, Google, an owner's App verification proof and sign-in setup) are refused 403 origin_not_allowed`, notRefused.length === 0, notRefused.join(" | ") || attempts.map(([label]) => label).join(", "));
    const session = await call<{ account?: { id: string } }>(`${env.site}/v1/session`, { jar: victim.jar, ip: ctx.ip });
    const silicons = await call<{ items?: Array<{ id?: string; silicon?: { id?: string } }> }>(`${env.site}/v1/me/silicons`, { jar: victim.jar, ip: ctx.ip });
    const emails = await call<{ items?: Array<{ email: string }> } | Array<{ email: string }>>(`${env.site}/v1/me/emails`, { jar: victim.jar, ip: ctx.ip });
    const emailList = Array.isArray(emails.body) ? emails.body : (emails.body.items ?? []);
    const mails = await call<{ items?: Array<{ to: string }> }>(`${env.messaging}/_messages?to=${encodeURIComponent(newEmail)}`);
    const nothing =
      session.status === 200 &&
      session.body.account?.id === victim.id &&
      !(silicons.body.items ?? []).some(item => (item.silicon?.id ?? item.id) === silicon) &&
      !emailList.some(item => item.email === newEmail) &&
      !(mails.body.items ?? []).length;
    results.check("…and nothing happened: still signed in with the same id, no Silicon, no added email, no code sent", nothing, `session ${session.status} ${session.body.account?.id}; silicons ${(silicons.body.items ?? []).length}; emails ${emailList.map(item => item.email).join(",")}; mails to ${newEmail}: ${(mails.body.items ?? []).length} (since seq ${seq})`);

    // 3. The hosted flow: starting one and acting in one also need the site's origin.
    const flowJar = new Jar();
    const flowFromEvil = await call(`${env.site}/v1/flows`, { json: { app_id: "briefcase", redirect_uri: `${env.apps}/briefcase/callback`, state: "x" }, jar: flowJar, origin: evil, ip: ctx.ip });
    const started = await startFlow(t, flowJar, { app_id: "briefcase", redirect_uri: `${env.apps}/briefcase/callback`, state: `s-${tag()}` });
    const flowId = flowOf(started)?.id ?? "";
    const target = `sec.csrf.flow.${tag()}@example.test`;
    const emailFromEvil = await call(`${env.site}/v1/flows/${flowId}/email`, { json: { email: target }, jar: flowJar.clone(), origin: evil, ip: ctx.ip });
    noteCookies("POST /v1/flows from another site", flowFromEvil);
    noteCookies("a flow step from another site", emailFromEvil);
    const flowMails = await call<{ items?: unknown[] }>(`${env.messaging}/_messages?to=${encodeURIComponent(target)}`);
    results.check("the hosted flow refuses a foreign origin: POST /v1/flows and a step with the right flow cookie both get 403, and no code is sent", flowFromEvil.status === 403 && errorOf(flowFromEvil).code === "origin_not_allowed" && emailFromEvil.status === 403 && errorOf(emailFromEvil).code === "origin_not_allowed" && !(flowMails.body.items ?? []).length, `${brief(flowFromEvil)} / ${brief(emailFromEvil)} / ${(flowMails.body.items ?? []).length} codes`);
    const okStep = await flowStep(t, flowJar, flowId, "switch");
    results.check("control: the same flow step from the site's origin works", okStep.status === 200, brief(okStep));

    // 3b. The v2 pages of an app's flow, acting for the signed-in victim: legacy-crm (one page: email required, phone,
    //     dob and timezone optional; the victim has no phone) and ledgerly (two pages and a review). From another site,
    //     with the victim's session and the flow's own cookie, none of them moves.
    const crmJar = victim.jar.clone();
    const crm = flowOf(await startFlow(t, crmJar, { app_id: "legacy-crm", redirect_uri: callbackOf(env, "legacy-crm"), state: `c-${tag()}` }));
    const continueFromEvil = await call(`${env.site}/v1/flows/${crm?.id}/continue`, { method: "POST", body: "", jar: crmJar.clone(), origin: evil, ip: ctx.ip });
    const continued = flowOf(await flowStep(t, crmJar, crm?.id ?? "", "continue"));
    const phone = randomPhone();
    const v2Attempts: Array<[string, string, unknown]> = [
      ["add a missing phone (an SMS code to the attacker's number)", "details/add", { phone }],
      ["verify a code for it", "details/verify", { code: "123456" }],
      ["continue the page (sharing a detail)", "details/continue", { share: ["timezone"] }],
      ["go back", "details/back", {}],
      ["approve the review", "review", { approve: true }],
      ["cancel the sign-in", "review", { approve: false }],
    ];
    const v2Moved: string[] = [];
    for (const [label, step, body] of v2Attempts) {
      const reply = await call(`${env.site}/v1/flows/${crm?.id}/${step}`, { json: body, jar: crmJar.clone(), origin: evil, ip: ctx.ip });
      if (reply.status !== 403 || errorOf(reply).code !== "origin_not_allowed") v2Moved.push(`${label}: ${brief(reply)}`);
      noteCookies(`flow ${step} from another site`, reply);
    }
    const crmAfter = flowOf(await call(`${env.site}/v1/flows/${crm?.id}`, { jar: crmJar, ip: ctx.ip }));
    const sms = await call<{ items?: unknown[] }>(`${env.messaging}/_messages?to=${encodeURIComponent(phone)}`);
    results.check(`continuing as the victim from another site is refused (403), and on the details page every v2 action from another site (${v2Attempts.length}: add a phone, verify, continue, back, approve, cancel) is refused 403 origin_not_allowed with the victim's session and the flow's cookie`, continueFromEvil.status === 403 && errorOf(continueFromEvil).code === "origin_not_allowed" && continued?.step === "details" && v2Moved.length === 0, `continue from another site ${brief(continueFromEvil)}; from the site → ${continued?.step}; ${v2Moved.join(" | ") || "all 403"}`);
    results.check("…and the flow did not move: still on the same details page, nothing shared, no SMS to the attacker's number", crmAfter?.step === "details" && crmAfter.details?.index === 0 && !(sms.body.items ?? []).length && !crmAfter.redirect_to, `flow ${crmAfter?.step} page ${crmAfter?.details?.index}; SMS ${(sms.body.items ?? []).length}`);
    const crmDone = await advance(t, crmJar, crmAfter ?? continued!);
    results.check("control: from the site's origin the same page continues and the sign-in completes with legacy-crm's code", crmDone.step === "complete" && /[?&]code=/.test(crmDone.redirect_to ?? ""), `${crmDone.step} ${crmDone.redirect_to?.slice(0, 80)}`);
    remember(ctx, "code", crmDone.redirect_to ? new URL(crmDone.redirect_to).searchParams.get("code") : null);
    // ledgerly's review page: approving or cancelling it, or going back from it, from another site.
    const ledgerJar = victim.jar.clone();
    let ledger = flowOf(await startFlow(t, ledgerJar, { app_id: "ledgerly", redirect_uri: callbackOf(env, "ledgerly"), state: `l-${tag()}` }));
    ledger = flowOf(await flowStep(t, ledgerJar, ledger?.id ?? "", "continue")) ?? ledger;
    const ledgerPhone = randomPhone();
    if (ledger?.step === "details" && ledger.details?.fields.some(field => field.field === "phone" && field.missing)) {
      const sentAt = await lastSeq(env);
      await flowStep(t, ledgerJar, ledger.id, "details/add", { phone: ledgerPhone });
      const smsCode = await codeFor(env, ledgerPhone, sentAt);
      remember(ctx, "code", smsCode);
      ledger = flowOf(await flowStep(t, ledgerJar, ledger.id, "details/verify", { code: smsCode })) ?? ledger;
    }
    for (let guard = 0; guard < 4 && ledger?.step === "details"; guard++) ledger = flowOf(await flowStep(t, ledgerJar, ledger.id, "details/continue", { share: [] })) ?? ledger;
    const atReview = ledger?.step === "review";
    const reviewAttempts: Array<[string, string, unknown]> = [
      ["approve", "review", { approve: true }],
      ["cancel", "review", { approve: false }],
      ["back", "details/back", {}],
    ];
    const reviewMoved: string[] = [];
    for (const [label, step, body] of reviewAttempts) {
      for (const origin of [evil, sameSite, null]) {
        const reply = await call(`${env.site}/v1/flows/${ledger?.id}/${step}`, { json: body, jar: ledgerJar.clone(), origin, ip: ctx.ip });
        if (reply.status !== 403 || errorOf(reply).code !== "origin_not_allowed") reviewMoved.push(`${label} from ${origin ?? "no Origin"}: ${brief(reply)}`);
        noteCookies(`review ${label} from ${origin ?? "no Origin"}`, reply);
      }
    }
    const ledgerAfter = flowOf(await call(`${env.site}/v1/flows/${ledger?.id}`, { jar: ledgerJar, ip: ctx.ip }));
    results.check("on ledgerly's review page, approving, cancelling and going back from another site, a same-site page on another port, or without an Origin are all refused 403 (9 tries), and the flow stays on the review", atReview && reviewMoved.length === 0 && ledgerAfter?.step === "review", `reached ${ledger?.step}; ${reviewMoved.join(" | ") || "9 × 403"}; now ${ledgerAfter?.step}`);
    const ledgerDone = flowOf(await flowStep(t, ledgerJar, ledger?.id ?? "", "review", { approve: true }));
    results.check("control: from the site's origin the review is approved and ledgerly gets its code", ledgerDone?.step === "complete" && /[?&]code=/.test(ledgerDone.redirect_to ?? ""), `${ledgerDone?.step} ${ledgerDone?.redirect_to?.slice(0, 80)}`);

    results.check(`none of the ${refusals} refusals of a foreign-origin request sets or clears a cookie (the browser would apply it even to a refused request)`, refusalCookies.length === 0, refusalCookies.join(" | ") || `${refusals} refusals, no Set-Cookie`);

    // 4. Controls: the site's origin and the configured extra origin work; a Bearer token needs no Origin.
    const renamed = `Renamed ${tag()}`;
    const fromSite = await call<{ display_name?: string }>(`${env.site}/v1/me`, { method: "PATCH", json: { display_name: renamed }, jar: victim.jar, origin: env.site, ip: ctx.ip });
    const extraOrigin = `http://127.0.0.1:${sitePort}`;
    const fromExtra = await call(`${env.site}/v1/me`, { method: "PATCH", json: { display_name: `${renamed} 2` }, jar: victim.jar, origin: extraOrigin, ip: ctx.ip });
    results.check("control: the same PATCH from the site's origin (and from the stack's configured extra origin) is accepted", fromSite.status === 200 && fromSite.body.display_name === renamed && fromExtra.status === 200, `${brief(fromSite)} / ${extraOrigin} ${brief(fromExtra)}`);
    const readFromEvil = await call(`${env.site}/v1/me`, { jar: victim.jar, origin: evil, ip: ctx.ip });
    results.check("a cookie GET from a foreign origin answers, but without CORS headers a foreign page can never read it", readFromEvil.status === 200 && !readFromEvil.headers.get("access-control-allow-origin") && !readFromEvil.headers.get("access-control-allow-credentials"), `${readFromEvil.status}, ACAO ${readFromEvil.headers.get("access-control-allow-origin") ?? "none"}`);
    const bot = await createSilicon(t, victim.jar, "csrf");
    remember(ctx, "stk", bot.stk);
    const login = await siliconLogin(t, bot.id, bot.stk);
    remember(ctx, "access token", login.body.access_token);
    remember(ctx, "refresh token", login.body.refresh_token);
    const bearerNoOrigin = await call(`${env.site}/v1/me`, { method: "PATCH", json: { display_name: `Bot ${tag()}` }, bearer: login.body.access_token, ip: ctx.ip });
    const bearerEvil = await call(`${env.site}/v1/me`, { method: "PATCH", json: { display_name: `Bot ${tag()}` }, bearer: login.body.access_token, origin: evil, ip: ctx.ip });
    results.check("a Bearer-token mutation (a Silicon's first-party token) needs no Origin: the guard is only about cookies browsers attach on their own", bearerNoOrigin.status === 200 && bearerEvil.status === 200, `${brief(bearerNoOrigin)} / ${brief(bearerEvil)}`);

    // A cookieless POST to sign-out from a foreign origin has no session to end: it must not touch the browser's cookies
    // either (a cross-site top-level form POST carries no SameSite=Lax cookie, but the browser does apply the answer's
    // Set-Cookie, so clearing cookies there signs any visitor out from any site).
    const cookieless = await call(`${env.site}/v1/session/signout`, { method: "POST", body: "", origin: "http://127.0.0.1:9", ip: ctx.ip });
    const cleared = cookieless.setCookies.filter(cookie => cookie.attributes.get("max-age") === "0").map(cookie => cookie.name);
    results.check("a cookieless sign-out from a foreign origin changes nothing: no Set-Cookie clears the browser's session or sign-up cookie", cleared.length === 0, `${brief(cookieless)}; Set-Cookie clears: ${cleared.join(", ") || "none"}`);

    // The same for a browser that still holds cookies the server no longer knows (signed out elsewhere, made up): only
    // the site's own pages may clean them up; from anywhere else (or with no Origin) the answer touches no cookie.
    const stale = await signInWithEmail(t, { label: "csrf-stale" });
    remember(ctx, "session cookie", stale.jar.get("sa_session"));
    remember(ctx, "code", stale.code);
    const staleSession = stale.jar.get("sa_session") ?? "";
    const signedOutElsewhere = await call(`${env.site}/v1/session/signout`, { method: "POST", body: "", jar: stale.jar.clone(), origin: env.site, ip: ctx.ip });
    const staleCookies = `sa_session=${staleSession}; sa_signup=sau_${"S".repeat(43)}`;
    const staleCases: Array<[string, string, string | null]> = [
      ["a signed-out session cookie from another site", staleCookies, "https://evil.example"],
      ["a signed-out session cookie from a same-site page on another port", staleCookies, sameSite],
      ["a signed-out session cookie from the developer site", staleCookies, new URL(env.developer).origin],
      ["a signed-out session cookie with no Origin", staleCookies, null],
      ["a made-up session cookie from another site", `sa_session=sas_${"G".repeat(43)}`, "https://evil.example"],
    ];
    const touched: string[] = [];
    for (const [label, cookie, origin] of staleCases) {
      const reply = await call(`${env.site}/v1/session/signout`, { method: "POST", body: "", headers: { cookie }, origin, ip: ctx.ip });
      if (reply.status !== 401 || errorOf(reply).code !== "unauthenticated" || reply.setCookies.length) touched.push(`${label}: ${brief(reply)}; Set-Cookie ${reply.setCookies.map(c => c.name).join(", ") || "none"}`);
    }
    results.check(`sign-out with cookies the server no longer knows (${staleCases.length} cases: signed out elsewhere from another site, a same-site page, the developer site or with no Origin; made up) gets 401 unauthenticated and no Set-Cookie`, signedOutElsewhere.status === 204 && touched.length === 0, touched.join(" | ") || `${staleCases.length} × 401, no Set-Cookie`);
    const ownCleanup = await call(`${env.site}/v1/session/signout`, { method: "POST", body: "", headers: { cookie: staleCookies }, origin: env.site, ip: ctx.ip });
    const ownCleared = ownCleanup.setCookies.filter(cookie => cookie.attributes.get("max-age") === "0").map(cookie => cookie.name);
    results.check("control: the same stale cookies sent from the site's own pages get 401 and are cleaned up (sa_session and sa_signup with Max-Age=0)", ownCleanup.status === 401 && ownCleared.includes("sa_session") && ownCleared.includes("sa_signup"), `${brief(ownCleanup)}; clears ${ownCleared.join(", ") || "nothing"}`);

    // 5. In the browser: attacker pages against the signed-in victim.
    const victimContext = await newContext(browser, { forwardedFor: null });
    const host = new URL(env.site).hostname;
    const sessionCookie = victim.jar.get("sa_session") ?? "";
    const plant = () => victimContext.addCookies([{ name: "sa_session", value: sessionCookie, domain: host, path: "/", httpOnly: true, sameSite: "Lax", secure: false, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await plant();
    const crossSite = `http://127.0.0.1:${sparePort(env, 6)}`;
    const attackerPage = (kind: string) => `<!doctype html><title>${kind}</title>
<form id="signout" method="POST" action="${env.site}/v1/session/signout"></form>
<form id="silicon" method="POST" action="${env.site}/v1/me/silicons" enctype="text/plain"><input name='{"id":"si:csrf-form-${tag()}","display_name":"x","pad":"' value='"}'></form>
<form id="device" method="POST" action="${env.site}/v1/device/${userCode}/approve"></form>
<script>
window.results = {};
async function shoot() {
  try { await fetch(${JSON.stringify(`${env.site}/v1/session/signout`)}, { method: "POST", mode: "no-cors", credentials: "include", headers: { "content-type": "text/plain" }, body: "x" }); window.results.signoutFetch = "sent"; } catch (e) { window.results.signoutFetch = "error " + e; }
  try { const r = await fetch(${JSON.stringify(`${env.site}/v1/me`)}, { credentials: "include" }); window.results.read = "read " + r.status + " " + (await r.text()).slice(0, 80); } catch (e) { window.results.read = "blocked"; }
  window.results.done = true;
}
</script>`;
    await victimContext.route(`${sameSite}/**`, route => route.fulfill({ contentType: "text/html", body: attackerPage("same-site") }));
    await victimContext.route(`${crossSite}/**`, route => route.fulfill({ contentType: "text/html", body: attackerPage("cross-site") }));
    const page = await victimContext.newPage();
    const answers: Array<{ url: string; status: number; origin: string; setCookie: string }> = [];
    page.on("response", response => {
      if (response.url().startsWith(`${env.site}/v1/`)) answers.push({ url: response.url().slice(env.site.length), status: response.status(), origin: response.request().headers()["origin"] ?? "", setCookie: response.headers()["set-cookie"] ?? "" });
    });
    /** The browser still holds the session cookie, and the server still accepts it. */
    const signedIn = async () => {
      const held = (await victimContext.cookies(env.site)).some(cookie => cookie.name === "sa_session" && cookie.value === sessionCookie);
      const live = (await call(`${env.site}/v1/session`, { headers: { cookie: `sa_session=${sessionCookie}` }, ip: ctx.ip })).status === 200;
      return { held, live, text: `browser ${held ? "holds" : "LOST"} the cookie, server ${live ? "accepts" : "REFUSES"} it` };
    };
    results.check("the victim's browser is signed in before the attacks", (await page.request.get(`${env.site}/v1/session`)).status() === 200);

    for (const [kind, origin, expected] of [
      ["same-site", sameSite, 403],
      ["cross-site", crossSite, 401],
    ] as const) {
      const why = expected === 403 ? "the cookie is sent, the Origin is refused" : "SameSite=Lax keeps the cookie home";
      answers.length = 0;
      await page.goto(`${origin}/csrf.html`);
      await page.evaluate(() => (window as unknown as { shoot: () => Promise<void> }).shoot());
      await sleep(300);
      const read = await page.evaluate(() => (window as unknown as { results: Record<string, string> }).results.read);
      const fetchSignout = answers.find(answer => answer.url === "/v1/session/signout");
      const afterFetch = await signedIn();
      results.check(`${kind} page (${origin}): a no-cors fetch to sign out gets ${expected} (${why}), a credentialed read is blocked by CORS, and the victim stays signed in`, (fetchSignout?.status ?? 0) === expected && read === "blocked" && afterFetch.held && afterFetch.live, `fetch sign-out ${fetchSignout?.status ?? "not seen"} (Origin ${fetchSignout?.origin || "?"}), read ${read}; ${afterFetch.text}`);

      // Handlers are attached at once: a navigation that fails before it is awaited must not crash the walk.
      const navigation = page.waitForResponse(response => response.url() === `${env.site}/v1/session/signout` && response.request().method() === "POST", { timeout: 15_000 }).then(async response => ({ status: response.status(), setCookie: (await response.allHeaders())["set-cookie"] ?? "" }), () => ({ status: 0, setCookie: "" }));
      await page.goto(`${origin}/csrf-form.html`);
      await page.evaluate(() => (document.getElementById("signout") as HTMLFormElement).submit());
      const signout = await navigation;
      await page.waitForLoadState("load").catch(() => undefined);
      await sleep(400);
      const afterForm = await signedIn();
      await shot(env, page, `security-csrf-${kind}-signout`);
      results.check(`${kind} page: a top-level form POST to sign out gets ${expected} (${why}) and the victim stays signed in (the browser keeps its session cookie)`, signout.status === expected && afterForm.held && afterForm.live, `form sign-out ${signout.status}${signout.setCookie ? `, Set-Cookie: ${signout.setCookie.replace(/\s+/g, " ").slice(0, 160)}` : ""}; ${afterForm.text}`);
      if (!afterForm.held) await plant();

      await page.goto(`${origin}/csrf-silicon.html`);
      const formPost = page.waitForResponse(response => response.url() === `${env.site}/v1/me/silicons`, { timeout: 15_000 }).then(response => response.status(), () => 0);
      await page.evaluate(() => (document.getElementById("silicon") as HTMLFormElement).submit());
      const siliconStatus = await formPost;
      await page.waitForLoadState("load").catch(() => undefined);
      await sleep(400);
      results.check(`${kind} page: a text/plain form posting "JSON" to create a Silicon gets ${expected}`, siliconStatus === expected, `form Silicon ${siliconStatus}`);
      if (!(await signedIn()).held) await plant();

      await page.goto(`${origin}/csrf-device.html`);
      const devicePost = page.waitForResponse(response => response.url() === `${env.site}/v1/device/${userCode}/approve`, { timeout: 15_000 }).then(response => response.status(), () => 0);
      await page.evaluate(() => (document.getElementById("device") as HTMLFormElement).submit());
      const deviceStatus = await devicePost;
      await page.waitForLoadState("load").catch(() => undefined);
      await sleep(400);
      results.check(`${kind} page: a form approving the attacker's CLI device code gets ${expected}`, deviceStatus === expected, `form device approval ${deviceStatus}`);
      if (!(await signedIn()).held) await plant();
    }
    const finalSilicons = await call<{ items?: Array<{ id?: string; silicon?: { id?: string } }> }>(`${env.site}/v1/me/silicons`, { headers: { cookie: `sa_session=${sessionCookie}` }, ip: ctx.ip });
    const ids = (finalSilicons.body.items ?? []).map(item => item.silicon?.id ?? item.id ?? "");
    results.check("…and no Silicon was created by the forged forms (only the one created from the site)", finalSilicons.status === 200 && !ids.some(id => id.startsWith("si:csrf-form-")) && ids.includes(bot.id), `${finalSilicons.status}: ${ids.join(", ")}`);
    const pendingDevice = await call<{ status?: string }>(`${env.site}/v1/device/${userCode}`, { headers: { cookie: `sa_session=${sessionCookie}` }, ip: ctx.ip });
    const poll = await call<{ error?: string; access_token?: string }>(`${env.site}/v1/oauth/token`, { form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.body.device_code ?? "", client_id: "silicon-accounts" }, ip: ctx.ip });
    results.check("…and the attacker's device code was never approved: still pending, and the attacker's terminal polling it gets authorization_pending, no token", device.status === 200 && pendingDevice.body.status === "pending" && poll.status === 400 && poll.body.error === "authorization_pending" && !poll.body.access_token, `device ${device.status}; status ${pendingDevice.status} ${pendingDevice.body.status}; poll ${poll.status} ${poll.body.error}`);
    await victimContext.close();

    // 6. A signed-out browser in the middle of a sign-up (its email verified, the details page next: sa_flow and the
    //    48-hour sa_signup, no session). Same-site pages send its cookies, cross-site ones don't; neither may end it.
    const pendingEmail = randomEmail("csrf-signup");
    const signupJar = new Jar();
    const pending = flowOf(await startFlow(t, signupJar, { app_id: "briefcase", redirect_uri: callbackOf(env, "briefcase"), state: `p-${tag()}`, prompt: "login" }));
    const pendingId = pending?.id ?? "";
    const sentAt = await lastSeq(env);
    await flowStep(t, signupJar, pendingId, "email", { email: pendingEmail });
    const pendingCode = await codeFor(env, pendingEmail, sentAt);
    remember(ctx, "code", pendingCode);
    const atSignup = flowOf(await flowStep(t, signupJar, pendingId, "verify", { code: pendingCode }));
    remember(ctx, "sa_signup cookie", signupJar.get("sa_signup"));
    remember(ctx, "sa_flow cookie", signupJar.get("sa_flow"));
    const signupContext = await newContext(browser, { forwardedFor: null });
    const signupCookies = ["sa_flow", "sa_signup"] as const;
    await signupContext.addCookies(signupCookies.map(name => ({ name, value: signupJar.get(name) ?? "", domain: host, path: "/", httpOnly: true, sameSite: "Lax" as const, secure: false, expires: Math.floor(Date.now() / 1000) + 3600 })));
    await signupContext.route(`${sameSite}/**`, route => route.fulfill({ contentType: "text/html", body: attackerPage("same-site") }));
    await signupContext.route(`${crossSite}/**`, route => route.fulfill({ contentType: "text/html", body: attackerPage("cross-site") }));
    const signupPage = await signupContext.newPage();
    for (const [kind, origin] of [
      ["same-site", sameSite],
      ["cross-site", crossSite],
    ] as const) {
      const navigation = signupPage.waitForResponse(response => response.url() === `${env.site}/v1/session/signout` && response.request().method() === "POST", { timeout: 15_000 }).then(async response => ({ status: response.status(), setCookie: (await response.allHeaders())["set-cookie"] ?? "", sentCookie: (await response.request().allHeaders())["cookie"] ?? "" }), () => ({ status: 0, setCookie: "", sentCookie: "" }));
      await signupPage.goto(`${origin}/csrf-signup.html`);
      await signupPage.evaluate(() => (document.getElementById("signout") as HTMLFormElement).submit());
      const answer = await navigation;
      await signupPage.waitForLoadState("load").catch(() => undefined);
      await sleep(400);
      const kept = (await signupContext.cookies(env.site)).filter(cookie => (signupCookies as readonly string[]).includes(cookie.name) && cookie.value === signupJar.get(cookie.name)).map(cookie => cookie.name);
      await shot(env, signupPage, `security-csrf-${kind}-signup-signout`);
      results.check(`${kind} page: a forged sign-out form against a browser in the middle of a sign-up gets 401 without Set-Cookie, and the browser keeps its sa_signup and sa_flow cookies`, answer.status === 401 && !answer.setCookie && kept.length === 2, `form sign-out ${answer.status} (cookies sent: ${answer.sentCookie ? answer.sentCookie.split(";").map(part => part.split("=")[0]!.trim()).join(", ") : env.engine === "webkit" ? "not reported by WebKit" : "none"})${answer.setCookie ? `, Set-Cookie: ${answer.setCookie.replace(/\s+/g, " ").slice(0, 160)}` : ""}; browser keeps ${kept.join(", ") || "NOTHING"}`);
      if (kept.length < 2) await signupContext.addCookies(signupCookies.map(name => ({ name, value: signupJar.get(name) ?? "", domain: host, path: "/", httpOnly: true, sameSite: "Lax" as const, secure: false, expires: Math.floor(Date.now() / 1000) + 3600 })));
    }
    // The sign-up survived: it is finished with the cookies the browser holds now.
    const finishJar = new Jar();
    for (const cookie of await signupContext.cookies(env.site)) if ((signupCookies as readonly string[]).includes(cookie.name)) finishJar.set(cookie.name, cookie.value);
    let finished = flowOf(await flowStep(t, finishJar, pendingId, "signup", {}));
    if (finished && finished.step !== "complete") finished = await advance(t, finishJar, finished).catch(() => finished);
    remember(ctx, "session cookie", finishJar.get("sa_session"));
    results.check("…and that sign-up is finished afterwards with the cookies the browser kept: the account is created and the flow completes with briefcase's code (after its details page)", atSignup?.step === "signup" && finished?.step === "complete" && /[?&]code=/.test(finished.redirect_to ?? ""), `verified → ${atSignup?.step}; finished → ${finished?.step}${finished?.error ? ` (${finished.error.code})` : ""}`);
    await signupContext.close();
  },
};

/**
 * CSRF: every cookie-authenticated mutation must come from the site's own origin (403 `origin_not_allowed`), whatever
 * the foreign Origin looks like (another site, a look-alike host, another port of the same host, https instead of
 * http, "null", none at all), and nothing changes when it is refused. Bearer tokens are not affected (browsers never
 * attach them on their own). Then the real thing in a browser: a page on a same-site origin (cookies are sent) and on a
 * cross-site origin (SameSite=Lax keeps them home) submits forms and fetches against the signed-in victim's session.
 */
import type { Journey } from "../../context";
import { lastSeq, newContext, shot, sleep, tag } from "../../lib";
import { brief, call, createSilicon, errorOf, flowOf, flowStep, remember, siliconLogin, signInWithEmail, sparePort, startFlow, viaSite, Jar } from "./_helpers";

export const journey: Journey = {
  name: "security-csrf",
  title: "CSRF: cookie mutations from any foreign Origin (look-alike host, other port, https, null, none) are refused with 403 and change nothing, incl. sign-out, delete, Silicon creation, device approval and the hosted flow; Bearer tokens need no Origin; a same-site and a cross-site attacker page in the browser cannot act for the signed-in Carbon",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = viaSite(ctx);
    const victim = await signInWithEmail(t, { label: "csrf" });
    remember(ctx, "session cookie", victim.jar.get("sa_session"));
    remember(ctx, "code", victim.code);
    const me = async () => (await call<{ display_name?: string; id?: string }>(`${env.site}/v1/me`, { jar: victim.jar, ip: ctx.ip })).body;
    const before = await me();

    // 1. PATCH /v1/me from every kind of foreign Origin.
    const sitePort = new URL(env.site).port;
    const foreign: Array<[string, string | null]> = [
      ["another site", "https://evil.example"],
      ["a look-alike host that starts with the site's origin", `${env.site}.evil.example`],
      ["the same host on another port (same site)", `http://localhost:${sparePort(env, 5)}`],
      ["the site's host over https", `https://localhost:${sitePort}`],
      ["an app's origin (the fake apps)", new URL(env.apps).origin],
      ['the opaque origin "null" (sandboxed frames, file:, data:)', "null"],
      ["no Origin header at all", null],
    ];
    const refusedPatch: string[] = [];
    for (const [label, origin] of foreign) {
      const reply = await call(`${env.site}/v1/me`, { method: "PATCH", json: { display_name: `Pwned ${tag()}` }, jar: victim.jar, origin, ip: ctx.ip });
      if (reply.status !== 403 || errorOf(reply).code !== "origin_not_allowed") refusedPatch.push(`${label}: ${brief(reply)}`);
    }
    const afterPatch = await me();
    results.check(`PATCH /v1/me with the session cookie is refused 403 origin_not_allowed from ${foreign.length} kinds of foreign Origin`, refusedPatch.length === 0, refusedPatch.join(" | ") || foreign.map(([label]) => label).join(", "));
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
      ["connect Google", "POST", "/v1/me/identities/google", {}],
    ];
    const notRefused: string[] = [];
    for (const [label, method, path, json] of attempts) {
      const reply = await call(`${env.site}${path}`, { method, ...(json !== undefined ? { json } : { body: "" }), jar: victim.jar, origin: evil, ip: ctx.ip, headers: { "idempotency-key": `csrf-${tag()}` } });
      if (reply.status !== 403 || errorOf(reply).code !== "origin_not_allowed") notRefused.push(`${label}: ${brief(reply)}`);
    }
    results.check(`${attempts.length} other cookie mutations from a foreign origin (sign-out, delete, Silicon, email, id, SLT, device approval, app access, sessions, Google) are refused 403 origin_not_allowed`, notRefused.length === 0, notRefused.join(" | ") || attempts.map(([label]) => label).join(", "));
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
    const emailFromEvil = await call(`${env.site}/v1/flows/${flowId}/email`, { json: { email: target }, jar: flowJar, origin: evil, ip: ctx.ip });
    const flowMails = await call<{ items?: unknown[] }>(`${env.messaging}/_messages?to=${encodeURIComponent(target)}`);
    results.check("the hosted flow refuses a foreign origin: POST /v1/flows and a step with the right flow cookie both get 403, and no code is sent", flowFromEvil.status === 403 && errorOf(flowFromEvil).code === "origin_not_allowed" && emailFromEvil.status === 403 && errorOf(emailFromEvil).code === "origin_not_allowed" && !(flowMails.body.items ?? []).length, `${brief(flowFromEvil)} / ${brief(emailFromEvil)} / ${(flowMails.body.items ?? []).length} codes`);
    const okStep = await flowStep(t, flowJar, flowId, "switch");
    results.check("control: the same flow step from the site's origin works", okStep.status === 200, brief(okStep));

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

    // 5. In the browser: attacker pages against the signed-in victim.
    const victimContext = await newContext(browser, { forwardedFor: null });
    const host = new URL(env.site).hostname;
    const sessionCookie = victim.jar.get("sa_session") ?? "";
    const plant = () => victimContext.addCookies([{ name: "sa_session", value: sessionCookie, domain: host, path: "/", httpOnly: true, sameSite: "Lax", secure: false, expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await plant();
    const sameSite = `http://localhost:${sparePort(env, 5)}`;
    const crossSite = `http://127.0.0.1:${sparePort(env, 5)}`;
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

      const navigation = page.waitForResponse(response => response.url() === `${env.site}/v1/session/signout` && response.request().method() === "POST", { timeout: 15_000 });
      await page.goto(`${origin}/csrf-form.html`);
      await page.evaluate(() => (document.getElementById("signout") as HTMLFormElement).submit());
      const signout = await navigation.then(async response => ({ status: response.status(), setCookie: (await response.allHeaders())["set-cookie"] ?? "" })).catch(() => ({ status: 0, setCookie: "" }));
      await sleep(400);
      const afterForm = await signedIn();
      await shot(env, page, `security-csrf-${kind}-signout`);
      results.check(`${kind} page: a top-level form POST to sign out gets ${expected} (${why}) and the victim stays signed in (the browser keeps its session cookie)`, signout.status === expected && afterForm.held && afterForm.live, `form sign-out ${signout.status}${signout.setCookie ? `, Set-Cookie: ${signout.setCookie.replace(/\s+/g, " ").slice(0, 160)}` : ""}; ${afterForm.text}`);
      if (!afterForm.held) await plant();

      await page.goto(`${origin}/csrf-silicon.html`);
      const formPost = page.waitForResponse(response => response.url() === `${env.site}/v1/me/silicons`, { timeout: 15_000 });
      await page.evaluate(() => (document.getElementById("silicon") as HTMLFormElement).submit());
      const siliconStatus = await formPost.then(response => response.status()).catch(() => 0);
      await sleep(400);
      results.check(`${kind} page: a text/plain form posting "JSON" to create a Silicon gets ${expected}`, siliconStatus === expected, `form Silicon ${siliconStatus}`);
      if (!(await signedIn()).held) await plant();

      await page.goto(`${origin}/csrf-device.html`);
      const devicePost = page.waitForResponse(response => response.url() === `${env.site}/v1/device/${userCode}/approve`, { timeout: 15_000 });
      await page.evaluate(() => (document.getElementById("device") as HTMLFormElement).submit());
      const deviceStatus = await devicePost.then(response => response.status()).catch(() => 0);
      await sleep(400);
      results.check(`${kind} page: a form approving the attacker's CLI device code gets ${expected}`, deviceStatus === expected, `form device approval ${deviceStatus}`);
      if (!(await signedIn()).held) await plant();
    }
    const finalSilicons = await call<{ items?: Array<{ id?: string; silicon?: { id?: string } }> }>(`${env.site}/v1/me/silicons`, { headers: { cookie: `sa_session=${sessionCookie}` }, ip: ctx.ip });
    const ids = (finalSilicons.body.items ?? []).map(item => item.silicon?.id ?? item.id ?? "");
    results.check("…and no Silicon was created by the forged forms (only the one created from the site)", finalSilicons.status === 200 && !ids.some(id => id.startsWith("si:csrf-form-")) && ids.includes(bot.id), `${finalSilicons.status}: ${ids.join(", ")}`);
    const pendingDevice = await call<{ status?: string }>(`${env.site}/v1/device/${userCode}`, { headers: { cookie: `sa_session=${sessionCookie}` }, ip: ctx.ip });
    const poll = await call<{ error?: string; access_token?: string }>(`${env.site}/v1/oauth/token`, { form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.body.device_code ?? "", client_id: "accounts" }, ip: ctx.ip });
    results.check("…and the attacker's device code was never approved: still pending, and the attacker's terminal polling it gets authorization_pending, no token", device.status === 200 && pendingDevice.body.status === "pending" && poll.status === 400 && poll.body.error === "authorization_pending" && !poll.body.access_token, `device ${device.status}; status ${pendingDevice.status} ${pendingDevice.body.status}; poll ${poll.status} ${poll.body.error}`);
    await victimContext.close();
  },
};


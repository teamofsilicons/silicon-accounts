/**
 * A hosted sign-in flow belongs to the browser that started it (its `sa_flow` binding cookie). Someone who learns a
 * flow's id (from a URL, a screenshot, a log) can't read it, drive it, verify a code in it, continue in it as their own
 * account, or collect the authorization code it ends with; a made-up or another flow's binding cookie doesn't help; the
 * sign-up step also needs the browser's own sign-up cookie; and a Google answer delivered by another browser is
 * discarded (no login CSRF, no session for the wrong browser). In the browser, opening someone else's flow page never
 * redirects to the app.
 */
import type { Journey } from "../../context";
import { codeFor, lastSeq, newContext, shot, sleep, tag } from "../../lib";
import { appCredentials, brief, call, callbackOf, errorOf, flowOf, flowStep, pkcePair, randomEmail, remember, signInWithEmail, startFlow, viaSite, Jar, type FlowView, type Reply } from "./_helpers";

const notBound = (reply: Reply) => reply.status === 403 && errorOf(reply).code === "flow_not_bound" && !(reply.body as { flow?: unknown } | null)?.flow;

export const journey: Journey = {
  name: "security-flow-binding",
  title: "flow binding: a stolen flow id without the browser's sa_flow cookie (none, another flow's, made up) can't read, drive, verify, continue or collect the code (403 flow_not_bound); sign-up needs the sa_signup cookie; a Google answer delivered by another browser is discarded; another browser opening the flow page is never sent to the app",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = viaSite(ctx);
    const callback = callbackOf(env, "briefcase");
    const victimJar = new Jar();
    const { verifier, challenge } = pkcePair();
    const started = await startFlow(t, victimJar, { app_id: "briefcase", redirect_uri: callback, state: `v-${tag()}`, code_challenge: challenge, code_challenge_method: "S256", prompt: "login" });
    const flowId = flowOf(started)?.id ?? "";
    results.check("the victim's browser starts a flow and holds its binding cookie", started.status === 201 && !!victimJar.get("sa_flow"), brief(started));

    // The attackers: no cookie at all, the binding cookie of a flow of their own, and a well-formed made-up one.
    const own = new Jar();
    await startFlow(t, own, { app_id: "briefcase", redirect_uri: callback, state: `a-${tag()}` });
    const madeUp = new Jar();
    madeUp.set("sa_flow", `saf_${"Q".repeat(43)}`);
    const attackers: Array<[string, Jar]> = [
      ["no cookie", new Jar()],
      ["another flow's cookie", own],
      ["a made-up cookie", madeUp],
    ];
    const victimEmail = randomEmail("flowvictim");
    const readable: string[] = [];
    for (const [label, jar] of attackers) {
      const read = await call(`${env.site}/v1/flows/${flowId}`, { jar, ip: ctx.ip });
      if (!notBound(read)) readable.push(`${label} GET: ${brief(read)}`);
      const drive = await flowStep(t, jar, flowId, "email", { email: victimEmail });
      if (!notBound(drive)) readable.push(`${label} email: ${brief(drive)}`);
    }
    const mails = await call<{ items?: unknown[] }>(`${env.messaging}/_messages?to=${encodeURIComponent(victimEmail)}`);
    results.check("a stolen flow id is useless without the browser's own sa_flow cookie: reading and driving it get 403 flow_not_bound (no cookie, another flow's cookie, a made-up one), the answer holds no flow, and no code is sent", readable.length === 0 && !(mails.body.items ?? []).length, readable.join(" | ") || `3 × GET + 3 × POST email refused; ${(mails.body.items ?? []).length} codes sent`);

    // The victim asks for a code; an attacker who somehow has the code still can't use it in that flow.
    const after = await lastSeq(env);
    const asked = await flowStep(t, victimJar, flowId, "email", { email: victimEmail });
    const code = await codeFor(env, victimEmail, after);
    remember(ctx, "code", code);
    const stolenVerify = await flowStep(t, own, flowId, "verify", { code });
    const stolenVerify2 = await flowStep(t, new Jar(), flowId, "verify", { code });
    results.check("an attacker holding the right code still can't verify it in the victim's flow (403 flow_not_bound)", asked.status === 200 && notBound(stolenVerify) && notBound(stolenVerify2), `${brief(stolenVerify)} / ${brief(stolenVerify2)}`);
    const verified = await flowStep(t, victimJar, flowId, "verify", { code });
    let flow = flowOf(verified);
    results.check("…and the attacker's tries took nothing from the victim: the same code still verifies in the victim's browser", verified.status === 200 && flow?.step === "signup", brief(verified));

    // The sign-up step needs the browser's sa_signup cookie too.
    const withoutSignup = victimJar.clone();
    withoutSignup.delete("sa_signup");
    const noSignupCookie = await flowStep(t, withoutSignup, flowId, "signup", {});
    results.check("the sign-up step without the browser's sa_signup cookie is refused (403 signup_not_bound) even with the flow cookie", noSignupCookie.status === 403 && /signup/.test(errorOf(noSignupCookie).code ?? ""), brief(noSignupCookie));
    for (let guard = 0; guard < 4 && flow && flow.step !== "complete"; guard++) {
      const next = flow.step === "signup" ? await flowStep(t, victimJar, flowId, "signup", {}) : await flowStep(t, victimJar, flowId, "consent", { approve: true, optional_scopes: [] });
      flow = flowOf(next);
    }
    const authCode = flow?.redirect_to ? new URL(flow.redirect_to).searchParams.get("code") : null;
    remember(ctx, "code", authCode);
    remember(ctx, "session cookie", victimJar.get("sa_session"));
    results.check("the victim finishes: the flow completes with an authorization code for briefcase", flow?.step === "complete" && !!authCode, `${flow?.step} ${flow?.redirect_to?.slice(0, 80)}`);

    // After completion the flow holds the code in redirect_to: a stolen id still reads nothing.
    const leaked: string[] = [];
    for (const [label, jar] of attackers) {
      const read = await call(`${env.site}/v1/flows/${flowId}`, { jar, ip: ctx.ip });
      if (!notBound(read) || (authCode && read.text.includes(authCode))) leaked.push(`${label}: ${brief(read)}`);
    }
    const attackerCarbon = await signInWithEmail(t, { label: "flowattacker" });
    remember(ctx, "session cookie", attackerCarbon.jar.get("sa_session"));
    const continueAsAttacker = await flowStep(t, attackerCarbon.jar, flowId, "continue");
    results.check("the completed flow (its redirect_to holds the code) can't be read with a stolen id, and a signed-in attacker can't continue in it (403 flow_not_bound)", leaked.length === 0 && notBound(continueAsAttacker), leaked.join(" | ") || brief(continueAsAttacker));
    const exchange = await call<{ access_token?: string }>(`${env.site}/v1/oauth/token`, { form: { grant_type: "authorization_code", code: authCode ?? "", redirect_uri: callback, code_verifier: verifier }, basic: appCredentials("briefcase"), ip: ctx.ip });
    remember(ctx, "access token", exchange.body.access_token);
    results.check("control: briefcase redeems the victim's code with the PKCE verifier", exchange.status === 200 && !!exchange.body.access_token, brief(exchange));

    // A Google answer delivered by another browser (login CSRF / a forwarded provider link).
    const gJar = new Jar();
    const gFlow = flowOf(await startFlow(t, gJar, { app_id: "briefcase", redirect_uri: callback, state: `g-${tag()}`, prompt: "login" }));
    const gEmail = `sec.google.${tag()}${tag()}@example.test`;
    const leg = await flowStep(t, gJar, gFlow?.id ?? "", "oauth/google");
    const authorizeUrl = String((leg.body as { authorize_url?: string } | null)?.authorize_url ?? "");
    const provider = new URL(authorizeUrl || `${env.oidc}/google/authorize`);
    provider.searchParams.set("_auto", gEmail);
    const answer = await fetch(provider, { redirect: "manual" });
    const location = answer.headers.get("location") ?? "";
    const callbackUrl = location.startsWith(env.site) ? location : `${env.site}${new URL(location, env.site).pathname}${new URL(location, env.site).search}`;
    const elsewhere = await call(callbackUrl, { jar: new Jar(), ip: ctx.ip, headers: { accept: "text/html" } });
    const elsewhereSetsSession = elsewhere.setCookies.some(cookie => /sa_session|sa_signup/.test(cookie.name) && cookie.value);
    const afterElsewhere = await call<{ flow?: FlowView }>(`${env.site}/v1/flows/${gFlow?.id}`, { jar: gJar, ip: ctx.ip });
    const gView = flowOf(afterElsewhere);
    results.check("a Google answer delivered by another browser is discarded: the callback refuses it (403), sets no session or sign-up cookie anywhere, and the real browser's flow did not sign anyone in", leg.status === 200 && answer.status >= 300 && answer.status < 400 && elsewhere.status === 403 && !elsewhereSetsSession && gView?.step !== "signup" && gView?.step !== "complete" && !gJar.get("sa_session"), `leg ${leg.status}, provider ${answer.status}, callback from elsewhere ${elsewhere.status} (${/data-error="([^"]+)"/.exec(elsewhere.text)?.[1] ?? errorOf(elsewhere).code ?? ""}), flow now ${gView?.step} ${gView?.error?.code ?? ""}`);
    const replay = await call(callbackUrl, { jar: gJar, ip: ctx.ip, headers: { accept: "text/html" } });
    const afterReplay = flowOf(await call(`${env.site}/v1/flows/${gFlow?.id}`, { jar: gJar, ip: ctx.ip }));
    results.check("…and the intercepted answer is used up: replaying it in the real browser signs nobody in", afterReplay?.step !== "signup" && afterReplay?.step !== "complete" && !gJar.get("sa_session"), `replay ${replay.status} → ${replay.headers.get("location") ?? ""}; flow ${afterReplay?.step} ${afterReplay?.error?.code ?? ""}`);
    const control = await flowStep(t, gJar, gFlow?.id ?? "", "oauth/google");
    const controlUrl = new URL(String((control.body as { authorize_url?: string } | null)?.authorize_url ?? authorizeUrl));
    controlUrl.searchParams.set("_auto", gEmail);
    const controlAnswer = await fetch(controlUrl, { redirect: "manual" });
    const controlLocation = controlAnswer.headers.get("location") ?? "";
    const delivered = await call(controlLocation.startsWith(env.site) ? controlLocation : `${env.site}${new URL(controlLocation, env.site).pathname}${new URL(controlLocation, env.site).search}`, { jar: gJar, ip: ctx.ip, headers: { accept: "text/html" } });
    const claimed = flowOf(await call(`${env.site}/v1/flows/${gFlow?.id}`, { jar: gJar, ip: ctx.ip }));
    results.check("control: a new Google leg delivered by the browser that started it goes through (302 back to the flow, which moves on to sign-up)", delivered.status === 302 && (delivered.headers.get("location") ?? "").includes(`/authorize/flow/${gFlow?.id}`) && claimed?.step === "signup", `${delivered.status} → ${delivered.headers.get("location")}; flow ${claimed?.step}`);

    // In the browser: another person opening the victim's flow page.
    const context = await newContext(browser);
    const navigations: string[] = [];
    const page = await context.newPage();
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    results.watch(page, "flow-binding", [/403 \(Forbidden\)/, /Failed to load resource/]);
    await page.goto(`${env.site}/authorize/flow/${flowId}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(2000);
    await shot(env, page, "security-flow-binding-01-stolen");
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const sentToApp = navigations.some(url => url.startsWith(env.apps));
    results.check("another browser opening the victim's completed flow page sees an error, is never sent to briefcase with the code, and doesn't see the victim's email", !sentToApp && new URL(page.url()).origin === env.site && !text.includes(victimEmail) && !(authCode && page.url().includes(authCode)), `at ${page.url()}; "${text.slice(0, 160)}"`);
    await context.close();
  },
};

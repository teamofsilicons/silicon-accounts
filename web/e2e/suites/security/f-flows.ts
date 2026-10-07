/**
 * A hosted sign-in flow belongs to the browser that started it (its `sa_flow` binding cookie). Someone who learns a
 * flow's id (from a URL, a screenshot, a log) can't read it, drive it, verify a code in it, continue in it as their own
 * account, or collect the authorization code it ends with; a made-up or another flow's binding cookie doesn't help; the
 * sign-up step also needs the browser's own sign-up cookie; and a Google answer, or an Apple form_post answer (parked
 * and continued with a same-site ticket), delivered by another browser is discarded and used up (no login CSRF, no
 * session for the wrong browser). In the browser, opening someone else's flow page never redirects to the app.
 */
import type { Journey } from "../../context";
import { codeFor, lastSeq, newContext, shot, sleep, tag } from "../../lib";
import { advance, appCredentials, brief, call, callbackOf, errorOf, flowOf, flowStep, pkcePair, randomEmail, randomPhone, remember, signInWithEmail, startFlow, viaSite, Jar, type FlowView, type Reply } from "./_helpers";

const notBound = (reply: Reply) => reply.status === 403 && errorOf(reply).code === "flow_not_bound" && !(reply.body as { flow?: unknown } | null)?.flow;

/** Decodes the HTML entities a form attribute may carry (named and numeric). */
const unescapeHtml = (text: string) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

export const journey: Journey = {
  name: "security-flow-binding",
  title: "flow binding: a stolen flow id without the browser's sa_flow cookie (none, another flow's, made up) can't read, drive, verify, continue, answer the v2 details/review pages or collect the code (403 flow_not_bound); those pages also need the flow account's own session; sign-up needs the sa_signup cookie; a Google answer and a parked Apple form_post delivered by another browser are discarded and used up; another browser opening the flow page is never sent to the app",
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
    const signedUp = await flowStep(t, victimJar, flowId, "signup", {});
    flow = flowOf(signedUp);
    remember(ctx, "session cookie", victimJar.get("sa_session"));

    // The v2 details page (briefcase: email required, timezone optional): a stolen id can't answer it either, and even
    // the right flow cookie needs the browser session of the flow's account.
    const atDetails = flow?.step === "details";
    const detailsActions: Array<[string, string, unknown]> = [
      ["continue (sharing the timezone)", "details/continue", { share: ["timezone"] }],
      ["go back", "details/back", {}],
      ["approve", "review", { approve: true }],
      ["cancel", "review", { approve: false }],
      ["add a phone", "details/add", { phone: randomPhone() }],
      ["verify a code", "details/verify", { code: "123456" }],
    ];
    const answered: string[] = [];
    for (const [label, jar] of attackers) {
      for (const [action, step, body] of detailsActions) {
        const reply = await flowStep(t, jar, flowId, step, body);
        if (!notBound(reply)) answered.push(`${label}, ${action}: ${brief(reply)}`);
      }
    }
    const attackerSession = await signInWithEmail(t, { label: "flowsession" });
    remember(ctx, "session cookie", attackerSession.jar.get("sa_session"));
    const otherSession = victimJar.clone();
    otherSession.set("sa_session", attackerSession.jar.get("sa_session") ?? "");
    const noSession = victimJar.clone();
    noSession.delete("sa_session");
    const asOther = await flowStep(t, otherSession, flowId, "details/continue", { share: [] });
    const withoutSession = await flowStep(t, noSession, flowId, "details/continue", { share: [] });
    const cancelAsOther = await flowStep(t, otherSession, flowId, "review", { approve: false });
    const stillThere = flowOf(await call(`${env.site}/v1/flows/${flowId}`, { jar: victimJar, ip: ctx.ip }));
    results.check(`on the details page a stolen flow id is refused for all ${detailsActions.length} v2 actions (continue, back, approve, cancel, add a phone, verify) with no cookie, another flow's cookie or a made-up one (${detailsActions.length * attackers.length} × 403 flow_not_bound)`, atDetails && answered.length === 0, `flow at ${flow?.step}; ${answered.join(" | ") || "all refused"}`);
    results.check("…and with the right flow cookie but another Carbon's session (409 account_changed) or no session (401 session_required) the page can't be continued or cancelled; the flow stays on its details page", asOther.status === 409 && errorOf(asOther).code === "account_changed" && withoutSession.status === 401 && errorOf(withoutSession).code === "session_required" && cancelAsOther.status === 409 && stillThere?.step === "details", `another session ${brief(asOther)}; cancel ${brief(cancelAsOther)}; no session ${brief(withoutSession)}; flow ${stillThere?.step}`);
    if (flow && flow.step !== "complete") flow = await advance(t, victimJar, flow);
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

    // An Apple answer comes back as a form_post: a cross-site POST, which carries no SameSite=Lax cookie. It is parked
    // and continued with a same-site GET (?ticket=…), which must carry the binding cookie of the browser that started
    // the sign-in. Delivered by another browser (a forwarded or intercepted answer, or login CSRF), it is discarded.
    const aJar = new Jar();
    const aFlow = flowOf(await startFlow(t, aJar, { app_id: "briefcase", redirect_uri: callback, state: `ap-${tag()}`, prompt: "login" }));
    const aId = aFlow?.id ?? "";
    const aEmail = randomEmail("apple");
    const appleAnswer = async () => {
      const legReply = await flowStep(t, aJar, aId, "oauth/apple");
      const authorize = new URL(String((legReply.body as { authorize_url?: string } | null)?.authorize_url ?? `${env.oidc}/apple/authorize`));
      authorize.searchParams.set("_auto", aEmail);
      const html = await (await fetch(authorize, { redirect: "manual" })).text();
      const action = unescapeHtml(/<form id="apple-form-post" method="post" action="([^"]+)"/.exec(html)?.[1] ?? "");
      const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(match => [unescapeHtml(match[1]!), unescapeHtml(match[2]!)]));
      remember(ctx, "code", fields.code);
      return { leg: legReply.status, action, fields };
    };
    /** Apple's form_post as the browser sends it: cross-site, so without the site's cookies. */
    const formPost = (answer: { action: string; fields: Record<string, string> }) => call(answer.action, { form: answer.fields, origin: "https://appleid.apple.com", ip: ctx.ip, headers: { accept: "text/html" } });
    const errorCode = (reply: Reply) => /data-error="([^"]+)"/.exec(reply.text)?.[1] ?? errorOf(reply).code ?? "";
    const signsIn = (reply: Reply) => reply.setCookies.some(cookie => /sa_session|sa_signup/.test(cookie.name) && cookie.value);

    const intercepted = await appleAnswer();
    const parked = await formPost(intercepted);
    const missingTicket = `${env.site}/v1/oauth/callback/apple?ticket=no-ticket-was-issued`;
    const ticketUrl = parked.headers.get("location") ?? "";
    const ticketElsewhere = await call(ticketUrl || missingTicket, { jar: new Jar(), ip: ctx.ip, headers: { accept: "text/html" } });
    const aView = flowOf(await call(`${env.site}/v1/flows/${aId}`, { jar: aJar, ip: ctx.ip }));
    results.check(
      "an Apple answer (form_post) delivered by another browser is parked (303 to a same-site ticket URL, no cookie set) and its ticket without the starting browser's binding cookie is refused (403 flow_not_bound): no session or sign-up cookie anywhere, and the real flow says provider_answer_elsewhere",
      intercepted.leg === 200 && !!intercepted.fields.code && parked.status === 303 && ticketUrl.startsWith(`${env.site}/v1/oauth/callback/apple?ticket=`) && parked.setCookies.length === 0 && ticketElsewhere.status === 403 && errorCode(ticketElsewhere) === "flow_not_bound" && !signsIn(ticketElsewhere) && aView?.error?.code === "provider_answer_elsewhere" && !aView.signed_in_as && !aJar.get("sa_session") && !aJar.get("sa_signup"),
      `leg ${intercepted.leg}; form_post ${parked.status} → ${ticketUrl.replace(/ticket=.*/, "ticket=…")} (Set-Cookie ${parked.setCookies.length}); ticket elsewhere ${ticketElsewhere.status} ${errorCode(ticketElsewhere)}; flow ${aView?.step} ${aView?.error?.code ?? ""}`,
    );
    const ticketReplayed = await call(ticketUrl || missingTicket, { jar: aJar, ip: ctx.ip, headers: { accept: "text/html" } });
    const postedAgain = await formPost(intercepted);
    const afterReplays = flowOf(await call(`${env.site}/v1/flows/${aId}`, { jar: aJar, ip: ctx.ip }));
    results.check("…and the discarded answer is used up: its ticket replayed in the right browser and the same form_post sent again are refused (400 invalid_state) and sign nobody in", ticketReplayed.status === 400 && errorCode(ticketReplayed) === "invalid_state" && postedAgain.status === 400 && !signsIn(ticketReplayed) && !signsIn(postedAgain) && afterReplays?.step === "choose_method" && !aJar.get("sa_session") && !aJar.get("sa_signup"), `ticket replay ${ticketReplayed.status} ${errorCode(ticketReplayed)}; form_post again ${postedAgain.status} ${errorCode(postedAgain)}; flow ${afterReplays?.step}`);

    // Control: the browser that started it continues its own parked answer, exactly once.
    const ownAnswer = await appleAnswer();
    const ownParked = await formPost(ownAnswer);
    const ownTicket = ownParked.headers.get("location") || missingTicket;
    const parkedTwice = await formPost(ownAnswer);
    const ticketByPost = await call(ownTicket, { method: "POST", body: "", contentType: "application/x-www-form-urlencoded", jar: aJar.clone(), ip: ctx.ip, headers: { accept: "text/html" } });
    const continued = await call(ownTicket, { jar: aJar, ip: ctx.ip, headers: { accept: "text/html" } });
    const claimedApple = flowOf(await call(`${env.site}/v1/flows/${aId}`, { jar: aJar, ip: ctx.ip }));
    remember(ctx, "sa_signup cookie", aJar.get("sa_signup"));
    const ticketReused = await call(ownTicket, { jar: aJar, ip: ctx.ip, headers: { accept: "text/html" } });
    results.check(
      "control: the browser that started the sign-in continues its parked Apple answer (303 → ticket GET with its binding cookie → 302 to the flow, which moves on to sign-up); the answer can't be parked twice, its ticket can't come back by POST, and a used ticket is refused",
      ownParked.status === 303 && parkedTwice.status === 400 && ticketByPost.status === 400 && continued.status === 302 && (continued.headers.get("location") ?? "") === `${env.site}/authorize/flow/${aId}` && claimedApple?.step === "signup" && claimedApple.signup?.email === aEmail && !!aJar.get("sa_signup") && ticketReused.status === 400,
      `form_post ${ownParked.status}; again ${parkedTwice.status} ${errorCode(parkedTwice)}; ticket by POST ${ticketByPost.status} ${errorCode(ticketByPost)}; ticket GET ${continued.status} → ${continued.headers.get("location")}; flow ${claimedApple?.step} (${claimedApple?.signup?.email ?? "no sign-up"}); ticket reused ${ticketReused.status} ${errorCode(ticketReused)}`,
    );

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

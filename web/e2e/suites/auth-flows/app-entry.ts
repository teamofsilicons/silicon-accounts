/**
 * Who types the email or phone number. UNDERSTANDING.md ("Adding sign-in to an app", as edited on 2026-10-07): "An app
 * can never take in a Carbon's email or phone number itself and send it to us for verification. The Carbon always
 * types it on our pages."
 *
 * In the browser: an app that hands an address to the hosted page (login_hint, with method=email|phone) gets nothing
 * sent, and the field is left for the Carbon to type; the code goes out only when the Carbon presses Continue on our
 * page. At the API: creating a flow with login_hint (or an email/phone field) sends nothing, and the app's own page
 * cannot call the code endpoints (its Origin is refused, nothing is sent).
 */
import type { Journey } from "../../context";
import { codeFor, lastSeq, newContext, shot, sleep, sql, tag } from "../../lib";
import { Browserish, brief, errorCode, messagesTo, randomPhone, startSignIn } from "./_helpers";

const hinted: Journey = {
  name: "auth-flows-app-entered-contacts",
  title: "an app never sends a Carbon's email or phone for verification: login_hint + method=email|phone send nothing and leave the field for the Carbon to type; the code goes out when the Carbon presses Continue; at the API a hinted flow sends nothing and the app's own page cannot call the code endpoints",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();

    // 1. briefcase hands our page an email (login_hint) and asks for the email method.
    const email = `hinted.${t}@example.test`;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "app-entry-email");
    const before = await lastSeq(env);
    await page.goto(`${env.apps}/briefcase/?only=hosted&method=email&login_hint=${encodeURIComponent(email)}`);
    await page.locator("#signin-hosted").click();
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    await sleep(1_500);
    const filled = await field.inputValue();
    await shot(env, page, "auth-flows-app-entry-email");
    results.check(
      "an email the app passed (login_hint) is not filled in: the Carbon types the address on our page (UNDERSTANDING: \"The Carbon always types it on our pages\")",
      filled === "",
      `the Email field holds "${filled}"`,
    );
    const early = await messagesTo(env, email, before);
    const challenges = await sql(env, `select count(*) from otp_challenges where destination = '${email}'`);
    results.check("nothing is sent on arrival: no email reached the address and no code challenge exists", early === 0 && challenges[0]?.[0] === "0", `${early} message(s), ${challenges[0]?.[0]} challenge(s)`);
    await field.fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, email, before).catch(() => null);
    results.check("…the code goes out once the Carbon presses Continue on our page", !!code && (await messagesTo(env, email, before)) === 1, `code ${code ? "received" : "missing"}`);
    await context.close();

    // 2. dm hands our page a phone number (login_hint) and asks for the phone method.
    const phone = randomPhone();
    const phoneContext = await newContext(browser);
    const phonePage = await phoneContext.newPage();
    results.watch(phonePage, "app-entry-phone");
    const beforePhone = await lastSeq(env);
    await phonePage.goto(`${env.apps}/dm/?only=hosted&method=phone&login_hint=${encodeURIComponent(phone)}`);
    await phonePage.locator("#signin-hosted").click();
    const phoneField = phonePage.getByRole("textbox", { name: "Phone number" });
    await phoneField.waitFor({ timeout: 30_000 });
    await sleep(1_500);
    const phoneFilled = await phoneField.inputValue();
    await shot(env, phonePage, "auth-flows-app-entry-phone");
    results.check(
      "a phone number the app passed (login_hint) is not filled in: the Carbon types it on our page",
      phoneFilled.replace(/\D/g, "") === "",
      `the Phone number field holds "${phoneFilled}"`,
    );
    const earlyText = await messagesTo(env, phone, beforePhone);
    const phoneChallenges = await sql(env, `select count(*) from otp_challenges where destination = '${phone}'`);
    results.check("nothing is sent on arrival: no text reached the number and no code challenge exists", earlyText === 0 && phoneChallenges[0]?.[0] === "0", `${earlyText} message(s), ${phoneChallenges[0]?.[0]} challenge(s)`);
    await phoneContext.close();

    // 3. At the API: a flow created with an address sends nothing; the app's page cannot ask for a code.
    const b = new Browserish(env, ctx.ip);
    const apiEmail = `hinted.api.${t}@example.test`;
    const beforeApi = await lastSeq(env);
    const started = await startSignIn(b, "briefcase", { loginHint: apiEmail, method: "email", extra: { email: apiEmail, phone } });
    results.check(
      "POST /v1/flows with login_hint, method=email and email/phone fields → a flow waiting at choose_method with no challenge",
      started.reply.status === 201 && started.flow?.step === "choose_method" && started.flow.challenge === null,
      `${started.reply.status} step=${started.flow?.step} challenge=${JSON.stringify(started.flow?.challenge)}`,
    );
    await sleep(500);
    results.check("…and nothing was sent to the address", (await messagesTo(env, apiEmail, beforeApi)) === 0);
    const appOrigin = new URL(env.apps).origin;
    const crossSite = await b.call("POST", `/v1/flows/${started.flow.id}/email`, { json: { email: apiEmail }, origin: appOrigin });
    results.check(
      `the app's own page (Origin ${appOrigin}) asking for a code in a flow → 403 origin_not_allowed`,
      crossSite.status === 403 && errorCode(crossSite) === "origin_not_allowed",
      brief(crossSite),
    );
    const crossSitePhone = await b.call("POST", `/v1/flows/${started.flow.id}/phone`, { json: { phone }, origin: appOrigin });
    results.check("…the same for a text message", crossSitePhone.status === 403 && errorCode(crossSitePhone) === "origin_not_allowed", brief(crossSitePhone));
    await sleep(500);
    results.check("…and neither sent anything", (await messagesTo(env, apiEmail, beforeApi)) === 0 && (await messagesTo(env, phone, beforeApi)) === 0);
  },
};

export const journeys: Journey[] = [hinted];

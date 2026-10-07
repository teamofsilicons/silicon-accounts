/**
 * Direct buttons on the app's own website (UNDERSTANDING.md v2 "Adding sign-in to an app"): an app can put `Continue
 * with Google`, `Continue with Apple`, `Continue with email`, `Continue with phone number`… on its page, "or it can just
 * have a Sign in and a Sign up button, and we show everything else on our pages accordingly". The iframe and the SDK
 * snippet draw those buttons from the app's configured methods; pressing one lands on our page for exactly that method,
 * where the Carbon types the address (nothing is sent before they press Continue); "Sign up" opens the sign-up version.
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { hostedTitle, lastSeq, newContext, readFlow, shot, sleep } from "../../lib";
import { messagesAfter, randomState, redirectUriOf } from "./_helpers";

const CONTRACT_LABELS = ["Continue with Google", "Continue with Apple", "Continue with email", "Continue with phone number"];

/** What our page offers once the browser is there: its visible text fields and provider buttons. */
async function hostedOffer(page: Page): Promise<{ url: string; email: boolean; phone: boolean; google: boolean; apple: boolean; emailValue: string; phoneValue: string }> {
  const email = page.getByRole("textbox", { name: "Email" });
  const phone = page.getByRole("textbox", { name: "Phone number" });
  const visible = async (locator: ReturnType<Page["getByRole"]>) => (await locator.count()) > 0 && (await locator.first().isVisible());
  return {
    url: page.url(),
    email: await visible(email),
    phone: await visible(phone),
    google: await visible(page.getByRole("button", { name: "Continue with Google" })),
    apple: await visible(page.getByRole("button", { name: "Continue with Apple" })),
    emailValue: (await visible(email)) ? await email.inputValue() : "",
    phoneValue: (await visible(phone)) ? await phone.inputValue() : "",
  };
}

const directButtons: Journey = {
  name: "auth-flows-direct-buttons",
  title: "interface's own page: the iframe and the SDK draw Continue with Google / Apple / email / phone number; Continue with email lands on our page with only the email field, Continue with phone number with only the phone field, empty, nothing sent; the SDK with intent=signup opens the sign-up version; the embed's Sign in / Sign up buttons",
  async run(ctx) {
    const { env, results, browser } = ctx;

    // The iframe.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "direct-iframe");
    await page.goto(`${env.apps}/interface/?only=iframe`);
    const frame = page.frameLocator("#signin-iframe");
    await frame.getByRole("link", { name: "Continue with Google" }).waitFor({ timeout: 15_000 });
    const iframeLabels = (await frame.getByRole("link").allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim()).filter(text => text.startsWith("Continue with"));
    results.check(`the iframe's buttons read ${CONTRACT_LABELS.join(", ")} (the contract's words)`, CONTRACT_LABELS.every(label => iframeLabels.includes(label)) && iframeLabels.length === CONTRACT_LABELS.length, JSON.stringify(iframeLabels));
    const before = await lastSeq(env);
    await frame.getByRole("link", { name: "Continue with email" }).click();
    await page.waitForURL(url => url.href.startsWith(env.site), { timeout: 30_000 });
    await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    await sleep(500);
    const onEmail = await hostedOffer(page);
    await shot(env, page, "auth-flows-direct-email");
    results.check("Continue with email → our page with only the email field (no phone field, no Google or Apple button)", onEmail.email && !onEmail.phone && !onEmail.google && !onEmail.apple, JSON.stringify(onEmail));
    results.check("…empty for the Carbon to type, and nothing sent yet", onEmail.emailValue === "" && (await messagesAfter(env, before)) === 0, `value "${onEmail.emailValue}"`);
    results.check("…and \"Other ways to sign in\" brings the other methods back", await page.getByRole("button", { name: "Other ways to sign in" }).click({ timeout: 10_000 }).then(async () => (await page.getByRole("button", { name: "Continue with Google" }).waitFor({ timeout: 10_000 }).then(() => true, () => false)), () => false));
    await context.close();

    // The SDK snippet.
    const sdkContext = await newContext(browser);
    const sdkPage = await sdkContext.newPage();
    results.watch(sdkPage, "direct-sdk");
    await sdkPage.goto(`${env.apps}/interface/?only=sdk`);
    const host = sdkPage.locator("#silicon-accounts");
    await host.getByRole("button", { name: "Continue with Google" }).waitFor({ timeout: 15_000 });
    const sdkLabels = (await host.getByRole("button").allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim()).filter(text => text.startsWith("Continue with"));
    results.check(`the SDK's buttons read ${CONTRACT_LABELS.join(", ")} (the contract's words)`, CONTRACT_LABELS.every(label => sdkLabels.includes(label)) && sdkLabels.length === CONTRACT_LABELS.length, JSON.stringify(sdkLabels));
    const beforePhone = await lastSeq(env);
    await host.getByRole("button", { name: "Continue with phone number" }).click();
    await sdkPage.waitForURL(url => url.href.startsWith(env.site), { timeout: 30_000 });
    await sdkPage.getByRole("textbox", { name: "Phone number" }).waitFor({ timeout: 30_000 });
    await sleep(500);
    const onPhone = await hostedOffer(sdkPage);
    await shot(env, sdkPage, "auth-flows-direct-phone");
    results.check("Continue with phone number → our page with only the phone field (no email field, no Google or Apple button)", onPhone.phone && !onPhone.email && !onPhone.google && !onPhone.apple, JSON.stringify(onPhone));
    results.check("…empty for the Carbon to type, and nothing sent yet", onPhone.phoneValue.replace(/\D/g, "").replace(/^1$/, "") === "" && (await messagesAfter(env, beforePhone)) === 0, `value "${onPhone.phoneValue}"`);
    // The SDK started as a sign-up (data-intent="signup"): its email button opens the sign-up version.
    await sdkPage.goto(`${env.apps}/interface/?only=sdk&intent=signup`);
    await host.getByRole("button", { name: "Continue with email" }).click({ timeout: 15_000 });
    await sdkPage.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    const signupTitle = await hostedTitle(sdkPage);
    const flow = await readFlow(sdkPage);
    results.check("the SDK with data-intent=\"signup\": Continue with email opens \"Create your Silicon Interface account\" on the email field", signupTitle === "Create your Silicon Interface account" && flow?.intent === "signup" && flow.method_hint === "email", `${signupTitle} | ${flow?.intent} ${flow?.method_hint}`);
    await sdkContext.close();

    // The embed's intent buttons: "Sign in" and "Sign up", and our pages show every method.
    const intentContext = await newContext(browser);
    const intentPage = await intentContext.newPage();
    results.watch(intentPage, "direct-intents");
    const query = new URLSearchParams({ app_id: "interface", redirect_uri: redirectUriOf(env, "interface"), state: randomState(), response_type: "code", buttons: "intents" });
    await intentPage.goto(`${env.site}/embed/v1/buttons?${query.toString()}`);
    const signIn = intentPage.getByRole("link", { name: "Sign in", exact: true });
    const signUp = intentPage.getByRole("link", { name: "Sign up", exact: true });
    const drawn = await signUp.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    results.check("the embed with buttons=intents draws \"Sign in\" and \"Sign up\" (and no method buttons)", drawn && (await signIn.count()) === 1 && (await intentPage.getByRole("link", { name: /^Continue with/ }).count()) === 0, (await intentPage.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 160));
    await shot(env, intentPage, "auth-flows-direct-intents");
    if (drawn) {
      await signUp.click();
      await intentPage.waitForURL(url => url.href.startsWith(`${env.site}/authorize/flow/`), { timeout: 30_000 });
      await intentPage.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
      const title = await hostedTitle(intentPage);
      const offer = await hostedOffer(intentPage);
      results.check("…\"Sign up\" opens the sign-up version with every method of interface", title === "Create your Silicon Interface account" && offer.google && offer.apple && offer.email, `${title} ${JSON.stringify(offer)}`);
    }
    await intentContext.close();
  },
};

export const journeys: Journey[] = [directButtons];

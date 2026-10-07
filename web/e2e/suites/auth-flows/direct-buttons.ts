/**
 * Direct buttons on the app's own website (UNDERSTANDING.md "Adding sign-in to an app", as edited on 2026-10-07): an
 * app can put `Continue with Google`, `Continue with Apple`, `Continue with email`, `Continue with phone number`… on its
 * page, "and we show everything else on our pages accordingly". The iframe and the SDK snippet draw those buttons from
 * the app's configured methods; pressing one lands on our page for exactly that method, where the Carbon types the
 * address (nothing is sent before they press Continue).
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { lastSeq, newContext, shot, sleep } from "../../lib";
import { messagesAfter } from "./_helpers";

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
  title: "interface's own page: the iframe and the SDK draw Continue with Google / Apple / email / phone number; Continue with email lands on our page with only the email field, Continue with phone number with only the phone field, empty for the Carbon to type, nothing sent",
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
    results.check(
      `the iframe's buttons read ${CONTRACT_LABELS.join(", ")} (the contract's words)`,
      CONTRACT_LABELS.every(label => iframeLabels.includes(label)) && iframeLabels.length === CONTRACT_LABELS.length,
      JSON.stringify(iframeLabels),
    );
    const before = await lastSeq(env);
    await frame.getByRole("link", { name: "Continue with email" }).click();
    await page.waitForURL(url => url.href.startsWith(env.site), { timeout: 30_000 });
    await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    await sleep(500);
    const onEmail = await hostedOffer(page);
    await shot(env, page, "auth-flows-direct-email");
    results.check("Continue with email → our page with only the email field (no phone field, no Google or Apple button)", onEmail.email && !onEmail.phone && !onEmail.google && !onEmail.apple, JSON.stringify(onEmail));
    results.check("…empty for the Carbon to type, and nothing sent yet", onEmail.emailValue === "" && (await messagesAfter(env, before)) === 0, `value "${onEmail.emailValue}"`);
    await context.close();

    // The SDK snippet.
    const sdkContext = await newContext(browser);
    const sdkPage = await sdkContext.newPage();
    results.watch(sdkPage, "direct-sdk");
    await sdkPage.goto(`${env.apps}/interface/?only=sdk`);
    const host = sdkPage.locator("#silicon-accounts");
    await host.getByRole("button", { name: "Continue with Google" }).waitFor({ timeout: 15_000 });
    const sdkLabels = (await host.getByRole("button").allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim()).filter(text => text.startsWith("Continue with"));
    results.check(
      `the SDK's buttons read ${CONTRACT_LABELS.join(", ")} (the contract's words)`,
      CONTRACT_LABELS.every(label => sdkLabels.includes(label)) && sdkLabels.length === CONTRACT_LABELS.length,
      JSON.stringify(sdkLabels),
    );
    const beforePhone = await lastSeq(env);
    await host.getByRole("button", { name: /^Continue with phone/ }).click();
    await sdkPage.waitForURL(url => url.href.startsWith(env.site), { timeout: 30_000 });
    await sdkPage.getByRole("textbox", { name: "Phone number" }).waitFor({ timeout: 30_000 });
    await sleep(500);
    const onPhone = await hostedOffer(sdkPage);
    await shot(env, sdkPage, "auth-flows-direct-phone");
    results.check("Continue with phone → our page with only the phone field (no email field, no Google or Apple button)", onPhone.phone && !onPhone.email && !onPhone.google && !onPhone.apple, JSON.stringify(onPhone));
    results.check("…empty for the Carbon to type, and nothing sent yet", onPhone.phoneValue.replace(/\D/g, "") === "" && (await messagesAfter(env, beforePhone)) === 0, `value "${onPhone.phoneValue}"`);
    await sdkContext.close();
  },
};

export const journeys: Journey[] = [directButtons];

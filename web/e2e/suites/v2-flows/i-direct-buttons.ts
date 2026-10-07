/**
 * Direct method buttons on the app's own site (UNDERSTANDING.md "Adding sign-in to an app": "On its own website an app
 * can put direct buttons: Continue with Google, Continue with Apple, Continue with email, Continue with phone number";
 * build spec 06-v2.md §5: email/phone → the hosted page opens straight on that method's entry field, empty).
 *
 * From briefcase's own page (its links), dm's (phone first, yet its email button opens on email), quill-docs' SDK
 * buttons and pixel-studio's iframe: each button opens our page narrowed to that one method, its field empty, with
 * "Other ways to sign in" to see the rest; a sign-in finishes from there. A method the app does not offer is refused
 * before anything starts; an app with one method shows its page as usual.
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { hostedTitle, live, newContext, shot, startAtApp } from "../../lib";
import { backAtApp, button, codeSignIn, freshEmail, settle, waitForDetailsPage, waitForFlow } from "./_helpers";

/** What the methods page offers right now: provider buttons, the email/phone choice, the fields and their values. */
async function offered(page: Page): Promise<{ google: boolean; apple: boolean; choice: boolean; email: string | null; phone: string | null; otherWays: boolean }> {
  await live(page, "main h1").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(400);
  const visible = async (locator: ReturnType<Page["getByRole"]>) => locator.first().isVisible().catch(() => false);
  const email = page.getByRole("textbox", { name: "Email", exact: true });
  const phone = page.getByRole("textbox", { name: "Phone number", exact: true });
  return {
    google: await visible(page.getByRole("button", { name: "Continue with Google", exact: true })),
    apple: await visible(page.getByRole("button", { name: "Continue with Apple", exact: true })),
    choice: await visible(page.getByRole("button", { name: "Phone", exact: true })),
    email: (await visible(email)) ? await email.first().inputValue() : null,
    phone: (await visible(phone)) ? await phone.first().inputValue() : null,
    otherWays: await visible(page.getByRole("button", { name: /^Other ways to sign (in|up)$/ })),
  };
}

export const journey: Journey = {
  name: "v2-flows-direct-buttons",
  title: "an app's own Continue with email / phone number buttons (links, SDK, iframe) open our page on that one method, its field empty, with Other ways to sign in; a sign-in finishes from there; a method the app lacks is refused; one-method apps are unchanged",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "direct", [/status of 400 \(Bad Request\) @ https?:\/\/[^ ]+\/v1\/flows\b/]);

    // briefcase's own page: its buttons, in its method order.
    await page.goto(`${env.apps}/briefcase/`);
    const buttons = await page.locator("#direct-buttons a").evaluateAll(links => links.map(link => `${link.getAttribute("data-method")}:${(link.textContent ?? "").trim()}`));
    results.check("briefcase's own page has its direct buttons in its order: Continue with Google, Apple, email, phone number", JSON.stringify(buttons) === JSON.stringify(["google:Continue with Google", "apple:Continue with Apple", "email:Continue with email", "phone:Continue with phone number"]), JSON.stringify(buttons));

    // Continue with email.
    const emailHref = await startAtApp(env, page, "briefcase", { method: "email" });
    let flow = await waitForFlow(page, f => f.step === "choose_method", "the email page");
    let seen = await offered(page);
    results.check("Continue with email asks method=email, and the flow keeps it as method_hint", emailHref.searchParams.get("method") === "email" && flow.method_hint === "email", `${emailHref.searchParams.get("method")} → ${flow.method_hint}`);
    results.check("…the page opens on the email field alone, empty: no Google or Apple buttons, no Email | Phone choice", seen.email === "" && seen.phone === null && !seen.google && !seen.apple && !seen.choice, JSON.stringify(seen));
    results.check("…with \"Other ways to sign in\"", seen.otherWays, JSON.stringify(seen));
    results.check("…under briefcase's usual title", (await hostedTitle(page)) === "Sign in to Briefcase", await hostedTitle(page));
    await settle(page);
    await shot(env, page, "v2f-i-01-direct-email");
    await page.getByRole("button", { name: "Other ways to sign in" }).click();
    await page.waitForTimeout(500);
    seen = await offered(page);
    results.check("Other ways to sign in shows every method: Google, Apple and the Email | Phone choice", seen.google && seen.apple && seen.choice && !seen.otherWays, JSON.stringify(seen));

    // Continue with phone number.
    const phoneHref = await startAtApp(env, page, "briefcase", { method: "phone" });
    flow = await waitForFlow(page, f => f.step === "choose_method", "the phone page");
    seen = await offered(page);
    results.check("Continue with phone number opens on the phone field alone, empty (method_hint phone)", phoneHref.searchParams.get("method") === "phone" && flow.method_hint === "phone" && seen.phone === "" && seen.email === null && !seen.google && !seen.apple && !seen.choice && seen.otherWays, JSON.stringify(seen));
    await settle(page);
    await shot(env, page, "v2f-i-02-direct-phone");

    // A sign-in finishes from the narrowed page.
    const email = freshEmail("direct");
    await startAtApp(env, page, "briefcase", { method: "email" });
    await codeSignIn(env, page, { email });
    await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
    await waitForDetailsPage(page);
    await button(page, "Share and continue").click();
    const outcome = await backAtApp(env, page, "briefcase");
    results.check("a new Carbon signs up from the email page and briefcase gets them", outcome.account?.email === email, JSON.stringify(outcome.account).slice(0, 200));

    // dm offers phone first; its email button still opens on email.
    await startAtApp(env, page, "dm", { method: "email" });
    flow = await waitForFlow(page, f => f.step === "choose_method", "dm's email page");
    // The browser is signed in now: the page first offers Continue as; Use another account shows the narrowed form.
    await page.getByRole("button", { name: "Use another account" }).click({ timeout: 15_000 });
    await waitForFlow(page, f => f.step === "choose_method" && !(f as { signed_in_as?: unknown }).signed_in_as, "dm's methods without the browser's account");
    seen = await offered(page);
    results.check("dm (phone first) with Continue with email: the email field alone, empty", flow.method_hint === "email" && seen.email === "" && seen.phone === null && !seen.choice && seen.otherWays, JSON.stringify(seen));

    // A method the app does not offer: refused before anything starts.
    await startAtApp(env, page, "dm", { extra: { method: "google" } });
    const back = page.getByRole("link", { name: "Back to the app" });
    const refused = await back.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const backTo = refused ? new URL((await back.getAttribute("href")) ?? "", env.site) : null;
    results.check("method=google on dm (it has no Google): no sign-in starts, \"Back to the app\" with error=invalid_request", refused && backTo?.searchParams.get("error") === "invalid_request" && /method 'google' is not a sign-in method of DM/.test(backTo.searchParams.get("error_description") ?? ""), backTo?.href.slice(0, 240) ?? "no Back to the app");

    // remind has email only: its page is the same with or without method=email.
    await startAtApp(env, page, "remind", { extra: { method: "email" } });
    await page.getByRole("button", { name: "Use another account" }).click({ timeout: 15_000 }).catch(() => undefined);
    seen = await offered(page);
    results.check("remind (email only) with method=email: its usual email page, nothing to narrow, no Other ways", seen.email === "" && !seen.otherWays, JSON.stringify(seen));
    await context.close();

    // quill-docs' SDK buttons (a fresh browser, so the form shows at once).
    {
      const sdkContext = await newContext(browser);
      const sdkPage = await sdkContext.newPage();
      results.watch(sdkPage, "direct-sdk");
      await sdkPage.goto(`${env.apps}/quill-docs/?only=sdk`);
      const sdkButton = sdkPage.locator("#silicon-accounts").getByRole("button", { name: "Continue with email" });
      await sdkButton.waitFor({ timeout: 20_000 });
      const sdkButtons = await sdkPage.locator("#silicon-accounts").getByRole("button").allInnerTexts();
      results.check("quill-docs' SDK draws its methods in its order: Continue with email, Continue with Google", JSON.stringify(sdkButtons.map(text => text.trim())) === JSON.stringify(["Continue with email", "Continue with Google"]), JSON.stringify(sdkButtons));
      await sdkButton.click();
      await sdkPage.waitForURL(url => url.pathname.startsWith("/authorize"), { timeout: 30_000 });
      const sdkFlow = await waitForFlow(sdkPage, f => f.step === "choose_method", "quill-docs' email page");
      const sdkSeen = await offered(sdkPage);
      results.check("…its Continue with email opens our page on the email field alone, empty", sdkFlow.method_hint === "email" && sdkSeen.email === "" && !sdkSeen.google && sdkSeen.otherWays, JSON.stringify(sdkSeen));
      await sdkContext.close();
    }

    // pixel-studio's iframe buttons.
    {
      const frameContext = await newContext(browser);
      const framePage = await frameContext.newPage();
      results.watch(framePage, "direct-iframe");
      await framePage.goto(`${env.apps}/pixel-studio/?only=iframe`);
      const frame = framePage.frameLocator("#signin-iframe");
      const link = frame.getByRole("link", { name: "Continue with email" });
      await link.waitFor({ timeout: 20_000 });
      const labels = await frame.getByRole("link").allInnerTexts();
      results.check("pixel-studio's iframe draws Continue with email, Google and Apple (its order), and Powered by", JSON.stringify(labels.map(text => text.trim()).filter(text => text.startsWith("Continue"))) === JSON.stringify(["Continue with email", "Continue with Google", "Continue with Apple"]) && labels.some(text => text.trim() === "Silicon Accounts"), JSON.stringify(labels));
      await link.click();
      await framePage.waitForURL(url => url.href.startsWith(`${env.site}/authorize`), { timeout: 30_000 });
      const frameFlow = await waitForFlow(framePage, f => f.step === "choose_method", "pixel-studio's email page");
      const frameSeen = await offered(framePage);
      results.check("…its Continue with email takes the whole window to our page on the email field alone, empty", frameFlow.method_hint === "email" && frameFlow.app.app_id === "pixel-studio" && frameSeen.email === "" && !frameSeen.google && !frameSeen.apple && frameSeen.otherWays, JSON.stringify(frameSeen));
      await frameContext.close();
    }
  },
};

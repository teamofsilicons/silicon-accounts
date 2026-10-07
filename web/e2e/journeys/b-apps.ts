import type { Journey } from "../context";
import { appAccount, codeFor, finishSignup, lastSeq, newContext, shot, sleep, tag } from "../lib";

export const journey: Journey = {
  name: "b-apps",
  title: "briefcase's hosted link: email code, sign-up, consent, the app exchanges the code; dm: Continue as + the phone it requires",
  provides: ["brook"],
  async run({ env, results, browser, shared }) {
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "b");
    const email = `brook.${tag()}@example.test`;
    const phone = `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;

    // briefcase: a new Carbon through the hosted pages.
    await page.goto(`${env.apps}/briefcase/`);
    const hosted = page.locator("#signin-hosted");
    const href = (await hosted.getAttribute("href")) ?? "";
    results.check("briefcase's hosted link points at the site's /authorize", href.startsWith(`${env.site}/authorize?`), href.slice(0, 120));
    await hosted.click();
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    await sleep(500);
    await shot(env, page, "b-01-briefcase-methods");
    const buttons = await page.getByRole("button").allInnerTexts();
    results.check("briefcase offers Google and Apple", buttons.some(text => /Google/.test(text)) && buttons.some(text => /Apple/.test(text)));
    let after = await lastSeq(env);
    await field.fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, email, after);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 30 });
    await finishSignup(env, page, "briefcase", "b-02-briefcase");
    await shot(env, page, "b-03-briefcase-signed-in", true);
    const account = await appAccount(page);
    results.check("briefcase shows the account it received", typeof account?.uuid === "string", JSON.stringify(account).slice(0, 200));
    results.check("briefcase received the email (required)", account?.email === email, String(account?.email));
    results.check("the membership id is briefcase:<uuid>", (await page.locator("#membership-id").innerText().catch(() => "")) === `briefcase:${String(account?.uuid)}`);

    // dm: one click as the signed-in Carbon, then the phone dm requires (typed whole, key by key, after "+").
    await page.goto(`${env.apps}/dm/`);
    await page.locator("#signin-hosted").click();
    const continueAs = page.getByRole("button", { name: /^Continue as/ });
    await continueAs.waitFor({ timeout: 30_000 });
    await sleep(400);
    await shot(env, page, "b-04-dm-continue-as");
    results.check("dm offers \"Continue as\" in one click", (await continueAs.count()) === 1);
    await continueAs.click();
    const phoneField = page.getByRole("textbox", { name: "Phone number" });
    await phoneField.waitFor({ timeout: 20_000 });
    results.check("dm's requirement step asks for a phone number", /phone/i.test(await page.locator("main").innerText()));
    after = await lastSeq(env);
    await phoneField.click();
    await page.keyboard.type(phone, { delay: 30 });
    await sleep(300);
    const typed = await phoneField.inputValue();
    results.check("a whole number typed after \"+\" lands in the number field under its country", typed.replace(/\D/g, "") === phone.slice(2), typed);
    await shot(env, page, "b-05-dm-phone");
    await page.getByRole("button", { name: "Send code" }).click();
    const sms = await codeFor(env, phone, after);
    await page.getByRole("group", { name: /Code/ }).first().waitFor({ timeout: 15_000 });
    await page.keyboard.type(sms, { delay: 30 });
    const share = page.getByRole("button", { name: "Share and continue" });
    await share.waitFor({ timeout: 20_000 });
    await share.click();
    await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/dm/`), { timeout: 30_000 });
    const dm = await appAccount(page);
    results.check("dm received the account with its verified phone", dm?.phone === phone, JSON.stringify(dm).slice(0, 200));
    results.check("the same uuid in both apps", dm?.uuid === account?.uuid);

    // briefcase again: continue as goes straight back (nothing new to share).
    const started = Date.now();
    await page.goto(`${env.apps}/briefcase/`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/briefcase/`), { timeout: 30_000 });
    results.check("a second briefcase sign-in: Continue as, and the consent is not asked again", true, `${Date.now() - started} ms`);

    const me = (await (await page.request.get(`${env.site}/v1/me`)).json()) as { id?: string; uuid?: string };
    shared.brook = { email, phone, id: me.id ?? "", uuid: me.uuid ?? String(account?.uuid ?? ""), cookies: await context.cookies() };
    await context.close();
  },
};

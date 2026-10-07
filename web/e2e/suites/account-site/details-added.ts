/**
 * Details a Carbon adds while signing into an app (UNDERSTANDING.md "What's shared with the app": a required detail the
 * Carbon has not set up yet, say their phone number, is added before continuing; 06-v2 §4: added verified, primary if
 * none) are the account's own from then on: the account site lists them on Sign-in methods, on the identity card and
 * in the activity, and /apps shows the app sees exactly what was shared (the optional email left unticked stays
 * private). Both ways round: a Carbon with only an email adds DM's required phone, one with only a phone adds
 * Briefcase's required email.
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { newContext, shot, signInWithCode, sleep, tag, type Env } from "../../lib";
import { call, getMe, newCarbon, probePage, randomPhone, rowByKey, rowsSeen, signIntoAppSeen, timezoneLabel, until, userBaseRow } from "./_helpers";

/** Signs up on the account site's own /sign-in with a phone code (the prefilled sign-up page), ending on the home page. */
async function signUpByPhone(env: Env, page: Page, phone: string): Promise<void> {
  await page.goto(`${env.site}/sign-in`);
  await signInWithCode(env, page, { phone });
  const create = page.getByRole("button", { name: "Create account" });
  await create.waitFor({ timeout: 30_000 });
  await sleep(300);
  await create.click();
  await page.waitForURL(`${env.site}/`, { timeout: 30_000 });
}

/** "1 of 10 phone numbers" from a Sign-in methods section's counter. */
async function counter(page: Page, region: string, plural: string): Promise<string> {
  return (await page.getByRole("region", { name: region, exact: true }).locator(`[aria-label$=" of 10 ${plural}"]`).first().getAttribute("aria-label").catch(() => null)) ?? "none";
}

const addedOnDetails: Journey = {
  name: "account-site-details-added",
  title: "details added while signing into an app are the account's own: DM's required phone added on its page becomes the primary phone on Sign-in methods and the card, a phone-only Carbon's email added on Briefcase's page becomes its primary email, and /apps shows each app exactly what was shared",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();

    // 1. A Carbon with only an email signs into DM, which requires a phone: added on DM's own page with a code.
    const carbon = await newCarbon(ctx, "acct-added-phone");
    const phone = randomPhone();
    const dm = await signIntoAppSeen(env, carbon.page, "dm", { add: { phone }, shotName: "acct-added-01-dm" });
    const setup = dm.walk.pages[0];
    results.check("DM's page asks for the phone it requires, missing on the account, and offers the email unticked", !!setup && setup.rows.some(row => row.field === "phone" && row.mode === "required" && row.missing) && setup.rows.some(row => row.field === "email" && row.mode === "optional" && row.ticked === false), rowsSeen(setup?.rows ?? []));
    results.check("…the phone is added there with a code, and DM gets it (and not the unticked email)", setup?.added.includes("phone") === true && dm.account?.phone === phone && dm.account?.email === undefined, `${JSON.stringify(setup?.added)} ${JSON.stringify({ phone: dm.account?.phone, email: dm.account?.email })}`);
    const me = await getMe(carbon.probe);
    results.check("the account now has the phone, verified and primary (its first)", me.phones.length === 1 && me.phones[0]?.phone === phone && me.phones[0]?.is_primary === true && !!me.phones[0]?.verified_at, JSON.stringify(me.phones));

    const { page } = carbon;
    await page.goto(`${env.site}/sign-in-methods`);
    const phones = page.getByRole("region", { name: "Phone numbers", exact: true });
    await phones.waitFor({ timeout: 30_000 });
    await sleep(700);
    await shot(env, page, "acct-added-02-sign-in-methods", true);
    const phoneRow = (await rowByKey(page, "Your phone numbers", phone).innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("Sign-in methods lists it as the primary phone number (1 of 10)", /Primary/.test(phoneRow) && (await counter(page, "Phone numbers", "phone numbers")) === "1 of 10 phone numbers", `${phoneRow} / ${await counter(page, "Phone numbers", "phone numbers")}`);
    await page.goto(`${env.site}/apps`);
    const dmCard = page.locator("#app-dm");
    await dmCard.waitFor({ timeout: 30_000 });
    await sleep(600);
    const dmText = (await dmCard.innerText()).replace(/\s+/g, " ");
    await shot(env, page, "acct-added-03-apps", true);
    results.check("/apps: DM can see the name and the phone, not the email (left unticked)", dmText.includes("Name, id and photo") && dmText.includes("Phone") && !dmText.includes("Email") && !dmText.includes(carbon.email), dmText.slice(0, 300));
    // An app whose flow spreads its details over pages and a review (Ledgerly: the phone on one page, the date of
    // birth and an optional timezone on the next): /apps shows what all its pages shared together.
    const ledgerly = await signIntoAppSeen(env, page, "ledgerly", { tick: ["timezone"], shotName: "acct-added-03b-ledgerly" });
    results.check("Ledgerly's flow: two details pages and a review, the phone already there (added for DM), the timezone ticked on page 2", ledgerly.walk.pages.length === 2 && !!ledgerly.walk.review && ledgerly.walk.pages[0]?.rows.some(row => row.field === "phone" && !row.missing) === true && ledgerly.walk.pages[1]?.shared.includes("timezone") === true, `${ledgerly.walk.pages.map(seen => `${seen.id}: ${rowsSeen(seen.rows)}`).join(" / ")}; review ${JSON.stringify(ledgerly.walk.review)}`);
    await page.goto(`${env.site}/apps`);
    const ledgerlyCard = page.locator("#app-ledgerly");
    await ledgerlyCard.waitFor({ timeout: 30_000 });
    await sleep(600);
    const ledgerlyText = (await ledgerlyCard.innerText()).replace(/\s+/g, " ");
    const meNow = await getMe(carbon.probe);
    results.check("/apps: Ledgerly can see the name, the phone, the date of birth and the timezone (all its pages), not the email", ["Name, id and photo", "Phone", "Date of birth", "Timezone"].every(label => ledgerlyText.includes(label)) && ledgerlyText.includes(timezoneLabel(meNow.timezone)) && !ledgerlyText.includes("Email"), ledgerlyText.slice(0, 320));
    const ledgerlyRow = await userBaseRow(ctx, "ledgerly", carbon.uuid);
    results.check("…and Ledgerly's user base agrees (phone, dob, timezone; no email)", ledgerlyRow.row?.phone === phone && ledgerlyRow.row.dob === meNow.dob && ledgerlyRow.row.timezone === meNow.timezone && !ledgerlyRow.row.email, JSON.stringify({ phone: ledgerlyRow.row?.phone, dob: ledgerlyRow.row?.dob, timezone: ledgerlyRow.row?.timezone, email: ledgerlyRow.row?.email }));

    const security = (await call<{ items: Array<{ title: string; detail: string | null }> }>(carbon.probe, "/v1/me/history?kind=security&limit=20")).body.items;
    // The account site's own adds read "Phone number +1… added"; one added on an app's page says which number too.
    const addedEntry = security.find(item => /^Phone number .*added/.test(item.title));
    results.check("the activity names the phone added and where: \"Phone number <number> added while signing in to DM\"", addedEntry?.title === `Phone number ${phone} added while signing in to DM`, security.slice(0, 5).map(item => `${item.title}${item.detail ? ` — ${item.detail}` : ""}`).join(" | "));
    await carbon.context.close();

    // 2. A Carbon with only a phone signs into Briefcase, which requires an email: added on Briefcase's page.
    const context = await newContext(ctx.browser);
    const phonePage = await context.newPage();
    results.watch(phonePage, "acct-added-email");
    const ownPhone = randomPhone();
    await signUpByPhone(env, phonePage, ownPhone);
    const probe = await probePage(env, context);
    const before = await getMe(probe);
    results.check("setup: a Carbon signed up on the site with a phone, no email", before.emails.length === 0 && before.phones.some(item => item.phone === ownPhone && item.is_primary), JSON.stringify({ emails: before.emails, phones: before.phones.map(item => item.phone) }));
    await phonePage.goto(`${env.site}/`);
    const front = phonePage.getByRole("region", { name: `Identity card of ${before.id}`, exact: true });
    await front.getByRole("button", { name: "Details" }).click({ timeout: 30_000 });
    const back = phonePage.locator(`section[aria-label="Identity card of ${before.id}, details"]`);
    await sleep(800);
    results.check("the card's back says there is no email yet", (await back.innerText().catch(() => "")).includes("No email yet"));
    const email = `acct.added.${t}@example.test`;
    const briefcase = await signIntoAppSeen(env, phonePage, "briefcase", { add: { email }, shotName: "acct-added-04-briefcase" });
    const share = briefcase.walk.pages[0];
    results.check("Briefcase's page asks for the email it requires, missing on the account", !!share && share.rows.some(row => row.field === "email" && row.mode === "required" && row.missing), rowsSeen(share?.rows ?? []));
    results.check("…the email is added there with a code, and Briefcase gets it", share?.added.includes("email") === true && briefcase.account?.email === email, `${JSON.stringify(share?.added)} ${String(briefcase.account?.email)}`);
    const after = await until(() => getMe(probe), value => value.emails.length === 1, 10_000);
    results.check("the account's first email is verified and primary", after.emails[0]?.email === email && after.emails[0]?.is_primary === true && !!after.emails[0]?.verified_at, JSON.stringify(after.emails));
    await phonePage.goto(`${env.site}/sign-in-methods`);
    await phonePage.getByRole("region", { name: "Emails", exact: true }).waitFor({ timeout: 30_000 });
    await sleep(700);
    const emailRow = (await rowByKey(phonePage, "Your emails", email).innerText().catch(() => "")).replace(/\s+/g, " ");
    await shot(env, phonePage, "acct-added-05-sign-in-methods", true);
    results.check("Sign-in methods lists it as the primary email (1 of 10)", /Primary/.test(emailRow) && (await counter(phonePage, "Emails", "emails")) === "1 of 10 emails", `${emailRow} / ${await counter(phonePage, "Emails", "emails")}`);
    await phonePage.goto(`${env.site}/`);
    await front.getByRole("button", { name: "Details" }).click({ timeout: 30_000 });
    await sleep(800);
    const backText = (await back.innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("…and the card's back shows it, primary", backText.includes(email) && /Primary/.test(backText), backText.slice(0, 240));
    const history = (await call<{ items: Array<{ title: string }> }>(probe, "/v1/me/history?kind=security&limit=20")).body.items.map(item => item.title);
    results.check("the activity names the email added and where: \"Email <address> added while signing in to Briefcase\"", history.includes(`Email ${email} added while signing in to Briefcase`), history.slice(0, 5).join(" | "));
    await context.close();
  },
};

export const journey = addedOnDetails;

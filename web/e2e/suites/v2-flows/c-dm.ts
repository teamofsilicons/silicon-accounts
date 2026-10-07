/**
 * dm's one custom page (build spec 06-v2.md §4, testkit fake-apps.json: one step "dm-setup" titled "Set up DM", with
 * its own subtitle and continue label "Start messaging"; phone required, email and timezone optional).
 *
 * UNDERSTANDING.md "What's shared with the app": a required detail the Carbon has not set up yet, "say their phone
 * number, they must add it before continuing"; optional details come with a checkbox that is "unticked until they do".
 * "The same verification is used whenever an email or phone number is added to an account later on": a 6 digit code,
 * 10 minutes, and "an email or phone number can only ever belong to one account".
 *
 *   1. A Carbon who signed up with a phone: the phone is there, the optional email is missing and offers Add; adding it
 *      with a code makes it part of the account, ticked to share; the timezone stays unticked → dm gets phone + email.
 *   2. A Carbon who signed up with an email: the page says "Set up DM" and opens the phone's adder by itself; Start
 *      messaging without it is stopped on the page and by the API; a phone of another account is refused; a code that
 *      ran out (moved past its 10 minutes in the database) is refused and a new one works; the email the account
 *      already has stays unticked unless ticked → dm gets the phone only.
 */
import type { Journey } from "../../context";
import { POWERED_BY_HREF, codeFor, hostedTitle, lastSeq, live, newContext, poweredBy, shot, sql, startAtApp } from "../../lib";
import { addOnPage, backAtApp, button, codeSentTo, codeSignIn, detailRows, flowApi, flowIdOf, freshEmail, freshPhone, membershipOf, progressText, refusal, sendOnPage, settle, setTicked, typeCode, uuidByEmail, uuidByPhone, waitForDetailsPage } from "./_helpers";

export const journey: Journey = {
  name: "v2-flows-dm-step",
  title: "dm's single custom page (\"Set up DM\", \"Start messaging\"): a required phone added with a code (blocked until then, another account's phone refused, an expired code refused and a new one sent), optional email added and ticked or left unticked, optional timezone unticked unless ticked",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const phoneOfFirst = await freshPhone(env);

    // 1. Signed up with a phone: the optional email is missing; adding it on the page ticks it.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "dm-phone");
      const email = freshEmail("dm-added");
      await startAtApp(env, page, "dm");
      await codeSignIn(env, page, { phone: phoneOfFirst });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      const flow = await waitForDetailsPage(page, { id: "dm-setup" });
      const details = flow.details!;
      const field = (name: string) => details.fields.find(entry => entry.field === name);
      results.check(
        "the server describes dm's one page: id dm-setup, \"Set up DM\", its subtitle, continue label \"Start messaging\", one page, no review",
        details.id === "dm-setup" && details.count === 1 && details.title === "Set up DM" && details.subtitle === "DM needs your phone number. Email and timezone are up to you." && details.continue_label === "Start messaging" && details.review_next === false,
        JSON.stringify({ ...details, fields: undefined, challenge: undefined }),
      );
      results.check("…the phone required and present, the email optional and missing, the timezone optional and not shared", field("phone")?.mode === "required" && field("phone")?.missing === false && field("email")?.mode === "optional" && field("email")?.missing === true && field("email")?.shared === false && field("timezone")?.mode === "optional" && field("timezone")?.shared === false, JSON.stringify(details.fields));
      results.check("the page reads \"Set up DM\" with dm's subtitle, no step count", (await hostedTitle(page)) === "Set up DM" && (await live(page, "main").first().innerText()).includes("DM needs your phone number. Email and timezone are up to you.") && (await progressText(page)) === null);
      const rows = await detailRows(page);
      const row = (name: string) => rows.find(entry => entry.field === name);
      results.check("…the rows in dm's order: profile, phone (Required), email (Optional), timezone (Optional)", JSON.stringify(rows.map(entry => entry.field)) === JSON.stringify(["profile", "phone", "email", "timezone"]) && row("phone")?.tag === "Required" && row("email")?.tag === "Optional" && row("timezone")?.tag === "Optional", JSON.stringify(rows.map(entry => `${entry.field}:${entry.tag}`)));
      results.check("…the missing email says nothing is shared, cannot be ticked and offers Add", row("email")?.missing === true && row("email")?.ticked === false && row("email")?.disabled === true && row("email")?.add === true && /You have not added one, so nothing is shared\./.test(row("email")?.text ?? ""), JSON.stringify(row("email")));
      results.check("…no adder is open (nothing required is missing) and the main button is \"Start messaging\"", !(await live(page, "[data-adding]").first().isVisible().catch(() => false)) && (await button(page, "Start messaging").count()) === 1);
      await settle(page);
      await shot(env, page, "v2f-c-01-dm-phone-account");
      // Add, on the email row: the adder names what it adds.
      await page.getByRole("button", { name: /^Add (a|an|your) email address$/ }).first().click({ timeout: 10_000 });
      const adder = live(page, '[data-adding="email"]').first();
      await adder.waitFor({ timeout: 10_000 });
      const adderTitle = (await adder.locator("p").first().innerText()).trim();
      results.check("the optional email's adder is titled \"Add an email address\"", adderTitle === "Add an email address", `"${adderTitle}"`);
      results.check("…and says the email joins the account, ticked to share (untick to keep it)", /joins your account, ticked to share with DM/.test(await adder.innerText()), (await adder.innerText()).replace(/\s+/g, " ").slice(0, 200));
      await addOnPage(env, page, "email", email);
      const afterAdd = await waitForDetailsPage(page, { id: "dm-setup" });
      const emailNow = afterAdd.details?.fields.find(entry => entry.field === "email");
      results.check("the added email is on the account and starts ticked (server and page)", emailNow?.missing === false && emailNow.shared === true && (await detailRows(page)).find(entry => entry.field === "email")?.ticked === true, JSON.stringify(emailNow));
      results.check("…verified on the account", (await uuidByEmail(env, email)) === (await uuidByPhone(env, phoneOfFirst)));
      await button(page, "Start messaging").click();
      const outcome = await backAtApp(env, page, "dm");
      results.check("dm gets the phone and the added (ticked) email, and no timezone (unticked)", outcome.account?.phone === phoneOfFirst && outcome.account.email === email && outcome.account.timezone === undefined, JSON.stringify(outcome.account).slice(0, 300));
      await context.close();
    }

    // 2. Signed up with an email: the required phone must be added on the page.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      // The refusals the journey asks for: another account's phone (409) and a code past its 10 minutes (410).
      results.watch(page, "dm-email", [refusal(409, "details/add"), refusal(410, "details/verify")]);
      const email = freshEmail("dm-email");
      const phone = await freshPhone(env);
      await startAtApp(env, page, "dm");
      await codeSignIn(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      const flow = await waitForDetailsPage(page, { id: "dm-setup" });
      const id = flowIdOf(page)!;
      const field = (name: string) => flow.details?.fields.find(entry => entry.field === name);
      results.check("the phone is required and missing; the email (the account has one) optional and not shared", field("phone")?.missing === true && field("email")?.missing === false && field("email")?.shared === false, JSON.stringify(flow.details?.fields));
      const adder = live(page, '[data-adding="phone"]').first();
      results.check("the phone's adder opens by itself: \"Add your phone number\"", (await adder.isVisible()) && /Add your phone number/.test(await adder.innerText()));
      const emailRow = (await detailRows(page)).find(entry => entry.field === "email");
      results.check("the email row is an unticked optional checkbox showing the masked address", emailRow?.mode === "optional" && emailRow.ticked === false && emailRow.disabled === false && /\*/.test(emailRow.text), JSON.stringify(emailRow));
      const powered = await poweredBy(page);
      results.check("the page keeps \"Powered by Silicon Accounts\"", powered.href === POWERED_BY_HREF && powered.atEnd, JSON.stringify(powered));
      await settle(page);
      await shot(env, page, "v2f-c-02-dm-email-account");

      await button(page, "Start messaging").click();
      results.check("Start messaging without a phone: \"DM needs your phone number on your account to continue. Add it above.\"", await page.getByText("DM needs your phone number on your account to continue. Add it above.").first().waitFor({ timeout: 5_000 }).then(() => true, () => false));
      const api = await flowApi(env, page, id, "/details/continue", { share: ["email"] }, ctx.ip);
      results.check("API: continuing without the phone → 409 requirements_missing [phone]", api.status === 409 && api.body.error?.code === "requirements_missing" && JSON.stringify(api.body.error.details?.missing) === JSON.stringify(["phone"]), `${api.status} ${JSON.stringify(api.body).slice(0, 200)}`);

      // A phone that belongs to another account is refused (one account per phone number).
      await sendOnPage(env, page, "phone", phoneOfFirst);
      const inUse = live(page, '[data-adding="phone"]').first();
      const refused = await inUse.getByText(/already|another account|belongs/i).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      results.check("a phone of another account is refused under the field (phone_in_use) and no code is sent", refused && (await flowApi(env, page, id, "", undefined, ctx.ip)).body.flow?.details?.challenge === null, (await inUse.innerText()).replace(/\s+/g, " ").slice(0, 300));
      const apiInUse = await flowApi(env, page, id, "/details/add", { phone: phoneOfFirst }, ctx.ip);
      results.check("API: details/add with that phone → 409 phone_in_use", apiInUse.status === 409 && apiInUse.body.error?.code === "phone_in_use", `${apiInUse.status} ${JSON.stringify(apiInUse.body).slice(0, 200)}`);

      // A code that ran out: refused, and a new one works.
      await sendOnPage(env, page, "phone", phone);
      const stale = await codeSentTo(env, phone);
      await sql(env, `update otp_challenges set expires_at = now() - interval '1 second' where destination = '${phone}' and purpose = 'requirement' and consumed_at is null`);
      await typeCode(page, stale);
      const expired = await page.getByText("Codes work for 10 minutes, and a newer code replaces the one before it. Send a new code.").first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      results.check("a code past its 10 minutes is refused: \"Codes work for 10 minutes…\" and the phone is not added", expired && (await detailRows(page)).find(entry => entry.field === "phone")?.missing === true);
      const resend = page.getByRole("button", { name: "Send a new code" });
      results.check("…the page offers \"Send a new code\"", await resend.first().waitFor({ timeout: 5_000 }).then(() => true, () => false));
      const beforeResend = await lastSeq(env);
      await resend.first().click();
      const fresh = await codeFor(env, phone, beforeResend);
      await page.getByText("New code sent").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
      await typeCode(page, fresh);
      await live(page, '[data-field="phone"]:not([data-missing])').first().waitFor({ timeout: 15_000 });
      const added = await waitForDetailsPage(page, { id: "dm-setup" });
      results.check("the new code adds the phone: no longer missing, and the email still unticked", added.details?.fields.find(entry => entry.field === "phone")?.missing === false && added.details.fields.find(entry => entry.field === "email")?.shared === false && (await detailRows(page)).find(entry => entry.field === "email")?.ticked === false, JSON.stringify(added.details?.fields));
      await button(page, "Start messaging").click();
      const outcome = await backAtApp(env, page, "dm");
      results.check("dm gets the phone only: the email and the timezone stayed unticked", outcome.account?.phone === phone && outcome.account.email === undefined && outcome.account.timezone === undefined, JSON.stringify(outcome.account).slice(0, 300));
      const uuid = await uuidByEmail(env, email);
      const membership = uuid ? await membershipOf(env, "dm", uuid) : null;
      results.check("…the membership grants phone + profile", JSON.stringify(membership?.scopes) === JSON.stringify(["phone", "profile"]), JSON.stringify(membership));
      await context.close();
    }

    // 3. A third Carbon, on a phone-sized screen, ticks only the timezone.
    {
      const context = await newContext(browser, { width: 390, height: 844 });
      const page = await context.newPage();
      results.watch(page, "dm-timezone");
      const phone = await freshPhone(env);
      await startAtApp(env, page, "dm");
      await codeSignIn(env, page, { phone });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      await waitForDetailsPage(page, { id: "dm-setup" });
      await settle(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const powered = await poweredBy(page);
      results.check("at 390 px dm's page fits the width (no sideways scroll) and ends with Powered by Silicon Accounts", overflow <= 0 && powered.atEnd && powered.href === POWERED_BY_HREF, `overflow ${overflow}px ${JSON.stringify(powered)}`);
      await shot(env, page, "v2f-c-03-dm-390", true);
      await setTicked(page, "timezone", true);
      await button(page, "Start messaging").click();
      const outcome = await backAtApp(env, page, "dm");
      results.check("ticking only the timezone: dm gets the phone and the timezone, no email", outcome.account?.phone === phone && outcome.account.timezone === "Asia/Kolkata" && outcome.account.email === undefined, JSON.stringify(outcome.account).slice(0, 300));
      await context.close();
    }
  },
};

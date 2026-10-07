/**
 * Returning Carbons (UNDERSTANDING.md "What's shared with the app": "We show it the first time a Carbon signs into an
 * app and again whenever the app asks for more"; build spec 06-v2.md §4: "returning Carbons with everything already
 * granted skip straight to complete").
 *
 * briefcase (one page): a Carbon who shared everything continues straight back to the app; when briefcase starts
 * requiring the date of birth, they see the page again with only that marked new and their earlier choice kept; when
 * it adds an optional detail, it is asking for more too; prompt=consent shows the page again; removing briefcase's
 * access makes the next sign-in a first one again.
 *
 * ledgerly (two pages and a review): a returning Carbon skips every page with nothing new; when ledgerly adds a
 * required detail to its second page, only that page shows (with the review); prompt=consent walks both pages again
 * with the earlier choices ticked.
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { hostedTitle, newContext, signInWithCode, startAtApp, type Env } from "../../lib";
import { addOnPage, appErrorPage, backAtApp, button, detailRows, freshEmail, freshPhone, membershipOf, progressText, reviewFields, setTicked, uuidByEmail, waitForDetailsPage, waitForReviewPage, withConfig, type AppOutcome } from "./_helpers";

/** From the app's own sign-in link (with `extra` query parameters): "Continue as …", then what the server answered. */
async function continueAs(env: Env, page: Page, app: string, extra?: Record<string, string>): Promise<{ step: string | null }> {
  await startAtApp(env, page, app, extra ? { extra } : {});
  const answered = page.waitForResponse(response => response.request().method() === "POST" && /\/v1\/flows\/[^/]+\/continue$/.test(new URL(response.url()).pathname), { timeout: 30_000 });
  await page.getByRole("button", { name: /^Continue as / }).click({ timeout: 30_000 });
  const body = (await (await answered).json().catch(() => null)) as { flow?: { step?: string } } | null;
  return { step: body?.flow?.step ?? null };
}

const returning: Journey = {
  name: "v2-flows-returning",
  title: "a returning Carbon at briefcase: nothing new → straight back to the app; briefcase now requires the date of birth → the page again with only it marked new; an added optional detail → shown again; prompt=consent → shown again with earlier choices; access removed → a first sign-in again",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "returning", [appErrorPage("briefcase")]);
    const email = freshEmail("returning");

    // First sign-in: the Carbon shares the timezone too.
    await startAtApp(env, page, "briefcase");
    await signInWithCode(env, page, { email });
    await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
    await waitForDetailsPage(page);
    await setTicked(page, "timezone", true);
    await button(page, "Share and continue").click();
    const first = await backAtApp(env, page, "briefcase");
    const uuid = (await uuidByEmail(env, email))!;
    results.check("first sign-in: briefcase gets the email and the timezone", first.account?.email === email && first.account.timezone === "Asia/Kolkata", JSON.stringify(first.account).slice(0, 200));

    // Nothing new: Continue as goes straight back.
    const again = await continueAs(env, page, "briefcase");
    const second = await backAtApp(env, page, "briefcase");
    results.check("signing in again with nothing new: Continue as completes at once (no details page)", again.step === "complete" && second.account?.uuid === uuid && second.account.timezone === "Asia/Kolkata", `${again.step} ${JSON.stringify(second.account).slice(0, 160)}`);

    // prompt=none (an app checking silently): nothing new, so it signs in without a page.
    await startAtApp(env, page, "briefcase", { extra: { prompt: "none" } });
    const silent = await backAtApp(env, page, "briefcase");
    results.check("prompt=none with nothing new: signed in silently, no page", silent.account?.uuid === uuid, JSON.stringify(silent).slice(0, 200));

    // briefcase now requires the date of birth: the page again, only the date of birth new.
    await withConfig(ctx, "briefcase", { required_fields: ["email", "dob"] }, async () => {
      await startAtApp(env, page, "briefcase", { extra: { prompt: "none" } });
      const blocked = await backAtApp(env, page, "briefcase");
      results.check("prompt=none once briefcase asks for more: back at briefcase with error=consent_required (a page would be needed)", blocked.error === "consent_required" && new URL(blocked.url).searchParams.get("error") === "consent_required", blocked.url.slice(0, 200));
      const asked = await continueAs(env, page, "briefcase");
      const flow = await waitForDetailsPage(page);
      const fields = flow.details?.fields ?? [];
      const by = (name: string) => fields.find(entry => entry.field === name);
      results.check("briefcase requiring the date of birth: Continue as now stops on the details page", asked.step === "details" && flow.details?.count === 1, `${asked.step} ${JSON.stringify(flow.details).slice(0, 200)}`);
      results.check("…the server marks the email and timezone as granted before and the date of birth as new, the timezone still shared", by("email")?.previously_granted === true && by("timezone")?.previously_granted === true && by("timezone")?.shared === true && by("dob")?.previously_granted === false && by("dob")?.mode === "required", JSON.stringify(fields));
      const title = await hostedTitle(page);
      const rows = await detailRows(page);
      results.check("…the page reads \"Briefcase would like a little more\"", title === "Briefcase would like a little more", title);
      results.check("…only the date of birth carries the New badge; the timezone is ticked as before", rows.find(row => row.field === "dob")?.isNew === true && rows.filter(row => row.isNew).length === 1 && rows.find(row => row.field === "timezone")?.ticked === true, JSON.stringify(rows.map(row => `${row.field}:${row.isNew ? "new" : ""}:${row.ticked}`)));
      await button(page, "Share and continue").click();
      const more: AppOutcome = await backAtApp(env, page, "briefcase");
      results.check("…continuing shares the date of birth (and keeps email and timezone)", typeof more.account?.dob === "string" && more.account.email === email && more.account.timezone === "Asia/Kolkata", JSON.stringify(more.account).slice(0, 240));
      const membership = await membershipOf(env, "briefcase", uuid);
      results.check("…the membership now grants dob too", JSON.stringify(membership?.scopes) === JSON.stringify(["dob", "email", "profile", "timezone"]), JSON.stringify(membership));
    });

    // briefcase asks for one more optional detail (the phone): that is asking for more as well.
    await withConfig(ctx, "briefcase", { optional_fields: ["timezone", "phone"] }, async () => {
      const asked = await continueAs(env, page, "briefcase");
      results.check(
        "briefcase adding an optional detail (phone) is asking for more: the returning Carbon sees the page again (UNDERSTANDING: \"again whenever the app asks for more\")",
        asked.step === "details",
        `the sign-in went to "${asked.step}"${asked.step === "complete" ? ": straight back to briefcase without showing the new optional phone (crates/auth flow/details.rs needs_carbon only re-asks for new required details or scope-asked ones)" : ""}`,
      );
      if (asked.step === "details") {
        const flow = await waitForDetailsPage(page);
        const phone = flow.details?.fields.find(entry => entry.field === "phone");
        results.check("…with the new optional phone unticked (and missing: this Carbon has no phone)", phone?.mode === "optional" && phone.shared === false, JSON.stringify(phone));
        await button(page, "Share and continue").click();
      }
      await backAtApp(env, page, "briefcase");
    });

    // prompt=consent: the page again, with what was shared before ticked.
    const consent = await continueAs(env, page, "briefcase", { prompt: "consent" });
    const consentFlow = await waitForDetailsPage(page);
    const consentRows = await detailRows(page);
    results.check("prompt=consent shows the page again", consent.step === "details" && consentFlow.details?.count === 1, `${consent.step}`);
    results.check("…everything previously granted, the timezone ticked as before, no New badge, the usual title", (consentFlow.details?.fields ?? []).every(entry => entry.previously_granted) && consentRows.find(row => row.field === "timezone")?.ticked === true && consentRows.every(row => !row.isNew) && (await hostedTitle(page)) === "Share your details with Briefcase", `${await hostedTitle(page)} ${JSON.stringify(consentRows.map(row => `${row.field}:${row.ticked}:${row.isNew}`))}`);
    await setTicked(page, "timezone", false);
    await button(page, "Share and continue").click();
    const untick = await backAtApp(env, page, "briefcase");
    results.check("…unticking the timezone there stops sharing it", untick.account?.timezone === undefined && !(await membershipOf(env, "briefcase", uuid))?.scopes.includes("timezone"), JSON.stringify(untick.account).slice(0, 200));

    // Access removed on the account: the next sign-in is a first one again.
    const removed = await page.request.delete(`${env.site}/v1/me/apps/briefcase`, { headers: { origin: env.site } });
    results.check("the Carbon removes briefcase's access (DELETE /v1/me/apps/briefcase → 204)", removed.status() === 204, `${removed.status()} ${(await removed.text()).slice(0, 200)}`);
    const back = await continueAs(env, page, "briefcase");
    const backFlow = await waitForDetailsPage(page);
    results.check("…the next sign-in shows the page again, nothing granted any more (optional details unticked)", back.step === "details" && (backFlow.details?.fields ?? []).every(entry => !entry.previously_granted) && (await detailRows(page)).find(row => row.field === "timezone")?.ticked === false, `${back.step} ${JSON.stringify(backFlow.details?.fields).slice(0, 300)}`);
    await button(page, "Share and continue").click();
    await backAtApp(env, page, "briefcase");
    results.check("…and continuing makes the membership active again", (await membershipOf(env, "briefcase", uuid))?.status === "active");
    await context.close();
  },
};

const returningSteps: Journey = {
  name: "v2-flows-returning-steps",
  title: "a returning Carbon at ledgerly (two pages + review): nothing new → no page; a required detail added to page 2 → only page 2 (and the review); prompt=consent → both pages again with the earlier choices",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "returning-steps");
    const email = freshEmail("returning-steps");
    const phone = await freshPhone(env);

    await startAtApp(env, page, "ledgerly");
    await signInWithCode(env, page, { email });
    await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
    await waitForDetailsPage(page, { id: "contact" });
    await addOnPage(env, page, "phone", phone);
    await button(page, "Continue").click();
    await waitForDetailsPage(page, { id: "about-you" });
    await setTicked(page, "timezone", true);
    await button(page, "Review").click();
    await waitForReviewPage(page);
    await button(page, "Share and continue").click();
    const first = await backAtApp(env, page, "ledgerly");
    const uuid = (await uuidByEmail(env, email))!;
    results.check("first sign-in at ledgerly: phone, dob and the ticked timezone", first.account?.phone === phone && typeof first.account.dob === "string" && first.account.timezone === "Asia/Kolkata", JSON.stringify(first.account).slice(0, 240));

    const again = await continueAs(env, page, "ledgerly");
    await backAtApp(env, page, "ledgerly");
    results.check("signing in again with nothing new: no page, no review (complete at once)", again.step === "complete", String(again.step));

    // ledgerly starts requiring the email: it joins its last page, so only that page shows, then the review.
    await withConfig(ctx, "ledgerly", { required_fields: ["phone", "dob", "email"] }, async () => {
      const asked = await continueAs(env, page, "ledgerly");
      const flow = await waitForDetailsPage(page);
      const details = flow.details!;
      results.check("ledgerly requiring the email: the sign-in skips page 1 (nothing new) and shows page 2 alone", asked.step === "details" && details.id === "about-you" && details.index === 0 && details.count === 1, `${asked.step} ${JSON.stringify({ ...details, fields: undefined, challenge: undefined })}`);
      const rows = await detailRows(page);
      results.check("…the email on it marked New, the timezone still ticked, no \"Step n of m\" for one page", rows.find(row => row.field === "email")?.isNew === true && rows.find(row => row.field === "timezone")?.ticked === true && (await progressText(page)) === null, `${await progressText(page)} ${JSON.stringify(rows.map(row => `${row.field}:${row.isNew}:${row.ticked}`))}`);
      results.check("…it still leads to the review (\"Review\")", details.review_next === true && (await button(page, "Review").count()) === 1);
      await button(page, "Review").click();
      await waitForReviewPage(page);
      results.check("…the review lists profile, phone, dob, timezone and the email", JSON.stringify(await reviewFields(page)) === JSON.stringify(["profile", "phone", "dob", "timezone", "email"]), JSON.stringify(await reviewFields(page)));
      await button(page, "Share and continue").click();
      const more = await backAtApp(env, page, "ledgerly");
      results.check("…ledgerly now gets the email too", more.account?.email === email, JSON.stringify(more.account).slice(0, 240));
    });

    // prompt=consent walks every page again, with the earlier answers.
    const consent = await continueAs(env, page, "ledgerly", { prompt: "consent" });
    const one = await waitForDetailsPage(page, { id: "contact" });
    results.check("prompt=consent: page 1 of 2 again", consent.step === "details" && one.details?.index === 0 && one.details.count === 2 && (await progressText(page)) === "Step 1 of 2", `${consent.step} ${await progressText(page)}`);
    await button(page, "Continue").click();
    const two = await waitForDetailsPage(page, { id: "about-you" });
    results.check("…page 2 of 2 with the timezone ticked as before", two.details?.fields.find(entry => entry.field === "timezone")?.shared === true && (await detailRows(page)).find(row => row.field === "timezone")?.ticked === true);
    await button(page, "Review").click();
    await waitForReviewPage(page);
    await button(page, "Share and continue").click();
    await backAtApp(env, page, "ledgerly");
    const after = await membershipOf(env, "ledgerly", uuid);
    results.check("…and the membership still grants phone, dob and the timezone", ["dob", "phone", "profile", "timezone"].every(scope => after?.scopes.includes(scope)), JSON.stringify(after));
    await context.close();
  },
};

export const journeys: Journey[] = [returning, returningSteps];

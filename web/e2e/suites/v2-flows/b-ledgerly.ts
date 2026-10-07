/**
 * ledgerly's own flow (UNDERSTANDING.md "Flows": an app decides which pages a Carbon goes through, in what order, and
 * which details are asked on which page; build spec 06-v2.md §4): two pages and a review page.
 *
 *   contact   (phone, required)                       "How can we reach you?"  card layout (the branding's)
 *   about-you (dob required, timezone optional)        "About you", "Review"    its own split layout
 *   review                                             "Check what Ledgerly sees"
 *
 * The journey walks it as a new Carbon from ledgerly's "Create an account" button and checks every page as drawn and
 * as the server describes it, the API's refusals on each page (a required phone still missing, a detail of another
 * page, going back from the first page, approving before the review), Back in both directions keeping the Carbon's
 * choices, and that the app gets exactly profile + required + ticked optional details.
 */
import type { Journey } from "../../context";
import { POWERED_BY_HREF, hostedTitle, live, newContext, poweredBy, shot, signInWithCode, startAtApp } from "../../lib";
import { addOnPage, backAtApp, button, detailRows, drawnLayout, flowApi, flowIdOf, freshEmail, freshPhone, membershipOf, progressText, reviewFields, setTicked, uuidByEmail, waitForDetailsPage, waitForReviewPage } from "./_helpers";

export const journey: Journey = {
  name: "v2-flows-ledgerly-steps",
  title: "ledgerly's 2-page flow + review as a new Carbon: each page's title, subtitle, step count, continue label and layout; the required phone added on page 1 with a code; the API refuses what a page cannot do; Back and forward keep the optional timezone's state; the review lists exactly what is shared",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "ledgerly");
    const email = freshEmail("ledgerly");
    const phone = await freshPhone(env);

    await startAtApp(env, page, "ledgerly", { intent: "signup" });
    await signInWithCode(env, page, { email });
    await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });

    // Page 1 of 2: contact.
    const one = await waitForDetailsPage(page, { id: "contact" });
    const id = flowIdOf(page)!;
    const d1 = one.details!;
    results.check(
      "page 1 as the server says: index 0 of 2, id contact, its title and subtitle, no continue label or layout of its own, no review next",
      d1.index === 0 && d1.count === 2 && d1.title === "How can we reach you?" && d1.subtitle === "We text you when an invoice is paid." && d1.continue_label === null && d1.layout === null && d1.review_next === false,
      JSON.stringify({ ...d1, fields: undefined, challenge: undefined }),
    );
    results.check("…its one detail: the phone, required and missing", d1.fields.length === 1 && d1.fields[0]?.field === "phone" && d1.fields[0].mode === "required" && d1.fields[0].missing === true, JSON.stringify(d1.fields));
    const title1 = await hostedTitle(page);
    const main1 = (await live(page, "main").first().innerText()).replace(/\s+/g, " ");
    results.check("page 1 reads \"How can we reach you?\" with its subtitle and \"Step 1 of 2\"", title1 === "How can we reach you?" && main1.includes("We text you when an invoice is paid.") && (await progressText(page)) === "Step 1 of 2", `${title1} | ${await progressText(page)} | ${main1.slice(0, 200)}`);
    results.check("…drawn in the branding's card layout", (await drawnLayout(page)) === "card", String(await drawnLayout(page)));
    const rows1 = await detailRows(page);
    results.check("…the profile first, then the phone: Required, missing, being added below", rows1[0]?.field === "profile" && rows1[1]?.field === "phone" && rows1[1].mode === "required" && rows1[1].missing && rows1[1].tag === "Required", JSON.stringify(rows1));
    results.check("…its adder open by itself (\"Add your phone number\")", await live(page, '[data-adding="phone"]').first().isVisible() && /Add your phone number/.test(await live(page, '[data-adding="phone"]').first().innerText()));
    results.check("…the first page offers Continue and Cancel (no Back) and the account with \"Switch account\"", (await button(page, "Continue").count()) === 1 && (await button(page, "Cancel").count()) === 1 && (await button(page, "Back").count()) === 0 && (await page.getByRole("button", { name: "Switch account" }).count()) === 1);
    await shot(env, page, "v2f-b-01-contact");

    // Continue with the phone still missing: the page says what is needed without asking the server…
    await button(page, "Continue").click();
    const blocked = page.getByText("Ledgerly needs your phone number on your account to continue. Add it above.");
    results.check("Continue with the required phone missing says \"Ledgerly needs your phone number on your account to continue. Add it above.\"", await blocked.first().waitFor({ timeout: 5_000 }).then(() => true, () => false));
    results.check("…and stays on page 1", (await waitForDetailsPage(page, { id: "contact" })).details?.index === 0);
    // …and the API refuses what page 1 cannot do.
    const missing = await flowApi(env, page, id, "/details/continue", { share: [] }, ctx.ip);
    results.check("API: continuing page 1 without the phone → 409 requirements_missing (details.missing [phone], the hint naming details/add)", missing.status === 409 && missing.body.error?.code === "requirements_missing" && JSON.stringify(missing.body.error.details?.missing) === JSON.stringify(["phone"]) && /details\/add/.test(missing.body.error.hint ?? ""), `${missing.status} ${JSON.stringify(missing.body).slice(0, 300)}`);
    const otherPage = await flowApi(env, page, id, "/details/continue", { share: ["timezone"] }, ctx.ip);
    results.check("API: sharing the timezone from page 1 (it is on page 2) → 422 on share[0]", otherPage.status === 422 && typeof otherPage.body.error?.details?.fields?.["share[0]"] === "string", `${otherPage.status} ${JSON.stringify(otherPage.body).slice(0, 300)}`);
    const unknown = await flowApi(env, page, id, "/details/continue", { share: ["shoe_size"] }, ctx.ip);
    results.check("API: sharing a detail that does not exist → 422 on share[0]", unknown.status === 422 && typeof unknown.body.error?.details?.fields?.["share[0]"] === "string", `${unknown.status} ${JSON.stringify(unknown.body).slice(0, 300)}`);
    const firstBack = await flowApi(env, page, id, "/details/back", {}, ctx.ip);
    results.check("API: Back on the first page → 409 no_previous_page", firstBack.status === 409 && firstBack.body.error?.code === "no_previous_page", `${firstBack.status} ${JSON.stringify(firstBack.body).slice(0, 200)}`);
    const early = await flowApi(env, page, id, "/review", { approve: true }, ctx.ip);
    results.check("API: approving before the review page → 409 invalid_step", early.status === 409 && early.body.error?.code === "invalid_step", `${early.status} ${JSON.stringify(early.body).slice(0, 200)}`);
    const wrongDetail = await flowApi(env, page, id, "/details/add", { email: freshEmail("ledgerly-other") }, ctx.ip);
    results.check("API: adding an email on page 1 (ledgerly never asks for one) → 409 detail_not_on_page", wrongDetail.status === 409 && wrongDetail.body.error?.code === "detail_not_on_page", `${wrongDetail.status} ${JSON.stringify(wrongDetail.body).slice(0, 200)}`);

    // The phone, added right there with a code.
    await addOnPage(env, page, "phone", phone);
    const added = await waitForDetailsPage(page, { id: "contact" });
    results.check("the phone is added on page 1 (verified, masked on the page) and the page stays until Continue", added.details?.fields[0]?.missing === false && /\*/.test(added.details.fields[0].value ?? ""), JSON.stringify(added.details?.fields));
    let clicked = Date.now();
    await button(page, "Continue").click();

    // Page 2 of 2: about-you, in its own split layout.
    const two = await waitForDetailsPage(page, { id: "about-you" });
    results.metric("Continue on page 1 → page 2 drawn", Date.now() - clicked);
    const d2 = two.details!;
    results.check(
      "page 2 as the server says: index 1 of 2, id about-you, \"About you\", its subtitle, continue label \"Review\", layout split, review next",
      d2.index === 1 && d2.count === 2 && d2.title === "About you" && d2.subtitle === "Your date of birth keeps your tax year right." && d2.continue_label === "Review" && d2.layout === "split" && d2.review_next === true,
      JSON.stringify({ ...d2, fields: undefined, challenge: undefined }),
    );
    const rows2 = await detailRows(page);
    const row2 = (field: string) => rows2.find(entry => entry.field === field);
    results.check("page 2 reads \"About you\", \"Step 2 of 2\", drawn in the split layout", (await hostedTitle(page)) === "About you" && (await progressText(page)) === "Step 2 of 2" && (await drawnLayout(page)) === "split", `${await hostedTitle(page)} | ${await progressText(page)} | ${await drawnLayout(page)}`);
    results.check("…no profile row or account here (page 1 showed them), the date of birth Required, the timezone Optional and unticked", !row2("profile") && (await page.getByRole("button", { name: "Switch account" }).count()) === 0 && row2("dob")?.tag === "Required" && row2("timezone")?.mode === "optional" && row2("timezone")?.ticked === false, JSON.stringify(rows2));
    results.check("…it offers Review, Back and \"Cancel signing in\"", (await button(page, "Review").count()) === 1 && (await button(page, "Back").count()) === 1 && (await button(page, "Cancel signing in").count()) === 1);
    await shot(env, page, "v2f-b-02-about-you-split");

    // Untouched timezone → the review lists profile, phone and date of birth only.
    clicked = Date.now();
    await button(page, "Review").click();
    const review1 = await waitForReviewPage(page);
    results.metric("Review on page 2 → review page drawn", Date.now() - clicked);
    results.check("Review with the timezone unticked: \"Check what Ledgerly sees\" lists profile, phone, dob (no timezone)", (await hostedTitle(page)) === "Check what Ledgerly sees" && JSON.stringify(await reviewFields(page)) === JSON.stringify(["profile", "phone", "dob"]) && JSON.stringify(review1.review?.fields.map(field => field.field)) === JSON.stringify(["profile", "phone", "dob"]), `${await hostedTitle(page)} | ${JSON.stringify(await reviewFields(page))} | ${JSON.stringify(review1.review)}`);
    results.check("…with Share and continue, Back and Cancel signing in", (await button(page, "Share and continue").count()) === 1 && (await button(page, "Back").count()) === 1 && (await button(page, "Cancel signing in").count()) === 1);
    const powered = await poweredBy(page);
    results.check("…and Powered by Silicon Accounts", powered.href === POWERED_BY_HREF && powered.atEnd, JSON.stringify(powered));
    await shot(env, page, "v2f-b-03-review-without-timezone");

    // Back keeps the choice (unticked), then the Carbon ticks it and reviews again.
    await button(page, "Back").click();
    let back = await waitForDetailsPage(page, { id: "about-you" });
    results.check("Back from the review → page 2 with the timezone still unticked (server and page)", back.details?.fields.find(field => field.field === "timezone")?.shared === false && (await detailRows(page)).find(entry => entry.field === "timezone")?.ticked === false);
    await setTicked(page, "timezone", true);
    await button(page, "Review").click();
    await waitForReviewPage(page);
    results.check("ticked, the review now lists the timezone too", JSON.stringify(await reviewFields(page)) === JSON.stringify(["profile", "phone", "dob", "timezone"]), JSON.stringify(await reviewFields(page)));
    await button(page, "Back").click();
    back = await waitForDetailsPage(page, { id: "about-you" });
    results.check("Back again → page 2 with the timezone ticked (the choice kept)", back.details?.fields.find(field => field.field === "timezone")?.shared === true && (await detailRows(page)).find(entry => entry.field === "timezone")?.ticked === true);
    await button(page, "Back").click();
    const backToOne = await waitForDetailsPage(page, { id: "contact" });
    results.check("Back from page 2 → page 1 (\"Step 1 of 2\", the phone now there)", backToOne.details?.index === 0 && backToOne.details.fields[0]?.missing === false && (await progressText(page)) === "Step 1 of 2", JSON.stringify(backToOne.details?.fields));
    await button(page, "Continue").click();
    const forward = await waitForDetailsPage(page, { id: "about-you" });
    results.check("Continue → page 2 again, the timezone still ticked", forward.details?.fields.find(field => field.field === "timezone")?.shared === true && (await detailRows(page)).find(entry => entry.field === "timezone")?.ticked === true);

    // The Carbon changes their mind: unticked, reviewed, approved.
    await setTicked(page, "timezone", false);
    await button(page, "Review").click();
    await waitForReviewPage(page);
    results.check("unticked again, the review leaves the timezone out", JSON.stringify(await reviewFields(page)) === JSON.stringify(["profile", "phone", "dob"]), JSON.stringify(await reviewFields(page)));
    clicked = Date.now();
    await button(page, "Share and continue").click();
    const outcome = await backAtApp(env, page, "ledgerly");
    results.metric("Share and continue on the review → signed in at the app (code exchanged)", Date.now() - clicked);
    results.check("ledgerly gets the phone and the date of birth, no timezone (unticked) and no email (never asked)", outcome.account?.phone === phone && typeof outcome.account.dob === "string" && outcome.account.timezone === undefined && outcome.account.email === undefined, JSON.stringify(outcome.account).slice(0, 300));
    results.check("…its token's scope is profile, phone and dob", ["profile", "phone", "dob"].every(scope => outcome.scope.includes(scope)) && !outcome.scope.includes("timezone") && !outcome.scope.includes("email"), outcome.scope.join(" "));
    const uuid = await uuidByEmail(env, email);
    const membership = uuid ? await membershipOf(env, "ledgerly", uuid) : null;
    results.check("…and the membership grants exactly dob, phone and profile", membership?.status === "active" && JSON.stringify(membership.scopes) === JSON.stringify(["dob", "phone", "profile"]), JSON.stringify(membership));
    await context.close();
  },
};

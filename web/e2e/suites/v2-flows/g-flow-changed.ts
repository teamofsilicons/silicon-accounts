/**
 * The app changes its flow while a Carbon is signing in (build spec 06-v2.md §4; crates/auth flow/details.rs: a page
 * that no longer exists answers 409 `flow_changed`, and the next read of the flow moves it to its next page; a required
 * detail that appears meanwhile sends the flow back to that detail's page with 409 `requirements_missing`).
 *
 *   A. On ledgerly's page 2 the app renames that page (new id, new title): Review → the page the flow is on now.
 *   B. On page 2 the app drops its own flow (flow: null): a reload shows the one default page.
 *   C. On the review page the app starts requiring an email the Carbon does not have: Share and continue → back to
 *      the page that now asks for it, with the reason, and adding it there finishes the sign-in.
 *
 * Every change is put back afterwards (the whole sign-in setup is restored).
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { hostedTitle, live, newContext, shot, signInWithCode, startAtApp, type Env } from "../../lib";
import { addOnPage, backAtApp, button, detailRows, drawnLayout, flowApi, flowIdOf, freshEmail, freshPhone, patchConfig, appDetails, restoreConfig, refusal, reviewFields, settle, waitForDetailsPage, waitForReviewPage } from "./_helpers";

const FLOW_STEPS = [
  { id: "contact", fields: ["phone"], title: "How can we reach you?", subtitle: "We text you when an invoice is paid.", continue_label: null, layout: null },
  { id: "about-again", fields: ["dob", "timezone"], title: "About you, again", subtitle: "The app changed this page while you were signing in.", continue_label: "Review", layout: "minimal" },
];

/** A Carbon on ledgerly's page 2 (signed up with an email, the phone added on page 1). */
async function toPageTwo(env: Env, page: Page, email: string, phone: string): Promise<string> {
  await startAtApp(env, page, "ledgerly");
  await signInWithCode(env, page, { email });
  await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
  await waitForDetailsPage(page, { id: "contact" });
  await addOnPage(env, page, "phone", phone);
  await button(page, "Continue").click();
  await waitForDetailsPage(page, { id: "about-you" });
  return flowIdOf(page)!;
}

export const journey: Journey = {
  name: "v2-flows-flow-changed",
  title: "ledgerly changes its flow mid-sign-in: a renamed page → 409 flow_changed and the page it is on now; the flow dropped → the default page after a reload; an email required at the review → back to its page, added there, then done",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const before = (await appDetails(ctx, "ledgerly")).signin_config;
    try {
      // A. The page on screen is renamed.
      {
        const context = await newContext(browser);
        const page = await context.newPage();
        results.watch(page, "changed-renamed", [refusal(409, "details/continue")]);
        const id = await toPageTwo(env, page, freshEmail("changed-a"), await freshPhone(env));
        const patched = await patchConfig(ctx, "ledgerly", { flow: { steps: FLOW_STEPS, review: true } });
        results.check("(setup) ledgerly renames its page 2 to \"about-again\"", patched.status === 200, `${patched.status} ${JSON.stringify(patched.body).slice(0, 200)}`);
        const stale = await flowApi(env, page, id, "/details/continue", { share: [] }, ctx.ip);
        results.check("API: continuing the page that is gone → 409 flow_changed", stale.status === 409 && stale.body.error?.code === "flow_changed", `${stale.status} ${JSON.stringify(stale.body).slice(0, 240)}`);
        // The page's own Review, then its own re-read of the flow (polling the flow meanwhile would itself move the
        // flow on to its next page, racing the click: the continue names no page, so it would continue that one).
        const continued = page.waitForResponse(response => response.request().method() === "POST" && /\/v1\/flows\/[^/]+\/details\/continue$/.test(new URL(response.url()).pathname), { timeout: 30_000 });
        const reread = page.waitForResponse(response => response.request().method() === "GET" && /^\/v1\/flows\/[^/]+$/.test(new URL(response.url()).pathname), { timeout: 30_000 });
        await button(page, "Review").click();
        const pressed = await continued;
        results.check("pressing Review on the page that is gone: the page's continue is answered 409 flow_changed", pressed.status() === 409, `${pressed.status()} ${(await pressed.text()).slice(0, 160)}`);
        await reread;
        const now = await waitForDetailsPage(page, { id: "about-again" });
        results.check("…and the page then shows the page the flow is on now (\"About you, again\", page 2 of 2)", now.details?.index === 1 && now.details.count === 2 && (await hostedTitle(page)) === "About you, again", `${await hostedTitle(page)} ${JSON.stringify({ ...now.details, fields: undefined })}`);
        results.check("…drawn in that page's own minimal layout", now.details?.layout === "minimal" && (await drawnLayout(page)) === "minimal", `${now.details?.layout} drawn ${await drawnLayout(page)}`);
        const alert = (await live(page, 'main [role="alert"]').allInnerTexts().catch(() => [] as string[])).join(" | ").replace(/\s+/g, " ");
        results.check(
          "…and tells the Carbon why the page changed under them (the 409 flow_changed has Carbon words: \"This sign-in moved on\")",
          /moved on|changed/i.test(alert),
          alert || "no alert on the page: the new page replaced the one the Carbon pressed Review on without a word",
        );
        if (alert) results.check("…without blaming another tab (the app changed its sign-in)", !/another tab/i.test(alert), alert);
        await settle(page);
        await shot(env, page, "v2f-g-01-renamed-page");
        await button(page, "Review").click();
        await waitForReviewPage(page);
        await button(page, "Share and continue").click();
        const outcome = await backAtApp(env, page, "ledgerly");
        results.check("…continuing through the renamed page signs in (phone and dob shared)", !!outcome.account?.phone && typeof outcome.account.dob === "string", JSON.stringify(outcome.account).slice(0, 200));
        await restoreConfig(ctx, "ledgerly", before);
        await context.close();
      }

      // B. The app drops its own flow: a reload of the page shows the one default page.
      {
        const context = await newContext(browser);
        const page = await context.newPage();
        results.watch(page, "changed-dropped");
        await toPageTwo(env, page, freshEmail("changed-b"), await freshPhone(env));
        const patched = await patchConfig(ctx, "ledgerly", { flow: null });
        results.check("(setup) ledgerly drops its own flow (flow: null)", patched.status === 200 && (patched.body.signin_config?.flow ?? null) === null, `${patched.status} ${JSON.stringify(patched.body.signin_config?.flow ?? patched.body).slice(0, 200)}`);
        await page.reload();
        const now = await waitForDetailsPage(page, { id: "details" });
        const rows = await detailRows(page);
        results.check("after a reload the sign-in is on the default page: one page with phone, dob and timezone, no review", now.details?.count === 1 && now.details.review_next === false && JSON.stringify(rows.map(row => row.field).filter(field => field !== "profile")) === JSON.stringify(["phone", "dob", "timezone"]), `${JSON.stringify({ ...now.details, fields: undefined })} ${JSON.stringify(rows.map(row => row.field))}`);
        results.check("…continuing with \"Share and continue\"", (await button(page, "Share and continue").count()) === 1);
        await button(page, "Share and continue").click();
        const outcome = await backAtApp(env, page, "ledgerly");
        results.check("…signs in without a review page", !!outcome.account?.phone && typeof outcome.account.dob === "string", JSON.stringify(outcome.account).slice(0, 200));
        await restoreConfig(ctx, "ledgerly", before);
        await context.close();
      }

      // C. A required email appears while the Carbon is on the review page.
      {
        const context = await newContext(browser);
        const page = await context.newPage();
        results.watch(page, "changed-required", [refusal(409, "review")]);
        const phone = await freshPhone(env);
        // A Carbon who signed up with the phone (no email on the account).
        await startAtApp(env, page, "ledgerly");
        await signInWithCode(env, page, { phone });
        await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
        await waitForDetailsPage(page, { id: "contact" });
        await button(page, "Continue").click();
        await waitForDetailsPage(page, { id: "about-you" });
        await button(page, "Review").click();
        await waitForReviewPage(page);
        const patched = await patchConfig(ctx, "ledgerly", { required_fields: ["phone", "dob", "email"] });
        results.check("(setup) ledgerly starts requiring an email (it joins its last page)", patched.status === 200, `${patched.status}`);
        await button(page, "Share and continue").click();
        const back = await waitForDetailsPage(page, { id: "about-you" });
        const email = back.details?.fields.find(field => field.field === "email");
        results.check("Share and continue → back on page 2, which now asks for the missing email (required)", email?.mode === "required" && email.missing === true, JSON.stringify(back.details?.fields));
        const alert = (await live(page, 'main [role="alert"]').allInnerTexts().catch(() => [] as string[])).join(" | ").replace(/\s+/g, " ");
        results.check("…saying why: \"One more detail is needed\" (Ledgerly needs your email address)", /One more detail is needed/.test(alert) && /email address/.test(alert), alert || "no alert on the page");
        await settle(page);
        await shot(env, page, "v2f-g-02-required-at-review");
        const added = freshEmail("changed-c");
        await addOnPage(env, page, "email", added);
        await button(page, "Review").click();
        await waitForReviewPage(page);
        results.check("…added there, the review lists the email too", (await reviewFields(page)).includes("email"), JSON.stringify(await reviewFields(page)));
        await button(page, "Share and continue").click();
        const outcome = await backAtApp(env, page, "ledgerly");
        results.check("…and ledgerly gets it", outcome.account?.email === added && outcome.account.phone === phone, JSON.stringify(outcome.account).slice(0, 200));
        await restoreConfig(ctx, "ledgerly", before);
        await context.close();
      }
    } finally {
      await restoreConfig(ctx, "ledgerly", before);
    }
  },
};

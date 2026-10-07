/**
 * Cancelling from the details pages and the review (build spec 06-v2.md §4: "A Carbon can also cancel from any details
 * step with POST /v1/flows/{id}/review {"approve": false}"; false → redirect with error=access_denied).
 *
 * Three places to cancel: the only page of briefcase ("Cancel"), page 2 of ledgerly ("Cancel signing in"), ledgerly's
 * review ("Cancel signing in"). Each sends the browser back to the app's redirect URI with error=access_denied and the
 * app's own state, grants nothing (no membership), and ends the flow (it answers its end, refuses further steps). The
 * Carbon can start again and is asked again.
 */
import type { Journey } from "../../context";
import { newContext, signInWithCode, startAtApp } from "../../lib";
import { addOnPage, appErrorPage, backAtApp, button, flowApi, flowIdOf, freshEmail, freshPhone, membershipOf, uuidByEmail, waitForDetailsPage, waitForReviewPage } from "./_helpers";

export const journey: Journey = {
  name: "v2-flows-cancel",
  title: "Cancel on briefcase's only page, on ledgerly's page 2 and on its review: back at the app with error=access_denied and its state, no membership, the flow ended; starting again asks again",
  async run(ctx) {
    const { env, results, browser } = ctx;

    // 1. briefcase's only page: Cancel.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "cancel-briefcase", [appErrorPage("briefcase")]);
      const email = freshEmail("cancel");
      const started = await startAtApp(env, page, "briefcase");
      const state = started.searchParams.get("state");
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      await waitForDetailsPage(page);
      const id = flowIdOf(page)!;
      await button(page, "Cancel").click();
      const outcome = await backAtApp(env, page, "briefcase");
      const url = new URL(outcome.url);
      results.check("Cancel on briefcase's page → back at briefcase's redirect URI with error=access_denied", outcome.error === "access_denied" && url.pathname.endsWith("/briefcase/callback") && url.searchParams.get("error") === "access_denied", outcome.url.slice(0, 200));
      results.check("…carrying briefcase's own state and an error_description", url.searchParams.get("state") === state && !!url.searchParams.get("error_description"), `state ${url.searchParams.get("state")?.slice(0, 10)}… vs ${state?.slice(0, 10)}…, description "${url.searchParams.get("error_description")}"`);
      const uuid = await uuidByEmail(env, email);
      results.check("…the account exists (the sign-up was done) but briefcase got no membership", !!uuid && (await membershipOf(env, "briefcase", uuid!)) === null, String(uuid));
      const ended = await flowApi(env, page, id, "", undefined, ctx.ip);
      const endedFlow = ended.body.flow as { step?: string; redirect_to?: string | null } | undefined;
      results.check("…the flow answers that it ended: step complete, redirect_to the access_denied redirect", ended.status === 200 && endedFlow?.step === "complete" && /error=access_denied/.test(endedFlow.redirect_to ?? ""), `${ended.status} ${JSON.stringify(ended.body).slice(0, 300)}`);
      const after = await flowApi(env, page, id, "/details/continue", { share: [] }, ctx.ip);
      results.check("…and refuses another step (409)", after.status === 409, `${after.status} ${JSON.stringify(after.body).slice(0, 200)}`);

      // Starting again: asked again (still a first sign-in to briefcase).
      await startAtApp(env, page, "briefcase");
      await page.getByRole("button", { name: /^Continue as / }).click({ timeout: 30_000 });
      const again = await waitForDetailsPage(page);
      results.check("starting again from briefcase: Continue as, then the page again (nothing was granted)", again.details?.count === 1 && (again.details.fields ?? []).every(field => !field.previously_granted), JSON.stringify(again.details?.fields).slice(0, 300));
      await button(page, "Share and continue").click();
      const signed = await backAtApp(env, page, "briefcase");
      results.check("…and this time briefcase gets the email", signed.account?.email === email, JSON.stringify(signed.account).slice(0, 200));
      await context.close();
    }

    // 2. ledgerly's page 2: "Cancel signing in".
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "cancel-ledgerly-page", [appErrorPage("ledgerly")]);
      const email = freshEmail("cancel-page2");
      const started = await startAtApp(env, page, "ledgerly");
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      await waitForDetailsPage(page, { id: "contact" });
      await addOnPage(env, page, "phone", await freshPhone(env));
      await button(page, "Continue").click();
      await waitForDetailsPage(page, { id: "about-you" });
      await button(page, "Cancel signing in").click();
      const outcome = await backAtApp(env, page, "ledgerly");
      const url = new URL(outcome.url);
      results.check("\"Cancel signing in\" on ledgerly's page 2 → access_denied with ledgerly's state", outcome.error === "access_denied" && url.searchParams.get("state") === started.searchParams.get("state"), outcome.url.slice(0, 200));
      const uuid = await uuidByEmail(env, email);
      results.check("…no ledgerly membership (the phone added on page 1 stays on the account)", !!uuid && (await membershipOf(env, "ledgerly", uuid!)) === null);
      await context.close();
    }

    // 3. ledgerly's review: "Cancel signing in".
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "cancel-ledgerly-review", [appErrorPage("ledgerly")]);
      const email = freshEmail("cancel-review");
      await startAtApp(env, page, "ledgerly");
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      await waitForDetailsPage(page, { id: "contact" });
      await addOnPage(env, page, "phone", await freshPhone(env));
      await button(page, "Continue").click();
      await waitForDetailsPage(page, { id: "about-you" });
      await button(page, "Review").click();
      await waitForReviewPage(page);
      await button(page, "Cancel signing in").click();
      const outcome = await backAtApp(env, page, "ledgerly");
      results.check("\"Cancel signing in\" on ledgerly's review → access_denied", outcome.error === "access_denied", outcome.url.slice(0, 200));
      const uuid = await uuidByEmail(env, email);
      results.check("…and no ledgerly membership", !!uuid && (await membershipOf(env, "ledgerly", uuid!)) === null);
      await context.close();
    }
  },
};

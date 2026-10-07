/**
 * A sign-in that runs out while the Carbon is on a details page (a flow stays open 60 minutes; the database moves this
 * one past its end instead of waiting). The hosted page says so and offers "Start again", which starts the same
 * sign-in again (the app's state and PKCE are still waiting on its side): the browser is signed in by then, so it is
 * Continue as and the app's pages again, and the app gets its sign-in with its original state.
 */
import type { Journey } from "../../context";
import { hostedTitle, live, newContext, shot, signInWithCode, sql, startAtApp } from "../../lib";
import { addOnPage, backAtApp, button, flowIdOf, freshEmail, freshPhone, refusal, settle, waitForDetailsPage, waitForReviewPage } from "./_helpers";

export const journey: Journey = {
  name: "v2-flows-expired",
  title: "a sign-in that runs out on ledgerly's page 2 (moved past its 60 minutes in the database): \"This sign-in expired\" with Start again, which brings back ledgerly's pages and finishes the sign-in with the app's own state",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "expired", [refusal(410, "details/continue"), refusal(404, "details/continue"), /status of 410 \(Gone\) @ https?:\/\/[^ ]+\/v1\/flows\/[^/ ]+$/]);
    const email = freshEmail("expired");
    const phone = await freshPhone(env);

    const started = await startAtApp(env, page, "ledgerly");
    await signInWithCode(env, page, { email });
    await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
    await waitForDetailsPage(page, { id: "contact" });
    await addOnPage(env, page, "phone", phone);
    await button(page, "Continue").click();
    await waitForDetailsPage(page, { id: "about-you" });
    const id = flowIdOf(page)!;
    await sql(env, `update signin_flows set expires_at = now() - interval '1 second' where id = '${id}'`);

    await button(page, "Review").click();
    const expired = await page.getByRole("heading", { name: "This sign-in expired" }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const text = (await live(page, "main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("Review after the sign-in ran out: \"This sign-in expired\", saying a sign-in stays open for 60 minutes", expired && /60 minutes/.test(text), text.slice(0, 240));
    const again = page.getByRole("button", { name: "Start again" });
    results.check("…with \"Start again\" (this tab remembers how the sign-in started)", (await again.count()) === 1);
    await settle(page);
    await shot(env, page, "v2f-e-01-expired");
    await again.click();
    await page.waitForURL(url => url.pathname.startsWith("/authorize/flow/") && !url.pathname.endsWith(id), { timeout: 30_000 });
    results.check("Start again opens a new sign-in for ledgerly", flowIdOf(page) !== id && (await hostedTitle(page)).length > 0, `${page.url().slice(0, 100)} "${await hostedTitle(page)}"`);
    await page.getByRole("button", { name: /^Continue as / }).click({ timeout: 30_000 });
    const one = await waitForDetailsPage(page, { id: "contact" });
    results.check("…the browser is signed in (Continue as) and ledgerly's pages come back from page 1, the phone already there", one.details?.count === 2 && one.details.fields[0]?.missing === false, JSON.stringify(one.details?.fields));
    await button(page, "Continue").click();
    await waitForDetailsPage(page, { id: "about-you" });
    await button(page, "Review").click();
    await waitForReviewPage(page);
    await button(page, "Share and continue").click();
    const outcome = await backAtApp(env, page, "ledgerly");
    const callbackState = new URL(page.url()).searchParams.get("state");
    results.check("…and ledgerly gets the sign-in on its own state (the one its link started with)", outcome.account?.phone === phone && (callbackState === null || callbackState === started.searchParams.get("state")), `${JSON.stringify(outcome.account).slice(0, 160)} state ${callbackState?.slice(0, 8)}`);
    await context.close();
  },
};

/**
 * The hosted pages when a sign-in can't go on: past its 60 minutes (time travel) it says so and starts again, opened in
 * another browser it says to finish where it started, an unknown flow id says it has ended. Two sign-ins open in one
 * browser stay usable side by side (one binding cookie for both).
 */
import type { Journey } from "../../context";
import { newContext, shot, sleep, sql } from "../../lib";
import { Browserish, brief, startSignIn } from "./_helpers";

const hostedProblems: Journey = {
  name: "auth-flows-hosted-problems",
  title: "hosted problem pages: a flow past 60 minutes (time travel) → \"This sign-in expired\" and Start again works; the flow's link in another browser → \"Finish signing in where you started\"; an unknown flow → \"This sign-in has ended\"; two open sign-ins in one browser both work",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const expectedErrors = [/status of 410 .*\/v1\/flows\//, /status of 403 .*\/v1\/flows\//, /status of 404 .*\/v1\/flows\//];

    // Expired.
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "hosted-problems", expectedErrors);
    await page.goto(`${env.apps}/briefcase/`);
    await page.locator("#signin-hosted").click();
    await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    const flowUrl = page.url();
    const flowId = new URL(flowUrl).pathname.split("/").pop() ?? "";
    await sql(env, `update signin_flows set expires_at = now() - interval '1 second' where id = '${flowId}'`);
    await page.reload();
    const expired = page.getByRole("heading", { name: "This sign-in expired" });
    await expired.waitFor({ timeout: 20_000 }).catch(() => undefined);
    await sleep(300);
    await shot(env, page, "auth-flows-hosted-problems-01-expired");
    results.check("a flow past its 60 minutes (time travel) → \"This sign-in expired\" (flow_expired)", (await expired.isVisible()) && (await page.locator("[data-problem]").getAttribute("data-problem")) === "flow_expired");
    await page.getByRole("button", { name: "Start again" }).click({ timeout: 10_000 });
    await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    const restarted = new URL(page.url()).pathname.split("/").pop() ?? "";
    results.check("\"Start again\" opens a new flow for the same app (the methods again)", restarted !== flowId && /\/authorize\/flow\//.test(page.url()), page.url());

    // The same flow link opened by another browser.
    const other = await newContext(browser);
    const stranger = await other.newPage();
    results.watch(stranger, "hosted-problems-other", expectedErrors);
    await stranger.goto(page.url());
    const notBound = stranger.getByRole("heading", { name: "Finish signing in where you started" });
    await notBound.waitFor({ timeout: 20_000 }).catch(() => undefined);
    await sleep(300);
    await shot(env, stranger, "auth-flows-hosted-problems-02-other-browser");
    results.check("the flow's link in another browser → \"Finish signing in where you started\" (flow_not_bound), no methods", (await notBound.isVisible()) && (await stranger.getByRole("textbox", { name: "Email" }).count()) === 0);

    // An unknown flow id.
    await stranger.goto(`${env.site}/authorize/flow/AAAAAAAAAAAAAAAAAAAAAA`);
    const ended = stranger.getByRole("heading", { name: "This sign-in has ended" });
    await ended.waitFor({ timeout: 20_000 }).catch(() => undefined);
    results.check("an unknown flow id → \"This sign-in has ended\" (flow_not_found)", await ended.isVisible());
    await other.close();
    await context.close();

    // Two sign-ins open in one browser: one binding cookie, both usable.
    const b = new Browserish(env, ctx.ip);
    const first = await startSignIn(b, "briefcase");
    const cookieAfterFirst = b.jar.get("sa_flow");
    const second = await startSignIn(b, "commit");
    results.check("a second flow in the same browser keeps the same sa_flow binding cookie", !!cookieAfterFirst && b.jar.get("sa_flow") === cookieAfterFirst);
    const readFirst = await b.flow(first.flow.id);
    const readSecond = await b.flow(second.flow.id);
    results.check("…and both flows stay readable (200) in that browser", readFirst.status === 200 && readSecond.status === 200, `${brief(readFirst).slice(0, 40)} / ${brief(readSecond).slice(0, 40)}`);
  },
};

export const journeys: Journey[] = [hostedProblems];

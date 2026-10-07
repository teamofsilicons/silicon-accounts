/**
 * Intents: an app starts a sign-in as a sign-in or as a sign-up (UNDERSTANDING.md "Adding sign-in to an app": an app
 * "can just have a Sign in and a Sign up button, and we show everything else on our pages accordingly"; build spec
 * 06-v2.md §5: `/authorize` accepts intent=signin|signup (default signin), the pages show the sign-in or the sign-up
 * version (title, copy, button labels), and the account logic is unchanged: a first time is a sign-up either way).
 *
 * briefcase (its own sign-up title), commit (none: "Create your Commit account"), acme-notes (its own titles, split
 * layout: the label beside the form and the hero follow the intent), a direct method button with intent=signup, the
 * account site's own sign-in, a returning Carbon arriving through a Sign up button (signed in, no second account), a
 * new address arriving through a Sign in button (signed up), and an intent the API does not know (refused, with the
 * way back to the app).
 */
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { hostedTitle, live, newContext, shot, signInWithCode, startAtApp, sql } from "../../lib";
import { backAtApp, button, freshEmail, settle, waitForDetailsPage, waitForFlow } from "./_helpers";

/** What the methods page shows: its heading, the paragraph under it, the email/phone group's name, the split label. */
async function methodsPage(page: Page): Promise<{ title: string; subtitle: string; group: string | null; splitLabel: string; hero: string; tab: string; otherWays: string | null }> {
  const title = await hostedTitle(page);
  await sleepUntilHydrated(page);
  const read = await page.evaluate(() => {
    const heading = [...document.querySelectorAll("main h1")].find(element => !element.closest("[data-step-leaving]"));
    const block = heading?.parentElement;
    const subtitle = block?.querySelector("h1 + p")?.textContent?.trim() ?? "";
    const label = block?.querySelector('p[aria-hidden="true"]')?.textContent?.trim() ?? "";
    const hero = document.querySelector(".sa-brand-title")?.textContent?.trim() ?? "";
    const other = [...document.querySelectorAll("main button")].find(element => !element.closest("[data-step-leaving]") && /^Other ways to sign (in|up)$/.test((element.textContent ?? "").trim()));
    return { subtitle, splitLabel: label, hero, tab: document.title, otherWays: other?.textContent?.trim() ?? null };
  });
  const named = async (name: string) => (await page.getByRole("group", { name, exact: true }).count()) > 0;
  const group = (await named("Sign up with")) ? "Sign up with" : (await named("Sign in with")) ? "Sign in with" : null;
  return { ...read, title, group };
}

/** The hosted card renders after hydration; wait for its step to be interactive. */
async function sleepUntilHydrated(page: Page): Promise<void> {
  await live(page, "main h1").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(300);
}

export const journey: Journey = {
  name: "v2-flows-intents",
  title: "intent=signin|signup: the sign-in and the sign-up versions of the methods page (titles, subtitles, labels, tab title, hero), defaults without the app's own copy, with a direct button; a Sign up button for an existing account signs in, a Sign in button for a new address signs up; an unknown intent is refused with the way back",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "intents", [/status of 400 \(Bad Request\) @ https?:\/\/[^ ]+\/v1\/flows\b/]);

    // briefcase: its sign-in and sign-up pages.
    const signinHref = await startAtApp(env, page, "briefcase");
    let flow = await waitForFlow(page, f => f.step === "choose_method", "briefcase's methods page");
    let seen = await methodsPage(page);
    results.check("briefcase's sign-in link carries no intent and the flow says intent signin", !signinHref.searchParams.has("intent") && flow.intent === "signin", `${signinHref.search.slice(0, 80)} → ${flow.intent}`);
    results.check("the sign-in page: \"Sign in to Briefcase\", briefcase's subtitle, \"Sign in with\"", seen.title === "Sign in to Briefcase" && seen.subtitle === "Your files, for every Carbon and Silicon." && seen.group === "Sign in with", JSON.stringify(seen));
    results.check("…and the browser tab says \"Sign in to Briefcase · Silicon Accounts\" (flow-page.tsx sets it from the app's title)", seen.tab === "Sign in to Briefcase · Silicon Accounts", `tab: "${seen.tab}"`);
    const signupHref = await startAtApp(env, page, "briefcase", { intent: "signup" });
    flow = await waitForFlow(page, f => f.step === "choose_method", "briefcase's sign-up page");
    seen = await methodsPage(page);
    results.check("briefcase's \"Create an account\" link asks intent=signup and the flow says so", signupHref.searchParams.get("intent") === "signup" && flow.intent === "signup", `${signupHref.searchParams.get("intent")} → ${flow.intent}`);
    results.check("the sign-up page: briefcase's own sign-up title \"Create your Briefcase account\", \"Sign up with\"", seen.title === "Create your Briefcase account" && seen.group === "Sign up with", JSON.stringify(seen));
    results.check("…and the browser tab says \"Create your Briefcase account · Silicon Accounts\" (not the sign-in tab)", seen.tab === "Create your Briefcase account · Silicon Accounts", `tab: "${seen.tab}"`);
    await page.reload();
    await waitForFlow(page, f => f.step === "choose_method", "briefcase's sign-up page, reloaded");
    await page.waitForTimeout(800);
    results.check("(after a reload of the same page the tab does say \"Create your Briefcase account · Silicon Accounts\")", (await page.title()) === "Create your Briefcase account · Silicon Accounts", `tab after reload: "${await page.title()}"`);
    results.check("…without the sign-in subtitle (briefcase has no sign-up subtitle)", seen.subtitle !== "Your files, for every Carbon and Silicon.", JSON.stringify(seen.subtitle));
    await settle(page);
    await shot(env, page, "v2f-h-01-briefcase-signup");

    // commit has no sign-up copy of its own: the default sign-up title.
    await startAtApp(env, page, "commit", { intent: "signup" });
    await waitForFlow(page, f => f.step === "choose_method", "commit's sign-up page");
    seen = await methodsPage(page);
    results.check("commit without its own sign-up title: \"Create your Commit account\"", seen.title === "Create your Commit account" && seen.group === null, JSON.stringify(seen));

    // acme-notes, split layout: the label beside the form and the hero follow the intent.
    await startAtApp(env, page, "acme-notes");
    await waitForFlow(page, f => f.step === "choose_method", "acme-notes' sign-in page");
    const acmeIn = await methodsPage(page);
    results.check("acme-notes' sign-in page: \"Welcome back to Acme Notes\", the split label \"Sign in\", the hero the same title", acmeIn.title === "Welcome back to Acme Notes" && acmeIn.splitLabel === "Sign in" && acmeIn.hero === "Welcome back to Acme Notes", JSON.stringify(acmeIn));
    await startAtApp(env, page, "acme-notes", { intent: "signup" });
    await waitForFlow(page, f => f.step === "choose_method", "acme-notes' sign-up page");
    const acmeUp = await methodsPage(page);
    results.check("acme-notes' sign-up page: \"Start your Acme notebook\", the split label \"Sign up\", the hero the same", acmeUp.title === "Start your Acme notebook" && acmeUp.splitLabel === "Sign up" && acmeUp.hero === "Start your Acme notebook", JSON.stringify(acmeUp));
    await settle(page);
    await shot(env, page, "v2f-h-02-acme-signup-split");

    // ledgerly has a sign-up subtitle of its own: each version keeps its own subtitle.
    await startAtApp(env, page, "ledgerly", { intent: "signup" });
    await waitForFlow(page, f => f.step === "choose_method" && f.intent === "signup", "ledgerly's sign-up page");
    const ledgerlyUp = await methodsPage(page);
    results.check("ledgerly's sign-up page: \"Create your Ledgerly account\" with its own sign-up subtitle \"Bookkeeping for freelancers, set up in two steps.\"", ledgerlyUp.title === "Create your Ledgerly account" && ledgerlyUp.subtitle === "Bookkeeping for freelancers, set up in two steps." && ledgerlyUp.group === "Sign up with", JSON.stringify(ledgerlyUp));
    await startAtApp(env, page, "ledgerly");
    await waitForFlow(page, f => f.step === "choose_method" && f.intent === "signin", "ledgerly's sign-in page");
    const ledgerlyIn = await methodsPage(page);
    results.check("…and its sign-in page: \"Sign in to Ledgerly\" with the sign-in subtitle, \"Sign in with\"", ledgerlyIn.title === "Sign in to Ledgerly" && ledgerlyIn.subtitle === "We need your phone and date of birth to keep your books safe." && ledgerlyIn.group === "Sign in with", JSON.stringify(ledgerlyIn));

    // A direct method button with the sign-up intent: the email field alone, "Other ways to sign up".
    await startAtApp(env, page, "briefcase", { extra: { method: "email", intent: "signup" } });
    flow = await waitForFlow(page, f => f.step === "choose_method", "briefcase's email sign-up page");
    seen = await methodsPage(page);
    const fields = await live(page, "main input").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).name || input.getAttribute("aria-label") || (input as HTMLInputElement).type));
    results.check("method=email&intent=signup: the sign-up title over the email field alone, with \"Other ways to sign up\"", flow.method_hint === "email" && flow.intent === "signup" && seen.title === "Create your Briefcase account" && seen.otherWays === "Other ways to sign up" && (await page.getByRole("button", { name: "Continue with Google", exact: true }).count()) === 0, `${JSON.stringify(seen)} inputs ${JSON.stringify(fields)}`);

    // The account site's own sign-in has a sign-up version too.
    await page.goto(`${env.site}/sign-in?intent=signup`);
    const ownTitle = await hostedTitle(page);
    results.check("the account site's /sign-in?intent=signup: \"Create your account\"", ownTitle === "Create your account", ownTitle);

    // The account logic does not change: a new address through Sign in signs up…
    const email = freshEmail("intent");
    await startAtApp(env, page, "briefcase");
    await signInWithCode(env, page, { email });
    const signup = await page.getByRole("button", { name: "Create account" }).waitFor({ timeout: 25_000 }).then(() => true, () => false);
    results.check("a new address through the Sign in button gets the sign-up step (Create account)", signup);
    await page.getByRole("button", { name: "Create account" }).click();
    await waitForDetailsPage(page);
    await button(page, "Share and continue").click();
    const first = await backAtApp(env, page, "briefcase");

    // …and an existing account through Sign up signs in (no sign-up step, no second account).
    const fresh = await newContext(browser);
    const other = await fresh.newPage();
    results.watch(other, "intents-existing");
    await startAtApp(env, other, "briefcase", { intent: "signup" });
    await signInWithCode(env, other, { email });
    const back = await backAtApp(env, other, "briefcase", 30_000);
    results.check("the same address through the Sign up button (another browser) signs in: no sign-up step, the same account", back.account?.uuid === first.account?.uuid && !!back.account, `${JSON.stringify(back.account).slice(0, 160)}`);
    const accounts = await sql(env, `select count(*) from account_emails where email = '${email}'`);
    results.check("…and no second account was made", accounts[0]?.[0] === "1", `accounts with that email: ${accounts[0]?.[0]}`);
    await fresh.close();

    // An intent the API does not know: refused before anything starts, with the way back to the app.
    await startAtApp(env, page, "briefcase", { extra: { intent: "register" } });
    const problem = page.getByRole("link", { name: "Back to the app" });
    const offered = await problem.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const backTo = offered ? new URL((await problem.getAttribute("href")) ?? "", env.site) : null;
    const pageText = (await live(page, "main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("intent=register: no sign-in starts; the page says the app's link has a mistake and offers \"Back to the app\"", offered && /The app's sign-in link has a mistake/.test(pageText) && page.url().startsWith(`${env.site}/authorize`), pageText.slice(0, 200));
    results.check("…whose address is the app's redirect URI with error=invalid_request and its state", !!backTo && backTo.pathname.endsWith("/briefcase/callback") && backTo.searchParams.get("error") === "invalid_request" && !!backTo.searchParams.get("state"), backTo?.href.slice(0, 200) ?? "no link");
    await context.close();
  },
};

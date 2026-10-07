import type { Journey } from "../context";
import { POWERED_BY_HREF, appAccount, completeDetails, hostedTitle, live, newContext, poweredBy, shot, signInWithCode, sleep, startAtApp, tag } from "../lib";

const randomPhone = () => `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;

export const journey: Journey = {
  name: "i-flows",
  title: "ledgerly's own flow: its sign-up page (intent=signup), page 1 of 2 adds the phone it requires, page 2 of 2 in its own split layout with the optional timezone ticked, the review lists what is shared; Back keeps the choices, Cancel gives the app access_denied",
  async run({ env, results, browser }) {
    // 1. A new Carbon through ledgerly's own "Create an account" button: the whole flow, approved on the review.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "i-signup");
      const email = `lena.flow.${tag()}@example.test`;
      const phone = randomPhone();
      const href = await startAtApp(env, page, "ledgerly", { intent: "signup" });
      results.check("ledgerly's \"Create an account\" asks for the sign-up page (intent=signup)", href.searchParams.get("intent") === "signup", href.search.slice(0, 160));
      const title = await hostedTitle(page);
      const text = (await live(page, "main").first().innerText()).replace(/\s+/g, " ");
      await sleep(500);
      await shot(env, page, "i-01-ledgerly-signup-intent");
      results.check("the sign-up version of the page: ledgerly's sign-up title and subtitle", title === "Create your Ledgerly account" && text.includes("Bookkeeping for freelancers, set up in two steps."), `${title} | ${text.slice(0, 160)}`);
      results.check("…its email and phone choice is named \"Sign up with\"", (await page.getByRole("group", { name: "Sign up with" }).count()) === 1);
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      const walk = await completeDetails(env, page, "ledgerly", { add: { phone }, tick: ["timezone"], shotName: "i-02-ledgerly" });
      const [contact, about] = walk.pages;
      const row = (seen: typeof contact, field: string) => seen?.rows.find(entry => entry.field === field);
      results.check("two pages, in ledgerly's order", walk.pages.length === 2 && contact?.id === "contact" && about?.id === "about-you", walk.pages.map(page => page.id).join(" → "));
      results.check("page 1: \"How can we reach you?\", Step 1 of 2, the phone required and missing", contact?.title === "How can we reach you?" && contact.progress === "Step 1 of 2" && row(contact, "phone")?.mode === "required" && row(contact, "phone")?.missing === true, `${contact?.title} | ${contact?.progress} | ${JSON.stringify(contact?.rows.map(entry => `${entry.field}:${entry.mode}:${entry.missing}`))}`);
      results.check("…the phone is added right there with a code, then Continue", contact?.added.includes("phone") === true && contact.continueLabel === "Continue", `${JSON.stringify(contact?.added)} ${contact?.continueLabel}`);
      results.check("…in the app's branding layout (card)", contact?.shownLayout === "card", String(contact?.shownLayout));
      results.check("page 2: \"About you\", Step 2 of 2, its own split layout, continued with \"Review\"", about?.title === "About you" && about.progress === "Step 2 of 2" && about.shownLayout === "split" && about.continueLabel === "Review", `${about?.title} | ${about?.progress} | ${about?.shownLayout} | ${about?.continueLabel}`);
      results.check("…the date of birth required, the timezone optional and unticked until the Carbon ticks it", row(about, "dob")?.mode === "required" && row(about, "timezone")?.mode === "optional" && row(about, "timezone")?.ticked === false && about?.shared.includes("timezone") === true, JSON.stringify(about?.rows.map(entry => `${entry.field}:${entry.mode}:${entry.ticked}`)));
      results.check("the review lists everything ledgerly will see, the profile first", walk.review?.title === "Check what Ledgerly sees" && JSON.stringify(walk.review.shared) === JSON.stringify(["profile", "phone", "dob", "timezone"]) && walk.review.kept.length === 0, JSON.stringify(walk.review));
      const account = await appAccount(page);
      results.check("ledgerly received the phone, the date of birth and the ticked timezone (and no email: it never asked)", account?.phone === phone && typeof account.dob === "string" && account.timezone === "Asia/Kolkata" && account.email === undefined, JSON.stringify(account).slice(0, 300));
      await context.close();
    }

    // 2. Back keeps the choices; Cancel ends the sign-in and the app gets error=access_denied.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      // The fake app answers a sign-in that came back with an error with its error page (HTTP 400).
      results.watch(page, "i-cancel", [/status of 400 .* @ http:\/\/[^ ]+\/ledgerly\/callback\?error=access_denied/]);
      const email = `omar.flow.${tag()}@example.test`;
      await startAtApp(env, page, "ledgerly");
      results.check("ledgerly's sign-in link shows the sign-in version", (await hostedTitle(page)) === "Sign in to Ledgerly", await hostedTitle(page));
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      const walk = await completeDetails(env, page, "ledgerly", { add: { phone: randomPhone() }, tick: ["timezone"], stopAtReview: true });
      results.check("the review shows the ticked timezone as shared", walk.review?.shared.includes("timezone") === true, JSON.stringify(walk.review));
      const seen = await poweredBy(page);
      results.check("the review page keeps \"Powered by Silicon Accounts\"", seen.inView && seen.href === POWERED_BY_HREF, `${seen.href} ${seen.inView}`);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await live(page, "span").filter({ hasText: /^Step 2 of 2$/ }).first().waitFor({ timeout: 15_000 });
      await sleep(400);
      const box = live(page, 'ul[aria-label^="Details shared with"] > li[data-field="timezone"] [role="checkbox"]').first();
      results.check("Back returns to page 2 with the timezone still ticked", (await box.getAttribute("aria-checked")) === "true");
      await shot(env, page, "i-03-ledgerly-back");
      await page.getByRole("button", { name: "Cancel signing in" }).click();
      await page.waitForURL(url => url.href.startsWith(`${env.apps}/ledgerly/`), { timeout: 30_000 });
      const code = await page.locator("#error-code").innerText().catch(() => "");
      results.check("Cancel sends the Carbon back to ledgerly with error=access_denied", code === "access_denied" || new URL(page.url()).searchParams.get("error") === "access_denied", `${page.url()} ${code}`);
      const apps = (await (await page.request.get(`${env.site}/v1/me/apps?limit=200`)).json()) as { items?: Array<{ app: { app_id: string }; status: string }> };
      results.check("…and ledgerly is not among the Carbon's apps", !apps.items?.some(item => item.app.app_id === "ledgerly" && item.status === "active"), JSON.stringify(apps.items?.map(item => `${item.app.app_id}:${item.status}`)));
      await context.close();
    }
  },
};

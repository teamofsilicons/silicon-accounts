import type { Journey } from "../context";
import { codeFor, lastSeq, newContext, shot, sleep, tag } from "../lib";

/** The date exactly 18 years before today in `timeZone`, as the date picker writes it ("October 7, 2008"). */
/** "2008-11-12": the day exactly 18 years before today in a timezone, as the API stores a date of birth. */
function eighteenYearsAgoDate(timeZone: string): string {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).split("-");
  return `${Number(year) - 18}-${month}-${day}`;
}

export const journey: Journey = {
  name: "a-signup",
  title: "first-party sign-up on the account site with an email code: the sign-up page is prefilled, the identity home renders and leads to the developer site",
  provides: ["ada"],
  async run({ env, results, browser, shared }) {
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "a");
    const email = `ada.walk.${tag()}@example.test`;

    await page.goto(`${env.site}/`);
    await shot(env, page, "a-01-landing");
    const signIn = page.getByRole("link", { name: /sign in/i }).first();
    results.check("the landing page offers sign-in", (await signIn.count()) > 0);
    await signIn.click();
    const field = page.getByRole("textbox", { name: /^(Email or phone|Email)$/ });
    await field.waitFor({ timeout: 30_000 });
    const after = await lastSeq(env);
    await field.fill(email);
    await page.getByRole("button", { name: "Send Me a Code", exact: true }).click();
    const code = await codeFor(env, email, after);
    results.check("the code reached the mock email server", /^\d{6}$/.test(code), code);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 30 });

    const idField = page.getByRole("textbox", { name: "Your CarbonID" });
    await idField.waitFor({ timeout: 20_000 });
    await sleep(800);
    await shot(env, page, "a-02-signup");
    const id = await idField.inputValue();
    const name = await page.getByRole("textbox", { name: "Your name" }).inputValue();
    const photos = await page.locator("img").evaluateAll(images => images.map(image => (image as HTMLImageElement).src).filter(src => /iris|pfp/.test(src)));
    results.check("sign-up: the id is prefilled from the email", id.startsWith("ada-walk-"), id);
    results.check("sign-up: the display name is prefilled", name.startsWith("Ada Walk"), name);
    // Sign-up asks only for the name and CarbonID (2026-11-12): the timezone and date of birth are checked on the account.
    results.check("sign-up: the default photo comes from Iris", photos.length > 0, photos[0] ?? "none");

    await page.getByRole("button", { name: /^Create account$/i }).click();
    await page.waitForURL(url => !url.pathname.startsWith("/authorize") && !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await sleep(800);
    await shot(env, page, "a-03-home");
    results.check("the identity home shows the new c:id", (await page.locator("main").innerText()).includes(id), id);
    const session = await page.request.get(`${env.site}/v1/session`);
    results.check("the session cookie works through the site's proxy", session.status() === 200, String(session.status()));
    const me = (await (await page.request.get(`${env.site}/v1/me`)).json()) as { id?: string; uuid?: string; dob?: string; timezone?: string };
    results.check("GET /v1/me answers for the new Carbon", me.id === `c:${id}`, JSON.stringify(me).slice(0, 200));
    results.check("the account's timezone is the browser's", /Kolkata/.test(me.timezone ?? ""), String(me.timezone));
    const expectedDob = eighteenYearsAgoDate("Asia/Kolkata");
    results.check("the account's date of birth is exactly 18 years before the Carbon's own today", me.dob === expectedDob, `${me.dob} (want ${expectedDob})`);
    // Building apps lives on the developer site now: the account site says where it is and links there.
    const meta = (await (await page.request.get(`${env.site}/v1/meta`)).json()) as { developer_url?: string };
    results.check("GET /v1/meta names the developer site (developer_url)", meta.developer_url === env.developer, String(meta.developer_url));
    const developerLinks = await page.locator(`a[href^="${env.developer}"]`).evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
    results.check("the account site's navigation links to the developer site", developerLinks.length > 0, developerLinks.slice(0, 3).join(" "));
    shared.ada = { email, id: me.id ?? "", uuid: me.uuid ?? "", cookies: await context.cookies() };
    await context.close();
  },
};

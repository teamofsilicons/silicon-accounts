import type { Journey } from "../context";
import { appAccount, completeDetails, hostedTitle, methodButton, newContext, shot, signInWithCode, sleep, startAtApp, tag } from "../lib";

const rowsOf = (rows: Array<{ field: string; mode: string; missing: boolean; ticked: boolean | null }>) =>
  rows.map(row => `${row.field}:${row.mode}${row.missing ? ":missing" : ""}${row.ticked === null ? "" : row.ticked ? ":ticked" : ":unticked"}`).join(" ");

export const journey: Journey = {
  name: "b-apps",
  title: "briefcase's hosted link: email code, sign-up, its what's-shared page (email required, timezone optional and unticked), the app exchanges the code; dm: Continue as, its own page adds the missing phone with a code and shares the email the Carbon ticks",
  provides: ["brook"],
  async run({ env, results, browser, shared }) {
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "b");
    const email = `brook.${tag()}@example.test`;
    const phone = `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;

    // briefcase: a new Carbon through the hosted pages.
    const href = await startAtApp(env, page, "briefcase");
    results.check("briefcase's hosted link points at the site's /authorize", href.href.startsWith(`${env.site}/authorize?`), href.href.slice(0, 120));
    results.check("…and hands the hosted pages no email or phone (an app never does)", !href.searchParams.has("login_hint") && ![...href.searchParams.values()].some(value => /@|\+\d{6,}/.test(value)), href.search.slice(0, 200));
    await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
    await sleep(500);
    await shot(env, page, "b-01-briefcase-methods");
    results.check("the sign-in page uses briefcase's own title", (await hostedTitle(page)) === "Sign in to Briefcase", await hostedTitle(page));
    results.check("briefcase offers Google and Apple", (await methodButton(page, "google").count()) === 1 && (await methodButton(page, "apple").count()) === 1);
    await signInWithCode(env, page, { email });
    const create = page.getByRole("button", { name: "Create account" });
    await create.waitFor({ timeout: 25_000 });
    await sleep(400);
    await shot(env, page, "b-02-briefcase-signup");
    await create.click();
    const first = await completeDetails(env, page, "briefcase", { shotName: "b-03-briefcase" });
    const what = first.pages[0];
    results.check("a first sign-in to briefcase shows one what's-shared page", first.pages.length === 1 && what?.count === 1 && !what.progress, `${first.pages.length} pages, ${what?.progress ?? "no progress"}`);
    results.check("…titled by default and continued with \"Share and continue\"", what?.title === "Share your details with Briefcase" && what.continueLabel === "Share and continue", `${what?.title} / ${what?.continueLabel}`);
    const row = (field: string) => what?.rows.find(entry => entry.field === field);
    results.check("…the profile and the email are required (locked), the timezone optional and unticked", row("profile")?.mode === "required" && row("email")?.mode === "required" && !row("email")?.missing && row("timezone")?.mode === "optional" && row("timezone")?.ticked === false, rowsOf(what?.rows ?? []));
    await shot(env, page, "b-04-briefcase-signed-in", true);
    const account = await appAccount(page);
    results.check("briefcase shows the account it received", typeof account?.uuid === "string", JSON.stringify(account).slice(0, 200));
    results.check("briefcase received the email (required)", account?.email === email, String(account?.email));
    results.check("briefcase did not receive the timezone (optional, left unticked)", account?.timezone === undefined, String(account?.timezone));
    results.check("the membership id is briefcase:<uuid>", (await page.locator("#membership-id").innerText().catch(() => "")) === `briefcase:${String(account?.uuid)}`);

    // dm: one click as the signed-in Carbon, then dm's own page ("Set up DM"): the phone it requires is added there
    // with a code, and the email (optional) is shared because the Carbon ticks it.
    await startAtApp(env, page, "dm");
    const continueAs = page.getByRole("button", { name: /^Continue as/ });
    await continueAs.waitFor({ timeout: 30_000 });
    await sleep(400);
    await shot(env, page, "b-05-dm-continue-as");
    results.check("dm offers \"Continue as\" in one click", (await continueAs.count()) === 1);
    await continueAs.click();
    const second = await completeDetails(env, page, "dm", { add: { phone }, tick: ["email"], shotName: "b-06-dm" });
    const setup = second.pages[0];
    const dmRow = (field: string) => setup?.rows.find(entry => entry.field === field);
    results.check("dm shows its one custom page: \"Set up DM\", continued with \"Start messaging\"", second.pages.length === 1 && setup?.title === "Set up DM" && setup.continueLabel === "Start messaging", `${setup?.title} / ${setup?.continueLabel}`);
    results.check("…asks for the phone it requires, which the account lacks", dmRow("phone")?.mode === "required" && dmRow("phone")?.missing === true, rowsOf(setup?.rows ?? []));
    results.check("…offers email and timezone as optional, both unticked until the Carbon ticks one", dmRow("email")?.mode === "optional" && dmRow("email")?.ticked === false && dmRow("timezone")?.mode === "optional" && dmRow("timezone")?.ticked === false, rowsOf(setup?.rows ?? []));
    results.check("the phone was added on the page with a code", setup?.added.includes("phone") === true, JSON.stringify(setup?.added));
    const dm = await appAccount(page);
    results.check("dm received the account with its verified phone", dm?.phone === phone && dm.phone_verified === true, JSON.stringify(dm).slice(0, 240));
    results.check("dm received the email the Carbon ticked, and not the unticked timezone", dm?.email === email && dm.timezone === undefined, `${String(dm?.email)} / ${String(dm?.timezone)}`);
    results.check("the same uuid in both apps", dm?.uuid === account?.uuid);
    const phones = (await (await page.request.get(`${env.site}/v1/me/phones`)).json()) as { items?: Array<{ phone: string; verified_at: string | null; primary?: boolean }> };
    results.check("the phone added on dm's page is on the account, verified", !!phones.items?.some(item => item.phone === phone && !!item.verified_at), JSON.stringify(phones.items ?? []).slice(0, 200));

    // briefcase again: continue as goes straight back (nothing new to share).
    const started = Date.now();
    await startAtApp(env, page, "briefcase");
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    const again = await completeDetails(env, page, "briefcase");
    results.check("a second briefcase sign-in: Continue as, and no details page again", again.pages.length === 0 && !again.review, `${again.pages.length} pages, ${Date.now() - started} ms`);
    results.metric("continue as, back at briefcase", Date.now() - started);

    const me = (await (await page.request.get(`${env.site}/v1/me`)).json()) as { id?: string; uuid?: string };
    shared.brook = { email, phone, id: me.id ?? "", uuid: me.uuid ?? String(account?.uuid ?? ""), cookies: await context.cookies() };
    await context.close();
  },
};

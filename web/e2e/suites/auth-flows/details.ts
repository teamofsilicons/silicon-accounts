/**
 * What's shared with the app (UNDERSTANDING.md v2 "What's shared with the app", "Flows"; build spec 06-v2.md §3–4).
 *
 * Each app picks the details it wants, each required or optional. Required details are always shared, and a missing
 * email or phone must be added (with a code) before continuing; optional details come with a checkbox, unticked until
 * the Carbon ticks it (a Carbon who shared it before finds it ticked), also when the app asks for it in `scope`. The
 * pages are shown the first time a Carbon signs in to an app and again whenever the app asks for more; an app without
 * a flow of its own gets one page (the what's-shared screen), and an app's flow decides which details go on which page,
 * with an optional review page at the end. Cancel anywhere sends the app error=access_denied and grants nothing.
 *
 * - auth-flows-whats-shared: briefcase's one page (email required, timezone optional) in the browser and at the API.
 * - auth-flows-required-details: dm's one custom page ("Set up DM"): the missing phone added with a code, in the
 *   browser and at the API (other accounts' numbers, wrong codes, resends, other browsers, signed out, added elsewhere).
 * - auth-flows-flow-pages: ledgerly's two pages and review page at the API (Back keeps choices, the review lists what
 *   is shared, a returning Carbon skips the pages, prompt=consent shows them again), then once in the browser.
 */
import type { Journey } from "../../context";
import { appAccount, codeFor, completeDetails, hostedTitle, lastSeq, live, newContext, poweredBy, POWERED_BY_HREF, shot, sleep, sql, startAtApp, tag } from "../../lib";
import {
  Browserish,
  addDetail,
  adoptSession,
  brief,
  drive,
  errorCode,
  errorDetails,
  exchangeCode,
  fieldErrors,
  grantOf,
  messagesTo,
  newCarbon,
  nextCode,
  randomPhone,
  redirectParams,
  scopeSet,
  sendCode,
  shownScope,
  startSignIn,
  withSigninConfig,
  type FlowView,
} from "./_helpers";

const DETAILS_LIST = (app: string) => `ul[aria-label="Details shared with ${app}"]`;

/** The rows of the details page on screen: field, required/optional, missing, ticked. */
async function rowsOf(page: import("@playwright/test").Page, app: string) {
  return live(page, `${DETAILS_LIST(app)} > li`).evaluateAll(items =>
    items.map(item => {
      const box = item.querySelector('[role="checkbox"]');
      return {
        field: item.getAttribute("data-field") ?? "",
        required: item.hasAttribute("data-required"),
        optional: item.hasAttribute("data-optional"),
        missing: item.hasAttribute("data-missing"),
        ticked: box ? box.getAttribute("aria-checked") === "true" : null,
      };
    }),
  );
}

const fieldOf = (flow: FlowView | null | undefined, name: string) => flow?.details?.fields.find(f => f.field === name);

const whatsShared: Journey = {
  name: "auth-flows-whats-shared",
  title: "briefcase's what's-shared page: email required (locked), timezone optional and unticked (also when asked in scope); ticking shares it, prompt=consent shows it ticked and unticking takes it back, Cancel → access_denied; at the API: bad share lists, no Back on the first page, approve before the review, asking for more shows the page again, a returning Carbon skips it",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const email = `shared.${t}@example.test`;
    const carbon = await newCarbon(env, ctx.ip, email, { timezone: "Europe/Berlin" });
    const context = await newContext(browser);
    await adoptSession(context, env.site, carbon.b);
    const page = await context.newPage();
    // Cancel ends at briefcase's error page, which answers 400 (the fake app's way of showing access_denied).
    results.watch(page, "whats-shared", [/status of 400 .*\/briefcase\/callback\?error=access_denied/]);

    await startAtApp(env, page, "briefcase");
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    const list = live(page, DETAILS_LIST("Briefcase")).first();
    await list.waitFor({ timeout: 20_000 });
    await sleep(400);
    await shot(env, page, "auth-flows-whats-shared-01");
    const title = await hostedTitle(page);
    results.check("briefcase (no flow of its own) shows one what's-shared page: \"Share your details with Briefcase\"", title === "Share your details with Briefcase", title);
    const rows = await rowsOf(page, "Briefcase");
    const row = (field: string) => rows.find(r => r.field === field);
    results.check(
      "rows: the profile and the email required (locked, no checkbox), the timezone optional",
      !!row("profile")?.required && !!row("email")?.required && row("email")?.ticked === null && !!row("timezone")?.optional && rows.length === 3,
      JSON.stringify(rows),
    );
    results.check("the optional timezone starts unticked (UNDERSTANDING: \"It's unticked until they do\")", row("timezone")?.ticked === false, JSON.stringify(row("timezone")));
    const listText = (await list.innerText()).replace(/\s+/g, " ");
    results.check("the email row shows the masked address, the timezone row the account's (Berlin)", listText.includes("s***@example.test") && !listText.includes(email) && /Berlin/.test(listText), listText.slice(0, 300));
    results.check("one page, so its button is \"Share and continue\" (and Cancel, no Back)", (await page.getByRole("button", { name: "Share and continue", exact: true }).count()) === 1 && (await page.getByRole("button", { name: "Cancel", exact: true }).count()) === 1 && (await page.getByRole("button", { name: "Back", exact: true }).count()) === 0);
    const powered = await poweredBy(page);
    results.check("the details page keeps \"Powered by Silicon Accounts\" linking to accounts.teamofsilicons.com", powered.href === POWERED_BY_HREF && /Powered by/.test(powered.text) && powered.atEnd, JSON.stringify(powered));
    // Tick the timezone and share.
    const walk = await completeDetails(env, page, "briefcase", { tick: ["timezone"] });
    results.check("ticking the timezone shares it with the email (and the profile)", JSON.stringify(walk.pages[0]?.shared.sort()) === JSON.stringify(["email", "profile", "timezone"]), JSON.stringify(walk.pages[0]?.shared));
    const shared = await appAccount(page);
    results.check("briefcase got the email and the timezone it was allowed (Europe/Berlin)", shared?.email === email && shared?.timezone === "Europe/Berlin", JSON.stringify(shared).slice(0, 300));
    results.check("…and the token's scope says so (email profile timezone)", (await shownScope(page)) === "email profile timezone", await shownScope(page));

    // prompt=consent: the page again, the timezone ticked (shared before); unticking takes it back.
    await startAtApp(env, page, "briefcase", { extra: { prompt: "consent" } });
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    await list.waitFor({ timeout: 20_000 });
    await sleep(300);
    const again = await rowsOf(page, "Briefcase");
    results.check("prompt=consent shows the page again with the timezone ticked (shared before)", again.find(r => r.field === "timezone")?.ticked === true, JSON.stringify(again));
    await completeDetails(env, page, "briefcase", { untick: ["timezone"] });
    const narrowed = await appAccount(page);
    results.check("unticking it takes it back: briefcase no longer gets the timezone (scope email profile)", narrowed !== null && !("timezone" in narrowed) && (await shownScope(page)) === "email profile", `${await shownScope(page)} ${JSON.stringify(narrowed).slice(0, 200)}`);
    results.check("…and the membership's grant was replaced (email profile)", (await grantOf(env, "briefcase", carbon.uuid)) === "email profile", String(await grantOf(env, "briefcase", carbon.uuid)));

    // Cancel: back at the app with access_denied, nothing new granted.
    await startAtApp(env, page, "briefcase", { extra: { prompt: "consent", scope: "email timezone" } });
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    const cancelled = await completeDetails(env, page, "briefcase", { tick: ["timezone"], cancelOnPage: 0 });
    results.check("Cancel (even with the timezone ticked) → briefcase gets error=access_denied", cancelled.cancelled && (await page.locator("#error-code").innerText().catch(() => "")) === "access_denied", page.url());
    results.check("…and the grant is unchanged (email profile)", (await grantOf(env, "briefcase", carbon.uuid)) === "email profile", String(await grantOf(env, "briefcase", carbon.uuid)));
    await context.close();

    // UNDERSTANDING.md: an optional detail stays unticked until the Carbon ticks it, also when the app asks for it in
    // `scope`; continuing without touching it gives the app nothing optional.
    const asker = await newCarbon(env, ctx.ip, `shared.asked.${t}@example.test`, { timezone: "Europe/Paris" });
    const askedContext = await newContext(browser);
    await adoptSession(askedContext, env.site, asker.b);
    const asked = await askedContext.newPage();
    results.watch(asked, "whats-shared-asked");
    await startAtApp(env, asked, "briefcase", { extra: { scope: "email timezone" } });
    await asked.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    await live(asked, DETAILS_LIST("Briefcase")).first().waitFor({ timeout: 20_000 });
    await sleep(300);
    const askedRows = await rowsOf(asked, "Briefcase");
    results.check("briefcase asks for timezone in scope → its checkbox still starts unticked", askedRows.find(r => r.field === "timezone")?.ticked === false, JSON.stringify(askedRows));
    await completeDetails(env, asked, "briefcase");
    const askedShared = await appAccount(asked);
    results.check("…and continuing without touching it gives briefcase no timezone (scope email profile)", askedShared !== null && !("timezone" in askedShared) && (await shownScope(asked)) === "email profile", `${await shownScope(asked)} ${JSON.stringify(askedShared).slice(0, 200)}`);
    await askedContext.close();

    // At the API.
    const c = new Browserish(env, ctx.ip);
    const fresh = await startSignIn(c, "briefcase", { scope: "email timezone" });
    const sent = await sendCode(c, fresh.flow.id, { email: `shared.api.${t}@example.test` });
    await c.act(fresh.flow.id, "verify", { code: sent.code ?? "" });
    const atPage = await c.act(fresh.flow.id, "signup", {});
    const details = atPage.body.flow?.details;
    results.check("a new account lands on the details page: one page (\"details\", 0 of 1), no review next", atPage.body.flow?.step === "details" && details?.id === "details" && details.index === 0 && details.count === 1 && details.review_next === false && details.title === null && details.continue_label === null, brief(atPage));
    results.check("…email required, present, shared (masked value)", fieldOf(atPage.body.flow, "email")?.mode === "required" && fieldOf(atPage.body.flow, "email")?.missing === false && fieldOf(atPage.body.flow, "email")?.shared === true && /^s\*\*\*@example\.test$/.test(fieldOf(atPage.body.flow, "email")?.value ?? ""), JSON.stringify(fieldOf(atPage.body.flow, "email")));
    results.check("…timezone optional and not shared although scope asks for it (unticked until the Carbon ticks it)", fieldOf(atPage.body.flow, "timezone")?.mode === "optional" && fieldOf(atPage.body.flow, "timezone")?.shared === false, JSON.stringify(fieldOf(atPage.body.flow, "timezone")));
    const id = fresh.flow.id;
    const phoneShare = await c.detailsContinue(id, ["phone"]);
    results.check("continue sharing phone (not on this page) → 422 naming share[0]", phoneShare.status === 422 && typeof fieldErrors(phoneShare)["share[0]"] === "string", brief(phoneShare));
    const junk = await c.detailsContinue(id, ["timezone", "superuser"]);
    results.check("an unknown detail (superuser) → 422 naming share[1]", junk.status === 422 && typeof fieldErrors(junk)["share[1]"] === "string", brief(junk));
    const back = await c.detailsBack(id);
    results.check("Back on the first page → 409 no_previous_page", back.status === 409 && errorCode(back) === "no_previous_page", brief(back));
    const early = await c.review(id, true);
    results.check("approving before a review page exists → 409 invalid_step", early.status === 409 && errorCode(early) === "invalid_step", brief(early));
    const mark = await lastSeq(env);
    const addPresent = await c.detailsAdd(id, { email: `other.${t}@example.test` });
    results.check("adding an email the account already has (required, present) sends nothing and keeps the page", addPresent.status === 200 && addPresent.body.flow.details?.challenge === null && (await messagesTo(env, `other.${t}@example.test`, mark)) === 0, brief(addPresent));
    const notOnPage = await c.detailsAdd(id, { phone: randomPhone() });
    results.check("adding a phone (briefcase's page doesn't ask for one) → 409 detail_not_on_page", notOnPage.status === 409 && errorCode(notOnPage) === "detail_not_on_page", brief(notOnPage));
    const both = await c.act(id, "details/add", { email: `x.${t}@example.test`, phone: randomPhone() });
    results.check("details/add with both an email and a phone → 422", both.status === 422, brief(both));
    const noCode = await c.detailsVerify(id, "123456");
    results.check("details/verify before any code was sent → 409 no_code_sent", noCode.status === 409 && errorCode(noCode) === "no_code_sent", brief(noCode));
    const declined = await c.review(id, false);
    const d = redirectParams(declined.body.flow);
    results.check("Cancel on the details page (review approve:false) → complete with error=access_denied and the state, no code", declined.status === 200 && declined.body.flow.step === "complete" && d.get("error") === "access_denied" && d.get("state") === fresh.state && !d.get("code"), declined.body.flow?.redirect_to ?? brief(declined));
    const uuid = (await c.session())?.account.uuid ?? "";
    results.check("…no membership was made for briefcase", (await grantOf(env, "briefcase", uuid)) === null, String(await grantOf(env, "briefcase", uuid)));
    const history = await sql(env, `select outcome from signin_history where account_uuid = '${uuid}' and app_id = 'briefcase'`);
    results.check("…the cancel is in the sign-in history as failed", JSON.stringify(history) === JSON.stringify([["failed"]]), JSON.stringify(history));
    const replay = await c.review(id, true);
    results.check("answering the finished flow again → 409 flow_completed", replay.status === 409 && errorCode(replay) === "flow_completed", brief(replay));

    // Granted the email only; the app later asks for timezone → the page again (no prompt needed), then never again.
    const first = await startSignIn(c, "briefcase");
    const firstTrace: FlowView[] = [];
    const firstDone = await drive(c, first.flow, { share: [], trace: firstTrace });
    results.check("the first real sign-in shows the page once and completes with a code", firstDone.step === "complete" && !!redirectParams(firstDone).get("code") && firstTrace.some(v => v.step === "details"), firstTrace.map(v => v.step).join(" → "));
    const plain = await startSignIn(c, "briefcase");
    const plainStep = await c.act(plain.flow.id, "continue");
    results.check("signing in again with nothing new → straight to complete (no page)", plainStep.body.flow?.step === "complete", brief(plainStep));
    const more = await startSignIn(c, "briefcase", { scope: "timezone" });
    const moreStep = await c.act(more.flow.id, "continue");
    const tz = fieldOf(moreStep.body.flow, "timezone");
    const em = fieldOf(moreStep.body.flow, "email");
    results.check("asking for timezone later → the page again: email previously granted, timezone new and unticked", moreStep.body.flow?.step === "details" && em?.previously_granted === true && tz?.previously_granted === false && tz.shared === false, JSON.stringify(moreStep.body.flow?.details?.fields));
    const moreDone = await drive(c, moreStep.body.flow, { share: ["timezone"] });
    const tokens = await exchangeCode(env, "briefcase", redirectParams(moreDone).get("code") ?? "", more.redirectUri, more.verifier);
    results.check("ticked → the token's scope and account include the timezone", tokens.status === 200 && scopeSet(tokens.body.scope) === "email profile timezone" && typeof tokens.body.account.timezone === "string", brief(tokens));
    const same = await startSignIn(c, "briefcase", { scope: "timezone" });
    const sameStep = await c.act(same.flow.id, "continue");
    results.check("asking for the same again → no page (complete at once)", sameStep.body.flow?.step === "complete", brief(sameStep));

    // Removing the app's access on the account site: the next sign-in shows the page again, nothing pre-ticked.
    const removed = await c.call("DELETE", "/v1/me/apps/briefcase");
    const back2 = await startSignIn(c, "briefcase");
    const back2Page = await c.act(back2.flow.id, "continue");
    const tzAfter = fieldOf(back2Page.body.flow, "timezone");
    results.check("after the Carbon removes briefcase's access, the next sign-in shows the page again with the timezone unticked (not previously granted)", removed.status === 204 && back2Page.body.flow?.step === "details" && tzAfter?.shared === false && tzAfter.previously_granted === false, `${removed.status} ${brief(back2Page)} ${JSON.stringify(tzAfter)}`);
    const back2Done = await drive(c, back2Page.body.flow);
    const back2Tokens = await exchangeCode(env, "briefcase", redirectParams(back2Done).get("code") ?? "", back2.redirectUri, back2.verifier);
    results.check("…and continuing as it stands shares email and profile only", back2Tokens.status === 200 && scopeSet(back2Tokens.body.scope) === "email profile", brief(back2Tokens));

    // A detail the app does not request but asks for in `scope` (phone on briefcase): optional, on the last page.
    const scoped = await startSignIn(c, "briefcase", { scope: "email phone" });
    const scopedPage = await c.act(scoped.flow.id, "continue");
    const ph = fieldOf(scopedPage.body.flow, "phone");
    results.check("briefcase asking for phone in scope (not one of its details) → the page shows phone as optional, missing and unticked", scopedPage.body.flow?.step === "details" && ph?.mode === "optional" && ph.missing === true && ph.shared === false, JSON.stringify(scopedPage.body.flow?.details?.fields));
    const scopedShare = await c.detailsContinue(scoped.flow.id, ["phone"]);
    results.check("…sharing it while missing → 422 naming share[0] (add it first)", scopedShare.status === 422 && typeof fieldErrors(scopedShare)["share[0]"] === "string", brief(scopedShare));
    const scopedNumber = randomPhone();
    const scopedAdded = await addDetail(c, scoped.flow.id, { phone: scopedNumber });
    const scopedDone = scopedAdded.verified?.status === 200 ? await drive(c, scopedAdded.verified.body.flow) : null;
    const scopedTokens = scopedDone ? await exchangeCode(env, "briefcase", redirectParams(scopedDone).get("code") ?? "", scoped.redirectUri, scoped.verifier) : null;
    results.check("…added on the page (starts ticked) → briefcase gets the phone (scope email phone profile)", scopedTokens?.status === 200 && scopedTokens.body.account.phone === scopedNumber && scopeSet(scopedTokens.body.scope) === "email phone profile", scopedTokens ? brief(scopedTokens) : brief(scopedAdded.verified ?? scopedAdded.sent));

    // A flow that runs out (60 minutes, time travel) while on the details page.
    const late = await startSignIn(c, "briefcase", { prompt: "consent" });
    await c.act(late.flow.id, "continue");
    await sql(env, `update signin_flows set expires_at = now() - interval '1 second' where id = '${late.flow.id}'`);
    const lateContinue = await c.detailsContinue(late.flow.id, []);
    results.check("a flow past its 60 minutes on the details page → 410 flow_expired, no code", lateContinue.status === 410 && errorCode(lateContinue) === "flow_expired", brief(lateContinue));

    // An app that asks for no details at all still shows one what's-shared page (the profile) the first time
    // (build spec 06-v2.md §4), then never again. The fake app "browser" asks for nothing for a moment.
    await withSigninConfig(env, "browser", { optional_fields: [] }, { optional_fields: ["timezone"] }, async () => {
      const n = (await newCarbon(env, ctx.ip, `shared.none.${t}@example.test`)).b;
      const ns = await startSignIn(n, "browser");
      const nPage = await n.act(ns.flow.id, "continue");
      results.check("an app asking for no details: the first sign-in still shows one page, with no detail rows (the profile only)", nPage.body.flow?.step === "details" && nPage.body.flow.details?.count === 1 && nPage.body.flow.details.fields.length === 0, brief(nPage));
      const nDone = await drive(n, nPage.body.flow);
      const nTokens = await exchangeCode(env, "browser", redirectParams(nDone).get("code") ?? "", ns.redirectUri, ns.verifier);
      results.check("…continuing shares the profile only (scope profile)", nTokens.status === 200 && scopeSet(nTokens.body.scope) === "profile", brief(nTokens));
      const nAgain = await startSignIn(n, "browser");
      const nStraight = await n.act(nAgain.flow.id, "continue");
      results.check("…and the next sign-in shows no page", nStraight.body.flow?.step === "complete", brief(nStraight));
      // In the browser: the page draws the profile row and "Share and continue".
      const u = await newCarbon(env, ctx.ip, `shared.none.ui.${t}@example.test`);
      const uContext = await newContext(browser);
      await adoptSession(uContext, env.site, u.b);
      const uPage = await uContext.newPage();
      results.watch(uPage, "whats-shared-none");
      await startAtApp(env, uPage, "browser");
      await uPage.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
      await live(uPage, DETAILS_LIST("Browser")).first().waitFor({ timeout: 20_000 });
      await sleep(300);
      await shot(env, uPage, "auth-flows-whats-shared-02-no-details");
      const uRows = await rowsOf(uPage, "Browser");
      results.check("…in the browser that page lists just the profile, with \"Share and continue\"", JSON.stringify(uRows.map(r => r.field)) === '["profile"]' && (await uPage.getByRole("button", { name: "Share and continue", exact: true }).count()) === 1, JSON.stringify(uRows));
      const uWalk = await completeDetails(env, uPage, "browser");
      results.check("…and continuing lands back at the app signed in", uWalk.pages.length === 1 && !!(await appAccount(uPage))?.uuid, uPage.url());
      await uContext.close();
    });
  },
};

const requiredDetails: Journey = {
  name: "auth-flows-required-details",
  title: "dm requires a phone: its one page \"Set up DM\" opens the missing phone's form by itself, Continue says what is missing, the phone is added with a code (ticked email shared, timezone not); at the API: phone_in_use, wrong and replaced codes, another browser, signed out, a number added elsewhere",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const email = `needs.${t}@example.test`;
    const carbon = await newCarbon(env, ctx.ip, email);
    const context = await newContext(browser);
    await adoptSession(context, env.site, carbon.b);
    const page = await context.newPage();
    results.watch(page, "required-details");
    await startAtApp(env, page, "dm");
    await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
    const list = live(page, DETAILS_LIST("DM")).first();
    await list.waitFor({ timeout: 20_000 });
    await sleep(400);
    await shot(env, page, "auth-flows-required-details-01");
    const title = await hostedTitle(page);
    const text = (await live(page, "main").first().innerText()).replace(/\s+/g, " ");
    results.check("dm's own page: \"Set up DM\" with its subtitle", title === "Set up DM" && text.includes("DM needs your phone number. Email and timezone are up to you."), `${title} | ${text.slice(0, 200)}`);
    const rows = await rowsOf(page, "DM");
    const row = (field: string) => rows.find(r => r.field === field);
    results.check("the phone is required and missing; email (the account has one) and timezone optional, unticked", !!row("phone")?.required && !!row("phone")?.missing && row("email")?.optional === true && row("email")?.ticked === false && row("timezone")?.ticked === false, JSON.stringify(rows));
    const adder = live(page, '[data-adding="phone"]').first();
    results.check("the missing required phone's form is open by itself (\"Add your phone number\")", (await adder.isVisible()) && /Add your phone number/.test(await adder.innerText()), (await adder.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));
    const mark = await lastSeq(env);
    await page.getByRole("button", { name: "Start messaging", exact: true }).click();
    const blocked = live(page, '[role="alert"]').filter({ hasText: /needs your phone number/ }).first();
    await blocked.waitFor({ timeout: 5_000 }).catch(() => undefined);
    results.check("\"Start messaging\" before the phone is added says DM needs the phone number, and asks nothing of the server", (await blocked.isVisible()) && new URL(page.url()).pathname.startsWith("/authorize/flow/"), (await blocked.innerText().catch(() => "")).trim());
    const number = randomPhone();
    const walk = await completeDetails(env, page, "dm", { add: { phone: number }, tick: ["email"], shotName: "auth-flows-required-details" });
    results.check("the phone was added on the page with a code, then the page continued (its button \"Start messaging\")", JSON.stringify(walk.pages[0]?.added) === '["phone"]' && walk.pages[0]?.continueLabel === "Start messaging" && walk.pages.length === 1, JSON.stringify(walk.pages.map(p => ({ id: p.id, added: p.added, label: p.continueLabel }))));
    const got = await appAccount(page);
    results.check("dm got the verified phone and the ticked email, and no timezone", got?.phone === number && got.phone_verified === true && got.email === email && !("timezone" in (got ?? {})), JSON.stringify(got).slice(0, 300));
    const primary = await sql(env, `select is_primary, verified_via from account_phones where phone = '${number}'`);
    results.check("the phone became the account's primary (it had none), verified by code", JSON.stringify(primary) === JSON.stringify([["t", "code"]]), JSON.stringify(primary));
    results.check("(no sign-in code went to the email meanwhile)", (await messagesTo(env, email, mark)) === 0);
    await context.close();

    // dm at the API.
    const c = (await newCarbon(env, ctx.ip, `dm.api.${t}@example.test`)).b;
    const s = await startSignIn(c, "dm");
    const atPage = await c.act(s.flow.id, "continue");
    const phoneField = fieldOf(atPage.body.flow, "phone");
    results.check("continue as → dm's page \"dm-setup\" with its title, subtitle and label, the phone required and missing", atPage.body.flow?.step === "details" && atPage.body.flow.details?.id === "dm-setup" && atPage.body.flow.details.title === "Set up DM" && atPage.body.flow.details.continue_label === "Start messaging" && phoneField?.mode === "required" && phoneField.missing === true && phoneField.value === null, brief(atPage));
    const missing = await c.detailsContinue(s.flow.id, []);
    results.check("continuing without the phone → 409 requirements_missing naming it", missing.status === 409 && errorCode(missing) === "requirements_missing" && JSON.stringify(errorDetails(missing).missing) === '["phone"]', brief(missing));
    const noCode = await c.detailsVerify(s.flow.id, "123456");
    results.check("verifying before any code was sent → 409 no_code_sent", noCode.status === 409 && errorCode(noCode) === "no_code_sent", brief(noCode));
    const taken = await c.detailsAdd(s.flow.id, { phone: number });
    results.check("another account's phone → 409 phone_in_use, no code sent", taken.status === 409 && errorCode(taken) === "phone_in_use", brief(taken));
    const bad = await c.detailsAdd(s.flow.id, { phone: "+1 202 555" });
    results.check("a number that is not one → 422 invalid_phone", bad.status === 422 && errorCode(bad) === "invalid_phone", brief(bad));
    const mine = randomPhone();
    let mark2 = await lastSeq(env);
    const sent = await c.detailsAdd(s.flow.id, { phone: mine });
    const first = await nextCode(env, mine, mark2);
    results.check("a free number → a code by SMS, the challenge on the details view (masked)", sent.status === 200 && !!first && sent.body.flow.details?.challenge?.channel === "phone" && sent.body.flow.details.challenge.destination.endsWith(mine.slice(-4)) && !sent.body.flow.details.challenge.destination.includes(mine.slice(2, 8)), brief(sent));
    const wrong = await c.detailsVerify(s.flow.id, first === "000000" ? "111111" : "000000");
    results.check("a wrong code → 422 invalid_code with 9 tries left", wrong.status === 422 && errorCode(wrong) === "invalid_code" && errorDetails(wrong).remaining_attempts === 9, brief(wrong));
    mark2 = await lastSeq(env);
    const resent = await c.act(s.flow.id, "resend");
    const second = await nextCode(env, mine, mark2);
    results.check("resend on the details page → a new code to the same number", resent.status === 200 && !!second && resent.body.flow.details?.challenge?.channel === "phone", brief(resent));
    const old = await c.detailsVerify(s.flow.id, first ?? "");
    results.check("the replaced code no longer works (422 invalid_code), 8 tries left", old.status === 422 && errorCode(old) === "invalid_code" && errorDetails(old).remaining_attempts === 8, brief(old));
    await sql(env, `update otp_challenges set expires_at = now() - interval '1 second' where destination = '${mine}' and consumed_at is null`);
    const expired = await c.detailsVerify(s.flow.id, second ?? "");
    results.check("past its 10 minutes (time travel) the code adding the phone → 410 code_expired", expired.status === 410 && errorCode(expired) === "code_expired", brief(expired));
    mark2 = await lastSeq(env);
    const resent2 = await c.act(s.flow.id, "resend");
    const third = await nextCode(env, mine, mark2);
    results.check("…a resend sends a fresh code", resent2.status === 200 && !!third, brief(resent2));
    const stranger = new Browserish(env, ctx.ip);
    const other = await stranger.detailsVerify(s.flow.id, third ?? "");
    results.check("another browser can't verify it (403 flow_not_bound)", other.status === 403 && errorCode(other) === "flow_not_bound", brief(other));
    const right = await c.detailsVerify(s.flow.id, third ?? "");
    const added = fieldOf(right.body.flow, "phone");
    results.check("the right code adds the phone: the page stays, the phone present (masked) and no challenge left", right.status === 200 && right.body.flow.step === "details" && added?.missing === false && (added.value ?? "").endsWith(mine.slice(-4)) && right.body.flow.details?.challenge === null, brief(right));
    const done = await drive(c, right.body.flow, { share: ["timezone"] });
    const tokens = await exchangeCode(env, "dm", redirectParams(done).get("code") ?? "", s.redirectUri, s.verifier);
    results.check("continuing → dm gets the phone and the ticked timezone, not the unticked email (scope phone profile timezone)", tokens.status === 200 && tokens.body.account.phone === mine && scopeSet(tokens.body.scope) === "phone profile timezone" && tokens.body.account.email === undefined, brief(tokens));

    // The number is added on the account site meanwhile: the page shows it present.
    const e = (await newCarbon(env, ctx.ip, `dm.elsewhere.${t}@example.test`)).b;
    const es = await startSignIn(e, "dm");
    await e.act(es.flow.id, "continue");
    const elsewhere = randomPhone();
    const mark3 = await lastSeq(env);
    const start = await e.post<{ challenge_id?: string }>("/v1/me/phones", { phone: elsewhere });
    const siteCode = await nextCode(env, elsewhere, mark3);
    const verifiedSite = await e.post("/v1/me/phones/verify", { challenge_id: start.body.challenge_id, code: siteCode });
    results.check("the phone is added and verified on the account site meanwhile", start.status < 300 && verifiedSite.status === 200, `${brief(start)} / ${brief(verifiedSite)}`);
    const reread = await e.flow(es.flow.id);
    results.check("reading the flow then shows the phone present on the page (missing false)", reread.body.flow?.step === "details" && fieldOf(reread.body.flow, "phone")?.missing === false, brief(reread));
    const fromSite = await drive(e, reread.body.flow);
    const siteTokens = await exchangeCode(env, "dm", redirectParams(fromSite).get("code") ?? "", es.redirectUri, es.verifier);
    results.check("…and dm gets the number added on the account site", siteTokens.status === 200 && siteTokens.body.account.phone === elsewhere, brief(siteTokens));

    // Signed out in between: the page can't act for that account.
    const g = (await newCarbon(env, ctx.ip, `dm.signout.${t}@example.test`)).b;
    const gs = await startSignIn(g, "dm");
    await g.act(gs.flow.id, "continue");
    await g.post("/v1/session/signout");
    const gone = await g.detailsAdd(gs.flow.id, { phone: randomPhone() });
    results.check("signed out meanwhile → 401 session_required on the details page", gone.status === 401 && errorCode(gone) === "session_required", brief(gone));
    const goneContinue = await g.detailsContinue(gs.flow.id, []);
    results.check("…the same for continuing", goneContinue.status === 401 && errorCode(goneContinue) === "session_required", brief(goneContinue));

    // An optional email added on dm's page starts ticked (UNDERSTANDING.md v2: an email or phone the Carbon adds on
    // the page starts ticked); "Switch account" from a details page goes back to the methods.
    const q = new Browserish(env, ctx.ip);
    const qs = await startSignIn(q, "dm");
    const qPhone = randomPhone();
    const qCode = await sendCode(q, qs.flow.id, { phone: qPhone });
    await q.act(qs.flow.id, "verify", { code: qCode.code ?? "" });
    const qPage = await q.act(qs.flow.id, "signup", {});
    results.check("a new phone-only Carbon on dm: the optional email is missing and unticked", fieldOf(qPage.body.flow, "email")?.missing === true && fieldOf(qPage.body.flow, "email")?.shared === false && fieldOf(qPage.body.flow, "email")?.mode === "optional", brief(qPage));
    const qEmail = `dm.optional.${t}@example.test`;
    const qAdded = await addDetail(q, qs.flow.id, { email: qEmail });
    const qRow = fieldOf(qAdded.verified?.body.flow, "email");
    results.check("adding the optional email on the page (with a code) → present and ticked (shared true)", qAdded.verified?.status === 200 && qRow?.missing === false && qRow.shared === true, qAdded.verified ? JSON.stringify(qRow) : brief(qAdded.sent));
    const qDone = qAdded.verified?.status === 200 ? await drive(q, qAdded.verified.body.flow) : null;
    const qTokens = qDone ? await exchangeCode(env, "dm", redirectParams(qDone).get("code") ?? "", qs.redirectUri, qs.verifier) : null;
    results.check("…continuing as the page stands shares it: dm gets the phone and the added email", qTokens?.status === 200 && qTokens.body.account.email === qEmail && qTokens.body.account.phone === qPhone, qTokens ? brief(qTokens) : "no flow");
    const qs2 = await startSignIn(q, "dm", { prompt: "consent" });
    const qPage2 = await q.act(qs2.flow.id, "continue");
    const qSwitch = await q.act(qs2.flow.id, "switch");
    results.check("\"Switch account\" from a details page → back at choose_method, no account offered", qPage2.body.flow?.step === "details" && qSwitch.status === 200 && qSwitch.body.flow.step === "choose_method" && qSwitch.body.flow.signed_in_as === null, `${brief(qPage2)} / ${brief(qSwitch)}`);

    // A required email for a phone-only Carbon (briefcase): added on the page with a code.
    const p = new Browserish(env, ctx.ip);
    const ps = await startSignIn(p, "dm");
    const phoneOnly = randomPhone();
    const ph = await sendCode(p, ps.flow.id, { phone: phoneOnly });
    await p.act(ps.flow.id, "verify", { code: ph.code ?? "" });
    await drive(p, (await p.act(ps.flow.id, "signup", {})).body.flow);
    const bs = await startSignIn(p, "briefcase");
    const bPage = await p.act(bs.flow.id, "continue");
    results.check("a phone-only Carbon continuing to briefcase → its page with the required email missing", bPage.body.flow?.step === "details" && fieldOf(bPage.body.flow, "email")?.missing === true && fieldOf(bPage.body.flow, "email")?.mode === "required", brief(bPage));
    const newEmail = `phone.only.${t}@example.test`;
    const addEmail = await addDetail(p, bs.flow.id, { email: newEmail });
    results.check("the email is added on the page with a code", addEmail.sent.status === 200 && addEmail.verified?.status === 200 && fieldOf(addEmail.verified.body.flow, "email")?.missing === false, `${brief(addEmail.sent)} / ${addEmail.verified ? brief(addEmail.verified) : "no code"}`);
    const pDone = addEmail.verified ? await drive(p, addEmail.verified.body.flow) : null;
    const pTokens = pDone ? await exchangeCode(env, "briefcase", redirectParams(pDone).get("code") ?? "", bs.redirectUri, bs.verifier) : null;
    results.check("…and briefcase gets it (verified)", pTokens?.status === 200 && pTokens.body.account.email === newEmail && pTokens.body.account.email_verified === true, pTokens ? brief(pTokens) : "no flow");
  },
};

const flowPages: Journey = {
  name: "auth-flows-flow-pages",
  title: "ledgerly's flow at the API: page 1 \"How can we reach you?\" (phone added with a code), page 2 \"About you\" (split, \"Review\"), the review lists what is shared, Back keeps choices, approve → the token; a returning Carbon skips the pages; prompt=consent shows them again; then once in the browser",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const b = new Browserish(env, ctx.ip);
    const s = await startSignIn(b, "ledgerly", { intent: "signup" });
    results.check("intent=signup is on the flow", s.flow.intent === "signup", String(s.flow.intent));
    const sent = await sendCode(b, s.flow.id, { email: `ledger.${t}@example.test` });
    await b.act(s.flow.id, "verify", { code: sent.code ?? "" });
    const p1 = await b.act(s.flow.id, "signup", { dob: "1990-02-14" });
    const d1 = p1.body.flow?.details;
    results.check("page 1 of 2: \"contact\", \"How can we reach you?\" with its subtitle, the phone required and missing, no review next", p1.body.flow?.step === "details" && d1?.id === "contact" && d1.index === 0 && d1.count === 2 && d1.title === "How can we reach you?" && d1.subtitle === "We text you when an invoice is paid." && d1.review_next === false && JSON.stringify(d1.fields.map(f => [f.field, f.mode, f.missing])) === '[["phone","required",true]]', JSON.stringify(d1));
    const phone = randomPhone();
    const added = await addDetail(b, s.flow.id, { phone });
    results.check("the phone is added on page 1 with a code (the page stays)", added.verified?.status === 200 && added.verified.body.flow.details?.id === "contact" && fieldOf(added.verified.body.flow, "phone")?.missing === false, added.verified ? brief(added.verified) : brief(added.sent));
    const p2 = await b.detailsContinue(s.flow.id, []);
    const d2 = p2.body.flow?.details;
    results.check("page 2 of 2: \"about-you\", \"About you\", split layout, \"Review\", dob required and timezone optional unticked", p2.status === 200 && d2?.id === "about-you" && d2.index === 1 && d2.count === 2 && d2.title === "About you" && d2.layout === "split" && d2.continue_label === "Review" && d2.review_next === true && fieldOf(p2.body.flow, "dob")?.mode === "required" && fieldOf(p2.body.flow, "dob")?.value === "1990-02-14" && fieldOf(p2.body.flow, "timezone")?.shared === false, JSON.stringify(d2));
    const rv = await b.detailsContinue(s.flow.id, ["timezone"]);
    const review = rv.body.flow?.review?.fields ?? [];
    results.check("the review page lists the profile first, then phone, dob and the ticked timezone (all shared)", rv.body.flow?.step === "review" && JSON.stringify(review.map(f => f.field)) === '["profile","phone","dob","timezone"]' && review.every(f => f.shared), JSON.stringify(review));
    const backFromReview = await b.detailsBack(s.flow.id);
    results.check("Back from the review → page 2 with the timezone still ticked (choices kept)", backFromReview.body.flow?.step === "details" && backFromReview.body.flow.details?.id === "about-you" && fieldOf(backFromReview.body.flow, "timezone")?.shared === true, brief(backFromReview));
    const backToFirst = await b.detailsBack(s.flow.id);
    results.check("Back again → page 1 (index 0)", backToFirst.body.flow?.details?.id === "contact" && backToFirst.body.flow.details.index === 0, brief(backToFirst));
    const noFurther = await b.detailsBack(s.flow.id);
    results.check("Back on page 1 → 409 no_previous_page", noFurther.status === 409 && errorCode(noFurther) === "no_previous_page", brief(noFurther));
    await b.detailsContinue(s.flow.id, []);
    const untick = await b.detailsContinue(s.flow.id, []);
    const kept = untick.body.flow?.review?.fields ?? [];
    results.check("continuing page 2 with the timezone unticked → the review no longer lists it", untick.body.flow?.step === "review" && !kept.some(f => f.field === "timezone"), JSON.stringify(kept));
    const approved = await b.review(s.flow.id, true);
    const tokens = await exchangeCode(env, "ledgerly", redirectParams(approved.body.flow).get("code") ?? "", s.redirectUri, s.verifier);
    results.check("approve → complete; ledgerly's token: phone and dob, no timezone (scope dob phone profile)", approved.body.flow?.step === "complete" && tokens.status === 200 && scopeSet(tokens.body.scope) === "dob phone profile" && tokens.body.account.phone === phone && tokens.body.account.dob === "1990-02-14" && tokens.body.account.timezone === undefined, brief(tokens));

    // A returning Carbon with everything granted skips the pages; prompt=consent shows them again.
    const again = await startSignIn(b, "ledgerly");
    const straight = await b.act(again.flow.id, "continue");
    results.check("signing in to ledgerly again → complete at once (no pages, no review)", straight.body.flow?.step === "complete" && !!redirectParams(straight.body.flow).get("code"), brief(straight));
    const consent = await startSignIn(b, "ledgerly", { prompt: "consent" });
    const shown = await b.act(consent.flow.id, "continue");
    results.check("prompt=consent → page 1 again, the phone previously granted", shown.body.flow?.step === "details" && shown.body.flow.details?.id === "contact" && fieldOf(shown.body.flow, "phone")?.previously_granted === true, brief(shown));
    const toReview = await b.detailsContinue(consent.flow.id, []);
    const atReview = await b.detailsContinue(consent.flow.id, ["timezone"]);
    const cancel = await b.review(consent.flow.id, false);
    results.check("…cancel on its review page → error=access_denied, and the grant is unchanged (dob phone profile)", toReview.status === 200 && atReview.body.flow?.step === "review" && redirectParams(cancel.body.flow).get("error") === "access_denied" && (await grantOf(env, "ledgerly", (await b.session())?.account.uuid ?? "")) === "dob phone profile", brief(cancel));

    // The browser: the same flow as a Carbon sees it (Step n of m, the split layout, the review, Back).
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "flow-pages");
    const email = `ledger.ui.${t}@example.test`;
    await startAtApp(env, page, "ledgerly", { intent: "signup" });
    const field = page.getByRole("textbox", { name: "Email" });
    await field.waitFor({ timeout: 30_000 });
    const heading = await hostedTitle(page);
    results.check("intent=signup: the methods page says \"Create your Ledgerly account\"", heading === "Create your Ledgerly account", heading);
    const after = await lastSeq(env);
    await field.fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, email, after);
    await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await page.keyboard.type(code, { delay: 25 });
    await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
    const walk = await completeDetails(env, page, "ledgerly", { add: { phone: randomPhone() }, tick: ["timezone"], stopAtReview: true, shotName: "auth-flows-flow-pages" });
    const [w1, w2] = walk.pages;
    results.check("page 1 \"How can we reach you?\" (Step 1 of 2), page 2 \"About you\" (Step 2 of 2) drawn split, its button \"Review\"", w1?.title === "How can we reach you?" && w1.progress === "Step 1 of 2" && w2?.title === "About you" && w2.progress === "Step 2 of 2" && w2.shownLayout === "split" && w2.continueLabel === "Review", JSON.stringify(walk.pages.map(p => ({ t: p.title, p: p.progress, l: p.shownLayout, c: p.continueLabel }))));
    results.check("the review page lists phone, dob and the ticked timezone (after the profile)", JSON.stringify(walk.review?.shared) === '["profile","phone","dob","timezone"]', JSON.stringify(walk.review));
    await page.getByRole("button", { name: "Back", exact: true }).click();
    // Wait for page 2 itself (the review keeps rendering while it morphs out).
    await live(page, DETAILS_LIST("Ledgerly")).first().waitFor({ timeout: 20_000 });
    await live(page, "span").filter({ hasText: /^Step 2 of 2$/ }).first().waitFor({ timeout: 10_000 });
    const backPage = await completeDetails(env, page, "ledgerly", { untick: ["timezone"], stopAtReview: true });
    results.check("Back from the review: page 2 again with the timezone still ticked; unticked there, the review no longer lists it as shared", backPage.pages[0]?.rows.find(r => r.field === "timezone")?.ticked === true && JSON.stringify(backPage.review?.shared) === '["profile","phone","dob"]', JSON.stringify({ rows: backPage.pages[0]?.rows, review: backPage.review }));
    await completeDetails(env, page, "ledgerly");
    const account = await appAccount(page);
    results.check("approved → ledgerly gets the phone and the dob, not the timezone", typeof account?.phone === "string" && typeof account.dob === "string" && !("timezone" in (account ?? {})), JSON.stringify(account).slice(0, 300));
    await context.close();
  },
};

export const journeys: Journey[] = [whatsShared, requiredDetails, flowPages];

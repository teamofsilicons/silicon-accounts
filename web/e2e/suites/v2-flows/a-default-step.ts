/**
 * An app without a flow of its own gets one page (build spec 06-v2.md §4: `flow: null` = ONE step containing every
 * requested field, `review: false`; that step IS the what's-shared screen; "Apps with no requested details still get
 * one what's-shared step showing the profile on the first sign-in").
 *
 * UNDERSTANDING.md "What's shared with the app": each detail is required or optional; `optional` comes with a
 * checkbox and "it's unticked until they do"; granted = profile + required + ticked optional.
 *
 * briefcase asks for email (required) and timezone (optional) with no flow: one page, "Share and continue", no step
 * count, no review. A Carbon who leaves the timezone unticked shares only the email; one who ticks it shares both.
 * A `scope` asking for a detail the app does not request adds it as an optional row of that page. An app that asks
 * for nothing (spacestation, emptied for the journey) still shows the profile once.
 */
import type { Journey } from "../../context";
import { POWERED_BY_HREF, hostedTitle, newContext, poweredBy, shot, signInWithCode, startAtApp } from "../../lib";
import { backAtApp, button, detailRows, flowIdOf, freshEmail, membershipOf, progressText, setTicked, uuidByEmail, waitForDetailsPage, waitForFlow, withConfig } from "./_helpers";

export const journey: Journey = {
  name: "v2-flows-default-step",
  title: "an app without its own flow (briefcase) shows one what's-shared page: email required and locked, timezone optional and unticked, \"Share and continue\", no review; unticked → not shared, ticked → shared; a scope-asked detail joins as optional; an app asking for nothing shows the profile once",
  async run(ctx) {
    const { env, results, browser } = ctx;
    /** The Carbon of part 2 (signed in to briefcase with everything shared): part 5 switches to them. */
    let returning = "";

    // 1. A new Carbon leaves the optional timezone unticked.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "default-unticked");
      const email = freshEmail("default");
      await startAtApp(env, page, "briefcase");
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      const flow = await waitForDetailsPage(page);
      const details = flow.details!;
      const field = (name: string) => details.fields.find(entry => entry.field === name);
      results.check(
        "the server describes one page: index 0 of 1, id \"details\", no title, subtitle, continue label or layout of its own, no review next",
        details.index === 0 && details.count === 1 && details.id === "details" && details.title === null && details.subtitle === null && details.continue_label === null && details.layout === null && details.review_next === false,
        JSON.stringify({ ...details, fields: undefined, challenge: undefined }),
      );
      results.check(
        "…email required (shared, present, masked), timezone optional and not shared until the Carbon ticks it",
        field("email")?.mode === "required" && field("email")?.shared === true && field("email")?.missing === false && /\*/.test(field("email")?.value ?? "") && field("timezone")?.mode === "optional" && field("timezone")?.shared === false && field("timezone")?.previously_granted === false,
        JSON.stringify(details.fields),
      );
      const title = await hostedTitle(page);
      results.check("the page reads \"Share your details with Briefcase\"", title === "Share your details with Briefcase", title);
      results.check("…with no \"Step n of m\" (one page)", (await progressText(page)) === null, String(await progressText(page)));
      const rows = await detailRows(page);
      const row = (name: string) => rows.find(entry => entry.field === name);
      results.check("the profile row comes first and is always shared", rows[0]?.field === "profile" && rows[0].tag === "Always", JSON.stringify(rows[0]));
      results.check("the email row is locked as Required (no checkbox)", row("email")?.mode === "required" && row("email")?.ticked === null && row("email")?.tag === "Required", JSON.stringify(row("email")));
      results.check("the timezone row is an Optional checkbox, unticked", row("timezone")?.mode === "optional" && row("timezone")?.ticked === false && row("timezone")?.tag === "Optional", JSON.stringify(row("timezone")));
      results.check("the page continues with \"Share and continue\" and offers Cancel, not Back", (await button(page, "Share and continue").count()) === 1 && (await button(page, "Cancel").count()) === 1 && (await button(page, "Back").count()) === 0);
      results.check("the account signing in is shown with \"Switch account\"", (await page.getByRole("button", { name: "Switch account" }).count()) === 1);
      const powered = await poweredBy(page);
      results.check("the page keeps \"Powered by Silicon Accounts\" linking to accounts.teamofsilicons.com", powered.href === POWERED_BY_HREF && powered.atEnd, JSON.stringify(powered));
      await shot(env, page, "v2f-a-01-default-page");
      const id = flowIdOf(page);
      await button(page, "Share and continue").click();
      const outcome = await backAtApp(env, page, "briefcase");
      results.check("briefcase gets the email and no timezone (left unticked)", outcome.account?.email === email && outcome.account.timezone === undefined, JSON.stringify(outcome.account).slice(0, 300));
      results.check("…its token's scope has email but not timezone", outcome.scope.includes("email") && !outcome.scope.includes("timezone"), outcome.scope.join(" "));
      const uuid = await uuidByEmail(env, email);
      const membership = uuid ? await membershipOf(env, "briefcase", uuid) : null;
      results.check("…and the membership grants profile + email only", membership?.status === "active" && JSON.stringify(membership.scopes) === JSON.stringify(["email", "profile"]), JSON.stringify(membership));
      results.check("the flow was a single details page (no review step)", !!id, String(id));
      await context.close();
    }

    // 2. Another new Carbon ticks the timezone: it is shared.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "default-ticked");
      const email = freshEmail("default-tick");
      returning = email;
      await startAtApp(env, page, "briefcase");
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      await waitForDetailsPage(page);
      await setTicked(page, "timezone", true);
      results.check("ticking the timezone shows it ticked", (await detailRows(page)).find(entry => entry.field === "timezone")?.ticked === true);
      await button(page, "Share and continue").click();
      const outcome = await backAtApp(env, page, "briefcase");
      results.check("briefcase gets the email and the ticked timezone (the browser's Asia/Kolkata)", outcome.account?.email === email && outcome.account.timezone === "Asia/Kolkata", JSON.stringify(outcome.account).slice(0, 300));
      const uuid = await uuidByEmail(env, email);
      const membership = uuid ? await membershipOf(env, "briefcase", uuid) : null;
      results.check("…and the membership grants profile + email + timezone", JSON.stringify(membership?.scopes) === JSON.stringify(["email", "profile", "timezone"]), JSON.stringify(membership));
      await context.close();
    }

    // 3. A scope asking for a detail briefcase does not request: an optional row on the same page (the phone, missing).
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "default-scope");
      const email = freshEmail("default-scope");
      await startAtApp(env, page, "briefcase", { extra: { scope: "profile email phone" } });
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      const flow = await waitForDetailsPage(page);
      const phone = flow.details?.fields.find(entry => entry.field === "phone");
      results.check("scope=…phone puts the phone on the page as an optional detail (missing for an email-only account)", flow.details?.count === 1 && phone?.mode === "optional" && phone.missing === true && phone.shared === false, JSON.stringify(flow.details?.fields));
      const row = (await detailRows(page)).find(entry => entry.field === "phone");
      results.check("…drawn as an optional row that cannot be ticked yet and offers Add", row?.mode === "optional" && row.missing && row.ticked === false && row.add, JSON.stringify(row));
      await button(page, "Share and continue").click();
      const outcome = await backAtApp(env, page, "briefcase");
      results.check("…continuing without it shares no phone", outcome.account?.email === email && outcome.account.phone === undefined, JSON.stringify(outcome.account).slice(0, 300));
      await context.close();
    }

    // 4. An app that asks for no details still shows one what's-shared page with the profile, once.
    await withConfig(ctx, "spacestation", { required_fields: [], optional_fields: [] }, async () => {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "default-nothing");
      const email = freshEmail("default-nothing");
      await startAtApp(env, page, "spacestation");
      await signInWithCode(env, page, { email });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      const flow = await waitForDetailsPage(page);
      const rows = await detailRows(page);
      results.check("an app asking for nothing: one page, no details of its own", flow.details?.count === 1 && (flow.details?.fields ?? []).filter(entry => entry.field !== "profile").length === 0, JSON.stringify(flow.details));
      results.check("…showing the profile (name, id and photo) as always shared", rows.length === 1 && rows[0]?.field === "profile" && rows[0].tag === "Always" && /Name, id and profile photo/.test(rows[0].text), JSON.stringify(rows));
      await shot(env, page, "v2f-a-02-profile-only");
      await button(page, "Share and continue").click();
      const outcome = await backAtApp(env, page, "spacestation");
      const uuid = await uuidByEmail(env, email);
      const membership = uuid ? await membershipOf(env, "spacestation", uuid) : null;
      results.check("…space station gets the profile only", !!outcome.account && outcome.account.email === undefined && outcome.account.timezone === undefined && JSON.stringify(membership?.scopes) === JSON.stringify(["profile"]), `${JSON.stringify(outcome.account).slice(0, 200)} ${JSON.stringify(membership)}`);
      // Signing in again: nothing new to share, so no page at all (spacestation does not remember the browser, so a code).
      const again = await context.newPage();
      results.watch(again, "default-nothing-again");
      await startAtApp(env, again, "spacestation");
      await signInWithCode(env, again, { email });
      const second = await backAtApp(env, again, "spacestation", 30_000);
      results.check("…and the next sign-in goes straight back to the app (the profile was shared already)", !!second.account && second.account.uuid === outcome.account?.uuid, JSON.stringify(second.account).slice(0, 160));
      await context.close();
    });

    // 5. "Switch account" on the details page: back to the methods (no Continue as), and another account signs in.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "default-switch");
      await startAtApp(env, page, "briefcase");
      await signInWithCode(env, page, { email: freshEmail("default-switch") });
      await page.getByRole("button", { name: "Create account" }).click({ timeout: 25_000 });
      await waitForDetailsPage(page);
      await page.getByRole("button", { name: "Switch account" }).click();
      const methods = await waitForFlow(page, f => f.step === "choose_method", "the methods page after Switch account");
      await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 15_000 });
      results.check("Switch account on the details page: back to briefcase's methods, without offering the browser's account", !(methods as { signed_in_as?: unknown }).signed_in_as && (await page.getByRole("button", { name: /^Continue as / }).count()) === 0, JSON.stringify((methods as { signed_in_as?: unknown }).signed_in_as ?? null));
      await signInWithCode(env, page, { email: returning });
      const other = await backAtApp(env, page, "briefcase");
      results.check("…another account (one that shared everything with briefcase before) then signs in straight to briefcase", other.account?.email === returning, JSON.stringify(other.account).slice(0, 200));
      await context.close();
    }
  },
};

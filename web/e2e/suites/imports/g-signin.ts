/**
 * An imported Carbon's first sign-in, with the hosted pages of UNDERSTANDING.md v2. legacy-crm takes no new accounts
 * (allow_signup false), so only imported people get in: they sign in with a code to the address the import carried,
 * land on "Finish setting up your account" prefilled with what the app imported and naming the app that imported them,
 * and finishing it makes the account active (same uuid, the proven address verified) and the membership active. Then
 * legacy-crm's details page: email required, phone, dob and timezone optional and unticked until the Carbon ticks them
 * (a missing required email is added there with a code). Afterwards the app sees only what was shared, an import never
 * demotes the Carbon, and never undoes a removed access.
 *
 * legacy-crm knows these people's emails and phones from its own records, but an app can never hand them to us: a
 * login_hint is ignored. Its own "Continue with phone number" button opens the hosted page on an empty phone field,
 * and its "Create an account" button (intent=signup) still finishes the imported account (first time is sign-up either
 * way), while a stranger is refused.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { appAccount, completeDetails, hostedTitle, newContext, readFlow, shot, signInWithCode, sleep, startAtApp, tag } from "../../lib";
import {
  accountsByUuid,
  allRows,
  appCall,
  describeRow,
  fakeApp,
  flowView,
  forgetImportBudgets,
  freshExchange,
  lastSeq,
  lit,
  messagesAfter,
  ownerOf,
  postJson,
  psql,
  rowsOf,
  textOf,
  waitJob,
  type FakeApp,
  type RowResult,
} from "./_helpers";

type Ctx = Parameters<Journey["run"]>[0];

async function importOne(ctx: Ctx, app: FakeApp, row: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<RowResult> {
  const answer = await postJson(ctx, app, { rows: [row], options }, { key: randomUUID() });
  if (!answer.body.job) throw new Error(`the import was refused: ${answer.status} ${JSON.stringify(answer.body)}`);
  const job = await waitJob(ctx, app, answer.body.job.id);
  const [result] = await allRows(ctx, app, job.id);
  if (!result) throw new Error(`job ${job.id} has no row`);
  return result;
}

/** The sign-up step's prefilled fields. */
async function prefill(page: Page) {
  const id = page.getByRole("textbox", { name: "Your id" });
  await id.waitFor({ timeout: 20_000 });
  await sleep(700);
  return {
    heading: await page.getByRole("heading", { name: "Finish setting up your account" }).count(),
    text: await textOf(page),
    id: await id.inputValue(),
    name: await page.getByRole("textbox", { name: "Display name" }).inputValue(),
    timezone: await page.getByRole("combobox", { name: "Timezone" }).inputValue(),
    dob: (await page.getByRole("button", { name: "Date of birth" }).innerText()).replace(/\s+/g, " "),
  };
}

interface AppUser {
  status?: string;
  history?: unknown[];
  email?: string | null;
  phone?: string | null;
  dob?: string | null;
  timezone?: string | null;
  granted_scopes?: string[];
  display_name?: string;
}

const rowsSeen = (walk: Awaited<ReturnType<typeof completeDetails>>) => JSON.stringify(walk.pages.map(page => page.rows.map(row => `${row.field}:${row.mode}${row.missing ? ":missing" : ""}:${row.ticked}`)));

export const journeys: Journey[] = [
  {
    name: "imports-signin-email",
    title: "an imported Carbon signs into legacy-crm with an email code (a login_hint with it ignored) → \"Finish setting up\" prefilled from the import and naming Legacy CRM → legacy-crm's details page (email required, the rest optional and unticked) → active account and membership, the app sees only what was shared; re-imports never demote it or undo a removed access; strangers can't sign up",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const crm = fakeApp("legacy-crm");
      await forgetImportBudgets(env, crm.app_id);
      const t = tag();
      const exchange = await freshExchange(env, ["415"]);
      const email = `fin.ward@${t}.legacy-crm.test`;
      const row = { external_id: `fin-${t}`, email: `Fin.Ward@${t}.Legacy-CRM.test`, phone: `+1415${exchange}0188`, display_name: "Fin Ward", username: `fin_${t}`, dob: "14/03/1991", timezone: "Europe/Paris" };
      const imported = await importOne(ctx, crm, row);
      const uuid = imported.account_uuid ?? "";
      results.check("the import creates c:fin_<tag> (unclaimed)", imported.outcome === "created" && imported.id === `c:fin_${t}` && !!uuid, describeRow(imported));
      const statsBefore = (await appCall<{ stats?: { imported_unclaimed?: number } }>(ctx, crm, "/v1/apps/legacy-crm")).body.stats;
      const userBefore = await appCall<AppUser>(ctx, crm, `/v1/apps/legacy-crm/users/${uuid}`);
      results.check(
        "before signing in, legacy-crm's user base has them as imported, with no sign-in, showing what legacy-crm itself supplied (email, phone, dob, timezone)",
        userBefore.status === 200 && userBefore.body.status === "imported" && (userBefore.body.history ?? []).length === 0 && userBefore.body.email === email && userBefore.body.phone === row.phone && userBefore.body.dob === "1991-03-14" && userBefore.body.timezone === "Europe/Paris",
        JSON.stringify(userBefore.body).slice(0, 400),
      );

      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "imports-signin");
      // legacy-crm knows the email from its own records; it can't hand it to us (UNDERSTANDING.md: the Carbon always
      // types it on our pages).
      await startAtApp(env, page, "legacy-crm", { extra: { login_hint: email } });
      const field = page.getByRole("textbox", { name: "Email" });
      await field.waitFor({ timeout: 30_000 });
      await page.waitForURL(/\/authorize\/flow\//, { timeout: 15_000 }).catch(() => undefined);
      await sleep(500);
      const hinted = await readFlow(page);
      results.check("legacy-crm's link with login_hint=<the imported email>: ignored (the field is empty, the flow never mentions it)", (await field.inputValue()) === "" && !!hinted && !JSON.stringify(hinted).toLowerCase().includes(email) && !("login_hint" in hinted), `field "${await field.inputValue()}"; flow ${JSON.stringify(hinted).slice(0, 160)}`);
      results.check("the page is legacy-crm's sign-in page (\"Sign in to Legacy CRM\")", (await hostedTitle(page)) === "Sign in to Legacy CRM", await hostedTitle(page));
      const code = await signInWithCode(env, page, { email: email.toUpperCase() });
      results.check("the code goes to the imported address (typed in upper case, sent to the normalized one)", code.length === 6, email);
      const seen = await prefill(page);
      await shot(env, page, "imports-signin-01-finish");
      results.check("the sign-up step says \"Finish setting up your account\" and that Legacy CRM added them", seen.heading === 1 && seen.text.includes("Legacy CRM added you to Silicon Accounts. Check the details it gave us, then continue.") && seen.text.includes(email), seen.text.slice(0, 300));
      results.check("it is prefilled with what legacy-crm imported: id, name, timezone, date of birth", seen.id === `fin_${t}` && seen.name === "Fin Ward" && /Paris/.test(seen.timezone) && /March 14, 1991/.test(seen.dob), JSON.stringify({ ...seen, text: undefined }));
      const flow = await flowView(page);
      results.check("the flow (API) is at signup with finishing_import true and the imported details", flow?.step === "signup" && flow.signup?.finishing_import === true && flow.signup.id === `c:fin_${t}` && flow.signup.display_name === "Fin Ward" && flow.signup.timezone === "Europe/Paris" && flow.signup.dob === "1991-03-14", JSON.stringify(flow?.signup ?? flow).slice(0, 400));
      results.check("…and names the app that imported them (imported_by legacy-crm), which the page repeats for the id (\"This is the id Legacy CRM set up for you.\")", flow?.signup?.imported_by?.app_id === "legacy-crm" && flow.signup.imported_by.name === "Legacy CRM" && seen.text.includes("This is the id Legacy CRM set up for you."), `${JSON.stringify(flow?.signup?.imported_by)}; ${/This is the id[^.]*\./.exec(seen.text)?.[0] ?? seen.text.slice(0, 200)}`);
      await page.getByRole("button", { name: "Finish setup" }).click();
      const walk = await completeDetails(env, page, "legacy-crm", { shotName: "imports-signin-02" });
      const details = walk.pages[0];
      const rowOf = (field: string) => details?.rows.find(item => item.field === field);
      results.check(
        "then legacy-crm's one details page: email required (already there, the proven address), phone, dob and timezone optional and unticked",
        walk.pages.length === 1 && rowOf("email")?.mode === "required" && !rowOf("email")?.missing && ["phone", "dob", "timezone"].every(field => rowOf(field)?.mode === "optional" && rowOf(field)?.ticked === false) && walk.review === null,
        rowsSeen(walk),
      );
      results.check("…the phone the import listed is missing there (nobody proved it), not filled in from the import", rowOf("phone")?.missing === true, JSON.stringify(rowOf("phone")));
      const account = await appAccount(page);
      results.check("legacy-crm receives the account the import created (same uuid and id), with the email and none of the unticked details", account?.uuid === uuid && account.id === `c:fin_${t}` && account.email === email && account.dob === undefined && account.timezone === undefined && account.phone === undefined, JSON.stringify(account).slice(0, 300));

      const [finished] = [...(await accountsByUuid(env, [uuid])).values()];
      results.check("the account is active, its email verified, the import's details kept", finished?.status === "active" && finished.emails.length === 1 && finished.emails[0]!.email === email && finished.emails[0]!.verified && finished.display_name === "Fin Ward" && finished.dob === "1991-03-14" && finished.timezone === "Europe/Paris" && finished.handle === `c:fin_${t}`, JSON.stringify(finished).slice(0, 400));
      results.check("the phone the import listed is not on the account (nobody proved it)", finished?.phones.length === 0, JSON.stringify(finished?.phones));
      results.check("the membership is active now (source stays import, external id kept)", finished?.membership?.status === "active" && finished.membership.source === "import" && finished.membership.external_id === `fin-${t}`, JSON.stringify(finished?.membership).slice(0, 300));
      const userAfter = await appCall<AppUser>(ctx, crm, `/v1/apps/legacy-crm/users/${uuid}`);
      results.check("legacy-crm's user base shows them active with one sign-in", userAfter.body.status === "active" && (userAfter.body.history ?? []).length === 1 && userAfter.body.email === email, JSON.stringify(userAfter.body).slice(0, 300));
      results.check(
        "…and from now on only what the Carbon shared (UNDERSTANDING.md: the details they've shared with it): granted profile + email; the imported phone, dob and timezone are no longer shown",
        JSON.stringify([...(userAfter.body.granted_scopes ?? [])].sort()) === JSON.stringify(["email", "profile"]) && !userAfter.body.phone && !userAfter.body.dob && !userAfter.body.timezone,
        JSON.stringify({ scopes: userAfter.body.granted_scopes, phone: userAfter.body.phone, dob: userAfter.body.dob, timezone: userAfter.body.timezone }),
      );
      const statsAfter = (await appCall<{ stats?: { imported_unclaimed?: number } }>(ctx, crm, "/v1/apps/legacy-crm")).body.stats;
      results.check("one fewer imported-and-unclaimed user in the app's stats", (statsBefore?.imported_unclaimed ?? 0) - (statsAfter?.imported_unclaimed ?? 0) === 1, `${statsBefore?.imported_unclaimed} → ${statsAfter?.imported_unclaimed}`);

      // Imports afterwards: matched, never demoted to imported, and the account untouched.
      const again = await importOne(ctx, crm, { ...row, display_name: "Fin Renamed By CRM", timezone: "Asia/Tokyo" });
      const [still] = [...(await accountsByUuid(env, [uuid])).values()];
      results.check("re-importing an active member matches it and keeps the membership active (never back to imported)", again.outcome === "matched" && again.account_uuid === uuid && still?.membership?.status === "active", `${describeRow(again)}; membership ${still?.membership?.status}`);
      results.check("…and its own name and timezone stay the Carbon's", still?.display_name === "Fin Ward" && still.timezone === "Europe/Paris", `${still?.display_name} ${still?.timezone}`);

      // The Carbon removes legacy-crm's access on the account site; an import never brings it back.
      await page.goto(`${env.site}/apps`);
      const removed = await page.evaluate(async () => (await fetch("/v1/me/apps/legacy-crm", { method: "DELETE" })).status);
      const [afterRemoval] = await rowsOf<{ status: string }>(env, `select status from memberships where app_id = 'legacy-crm' and account_uuid = ${lit(uuid)}`);
      results.check("the Carbon removes legacy-crm's access", [200, 204].includes(removed) && afterRemoval?.status === "access_removed", `${removed} → ${afterRemoval?.status}`);
      const third = await importOne(ctx, crm, row);
      const [afterThird] = await rowsOf<{ status: string }>(env, `select status from memberships where app_id = 'legacy-crm' and account_uuid = ${lit(uuid)}`);
      results.check("an import after that skips the row with warning access_removed, and the access stays removed", third.outcome === "skipped" && third.messages.some(m => m.code === "access_removed" && m.level === "warning") && afterThird?.status === "access_removed", `${describeRow(third)}; membership ${afterThird?.status}`);
      await context.close();

      // Someone legacy-crm never imported can't sign up there.
      const strangerContext = await newContext(browser);
      const strangerPage = await strangerContext.newPage();
      results.watch(strangerPage, "imports-signin-stranger", [/status of 403/]);
      const stranger = `stranger.${t}@example.test`;
      await startAtApp(env, strangerPage, "legacy-crm");
      await signInWithCode(env, strangerPage, { email: stranger });
      const refusal = strangerPage.getByText(/doesn.t accept new accounts/);
      const refused = await refusal.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await shot(env, strangerPage, "imports-signin-03-stranger");
      results.check("a Carbon legacy-crm never imported is told it takes no new accounts", refused && (await textOf(strangerPage)).includes("This app does not take new accounts"), (await textOf(strangerPage)).slice(0, 300));
      results.check("…and no account is made for them", (await ownerOf(env, stranger)) === null);
      await strangerContext.close();
    },
  },
  {
    name: "imports-signin-phone",
    title: "a phone-only imported Carbon presses legacy-crm's own \"Continue with phone number\" (the hosted page opens on an empty phone field, a phone login_hint ignored), signs in by SMS, finishes setting up from the import, then legacy-crm's details page asks for the email it requires (added there with a code) and offers the phone unticked; one active account, both addresses verified",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const crm = fakeApp("legacy-crm");
      await forgetImportBudgets(env, crm.app_id);
      const t = tag();
      const exchange = await freshExchange(env, ["415"]);
      const phone = `+1415${exchange}0177`;
      const email = `pia.${t}@example.test`;
      const imported = await importOne(ctx, crm, { external_id: `pia-${t}`, phone: `(415) ${exchange}-0177`, display_name: "Pia Phone", username: `pia_${t}`, dob: "1988-08-08", timezone: "America/Los_Angeles" }, { default_country: "US" });
      const uuid = imported.account_uuid ?? "";
      const [before] = [...(await accountsByUuid(env, [uuid])).values()];
      results.check("the import creates c:pia_<tag> carrying the local number normalized, unverified", imported.outcome === "created" && before?.phones[0]?.phone === phone && before.phones[0]?.verified === false && before.emails.length === 0, `${describeRow(imported)} ${JSON.stringify(before?.phones)}`);

      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "imports-signin-phone");
      // legacy-crm's own "Continue with phone number" button, with the number it has on file as a login_hint.
      const authorize = await startAtApp(env, page, "legacy-crm", { method: "phone", extra: { login_hint: phone } });
      const phoneField = page.getByRole("textbox", { name: "Phone number" });
      const opened = await phoneField.waitFor({ timeout: 30_000 }).then(() => true, () => false);
      await sleep(500);
      const value = opened ? (await phoneField.inputValue()).replace(/[\s+]/g, "") : "?";
      const flowAtStart = await readFlow(page);
      results.check(
        "legacy-crm's direct phone button opens the hosted page straight on the phone field, empty (the login_hint with its number is ignored)",
        authorize.searchParams.get("method") === "phone" && opened && value === "" && flowAtStart?.method_hint === "phone" && !JSON.stringify(flowAtStart).includes(phone.slice(2)),
        `method=${authorize.searchParams.get("method")}; field "${opened ? await phoneField.inputValue() : "not shown"}"; method_hint ${flowAtStart?.method_hint}`,
      );
      await signInWithCode(env, page, { phone });
      const seen = await prefill(page);
      results.check("the SMS code leads to \"Finish setting up\" prefilled from the import", seen.heading === 1 && seen.id === `pia_${t}` && seen.name === "Pia Phone" && /Los.Angeles/.test(seen.timezone) && /August 8, 1988/.test(seen.dob) && seen.text.includes("Legacy CRM added you to Silicon Accounts."), JSON.stringify({ ...seen, text: seen.text.slice(0, 160) }));
      await page.getByRole("button", { name: "Finish setup" }).click();
      const after = await lastSeq(env);
      const walk = await completeDetails(env, page, "legacy-crm", { add: { email }, tick: ["phone"], shotName: "imports-signin-04-requires-email" });
      const details = walk.pages[0];
      const rowOf = (field: string) => details?.rows.find(item => item.field === field);
      results.check(
        "legacy-crm's details page asks for the email it requires (required, missing: added there with a code) and offers the proven phone as optional, unticked",
        walk.pages.length === 1 && rowOf("email")?.mode === "required" && rowOf("email")?.missing === true && details?.added.includes("email") === true && rowOf("phone")?.mode === "optional" && rowOf("phone")?.missing === false && rowOf("phone")?.ticked === false,
        rowsSeen(walk),
      );
      const mailed = (await messagesAfter(env, after)).filter(item => item.to === email);
      results.check("the email's code went to the address the Carbon typed (one code)", mailed.length === 1, mailed.map(item => `${item.channel} to ${item.to}`).join(", "));
      const account = await appAccount(page);
      results.check("legacy-crm receives the imported uuid with the email it required and the phone the Carbon ticked", account?.uuid === uuid && account.email === email && account.phone === phone && account.dob === undefined, JSON.stringify(account).slice(0, 300));
      const [finished] = [...(await accountsByUuid(env, [uuid])).values()];
      results.check("one active account: the phone it proved and the email it added, both verified; the membership active", finished?.status === "active" && finished.phones.length === 1 && finished.phones[0]!.phone === phone && finished.phones[0]!.verified && finished.emails.length === 1 && finished.emails[0]!.email === email && finished.emails[0]!.verified && finished.membership?.status === "active", JSON.stringify(finished).slice(0, 500));
      const duplicates = await psql(env, `select count(*) from account_phones where phone = ${lit(phone)}`);
      results.check("no second account was made for that phone", duplicates === "1", `${duplicates} rows`);
      const user = await appCall<AppUser>(ctx, crm, `/v1/apps/legacy-crm/users/${uuid}`);
      results.check("legacy-crm's user base: active, the email and phone shared, no dob or timezone", user.body.status === "active" && user.body.email === email && user.body.phone === phone && !user.body.dob && !user.body.timezone, JSON.stringify(user.body).slice(0, 300));
      await context.close();
    },
  },
  {
    name: "imports-signin-intent-signup",
    title: "legacy-crm's own \"Create an account\" (intent=signup): the sign-up version of the hosted page; an imported Carbon still finishes the account legacy-crm imported (same uuid) and may pick its own id and name there; a stranger is refused (no new accounts), and the finished Carbon pressing it again just signs in",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const crm = fakeApp("legacy-crm");
      await forgetImportBudgets(env, crm.app_id);
      const t = tag();
      const email = `sana.${t}@legacy-crm.test`;
      const imported = await importOne(ctx, crm, { external_id: `sana-${t}`, email, display_name: "Sana Signup", username: `sana_${t}`, timezone: "Asia/Dubai" });
      const uuid = imported.account_uuid ?? "";
      results.check("legacy-crm imports c:sana_<tag> (unclaimed)", imported.outcome === "created" && !!uuid, describeRow(imported));

      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "imports-signin-intent");
      const authorize = await startAtApp(env, page, "legacy-crm", { intent: "signup" });
      const title = await hostedTitle(page);
      results.check("the app's \"Create an account\" opens the sign-up version of its hosted page (intent=signup: \"Create your Legacy CRM account\")", authorize.searchParams.get("intent") === "signup" && title === "Create your Legacy CRM account", `${authorize.searchParams.get("intent")}: ${title}`);
      await signInWithCode(env, page, { email });
      const seen = await prefill(page);
      await shot(env, page, "imports-signin-05-intent-signup");
      results.check("an imported Carbon who came to sign up finishes the account legacy-crm imported (\"Finish setting up your account\", its id and name)", seen.heading === 1 && seen.id === `sana_${t}` && seen.name === "Sana Signup" && /Asia.Dubai|Dubai/.test(seen.timezone), JSON.stringify({ ...seen, text: seen.text.slice(0, 160) }));
      // The prefill is the Carbon's to change: another id and name than the ones legacy-crm chose.
      await page.getByRole("textbox", { name: "Your id" }).fill(`sana_own_${t}`);
      await page.getByRole("textbox", { name: "Display name" }).fill("Sana Her Own Name");
      await sleep(900);
      await page.getByRole("button", { name: "Finish setup" }).click();
      await completeDetails(env, page, "legacy-crm");
      const account = await appAccount(page);
      const [member] = await rowsOf<{ status: string; accounts: number }>(env, `select m.status, (select count(*)::int from account_emails where email = ${lit(email)}) as accounts from memberships m where m.app_id = 'legacy-crm' and m.account_uuid = ${lit(uuid)}`);
      results.check("legacy-crm gets the imported uuid; the membership is active; still one account with that email", account?.uuid === uuid && member?.status === "active" && member.accounts === 1, `${JSON.stringify(account).slice(0, 160)} ${JSON.stringify(member)}`);
      const [finished] = [...(await accountsByUuid(env, [uuid])).values()];
      results.check("the id and name the Carbon chose while finishing replace the imported ones: on the account and at legacy-crm (same uuid)", finished?.handle === `c:sana_own_${t}` && finished.display_name === "Sana Her Own Name" && account?.id === `c:sana_own_${t}` && account.display_name === "Sana Her Own Name", `${finished?.handle} "${finished?.display_name}"; app got ${account?.id} "${account?.display_name}"`);
      const [ids] = await rowsOf<{ history: string[]; reserved: string | null }>(env, `select array(select coalesce(old_handle, '-') || '>' || new_handle from handle_history where account_uuid = ${lit(uuid)} order by changed_at, id) as history,
          (select account_uuid from handle_reservations where handle = ${lit(`c:sana_${t}`)} and reserved_until > now()) as reserved`);
      results.check("the id history has the import's id then the Carbon's own, and the imported id stays reserved for this account (10 days)", JSON.stringify(ids?.history) === JSON.stringify([`->c:sana_${t}`, `c:sana_${t}>c:sana_own_${t}`]) && ids?.reserved === uuid, JSON.stringify(ids));
      await context.close();

      // A stranger pressing "Create an account" at an app that takes no new accounts.
      const strangerContext = await newContext(browser);
      const strangerPage = await strangerContext.newPage();
      results.watch(strangerPage, "imports-signin-intent-stranger", [/status of 403/]);
      const stranger = `nobody.${t}@example.test`;
      await startAtApp(env, strangerPage, "legacy-crm", { intent: "signup" });
      await signInWithCode(env, strangerPage, { email: stranger });
      const refused = await strangerPage.getByText(/doesn.t accept new accounts/).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await shot(env, strangerPage, "imports-signin-06-intent-stranger");
      results.check("a stranger who came to sign up is told legacy-crm takes no new accounts, and no account is made", refused && (await ownerOf(env, stranger)) === null, (await textOf(strangerPage)).slice(0, 300));
      await strangerContext.close();

      // The finished Carbon presses "Create an account" again, in a fresh browser: it is a sign-in now.
      const againContext = await newContext(browser);
      const againPage = await againContext.newPage();
      results.watch(againPage, "imports-signin-intent-again");
      await startAtApp(env, againPage, "legacy-crm", { intent: "signup" });
      await signInWithCode(env, againPage, { email });
      const walk = await completeDetails(env, againPage, "legacy-crm");
      const again = await appAccount(againPage);
      results.check("pressing \"Create an account\" again with that email just signs in: no sign-up step, no details page (nothing new to share), the same uuid", again?.uuid === uuid && walk.pages.length === 0 && (await psql(env, `select count(*) from account_emails where email = ${lit(email)}`)) === "1", `${JSON.stringify(again).slice(0, 160)}; ${walk.pages.length} details pages`);
      await againContext.close();
    },
  },
];

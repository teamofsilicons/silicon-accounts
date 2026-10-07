/**
 * An imported Carbon's first sign-in. legacy-crm takes no new accounts (allow_signup false), so only imported people
 * get in: they sign in with a code to the address the import carried, land on "Finish setting up your account"
 * prefilled with what the app imported, and finishing it makes the account active (same uuid, the proven address
 * verified) and the membership active. Afterwards an import never demotes them, and never undoes a removed access.
 * A phone-only import signs in by SMS and is then asked for the email legacy-crm requires.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { afterConsent, appAccount, codeFor, lastSeq, newContext, shot, sleep, tag } from "../../lib";
import {
  accountsByUuid,
  allRows,
  appCall,
  describeRow,
  fakeApp,
  flowView,
  forgetImportBudgets,
  freshExchange,
  lit,
  ownerOf,
  postJson,
  psql,
  rowsOf,
  waitJob,
  type FakeApp,
  type RowResult,
} from "./_helpers";

type Ctx = Parameters<Journey["run"]>[0];

async function importOne(ctx: Ctx, crm: FakeApp, row: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<RowResult> {
  const answer = await postJson(ctx, crm, { rows: [row], options }, { key: randomUUID() });
  if (!answer.body.job) throw new Error(`the import was refused: ${answer.status} ${JSON.stringify(answer.body)}`);
  const job = await waitJob(ctx, crm, answer.body.job.id);
  const [result] = await allRows(ctx, crm, job.id);
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
    text: (await page.locator("main").innerText()).replace(/\s+/g, " "),
    id: await id.inputValue(),
    name: await page.getByRole("textbox", { name: "Display name" }).inputValue(),
    timezone: await page.getByRole("combobox", { name: "Timezone" }).inputValue(),
    dob: (await page.getByRole("button", { name: "Date of birth" }).innerText()).replace(/\s+/g, " "),
  };
}

export const journeys: Journey[] = [
  {
    name: "imports-signin-email",
    title: "an imported Carbon signs into legacy-crm with an email code → \"Finish setting up\" prefilled from the import → active account and membership; re-imports never demote it or undo a removed access; strangers can't sign up",
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
      const userBefore = await appCall<{ status?: string; history?: unknown[] }>(ctx, crm, `/v1/apps/legacy-crm/users/${uuid}`);
      results.check("before signing in, legacy-crm's user base has them as imported, with no sign-in", userBefore.status === 200 && userBefore.body.status === "imported" && (userBefore.body.history ?? []).length === 0, JSON.stringify(userBefore.body).slice(0, 300));

      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "imports-signin");
      await page.goto(`${env.apps}/legacy-crm/`);
      await page.locator("#signin-hosted").click();
      const field = page.getByRole("textbox", { name: "Email" });
      await field.waitFor({ timeout: 30_000 });
      const after = await lastSeq(env);
      await field.fill(email.toUpperCase());
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const code = await codeFor(env, email, after);
      results.check("the code goes to the imported address (typed in upper case, sent to the normalized one)", code.length === 6, email);
      await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
      await page.keyboard.type(code, { delay: 30 });
      const seen = await prefill(page);
      await shot(env, page, "imports-signin-01-finish");
      results.check("the sign-up step says \"Finish setting up your account\" and that Legacy CRM added them", seen.heading === 1 && /Legacy CRM added you to Silicon Accounts/.test(seen.text) && seen.text.includes(email), seen.text.slice(0, 300));
      results.check("it is prefilled with what legacy-crm imported: id, name, timezone, date of birth", seen.id === `fin_${t}` && seen.name === "Fin Ward" && /Paris/.test(seen.timezone) && /March 14, 1991/.test(seen.dob), JSON.stringify(seen).slice(0, 300));
      const flow = await flowView(page);
      results.check("the flow (API) is at signup with finishing_import true and the imported details", flow?.step === "signup" && flow.signup?.finishing_import === true && flow.signup.id === `c:fin_${t}` && flow.signup.display_name === "Fin Ward" && flow.signup.timezone === "Europe/Paris" && flow.signup.dob === "1991-03-14", JSON.stringify(flow).slice(0, 400));
      results.check("…and names the app that imported them (imported_by legacy-crm), which the page repeats for the id (\"This is the id Legacy CRM set up for you.\")", flow?.signup?.imported_by?.app_id === "legacy-crm" && flow.signup.imported_by.name === "Legacy CRM" && seen.text.includes("This is the id Legacy CRM set up for you."), `${JSON.stringify(flow?.signup?.imported_by)}; ${/This is the id[^.]*\./.exec(seen.text)?.[0] ?? seen.text.slice(0, 200)}`);
      await page.getByRole("button", { name: "Finish setup" }).click();
      await afterConsent(env, page, "legacy-crm", "imports-signin-02");
      const account = await appAccount(page);
      results.check("legacy-crm receives the account the import created (same uuid and id)", account?.uuid === uuid && account.id === `c:fin_${t}`, JSON.stringify(account).slice(0, 300));

      const [finished] = [...(await accountsByUuid(env, [uuid])).values()];
      results.check("the account is active, its email verified, the import's details kept", finished?.status === "active" && finished.emails.length === 1 && finished.emails[0]!.email === email && finished.emails[0]!.verified && finished.display_name === "Fin Ward" && finished.dob === "1991-03-14" && finished.timezone === "Europe/Paris" && finished.handle === `c:fin_${t}`, JSON.stringify(finished).slice(0, 400));
      results.check("the phone the import listed is not on the account (nobody proved it)", finished?.phones.length === 0, JSON.stringify(finished?.phones));
      results.check("the membership is active now (source stays import, external id kept)", finished?.membership?.status === "active" && finished.membership.source === "import" && finished.membership.external_id === `fin-${t}`, JSON.stringify(finished?.membership).slice(0, 300));
      const userAfter = await appCall<{ status?: string; history?: unknown[]; email?: string }>(ctx, crm, `/v1/apps/legacy-crm/users/${uuid}`);
      results.check("legacy-crm's user base shows them active with one sign-in", userAfter.body.status === "active" && (userAfter.body.history ?? []).length === 1 && userAfter.body.email === email, JSON.stringify(userAfter.body).slice(0, 300));
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
      await strangerPage.goto(`${env.apps}/legacy-crm/`);
      await strangerPage.locator("#signin-hosted").click();
      const strangerField = strangerPage.getByRole("textbox", { name: "Email" });
      await strangerField.waitFor({ timeout: 30_000 });
      const before = await lastSeq(env);
      await strangerField.fill(stranger);
      await strangerPage.getByRole("button", { name: "Continue", exact: true }).click();
      const strangerCode = await codeFor(env, stranger, before);
      await strangerPage.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
      await strangerPage.keyboard.type(strangerCode, { delay: 30 });
      const refusal = strangerPage.getByText(/doesn.t accept new accounts/);
      const refused = await refusal.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await shot(env, strangerPage, "imports-signin-03-stranger");
      results.check("a Carbon legacy-crm never imported is told it takes no new accounts", refused, (await strangerPage.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300));
      results.check("…and no account is made for them", (await ownerOf(env, stranger)) === null);
      await strangerContext.close();
    },
  },
  {
    name: "imports-signin-phone",
    title: "a phone-only imported Carbon signs into legacy-crm by SMS, finishes setting up from the import, then adds the email legacy-crm requires; one active account with both addresses verified",
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
      await page.goto(`${env.apps}/legacy-crm/`);
      await page.locator("#signin-hosted").click();
      await page.getByRole("button", { name: "Phone", exact: true }).click({ timeout: 30_000 });
      const field = page.getByRole("textbox", { name: "Phone number" });
      await field.click();
      let after = await lastSeq(env);
      await page.keyboard.type(phone, { delay: 25 });
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const sms = await codeFor(env, phone, after);
      await page.getByRole("group", { name: /Code/ }).first().waitFor({ timeout: 15_000 });
      await page.keyboard.type(sms, { delay: 30 });
      const seen = await prefill(page);
      results.check("the SMS code leads to \"Finish setting up\" prefilled from the import", seen.heading === 1 && seen.id === `pia_${t}` && seen.name === "Pia Phone" && /Los.Angeles/.test(seen.timezone) && /August 8, 1988/.test(seen.dob), JSON.stringify(seen).slice(0, 300));
      await page.getByRole("button", { name: "Finish setup" }).click();
      const emailField = page.getByRole("textbox", { name: "Email" });
      await emailField.waitFor({ timeout: 20_000 });
      const asked = (await page.locator("main").innerText()).replace(/\s+/g, " ");
      await shot(env, page, "imports-signin-04-requires-email");
      results.check("legacy-crm then asks for the email it requires", /Legacy CRM needs an email/i.test(asked) || /email/i.test(asked), asked.slice(0, 200));
      after = await lastSeq(env);
      await emailField.fill(email);
      await page.getByRole("button", { name: "Send code" }).click();
      const mailCode = await codeFor(env, email, after);
      await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
      await page.keyboard.type(mailCode, { delay: 30 });
      await afterConsent(env, page, "legacy-crm", "imports-signin-05");
      const account = await appAccount(page);
      results.check("legacy-crm receives the imported uuid with the email it required", account?.uuid === uuid && account.email === email, JSON.stringify(account).slice(0, 300));
      const [finished] = [...(await accountsByUuid(env, [uuid])).values()];
      results.check("one active account: the phone it proved and the email it added, both verified; the membership active", finished?.status === "active" && finished.phones.length === 1 && finished.phones[0]!.phone === phone && finished.phones[0]!.verified && finished.emails.length === 1 && finished.emails[0]!.email === email && finished.emails[0]!.verified && finished.membership?.status === "active", JSON.stringify(finished).slice(0, 500));
      const duplicates = await psql(env, `select count(*) from account_phones where phone = ${lit(phone)}`);
      results.check("no second account was made for that phone", duplicates === "1", `${duplicates} rows`);
      await context.close();
    },
  },
];

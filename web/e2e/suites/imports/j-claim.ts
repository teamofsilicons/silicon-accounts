/**
 * Finishing an imported account somewhere else, and late. UNDERSTANDING.md: an imported Carbon finishes setting the
 * account up "the first time they sign in" — which can be another app and another method: signing into briefcase
 * with Google using the imported email finishes the account legacy-crm imported (same uuid, the import's details as
 * the prefill), while legacy-crm's membership stays imported until they sign in there (then active, in one click).
 * The page names the app whose import created the account (the flow's `imported_by`), never simply the app being
 * signed into: when pixel-studio imports someone legacy-crm already imported, the second import only matches, and
 * finishing at pixel-studio says Legacy CRM added them. And the 48-hour sign-up session of a finishing import expires
 * (time travel): finishing is refused with a reason that reads, the account stays unclaimed, and a new code finishes it.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { Journey } from "../../context";
import { afterConsent, appAccount, codeFor, lastSeq, newContext, shot, sleep, tag } from "../../lib";
import { accountsByUuid, allRows, appCall, describeRow, fakeApp, flowView, forgetImportBudgets, importRows, lit, postJson, psql, rowsOf, waitJob, type FakeApp, type RowResult } from "./_helpers";

type Ctx = Parameters<Journey["run"]>[0];

async function importOne(ctx: Ctx, crm: FakeApp, row: Record<string, unknown>): Promise<RowResult> {
  const answer = await postJson(ctx, crm, { rows: [row], options: {} }, { key: randomUUID() });
  if (!answer.body.job) throw new Error(`the import was refused: ${answer.status} ${JSON.stringify(answer.body)}`);
  const job = await waitJob(ctx, crm, answer.body.job.id);
  const [result] = await allRows(ctx, crm, job.id);
  if (!result) throw new Error(`job ${job.id} has no row`);
  return result;
}

const pageText = async (page: Page) => (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");

export const journeys: Journey[] = [
  {
    name: "imports-claim-elsewhere",
    title: "a Carbon legacy-crm imported first signs into briefcase with Google: the imported account is finished there (same uuid, the import's details), legacy-crm's membership stays imported until they sign in to it, then turns active in one click",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const crm = fakeApp("legacy-crm");
      await forgetImportBudgets(env, crm.app_id);
      const t = tag();
      const email = `gina.${t}@gmail.test`;
      const imported = await importOne(ctx, crm, { external_id: `gina-${t}`, email, display_name: "Gina Imported", username: `gina_${t}`, dob: "1985-05-05", timezone: "Asia/Tokyo" });
      const uuid = imported.account_uuid ?? "";
      results.check("legacy-crm imports c:gina_<tag> (unclaimed)", imported.outcome === "created" && !!uuid, describeRow(imported));

      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "imports-claim-google");
      await page.goto(`${env.apps}/briefcase/`);
      await page.locator("#signin-hosted").click();
      await page.getByRole("button", { name: "Continue with Google" }).click({ timeout: 30_000 });
      await page.waitForURL(new RegExp(env.oidc.replace(/[.:/]/g, "\\$&")), { timeout: 30_000 });
      await page.locator('#new-identity input[name="_auto"]').fill(email);
      await page.locator('#new-identity input[name="_name"]').fill("Gina From Google");
      await page.locator('#new-identity button[data-action="use-another"]').click();
      const idField = page.getByRole("textbox", { name: "Your id" });
      await idField.waitFor({ timeout: 30_000 });
      await sleep(700);
      const text = await pageText(page);
      await shot(env, page, "imports-claim-01-briefcase-google");
      const seen = {
        id: await idField.inputValue(),
        name: await page.getByRole("textbox", { name: "Display name" }).inputValue(),
        timezone: await page.getByRole("combobox", { name: "Timezone" }).inputValue(),
        dob: (await page.getByRole("button", { name: "Date of birth" }).innerText()).replace(/\s+/g, " "),
      };
      results.check("Google with the imported email at briefcase leads to \"Finish setting up your account\", not a new sign-up", /Finish setting up your account/.test(text) && (await page.getByRole("button", { name: "Finish setup" }).count()) === 1, text.slice(0, 300));
      results.check("…prefilled with what legacy-crm imported (not Google's name)", seen.id === `gina_${t}` && seen.name === "Gina Imported" && /Tokyo/.test(seen.timezone) && /May 5, 1985/.test(seen.dob), JSON.stringify(seen));
      results.check("…and it doesn't say Briefcase added them: legacy-crm did", !/Briefcase added you/.test(text) && !/id Briefcase set up for you/.test(text), text.match(/[^.]*added you[^.]*\.|This is the id[^.]*\./g)?.join(" | ") ?? text.slice(0, 200));
      results.check(
        "…it names legacy-crm and where they are going: \"Legacy CRM added you to Silicon Accounts. Check the details it gave us, then continue to Briefcase.\" and \"This is the id Legacy CRM set up for you.\"",
        text.includes("Legacy CRM added you to Silicon Accounts. Check the details it gave us, then continue to Briefcase.") && text.includes("This is the id Legacy CRM set up for you."),
        text.match(/[^.]*added you[^.]*\.[^.]*\.|This is the id[^.]*\./g)?.join(" | ") ?? text.slice(0, 200),
      );
      const flow = await flowView(page);
      results.check("the flow (API) at briefcase says who imported them: imported_by legacy-crm (Legacy CRM)", flow?.signup?.finishing_import === true && flow.signup.imported_by?.app_id === "legacy-crm" && flow.signup.imported_by.name === "Legacy CRM", JSON.stringify(flow?.signup ?? flow).slice(0, 300));
      await page.getByRole("button", { name: "Finish setup" }).click();
      await afterConsent(env, page, "briefcase", "imports-claim-02");
      const atBriefcase = await appAccount(page);
      results.check("briefcase receives the account legacy-crm imported (same uuid)", atBriefcase?.uuid === uuid && atBriefcase.id === `c:gina_${t}`, JSON.stringify(atBriefcase).slice(0, 300));
      const [after] = [...(await accountsByUuid(env, [uuid])).values()];
      const identities = await rowsOf<{ provider: string }>(env, `select provider from identities where account_uuid = ${lit(uuid)}`);
      const [briefcaseMember] = await rowsOf<{ status: string }>(env, `select status from memberships where app_id = 'briefcase' and account_uuid = ${lit(uuid)}`);
      results.check("the account is active, the email verified, Google linked, the import's name kept", after?.status === "active" && after.emails[0]?.email === email && after.emails[0]?.verified === true && identities.some(identity => identity.provider === "google") && after.display_name === "Gina Imported", `${JSON.stringify(after).slice(0, 300)} identities ${JSON.stringify(identities)}`);
      results.check("legacy-crm's membership stays imported (they haven't signed in there); briefcase's is active", after?.membership?.status === "imported" && briefcaseMember?.status === "active", `legacy-crm ${after?.membership?.status}, briefcase ${briefcaseMember?.status}`);

      // Now legacy-crm, from the same browser: Continue as, consent, active.
      await page.goto(`${env.apps}/legacy-crm/`);
      await page.locator("#signin-hosted").click();
      const continueAs = page.getByRole("button", { name: /^Continue as/ });
      const offered = await continueAs.waitFor({ timeout: 30_000 }).then(() => true, () => false);
      results.check("legacy-crm offers \"Continue as\" the finished account", offered, (await pageText(page)).slice(0, 200));
      if (offered) {
        await continueAs.click();
        await afterConsent(env, page, "legacy-crm", "imports-claim-03");
        const atCrm = await appAccount(page);
        const [member] = await rowsOf<{ status: string; source: string; external_id: string }>(env, `select status, source, external_id from memberships where app_id = 'legacy-crm' and account_uuid = ${lit(uuid)}`);
        results.check("legacy-crm gets the same uuid, and its membership turns active (external id kept)", atCrm?.uuid === uuid && member?.status === "active" && member.external_id === `gina-${t}`, `${JSON.stringify(atCrm).slice(0, 160)} ${JSON.stringify(member)}`);
      }
      await context.close();
    },
  },
  {
    name: "imports-signup-expired",
    title: "the 48-hour sign-up session of a finishing import expires (time travel): finishing is refused with the reason, the account stays unclaimed and imported, and a new code finishes it",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const crm = fakeApp("legacy-crm");
      await forgetImportBudgets(env, crm.app_id);
      const t = tag();
      const email = `late.${t}@legacy-crm.test`;
      const imported = await importOne(ctx, crm, { external_id: `late-${t}`, email, display_name: "Lou Late", username: `late_${t}`, dob: "1979-09-19", timezone: "Europe/Lisbon" });
      const uuid = imported.account_uuid ?? "";

      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "imports-expired", [/status of 410/]);
      const reachFinish = async () => {
        const field = page.getByRole("textbox", { name: "Email" });
        await field.waitFor({ timeout: 30_000 });
        const after = await lastSeq(env);
        await field.fill(email);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        const code = await codeFor(env, email, after);
        await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
        await page.keyboard.type(code, { delay: 30 });
        await page.getByRole("button", { name: "Finish setup" }).waitFor({ timeout: 20_000 });
      };
      await page.goto(`${env.apps}/legacy-crm/`);
      await page.locator("#signin-hosted").click();
      await reachFinish();
      const [session] = await rowsOf<{ id: string; claim: string | null }>(env, `select id, claim_account_uuid as claim from signup_sessions where verified_email = ${lit(email)} and consumed_at is null order by created_at desc limit 1`);
      results.check("the sign-up session names the imported account it finishes", session?.claim === uuid, JSON.stringify(session));
      await psql(env, `update signup_sessions set expires_at = now() - interval '1 second' where id = ${lit(session?.id ?? randomUUID())}`);
      await page.getByRole("button", { name: "Finish setup" }).click();
      const alert = page.getByText("Your sign-up expired");
      const told = await alert.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      await sleep(1500);
      const text = await pageText(page);
      await shot(env, page, "imports-expired-01");
      results.check("48 hours later, finishing is refused: back at the sign-in methods with \"Your sign-up expired\" and what to do", told && /Verify the email or phone/.test(text) && (await page.getByRole("textbox", { name: "Email" }).isVisible()), text.slice(0, 400));
      const reason = /The sign-up session expired[^.]*\./.exec(text)?.[0] ?? "";
      results.check("…in a sentence that reads (no dangling \"expired at:\" where the time was cut out)", !!reason && !/expired at:/.test(reason), reason || text.slice(0, 300));
      const sentence = "The sign-up session expired. A verified email, phone or provider account stays ready for sign-up for 48 hours.";
      results.check(`…the whole reason reads "${sentence}", with no UTC instant left in it`, text.includes(sentence) && !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), /The sign-up session expired.{0,140}/.exec(text)?.[0] ?? text.slice(0, 300));
      const [still] = [...(await accountsByUuid(env, [uuid])).values()];
      results.check("…the account stays unclaimed with its unverified email, and the membership imported", still?.status === "unclaimed" && still.emails[0]?.verified === false && still.membership?.status === "imported", JSON.stringify(still).slice(0, 300));

      // A new code finishes it.
      const emailField = page.getByRole("textbox", { name: "Email" });
      if (!(await emailField.isVisible().catch(() => false))) {
        await page.goto(`${env.apps}/legacy-crm/`);
        await page.locator("#signin-hosted").click();
      }
      await reachFinish();
      await page.getByRole("button", { name: "Finish setup" }).click();
      await afterConsent(env, page, "legacy-crm", "imports-expired-02");
      const account = await appAccount(page);
      const [finished] = [...(await accountsByUuid(env, [uuid])).values()];
      results.check("a new code finishes the same account: active, the email verified, the membership active", account?.uuid === uuid && finished?.status === "active" && finished.emails[0]?.verified === true && finished.membership?.status === "active", `${JSON.stringify(account).slice(0, 160)} ${finished?.status}/${finished?.membership?.status}`);
      await context.close();
    },
  },
  {
    name: "imports-claim-second-importer",
    title: "two apps import the same new person: the second import matches the account the first created; signing in to the second app finishes it, and the page names the app that created it (Legacy CRM), not the one being signed into; each membership keeps its own state",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const crm = fakeApp("legacy-crm");
      const pixel = fakeApp("pixel-studio");
      await forgetImportBudgets(env, crm.app_id);
      await forgetImportBudgets(env, pixel.app_id);
      const t = tag();
      const email = `xena.${t}@example.test`;
      const first = await importRows(ctx, crm, [{ external_id: `xena-${t}`, email, display_name: "Xena From The CRM", username: `xena_${t}`, dob: "1990-10-10", timezone: "Africa/Lagos" }]);
      const uuid = first.rows[0]?.account_uuid ?? "";
      results.check("legacy-crm's import creates the account (c:xena_<tag>, unclaimed)", first.rows[0]?.outcome === "created" && first.rows[0].id === `c:xena_${t}` && !!uuid, describeRow(first.rows[0]));
      const second = await importRows(ctx, pixel, [{ external_id: `px-xena-${t}`, email: email.toUpperCase(), display_name: "Xena As Pixel Knows Her", username: `xena_px_${t}`, timezone: "Asia/Tokyo" }]);
      results.check("pixel-studio's import of the same email matches that account (matched, same uuid; nothing new is created)", second.rows[0]?.outcome === "matched" && second.rows[0].account_uuid === uuid && second.job.counts.created === 0, describeRow(second.rows[0]));
      const [both] = await rowsOf<{ crm: string | null; pixel: string | null; status: string; name: string; handle: string }>(env, `select (select status from memberships where app_id = 'legacy-crm' and account_uuid = a.uuid) as crm,
          (select status from memberships where app_id = 'pixel-studio' and account_uuid = a.uuid) as pixel, a.status, a.display_name as name, a.handle from accounts a where a.uuid = ${lit(uuid)}`);
      results.check("…so the unclaimed account has two imported memberships, and keeps the first import's details (an import never overwrites an account)", both?.crm === "imported" && both.pixel === "imported" && both.status === "unclaimed" && both.name === "Xena From The CRM" && both.handle === `c:xena_${t}`, JSON.stringify(both));

      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "imports-claim-second");
      await page.goto(`${env.apps}/pixel-studio/`);
      await page.locator("#signin-hosted").click();
      const field = page.getByRole("textbox", { name: "Email" });
      await field.waitFor({ timeout: 30_000 });
      const after = await lastSeq(env);
      await field.fill(email);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const code = await codeFor(env, email, after);
      await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
      await page.keyboard.type(code, { delay: 30 });
      const idField = page.getByRole("textbox", { name: "Your id" });
      await idField.waitFor({ timeout: 30_000 });
      await sleep(700);
      const text = await pageText(page);
      await shot(env, page, "imports-claim-04-second-importer");
      const flow = await flowView(page);
      results.check("at pixel-studio, the email code leads to \"Finish setting up your account\" prefilled with the account's details (legacy-crm's import)", /Finish setting up your account/.test(text) && (await idField.inputValue()) === `xena_${t}` && (await page.getByRole("textbox", { name: "Display name" }).inputValue()) === "Xena From The CRM", text.slice(0, 300));
      results.check(
        "…and names the app whose import created the account: \"Legacy CRM added you to Silicon Accounts. Check the details it gave us, then continue to Pixel Studio.\" (flow imported_by legacy-crm)",
        text.includes("Legacy CRM added you to Silicon Accounts. Check the details it gave us, then continue to Pixel Studio.") && text.includes("This is the id Legacy CRM set up for you.") && !/Pixel Studio added you/.test(text) && flow?.signup?.imported_by?.app_id === "legacy-crm",
        `${text.match(/[^.]*added you[^.]*\.[^.]*\.|This is the id[^.]*\./g)?.join(" | ") ?? text.slice(0, 200)}; imported_by ${JSON.stringify(flow?.signup?.imported_by)}`,
      );
      await page.getByRole("button", { name: "Finish setup" }).click();
      await afterConsent(env, page, "pixel-studio", "imports-claim-05");
      const atPixel = await appAccount(page);
      const [finished] = await rowsOf<{ crm: string | null; pixel: string | null; status: string; email_verified: boolean }>(env, `select (select status from memberships where app_id = 'legacy-crm' and account_uuid = a.uuid) as crm,
          (select status from memberships where app_id = 'pixel-studio' and account_uuid = a.uuid) as pixel, a.status,
          (select verified_at is not null from account_emails where account_uuid = a.uuid and email = ${lit(email)}) as email_verified from accounts a where a.uuid = ${lit(uuid)}`);
      results.check("pixel-studio receives that account (same uuid); it is active with the email verified; pixel-studio's membership is active, legacy-crm's still imported", atPixel?.uuid === uuid && finished?.status === "active" && finished.email_verified === true && finished.pixel === "active" && finished.crm === "imported", `${JSON.stringify(atPixel).slice(0, 160)} ${JSON.stringify(finished)}`);
      const crmView = await appCall<{ status?: string; email?: string | null; external_id?: string }>(ctx, crm, `/v1/apps/legacy-crm/users/${uuid}`);
      results.check("legacy-crm's user base still shows them as imported, with the email it supplied", crmView.body.status === "imported" && crmView.body.email === email && crmView.body.external_id === `xena-${t}`, JSON.stringify(crmView.body).slice(0, 300));
      await context.close();
    },
  },
];

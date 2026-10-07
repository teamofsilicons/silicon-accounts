/**
 * The Import tab (UNDERSTANDING "The app's user base": an app imports its existing users; each one is matched to the
 * account that already has their email or phone, otherwise a Carbon account is created that they finish on their
 * first sign-in). Legacy CRM's owner imports a dirty file on the developer site: a column Silicon Accounts doesn't keep
 * (named before anything is sent, then ignored on purpose), a username that is already someone's c:id, an email that
 * already has an account, a broken phone, a row without any email or phone, the same email twice in another case, a
 * local phone number read with the default country. A file without identifiers is stopped in the browser; the dry run
 * writes nothing and hides which account matched; "Import for real" repeats it exactly; the report filters and opens
 * rows; Recent imports lists both; the users land in the user base; the imported Carbon finishes setting up at the app.
 */
import { readFileSync } from "node:fs";
import type { Journey } from "../../context";
import { completeDetails, developerApi, newContext, shot, signInOnSite, signInWithCode, sleep, sql, startAtApp, tag, appAccount } from "../../lib";
import { freshEmail, ownerSignIn, pressSegment } from "./_helpers";
import { siteCall, until, type ImportJobView } from "./_kit";

const APP = "legacy-crm";

interface RowView {
  row_number: number;
  outcome: string;
  id: string | null;
  account_uuid: string | null;
  messages: Array<{ level: string; code: string; message: string; field: string | null }>;
  input: Record<string, unknown>;
}

interface UserView {
  uuid: string;
  id: string | null;
  display_name: string;
  email?: string | null;
  phone?: string | null;
  status: string;
  source: string;
  external_id: string | null;
  first_signed_in_at: string | null;
}

const ALLOWED_TEMPLATE_COLUMNS = ["external_id", "email", "emails", "phone", "phones", "display_name", "name", "username", "dob", "timezone", "pfp_url", "email_verified"];

export const journey: Journey = {
  name: "developer-site-import",
  title: "the Import tab with dirty data: a file without identifiers stopped in the browser; an unknown column named, then ignored; an id already taken, an existing account, a broken phone, a row without identifiers, a repeat in another case, a local number with a default country; a dry run that writes nothing; Import for real with the same counts; the report's filters and rows; Recent imports; the user base; the imported Carbon finishing setup",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();

    // A Carbon who already has an account (to be matched), whose c:id another row wants as its username.
    const existingEmail = freshEmail("imp-existing");
    const existing = await newContext(browser);
    const existingPage = await existing.newPage();
    results.watch(existingPage, "import-existing");
    await signInOnSite(env, existingPage, existingEmail);
    const me = await siteCall<{ uuid?: string; id?: string }>(existingPage, env, "GET", "/v1/me");
    const takenHandle = String(me.body.id ?? "").replace(/^c:/, "");
    await existing.close();

    const newEmail = `ds-imp-new-${t}@example.test`;
    const csv = [
      "email,display_name,username,external_id,phone,plan",
      `${newEmail},New Person ${t},dsnew${t},crm-${t}-1,,gold`,
      `${existingEmail},Matched Person ${t},,crm-${t}-2,,silver`,
      `ds-imp-taken-${t}@example.test,Taken Name ${t},${takenHandle},crm-${t}-3,,gold`,
      `ds-imp-badphone-${t}@example.test,Bad Phone ${t},,crm-${t}-4,12ab,gold`,
      `,No Identifier ${t},,crm-${t}-5,,gold`,
      `${newEmail.toUpperCase()},Again ${t},,crm-${t}-6,,gold`,
      `ds-imp-local-${t}@example.test,Local Phone ${t},,crm-${t}-7,98765 43210,`,
    ].join("\n");

    const { context, page } = await ownerSignIn(ctx, APP, { label: "import", returnTo: `/apps/${APP}/import` });
    try {
      const panel = page.getByRole("tabpanel", { name: "Import" });
      await panel.getByRole("button", { name: "Paste instead" }).waitFor({ timeout: 30_000 });
      const jobs = async () => (await developerApi<{ items?: ImportJobView[] }>(env, page, `/apps/${APP}/imports?limit=20`)).body.items ?? [];
      const jobsBefore = (await jobs()).length;

      // The template: only the columns Silicon Accounts gives.
      const download = page.waitForEvent("download", { timeout: 10_000 });
      await panel.getByRole("button", { name: "Download a CSV template" }).click();
      const file = await download;
      const template = readFileSync((await file.path()) ?? "", "utf8");
      const header = (template.split(/\r?\n/)[0] ?? "").split(",").map(cell => cell.trim());
      results.check("the CSV template has a header of the import columns only", file.suggestedFilename() === `${APP}-users-template.csv` && header.length > 2 && header.every(column => ALLOWED_TEMPLATE_COLUMNS.includes(column)) && header.includes("email"), `${file.suggestedFilename()}: ${header.join(",")}`);

      // A pasted file with no email or phone column is stopped before anything is sent.
      await panel.getByRole("button", { name: "Paste instead" }).click();
      await panel.getByRole("textbox", { name: "Paste CSV or JSON" }).fill("display_name,username\nNo One,noone");
      // (The stepper's own "Check columns" step comes first in the page.)
      await panel.getByRole("button", { name: "Check columns", exact: true }).last().click();
      const stop = panel.getByRole("alert").filter({ hasText: "No column holds an email or phone number" });
      await stop.waitFor({ timeout: 10_000 }).catch(() => undefined);
      results.check("a file without an email or phone column is stopped in the browser, saying why, and cannot continue", (await stop.count()) === 1 && (await panel.getByRole("button", { name: "Continue to options" }).isDisabled()) && (await jobs()).length === jobsBefore, (await stop.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200));
      await panel.getByRole("button", { name: "Choose another file" }).click();

      // The dirty file.
      const input = page.locator('input[type="file"]').first();
      await input.waitFor({ state: "attached", timeout: 10_000 });
      await input.setInputFiles({ name: "crm-export.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
      // A warning (role status), not an error.
      const unknown = panel.locator('[role="status"], [role="alert"]').filter({ hasText: "Silicon Accounts doesn't keep" }).first();
      await unknown.waitFor({ timeout: 15_000 });
      const unknownText = (await unknown.innerText()).replace(/\s+/g, " ");
      const chips = (await panel.getByRole("region", { name: "Columns" }).getByRole("listitem").allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim());
      const sampleHead = (await panel.getByRole("region", { name: "First rows" }).locator("thead th").allInnerTexts()).map(text => text.trim());
      results.check("the column check names plan as a column Silicon Accounts doesn't keep, and blocks Continue until decided", /1 column Silicon Accounts doesn't keep/.test(unknownText) && /^plan\./.test(unknownText.replace(/^.*?doesn't keep\s*/, "")) && chips.some(chip => /plan not kept/.test(chip)) && (await panel.getByRole("button", { name: "Continue to options" }).isDisabled()), `${unknownText.slice(0, 160)} | ${chips.join(", ")}`);
      results.check("…and the first rows show only the columns it keeps", !sampleHead.includes("plan") && ["email", "display_name", "username", "external_id", "phone"].every(column => sampleHead.includes(column)), sampleHead.join(","));
      await shot(env, page, "ds-m-01-columns", true);
      await panel.getByRole("button", { name: "Ignore them and continue" }).click();
      await panel.getByRole("button", { name: "Continue to options" }).click();

      // Options: a default country for the local number.
      const country = panel.getByRole("combobox", { name: "Default country for phone numbers" });
      await country.click();
      await page.keyboard.type("India", { delay: 10 });
      await sleep(250);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await sleep(200);
      const countryValue = await country.inputValue().catch(() => "");
      results.check("the default country is chosen (India, +91), and the button says how many rows go in", /India/.test(countryValue) && (await panel.getByRole("button", { name: "Import 7 rows" }).count()) === 1, countryValue);

      // The dry run writes nothing.
      const dryStarted = Date.now();
      await panel.getByRole("button", { name: "Do a dry run" }).click();
      await panel.getByText("Dry run finished", { exact: true }).waitFor({ timeout: 60_000 });
      results.metric("dry run of 7 rows → report", Date.now() - dryStarted, "ms");
      const dry = (await jobs())[0];
      const counts = (job: ImportJobView | undefined) => (job ? `created ${job.counts.created}, matched ${job.counts.matched}, updated ${job.counts.updated}, skipped ${job.counts.skipped}, error ${job.counts.error}` : "no job");
      const want = "created 4, matched 1, updated 0, skipped 1, error 1";
      results.check("the dry run: 4 created, 1 matched, 1 skipped (the repeat), 1 error (no identifier), with warnings", dry?.dry_run === true && counts(dry) === want && (dry?.counts.warnings ?? 0) >= 2, `${counts(dry)}, warnings ${dry?.counts.warnings}`);
      const written = await sql(env, `select count(*) from account_emails where email like 'ds-imp-%-${t}@example.test'`).catch(async () => sql(env, `select count(*) from accounts where display_name like '%${t}' and display_name not like 'Ds %'`));
      results.check("…and wrote nothing", Number(written[0]?.[0] ?? "-1") === 0, `rows with this run's addresses: ${written[0]?.[0]}`);
      const reportText = (await panel.innerText()).replace(/\s+/g, " ");
      results.check("its report says so: \"Nothing was written. 5 rows would go through, 1 row would fail and 1 would be skipped.\"", /Nothing was written\. 5 rows would go through, 1 row would fail and 1 would be skipped\./.test(reportText), reportText.slice(reportText.indexOf("Dry run finished"), reportText.indexOf("Dry run finished") + 160));
      const dryRows = (await developerApi<{ items?: RowView[] }>(env, page, `/apps/${APP}/imports/${dry?.id}/rows?limit=50`)).body.items ?? [];
      const dryMatched = dryRows.find(row => row.outcome === "matched");
      const matchedCell = (await panel.locator("table tbody tr").filter({ hasText: "Matched" }).first().innerText().catch(() => "")).replace(/\s+/g, " ");
      results.check("…without saying which account matched (\"hidden in a dry run\")", !!dryMatched && dryMatched.id === null && /hidden in a dry run/.test(matchedCell), `${JSON.stringify(dryMatched).slice(0, 160)} | ${matchedCell}`);

      // Import for real: the same file and options.
      const realStarted = Date.now();
      await panel.getByRole("button", { name: "Import for real" }).click();
      await panel.getByText("Import finished", { exact: true }).waitFor({ timeout: 60_000 });
      results.metric("import of 7 rows → report", Date.now() - realStarted, "ms");
      await sleep(500);
      const real = (await jobs())[0];
      results.check("Import for real repeats it exactly: the same counts", real?.dry_run === false && real.id !== dry?.id && counts(real) === want && real.counts.warnings === dry?.counts.warnings && real.options?.default_country === "IN" && real.options?.ignore_unknown_columns === true, `${counts(real)}, warnings ${real?.counts.warnings}, options ${JSON.stringify(real?.options)}`);
      const realText = (await panel.innerText()).replace(/\s+/g, " ");
      results.check("its report: \"4 accounts created, 1 matched to existing accounts, 0 updated; 1 row failed and 1 was skipped.\"", /4 accounts created, 1 matched to existing accounts, 0 updated; 1 row failed and 1 was skipped\./.test(realText), realText.slice(realText.indexOf("Import finished"), realText.indexOf("Import finished") + 160));
      await shot(env, page, "ds-m-02-report", true);
      const rows = (await developerApi<{ items?: RowView[] }>(env, page, `/apps/${APP}/imports/${real?.id}/rows?limit=50`)).body.items ?? [];
      const rowWith = (fragment: string) => rows.find(row => JSON.stringify(row.input).toLowerCase().includes(fragment.toLowerCase()));
      const codes = (row: RowView | undefined) => (row?.messages ?? []).map(message => `${message.level}:${message.code}`);
      const taken = rowWith(`Taken Name ${t}`);
      results.check("the username that is already a c:id: created with another id and an id_conflict warning saying so", taken?.outcome === "created" && !!taken.id && taken.id !== `c:${takenHandle}` && codes(taken).includes("warning:id_conflict"), `${taken?.id} ${codes(taken).join(" ")} ${taken?.messages.find(message => message.code === "id_conflict")?.message ?? ""}`);
      const bad = rowWith(`Bad Phone ${t}`);
      results.check("the broken phone: still created (the email is enough), with an invalid_phone warning", bad?.outcome === "created" && codes(bad).includes("warning:invalid_phone"), codes(bad).join(" "));
      const none = rowWith(`No Identifier ${t}`);
      results.check("the row without email or phone: an error, missing_identifier", none?.outcome === "error" && codes(none).includes("error:missing_identifier"), codes(none).join(" "));
      const again = rowWith(`Again ${t}`);
      results.check("the same email again in capitals: skipped as duplicate_in_file", again?.outcome === "skipped" && codes(again).some(code => code.endsWith(":duplicate_in_file")), `${again?.outcome} ${codes(again).join(" ")}`);
      const matched = rowWith(`Matched Person ${t}`);
      results.check("the email that already has an account: matched to it (the account it matched is named in the real import)", matched?.outcome === "matched" && matched.account_uuid === me.body.uuid, `${matched?.outcome} ${matched?.account_uuid} vs ${me.body.uuid}`);
      results.check("the ignored plan column is noted on the rows that had a value in it", codes(rowWith(`New Person ${t}`)).includes("warning:unknown_columns") && !codes(rowWith(`Local Phone ${t}`)).includes("warning:unknown_columns"), `${codes(rowWith(`New Person ${t}`)).join(" ")} | ${codes(rowWith(`Local Phone ${t}`)).join(" ")}`);

      // The report's filters and a row's detail.
      await pressSegment(panel, "Show rows", "Errors");
      await sleep(600);
      const errorRows = (await panel.locator("table tbody tr").allInnerTexts()).map(text => text.replace(/\s+/g, " "));
      results.check("Show rows · Errors lists only the failed row, with its code", errorRows.length === 1 && /missing_identifier/.test(errorRows[0] ?? ""), errorRows.join(" | "));
      await pressSegment(panel, "Show rows", "All");
      await sleep(400);
      await panel.getByRole("button", { name: "Show only rows with id_conflict" }).first().click();
      await sleep(600);
      const conflictRows = (await panel.locator("table tbody tr").allInnerTexts()).map(text => text.replace(/\s+/g, " "));
      results.check("a message code filters the rows to that code", conflictRows.length === 1 && /id_conflict/.test(conflictRows[0] ?? ""), conflictRows.join(" | "));
      await panel.getByRole("button", { name: /^Open row / }).first().click();
      const drawer = page.getByRole("dialog", { name: `Row ${taken?.row_number}` });
      await drawer.waitFor({ timeout: 10_000 });
      await sleep(400);
      const rowDetail = (await drawer.innerText()).replace(/\s+/g, " ");
      results.check("the row's drawer: its outcome and id, each message in full, and the row as read", /Created/.test(rowDetail) && rowDetail.includes(taken?.id ?? "?") && /id_conflict/.test(rowDetail) && rowDetail.includes(takenHandle), rowDetail.slice(0, 300));
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);

      // Recent imports: the import, then its dry run.
      await panel.getByRole("button", { name: "Start another import" }).click();
      const recent = panel.getByRole("region", { name: "Recent imports" }).getByRole("listitem");
      await recent.first().waitFor({ timeout: 10_000 });
      const [newest, next] = (await recent.allInnerTexts()).map(text => text.replace(/\s+/g, " "));
      results.check("Recent imports lists the import first (4 created · 1 matched · 1 error), then its dry run, marked", /CSV · 7 rows/.test(newest ?? "") && /4 created · 1 matched · 1 error/.test(newest ?? "") && !/Dry run/.test(newest ?? "") && /Dry run/.test(next ?? ""), `${newest} | ${next}`);

      // The user base: the imported users, with what the app gave.
      const users = (await developerApi<{ items?: UserView[] }>(env, page, `/apps/${APP}/users?limit=200&q=${encodeURIComponent(t)}`)).body.items ?? [];
      const created = users.find(user => user.external_id === `crm-${t}-1`);
      const local = users.find(user => user.external_id === `crm-${t}-7`);
      const matchedUser = users.find(user => user.uuid === me.body.uuid) ?? (await developerApi<UserView>(env, page, `/apps/${APP}/users/${me.body.uuid}`)).body;
      results.check("the user base has them: imported, from Import, with the external id and imported email; the local number read as +91", created?.status === "imported" && created.source === "import" && created.email === newEmail && local?.phone === "+919876543210", JSON.stringify({ created, local: local?.phone }).slice(0, 300));
      results.check("the matched account joined Legacy CRM's user base with its external id", matchedUser?.uuid === me.body.uuid && matchedUser.external_id === `crm-${t}-2`, JSON.stringify(matchedUser).slice(0, 200));

      // The imported Carbon signs in for the first time: they finish setting up their account, then they are active.
      const carbon = await newContext(browser);
      const carbonPage = await carbon.newPage();
      results.watch(carbonPage, "import-first-signin");
      await startAtApp(env, carbonPage, APP);
      await signInWithCode(env, carbonPage, { email: newEmail });
      const finish = carbonPage.getByRole("button", { name: "Finish setup" });
      await finish.waitFor({ timeout: 25_000 });
      const setupText = (await carbonPage.locator("main").first().innerText()).replace(/\s+/g, " ");
      await shot(env, carbonPage, "ds-m-03-finish-setup");
      results.check("their first sign-in finishes the account the import made (\"Finish setup\", the imported name and username filled in)", /New Person/.test(setupText) || (await carbonPage.getByRole("textbox").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value).join(" "))).includes(`New Person ${t}`), setupText.slice(0, 200));
      await finish.click();
      await completeDetails(env, carbonPage, APP, {});
      const account = await appAccount(carbonPage);
      results.check("…and Legacy CRM receives them as c:dsnew<tag>, the username it asked for", account?.id === `c:dsnew${t}` && account.email === newEmail, JSON.stringify(account).slice(0, 200));
      const activeNow = await until(async () => {
        const user = (await developerApi<UserView>(env, page, `/apps/${APP}/users/${String(account?.uuid ?? "")}`)).body;
        return user?.status === "active" ? user : null;
      }, 10_000);
      results.check("the user base now shows them active, signed in", activeNow?.status === "active" && !!activeNow.first_signed_in_at && activeNow.external_id === `crm-${t}-1`, JSON.stringify(activeNow).slice(0, 200));
      await carbon.close();
    } finally {
      await context.close();
    }
  },
};

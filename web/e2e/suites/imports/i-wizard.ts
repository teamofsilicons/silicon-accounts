/**
 * The import wizard on the developer pages, as legacy-crm's owner: upload → check columns (the browser names the
 * columns and shows the first rows before anything is sent) → options → a dry run → "Import for real" → the report
 * (totals, filters, a row's detail) → Recent imports; columns Silicon Accounts doesn't keep must be acknowledged;
 * a pasted file without an email or phone column can't go on; the user base then lists the imported Carbons.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "../../context";
import { newContext, shot, signInOnSite, sleep, tag } from "../../lib";
import { FIXTURES, fakeApp, forgetImportBudgets, lastSeq, messagesAfter, psql, rowsOf, tagCsv, taggedClean } from "./_helpers";

export const journey: Journey = {
  name: "imports-wizard",
  title: "the developer page's import wizard: upload, column check, options, dry run, Import for real, report filters and row detail, Recent imports, unknown columns acknowledged, a file without identifiers stopped, the user base",
  async run(ctx) {
    const dir = mkdtempSync(join(tmpdir(), "sa-e2e-wizard-"));
    try {
      await walk(ctx, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

async function walk(ctx: Parameters<Journey["run"]>[0], dir: string): Promise<void> {
  const { env, results, browser } = ctx;
  const crm = fakeApp("legacy-crm");
  await forgetImportBudgets(env, crm.app_id);
  const t = tag();
  const cleanPath = join(dir, `crm-users-${t}.csv`);
  writeFileSync(cleanPath, (await taggedClean(env, t)).text);
  const unknownPath = join(dir, `crm-extra-columns-${t}.csv`);
  writeFileSync(unknownPath, tagCsv(readFileSync(join(FIXTURES, "unknown-columns.csv"), "utf8"), `${t}w`, "000").text);
  const taggedEmails = () => psql(env, `select count(*) from account_emails where email like '%@${t}.legacy-crm.test'`);

  const context = await newContext(browser);
  const page = await context.newPage();
  // The user base shows imported members' photos; dirty.json's row 13 points at a host that doesn't exist here.
  results.watch(page, "imports-wizard", [/images\.legacy-crm\.test/]);
  await signInOnSite(env, page, crm.owner_email);
  const seq = await lastSeq(env);
  await page.goto(`${env.site}/developer/legacy-crm/import`);
  const upload = page.locator('input[type="file"]').first();
  await upload.waitFor({ state: "attached", timeout: 30_000 });
  const help = (await page.getByRole("complementary", { name: "Columns an import can have" }).innerText().catch(() => "")).replace(/\s+/g, " ");
  results.check("the upload step lists the only columns an import keeps and says nobody gets an email or SMS", ["external_id", "email", "phones", "display_name", "username", "pfp_url"].every(column => help.includes(column)) && /never sends an email or SMS/.test(help), help.slice(0, 300));
  await shot(env, page, "imports-wizard-01-upload");

  // Upload → Check columns.
  await upload.setInputFiles(cleanPath);
  const toOptions = page.getByRole("button", { name: "Continue to options" });
  await toOptions.waitFor({ timeout: 20_000 });
  await sleep(300);
  const check = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  results.check("the column check names the file, its 25 rows and 7 columns", check.includes(`crm-users-${t}.csv`) && /CSV · 25 rows · 7 columns/.test(check), check.slice(0, 300));
  const chips = await page.getByRole("region", { name: "Columns" }).getByRole("listitem").allInnerTexts();
  results.check("…each column as a chip (external_id, email, phone, display_name, username, dob, timezone)", chips.map(chip => chip.trim()).join(",") === "external_id,email,phone,display_name,username,dob,timezone", chips.join(","));
  const preview = (await page.getByRole("region", { name: "First rows" }).innerText().catch(() => "")).replace(/\s+/g, " ");
  results.check("…and the first rows as they will be read (before anything is sent)", preview.includes(`clean.ada@${t}.legacy-crm.test`) && preview.includes(`clean_ada_${t}`) && (await taggedEmails()) === "0", preview.slice(0, 300));
  await shot(env, page, "imports-wizard-02-columns", true);

  // Options → dry run.
  await toOptions.click();
  const country = page.getByRole("combobox", { name: "Default country for phone numbers" });
  await country.click();
  await page.keyboard.type("United States", { delay: 10 });
  await sleep(200);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await shot(env, page, "imports-wizard-03-options");
  await page.getByRole("button", { name: "Do a dry run" }).click();
  await page.getByText("Dry run finished", { exact: true }).waitFor({ timeout: 60_000 });
  await sleep(500);
  const dryText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  results.check("the dry run's report: nothing written, 25 rows would go through", /Nothing was written\. 25 rows would go through, 0 rows would fail and 0 would be skipped\./.test(dryText), dryText.slice(0, 300));
  results.check("…and nothing was written", (await taggedEmails()) === "0");
  const [dryJob] = await rowsOf<{ id: string; options: { dry_run?: boolean; default_country?: string }; created_by: string }>(env, `select id, options, created_by from import_jobs where app_id = 'legacy-crm' order by created_at desc limit 1`);
  const ownerUuid = await psql(env, `select uuid from accounts where handle = '${crm.owner_id}'`);
  results.check("the dry run ran with the chosen options (dry run, default country US) as the owner", dryJob?.options.dry_run === true && dryJob.options.default_country === "US" && dryJob.created_by === ownerUuid, JSON.stringify(dryJob));
  await shot(env, page, "imports-wizard-04-dry-run", true);

  // Import for real: the same file and options.
  await page.getByRole("button", { name: "Import for real" }).click();
  await page.getByText("Import finished", { exact: true }).waitFor({ timeout: 60_000 });
  await sleep(600);
  const realText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  results.check("Import for real: \"25 accounts created, 0 matched…\"", /25 accounts created, 0 matched to existing accounts, 0 updated; 0 rows failed and 0 were skipped\./.test(realText), realText.slice(0, 300));
  results.check("…25 accounts exist now", (await taggedEmails()) === "24" && (await psql(env, `select count(*) from memberships where app_id = 'legacy-crm' and external_id like '%-${t}'`)) === "25");
  const [realJob] = await rowsOf<{ id: string; options: { dry_run?: boolean; default_country?: string } }>(env, `select id, options from import_jobs where app_id = 'legacy-crm' order by created_at desc limit 1`);
  results.check("…with exactly the dry run's options, minus the dry run", realJob?.id !== dryJob?.id && realJob?.options.dry_run === false && realJob.options.default_country === "US", JSON.stringify(realJob));
  await shot(env, page, "imports-wizard-05-imported", true);

  // The report: filters and a row's detail.
  const table = page.getByRole("table").last();
  const bodyRows = () => table.locator("tbody tr").count();
  results.check("the report lists the 25 rows", (await bodyRows()) === 25, `${await bodyRows()} rows`);
  const filters = page.getByRole("group", { name: "Show rows" });
  await filters.getByRole("button", { name: "Errors" }).click();
  const noErrors = await page.getByText("No errors in this import.").waitFor({ timeout: 10_000 }).then(() => true, () => false);
  results.check("the Errors filter: \"No errors in this import.\"", noErrors);
  await filters.getByRole("button", { name: "Created" }).click();
  await sleep(800);
  results.check("the Created filter: all 25", (await bodyRows()) === 25, `${await bodyRows()} rows`);
  await page.getByRole("button", { name: "Open row 1", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer.waitFor({ timeout: 10_000 });
  const drawerText = (await drawer.innerText()).replace(/\s+/g, " ");
  await shot(env, page, "imports-wizard-06-row");
  results.check("a row's detail: Row 1 · Created · c:clean_ada_<tag>, its input", /Row 1/.test(drawerText) && drawerText.includes(`c:clean_ada_${t}`) && /Created/.test(drawerText) && drawerText.includes(`clean.ada@${t}.legacy-crm.test`), drawerText.slice(0, 300));
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);

  // Recent imports, then a file with columns Silicon Accounts doesn't keep.
  await page.getByRole("button", { name: "Start another import" }).click();
  const recent = page.getByRole("region", { name: "Recent imports" });
  const items = recent.getByRole("listitem");
  await items.first().waitFor({ timeout: 15_000 });
  // The list may first show what it had cached before these imports, then its refetch: wait (up to 15 s) for the two
  // newest entries to be this wizard's import and, below it, its dry run.
  let newest = "";
  let next = "";
  const deadline = Date.now() + 15_000;
  do {
    newest = (await items.nth(0).innerText().catch(() => "")).replace(/\s+/g, " ");
    next = (await items.nth(1).innerText().catch(() => "")).replace(/\s+/g, " ");
    if (/just now · CSV · 25 rows 25 created/.test(newest) && !/Dry run/.test(newest) && /just now · CSV · 25 rows 25 created/.test(next) && /Dry run/.test(next)) break;
    await sleep(250);
  } while (Date.now() < deadline);
  results.check("\"Start another import\": Recent imports lists this import first, then its dry run (marked), with their counts", /just now · CSV · 25 rows 25 created/.test(newest) && !/Dry run/.test(newest) && /just now · CSV · 25 rows 25 created/.test(next) && /Dry run/.test(next), `newest: ${newest} | next: ${next}`);
  await page.locator('input[type="file"]').first().setInputFiles(unknownPath);
  const warning = page.getByText("3 columns Silicon Accounts doesn't keep");
  await warning.waitFor({ timeout: 20_000 });
  const blocked = await page.getByRole("button", { name: "Continue to options" }).isDisabled();
  const warningText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  await shot(env, page, "imports-wizard-07-unknown-columns", true);
  results.check("unknown columns are named before anything is sent, and the wizard won't go on until they are dealt with", blocked && ["favorite_color", "plan", "last_login_at"].every(column => warningText.includes(column)), warningText.slice(0, 300));
  await page.getByRole("button", { name: "Ignore them and continue" }).click();
  await page.getByRole("button", { name: "Continue to options" }).click();
  const ignoreSwitch = page.getByRole("switch", { name: "Ignore columns Silicon Accounts doesn't keep" });
  results.check("the options show the ignore switch, on", (await ignoreSwitch.getAttribute("aria-checked")) === "true" || (await ignoreSwitch.isChecked().catch(() => false)));
  await page.getByRole("button", { name: "Import 5 rows" }).click();
  await page.getByText("Import finished", { exact: true }).waitFor({ timeout: 60_000 });
  await sleep(500);
  await page.getByRole("group", { name: "Show rows" }).getByRole("button", { name: "Warnings" }).click();
  await sleep(800);
  const warned = (await page.getByRole("table").last().innerText()).replace(/\s+/g, " ");
  results.check("the 5 rows are imported, each with an unknown_columns warning", (await page.getByRole("table").last().locator("tbody tr").count()) === 5 && (warned.match(/unknown_columns/g) ?? []).length >= 5, warned.slice(0, 300));
  await shot(env, page, "imports-wizard-08-ignored", true);

  // A pasted file without an email or phone column can't go on.
  await page.getByRole("button", { name: "Start another import" }).click();
  await page.getByRole("button", { name: "Paste instead" }).click();
  await page.getByRole("textbox", { name: "Paste CSV or JSON" }).fill(`display_name,username\nNo Contact,nocontact_${t}`);
  // The stepper's own "Check columns" step comes first in the page; the paste box's button is the last one.
  await page.getByRole("button", { name: "Check columns", exact: true }).last().click();
  const stopped = await page.getByText("This file can't be imported yet").waitFor({ timeout: 10_000 }).then(() => true, () => false);
  const stoppedText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  results.check("a pasted CSV without an email or phone column is stopped, saying why", stopped && /No column holds an email or phone number/.test(stoppedText) && (await page.getByRole("button", { name: "Continue to options" }).isDisabled()), stoppedText.slice(0, 300));
  await shot(env, page, "imports-wizard-09-no-identifier");

  // The user base lists them as imported.
  await page.goto(`${env.site}/developer/legacy-crm/users`);
  const search = page.getByRole("searchbox", { name: "Search users" }).or(page.getByRole("textbox", { name: "Search users" }));
  await search.first().fill(`clean_ada_${t}`);
  const person = page.locator(`[data-open-user]`).filter({ hasText: "Ada King" });
  const found = await person.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const userRow = found ? (await person.first().locator("xpath=ancestor::tr").innerText().catch(() => "")).replace(/\s+/g, " ") : "";
  await shot(env, page, "imports-wizard-10-users");
  results.check("the user base finds the imported Carbon, marked Imported, joined through an import", found && /Imported/.test(userRow), userRow.slice(0, 300));
  const sent = await messagesAfter(env, seq);
  results.check("no email or SMS went out for any of these imports", sent.length === 0, sent.map(item => `${item.channel} to ${item.to}`).join(", ") || "nothing captured");
  await context.close();
}

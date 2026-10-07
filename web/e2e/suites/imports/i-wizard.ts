/**
 * The import wizard on the developer site (developer.teamofsilicons.com: an app's user base and imports live there,
 * UNDERSTANDING.md), as legacy-crm's owner signed in through its BFF: upload → check columns (the browser names the
 * columns and shows the first rows before anything is sent) → options → a dry run → "Import for real" → the report
 * (totals, filters, a row's detail) → Recent imports; columns Silicon Accounts doesn't keep must be acknowledged; dirty
 * data in the browser (dirty.csv: its BOM, its quoted newline, 59 rows; the dry run's report of every outcome, matched
 * accounts hidden, a message code as a filter; dirty.json sent as JSON); a pasted file without an email or phone column can't go on; what
 * only the server can judge (a 9,000-byte cell) is refused in the server's own words; a file
 * over 50 MB is refused before anything is uploaded; the user base then lists the imported Carbons.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "../../context";
import { shot, sleep, tag } from "../../lib";
import {
  FIXTURES,
  PRECONDITION_PHONE,
  developerSession,
  ensurePhoneOwned,
  expectedFor,
  fakeApp,
  forgetImportBudgets,
  freshExchange,
  lastSeq,
  messagesAfter,
  psql,
  rowsOf,
  tagCsv,
  tagJsonRows,
  taggedClean,
  textOf,
} from "./_helpers";

export const journey: Journey = {
  name: "imports-wizard",
  title: "the developer site's import wizard (signed in through its BFF): upload, column check, options, dry run, Import for real, report filters and row detail, Recent imports, unknown columns acknowledged, dirty.csv's dry run in the report, a file without identifiers stopped, a file over 50 MB refused before upload, the user base",
  timeoutMs: 8 * 60_000,
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
  const { env, results } = ctx;
  const crm = fakeApp("legacy-crm");
  await forgetImportBudgets(env, crm.app_id);
  await ensurePhoneOwned(ctx, PRECONDITION_PHONE);
  const t = tag();
  const cleanPath = join(dir, `crm-users-${t}.csv`);
  writeFileSync(cleanPath, (await taggedClean(env, t)).text);
  const unknownPath = join(dir, `crm-extra-columns-${t}.csv`);
  writeFileSync(unknownPath, tagCsv(readFileSync(join(FIXTURES, "unknown-columns.csv"), "utf8"), `${t}w`, "000").text);
  const dirtyExchange = await freshExchange(env, ["415", "212"]);
  const dirtyPath = join(dir, `crm-dirty-${t}.csv`);
  writeFileSync(dirtyPath, tagCsv(readFileSync(join(FIXTURES, "dirty.csv"), "utf8"), `${t}d`, dirtyExchange, { keepRows: row => ["crm-038", "crm-039", "crm-040"].includes((row.external_id ?? "").trim()) }).text);
  const dirtyJsonPath = join(dir, `crm-dirty-${t}.json`);
  writeFileSync(dirtyJsonPath, JSON.stringify({ rows: tagJsonRows((JSON.parse(readFileSync(join(FIXTURES, "dirty.json"), "utf8")) as { rows: Array<Record<string, unknown>> }).rows, `${t}j`, await freshExchange(env, ["415"]), row => row.external_id === "json-011").rows }, null, 2));
  const taggedEmails = () => psql(env, `select count(*) from account_emails where email like '%@${t}.legacy-crm.test'`);
  const ownerUuid = await psql(env, `select uuid from accounts where handle = '${crm.owner_id}'`);

  // The user base shows imported members' photos; dirty.csv's row 1 points at a host that doesn't exist here. The 422 is
  // asked for: the file with a 9,000-byte cell that only the server refuses.
  const { context, page } = await developerSession(ctx, crm.owner_email, "imports-wizard", { returnTo: "/apps/legacy-crm/import", expected: [/images\.legacy-crm\.test/, /status of 422 \(Unprocessable Entity\) @ https?:\/\/[^ ]+\/api\/accounts\/apps\/legacy-crm\/imports\b/] });
  results.check("signed in through the developer site, the owner lands on legacy-crm's Import tab", page.url() === `${env.developer}/apps/legacy-crm/import`, page.url());
  const seq = await lastSeq(env);
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
  const check = await textOf(page);
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
  const dryText = await textOf(page);
  results.check("the dry run's report: nothing written, 25 rows would go through", /Nothing was written\. 25 rows would go through, 0 rows would fail and 0 would be skipped\./.test(dryText), dryText.slice(0, 300));
  results.check("…and nothing was written", (await taggedEmails()) === "0");
  const [dryJob] = await rowsOf<{ id: string; options: { dry_run?: boolean; default_country?: string }; created_by: string }>(env, `select id, options, created_by from import_jobs where app_id = 'legacy-crm' order by created_at desc limit 1`);
  results.check("the dry run ran with the chosen options (dry run, default country US) as the owner", dryJob?.options.dry_run === true && dryJob.options.default_country === "US" && dryJob.created_by === ownerUuid, JSON.stringify(dryJob));
  await shot(env, page, "imports-wizard-04-dry-run", true);

  // Import for real: the same file and options.
  await page.getByRole("button", { name: "Import for real" }).click();
  await page.getByText("Import finished", { exact: true }).waitFor({ timeout: 60_000 });
  await sleep(600);
  const realText = await textOf(page);
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
  const warningText = await textOf(page);
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

  // Dirty data in the browser: dirty.csv (a BOM, CRLF, a quoted newline, 59 rows) through a dry run.
  await page.getByRole("button", { name: "Start another import" }).click();
  await page.locator('input[type="file"]').first().setInputFiles(dirtyPath);
  await page.getByRole("button", { name: "Continue to options" }).waitFor({ timeout: 20_000 });
  await sleep(300);
  const dirtyCheck = await textOf(page);
  const dirtyChips = (await page.getByRole("region", { name: "Columns" }).getByRole("listitem").allInnerTexts()).map(chip => chip.trim());
  results.check(
    "dirty.csv's column check: 59 rows (a quoted newline is not a row), 11 columns, the first named external_id (the BOM isn't part of its name), nothing unknown",
    /CSV · 59 rows · 11 columns/.test(dirtyCheck) && dirtyChips[0] === "external_id" && !/doesn't keep/.test(dirtyCheck) && (await page.getByRole("button", { name: "Continue to options" }).isEnabled()),
    `${/CSV · [^·]+ · [^·]+ columns/.exec(dirtyCheck)?.[0] ?? dirtyCheck.slice(0, 200)}; chips ${dirtyChips.join(",")}`,
  );
  await page.getByRole("button", { name: "Continue to options" }).click();
  const country2 = page.getByRole("combobox", { name: "Default country for phone numbers" });
  await country2.click();
  await page.keyboard.type("United States", { delay: 10 });
  await sleep(200);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Do a dry run" }).click();
  await page.getByText("Dry run finished", { exact: true }).waitFor({ timeout: 60_000 });
  await sleep(600);
  const expected = expectedFor("dirty.csv");
  const goThrough = expected.counts.created + expected.counts.matched + expected.counts.updated;
  const dirtyText = await textOf(page);
  results.check(
    `dirty.csv's dry run: "Nothing was written. ${goThrough} rows would go through, ${expected.counts.error} rows would fail and ${expected.counts.skipped} would be skipped."`,
    dirtyText.includes(`Nothing was written. ${goThrough} rows would go through, ${expected.counts.error} rows would fail and ${expected.counts.skipped} would be skipped.`),
    /Nothing was written[^.]*\.[^.]*\./.exec(dirtyText)?.[0] ?? dirtyText.slice(0, 300),
  );
  const dirtyTable = page.getByRole("table").last();
  const shownRows = async () => (await dirtyTable.locator("tbody tr").allInnerTexts()).map(row => row.replace(/\s+/g, " "));
  const firstPage = await shownRows();
  const more = page.getByRole("button", { name: "Load more rows" });
  const hasMore = await more.isVisible().catch(() => false);
  if (hasMore) {
    await more.click();
    await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length > 50, undefined, { timeout: 10_000 }).catch(() => undefined);
  }
  const allShown = await shownRows();
  results.check("the report shows the first 50 rows, and \"Load more rows\" the other 9", firstPage.length === 50 && hasMore && allShown.length === 59, `${firstPage.length} then ${allShown.length} rows`);
  const row38 = (await page.getByRole("button", { name: "Open row 38", exact: true }).locator("xpath=ancestor::tr").innerText().catch(() => "")).replace(/\s+/g, " ");
  results.check("row 38 (the email of c:saket) is Matched, its account \"hidden in a dry run\" (a dry run never maps an email to an account)", /Matched/.test(row38) && /hidden in a dry run/.test(row38) && !/c:saket/.test(row38), row38);
  await page.getByRole("group", { name: "Show rows" }).getByRole("button", { name: "Errors" }).click();
  await sleep(900);
  const errorRows = (await shownRows()).map(row => Number(/^\d+/.exec(row)?.[0]));
  const wantErrors = expected.rows.filter(row => row.outcome === "error").map(row => row.row_number);
  results.check(`the Errors filter lists the ${wantErrors.length} rows that can't be imported (${wantErrors.join(", ")})`, JSON.stringify(errorRows) === JSON.stringify(wantErrors), errorRows.join(", "));
  await shot(env, page, "imports-wizard-09-dirty-errors", true);
  await page.getByRole("group", { name: "Show rows" }).getByRole("button", { name: "All" }).click();
  await sleep(600);
  await page.getByRole("button", { name: "Show only rows with id_conflict" }).first().click();
  await sleep(900);
  const conflictRows = await shownRows();
  const onlyChip = (await page.getByText(/^Only/).first().innerText().catch(() => "")).replace(/\s+/g, " ");
  results.check(
    "a message code is a filter: id_conflict → rows 41 and 42 (usernames that are already c:saket and c:shubham), each assigned another id",
    conflictRows.length === 2 && /^41 /.test(conflictRows[0] ?? "") && /^42 /.test(conflictRows[1] ?? "") && /c:saket-\d+/.test(conflictRows[0] ?? "") && /c:shubham-\d+/.test(conflictRows[1] ?? "") && /id_conflict/.test(onlyChip),
    `${conflictRows.join(" | ").slice(0, 400)}; chip "${onlyChip}"`,
  );
  await shot(env, page, "imports-wizard-10-dirty-id-conflict", true);
  results.check("…and the dirty dry run wrote nothing", (await psql(env, `select count(*) from account_emails where email like '%@${t}d.legacy-crm.test'`)) === "0");

  // A JSON file goes the same way (the wizard sends its rows as a JSON body): dirty.json's dry run.
  await page.getByRole("button", { name: "Start another import" }).click();
  await page.locator('input[type="file"]').first().setInputFiles(dirtyJsonPath);
  await page.getByRole("button", { name: "Continue to options" }).waitFor({ timeout: 20_000 });
  await sleep(300);
  const jsonCheck = await textOf(page);
  const jsonPreview = (await page.getByRole("region", { name: "First rows" }).innerText().catch(() => "")).replace(/\s+/g, " ");
  results.check(
    "dirty.json's column check: JSON · 16 rows, nothing unknown; row 1's `name` is previewed as its display name (\"Json Mixed\")",
    /JSON · 16 rows/.test(jsonCheck) && !/doesn't keep/.test(jsonCheck) && jsonPreview.includes("Json Mixed") && (await page.getByRole("button", { name: "Continue to options" }).isEnabled()),
    `${/JSON · [^·]+ · [^·]+ columns/.exec(jsonCheck)?.[0] ?? jsonCheck.slice(0, 200)}; preview ${jsonPreview.slice(0, 200)}`,
  );
  await page.getByRole("button", { name: "Continue to options" }).click();
  const country3 = page.getByRole("combobox", { name: "Default country for phone numbers" });
  await country3.click();
  await page.keyboard.type("United States", { delay: 10 });
  await sleep(200);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Do a dry run" }).click();
  await page.getByText("Dry run finished", { exact: true }).waitFor({ timeout: 60_000 });
  await sleep(500);
  const expectedJson = expectedFor("dirty.json");
  const jsonGoes = expectedJson.counts.created + expectedJson.counts.matched + expectedJson.counts.updated;
  const jsonText = await textOf(page);
  const [jsonJob] = await rowsOf<{ format: string; total_rows: number; options: { dry_run?: boolean } }>(env, `select format, total_rows, options from import_jobs where app_id = 'legacy-crm' order by created_at desc limit 1`);
  results.check(
    `dirty.json's dry run, sent as JSON: "Nothing was written. ${jsonGoes} rows would go through, ${expectedJson.counts.error} rows would fail and ${expectedJson.counts.skipped} would be skipped."`,
    jsonText.includes(`Nothing was written. ${jsonGoes} rows would go through, ${expectedJson.counts.error} rows would fail and ${expectedJson.counts.skipped} would be skipped.`) && jsonJob?.format === "json" && jsonJob.total_rows === 16 && jsonJob.options.dry_run === true,
    `${/Nothing was written[^.]*\.[^.]*\./.exec(jsonText)?.[0] ?? jsonText.slice(0, 300)}; job ${JSON.stringify(jsonJob)}`,
  );

  // A dry run reopened from Recent imports is only its report: it never offers "Import for real" (that would import
  // whatever file is loaded now, with the options shown now).
  await page.getByRole("button", { name: "Start another import" }).click();
  const recentNow = page.getByRole("region", { name: "Recent imports" }).getByRole("listitem");
  await recentNow.first().waitFor({ timeout: 15_000 });
  let newestNow = "";
  const recentDeadline = Date.now() + 15_000;
  do {
    newestNow = (await recentNow.first().innerText().catch(() => "")).replace(/\s+/g, " ");
    if (/JSON · 16 rows/.test(newestNow) && /Dry run/.test(newestNow)) break;
    await sleep(250);
  } while (Date.now() < recentDeadline);
  await recentNow.first().getByRole("button").first().click();
  await page.getByText("Dry run finished", { exact: true }).waitFor({ timeout: 20_000 });
  await sleep(400);
  const reopened = await textOf(page);
  const offersReal = await page.getByRole("button", { name: "Import for real" }).count();
  results.check(
    "a dry run reopened from Recent imports shows its report without \"Import for real\" (\"To import it for real, upload the file again: this report is not the file loaded now.\")",
    /JSON · 16 rows/.test(newestNow) && offersReal === 0 && reopened.includes("To import it for real, upload the file again: this report is not the file loaded now."),
    `newest ${newestNow.slice(0, 120)}; Import for real buttons ${offersReal}; ${/To import it for real[^.]*\./.exec(reopened)?.[0] ?? reopened.slice(0, 200)}`,
  );

  // A pasted file without an email or phone column can't go on.
  await page.getByRole("button", { name: "Start another import" }).click();
  await page.getByRole("button", { name: "Paste instead" }).click();
  await page.getByRole("textbox", { name: "Paste CSV or JSON" }).fill(`display_name,username\nNo Contact,nocontact_${t}`);
  // The stepper's own "Check columns" step comes first in the page; the paste box's button is the last one.
  await page.getByRole("button", { name: "Check columns", exact: true }).last().click();
  const stopped = await page.getByText("This file can't be imported yet").waitFor({ timeout: 10_000 }).then(() => true, () => false);
  const stoppedText = await textOf(page);
  results.check("a pasted CSV without an email or phone column is stopped, saying why", stopped && /No column holds an email or phone number/.test(stoppedText) && (await page.getByRole("button", { name: "Continue to options" }).isDisabled()), stoppedText.slice(0, 300));
  await shot(env, page, "imports-wizard-11-no-identifier");

  // What only the server can judge (a 9,000-byte cell): the wizard sends it and shows the server's own refusal.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Paste instead" }).click();
  await page.getByRole("textbox", { name: "Paste CSV or JSON" }).fill(`email,display_name\nhuge.cell.${t}@legacy-crm.test,${"x".repeat(9000)}`);
  await page.getByRole("button", { name: "Check columns", exact: true }).last().click();
  await page.getByRole("button", { name: "Continue to options" }).click({ timeout: 10_000 });
  await page.getByRole("button", { name: "Do a dry run" }).click();
  const refusedAlert = page.getByText("The import did not start", { exact: true });
  const refusedShown = await refusedAlert.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  const refusedText = await textOf(page);
  await shot(env, page, "imports-wizard-12-server-refusal");
  results.check(
    "a 9,000-byte cell (only the server checks it): \"The import did not start\" with the server's own words (row 1, display_name, 9000 bytes, at most 8192 bytes) and its hint",
    refusedShown && /display_name/.test(refusedText) && /9000 bytes/.test(refusedText) && /8192 bytes/.test(refusedText) && /Fix that row/.test(refusedText) && (await psql(env, `select count(*) from account_emails where email = 'huge.cell.${t}@legacy-crm.test'`)) === "0",
    /The import did not start.{0,320}/.exec(refusedText)?.[0] ?? refusedText.slice(0, 300),
  );

  // A file over 50 MB is refused in the browser, before anything is uploaded.
  const bigPath = join(dir, `crm-too-big-${t}.csv`);
  const big = Buffer.alloc(51 * 1024 * 1024, 0x61);
  big.write("email,display_name\n", 0);
  writeFileSync(bigPath, big);
  const importPosts: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && /\/apps\/legacy-crm\/imports/.test(request.url())) importPosts.push(request.url());
  });
  await page.goto(`${env.developer}/apps/legacy-crm/import`);
  const bigInput = page.locator('input[type="file"]').first();
  await bigInput.waitFor({ state: "attached", timeout: 30_000 });
  await bigInput.setInputFiles(bigPath);
  const said = await page.getByText(`crm-too-big-${t}.csv is 51.0 MB; an import can be at most 50 MB. Split it into several files.`).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const goOn = page.getByRole("button", { name: "Continue to options" });
  const blockedBig = (await goOn.count()) === 0 || (await goOn.isDisabled());
  await sleep(500);
  await shot(env, page, "imports-wizard-13-too-big");
  results.check(
    "a 51 MB file is refused in the browser before anything is sent (\"… is 51.0 MB; an import can be at most 50 MB. Split it into several files.\"), and the wizard can't go on",
    said && blockedBig && importPosts.length === 0,
    `${said ? "the reason is shown" : (await textOf(page)).slice(0, 300)}; continue blocked ${blockedBig}; import requests sent ${importPosts.length}`,
  );

  // The user base lists them as imported.
  await page.goto(`${env.developer}/apps/legacy-crm/users`);
  const search = page.getByRole("searchbox", { name: "Search users" }).or(page.getByRole("textbox", { name: "Search users" }));
  await search.first().fill(`clean_ada_${t}`);
  const person = page.locator(`[data-open-user]`).filter({ hasText: "Ada King" });
  const found = await person.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const userRow = found ? (await person.first().locator("xpath=ancestor::tr").innerText().catch(() => "")).replace(/\s+/g, " ") : "";
  await shot(env, page, "imports-wizard-14-users");
  results.check("the user base finds the imported Carbon, marked Imported, joined through an import", found && /Imported/.test(userRow), userRow.slice(0, 300));
  const sent = await messagesAfter(env, seq);
  results.check("no email or SMS went out for any of these imports", sent.length === 0, sent.map(item => `${item.channel} to ${item.to}`).join(", ") || "nothing captured");
  await context.close();
}

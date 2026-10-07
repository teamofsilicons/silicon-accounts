import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Journey } from "../context";
import { E2E_DIR, appAccount, cli, cliHome, codeFor, lastSeq, newContext, shot, signInOnSite, sleep } from "../lib";

const ROOT = resolve(E2E_DIR, "../..");
const DIRTY = join(ROOT, "testkit/fixtures/imports/dirty.csv");

interface ExpectedRow {
  row_number: number;
  outcome: string;
  id?: string | null;
  id_exact?: boolean;
}

interface ImportJob {
  id: string;
  status: string;
  dry_run: boolean;
  counts: { created: number; matched: number; updated: number; skipped: number; error: number; warnings: number };
  created_at: string;
  finished_at: string | null;
}

interface FakeApp {
  app_id: string;
  owner_email: string;
  secret: string;
}

export const journey: Journey = {
  name: "f-import",
  title: "dirty.csv into legacy-crm through the developer page (dry run, then for real) and the CLI; an imported Carbon signs in and finishes setting up",
  async run({ env, results, browser }) {
    const expected = (JSON.parse(readFileSync(join(ROOT, "testkit/fixtures/imports/expected.json"), "utf8")) as { files: Array<{ file: string; rows: ExpectedRow[] }> }).files.find(file => file.file === "dirty.csv")!;
    const crm = (JSON.parse(readFileSync(join(ROOT, "testkit/fake-apps.json"), "utf8")) as { apps: FakeApp[] }).apps.find(app => app.app_id === "legacy-crm")!;

    // Row 40's precondition (expected.json): +12025550142 already belongs to an account.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "f-pre");
      await page.goto(`${env.site}/sign-in`);
      await page.getByRole("button", { name: "Phone", exact: true }).click({ timeout: 30_000 });
      const field = page.getByRole("textbox", { name: "Phone number" });
      await field.click();
      const after = await lastSeq(env);
      await page.keyboard.type("+12025550142", { delay: 20 });
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const code = await codeFor(env, "+12025550142", after);
      await page.getByRole("group", { name: /Code/ }).first().waitFor({ timeout: 15_000 });
      await page.keyboard.type(code, { delay: 25 });
      const create = page.getByRole("button", { name: "Create account" });
      const home = page.waitForURL(`${env.site}/`, { timeout: 30_000 }).then(() => "home" as const);
      if ((await Promise.race([home, create.waitFor({ timeout: 30_000 }).then(() => "signup" as const)])) === "signup") await create.click();
      await page.waitForURL(`${env.site}/`, { timeout: 30_000 });
      await context.close();
    }

    // The owner imports on the developer page: a dry run, then "Import for real".
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "f-dev");
    await signInOnSite(env, page, crm.owner_email);
    const started = Date.now();
    await page.goto(`${env.site}/developer/legacy-crm/import`);
    const file = page.locator('input[type="file"]').first();
    await file.waitFor({ state: "attached", timeout: 30_000 });
    await file.setInputFiles(DIRTY);
    const toOptions = page.getByRole("button", { name: "Continue to options" });
    await toOptions.waitFor({ timeout: 20_000 });
    await shot(env, page, "f-01-columns", true);
    await toOptions.click();
    const country = page.getByRole("combobox", { name: "Default country for phone numbers" });
    await country.click();
    await page.keyboard.type("United States", { delay: 10 });
    await sleep(200);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Do a dry run" }).click();
    await page.getByText("Dry run finished", { exact: true }).waitFor({ timeout: 60_000 });
    const jobs = async () => ((await (await page.request.get(`${env.site}/v1/apps/legacy-crm/imports`)).json()) as { items: ImportJob[] }).items;
    const counts = (job: ImportJob | undefined) => (job ? `created ${job.counts.created}, matched ${job.counts.matched}, updated ${job.counts.updated}, skipped ${job.counts.skipped}, error ${job.counts.error}` : "no job");
    const want = "created 46, matched 1, updated 0, skipped 3, error 9";
    const dry = (await jobs())[0];
    results.check("the dry run reports expected.json's counts", dry?.dry_run === true && counts(dry) === want, counts(dry));
    await page.getByRole("button", { name: "Import for real" }).click();
    await page.getByText("Import finished", { exact: true }).waitFor({ timeout: 60_000 });
    await sleep(600);
    await shot(env, page, "f-02-imported", true);
    const real = (await jobs())[0];
    results.check("the import (for real) matches expected.json's counts", real?.dry_run === false && counts(real) === want, `${counts(real)} in ${Date.now() - started} ms (page)`);
    const rows: Array<{ row_number: number; outcome: string; id: string | null; account_uuid: string | null }> = [];
    let cursor: string | null = null;
    do {
      const pageOf = (await (await page.request.get(`${env.site}/v1/apps/legacy-crm/imports/${real!.id}/rows?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json()) as { items: typeof rows; next_cursor: string | null };
      rows.push(...pageOf.items);
      cursor = pageOf.next_cursor;
    } while (cursor);
    const wrong = expected.rows.filter(row => {
      const got = rows.find(item => item.row_number === row.row_number);
      return !got || got.outcome !== row.outcome || (row.id_exact && row.id && got.id !== row.id);
    });
    results.check(`all ${expected.rows.length} rows match expected.json (outcomes and exact ids)`, wrong.length === 0, wrong.slice(0, 4).map(row => `row ${row.row_number}`).join(", "));

    // The CLI imports the same file with the app's credentials: the created rows now match.
    const run = await cli(env, cliHome(), ["app", "import", DIRTY, "--default-country", "US", "--wait", "--json", "--app-id", "legacy-crm", "--app-secret-stdin"], { stdin: `${crm.secret}\n` });
    const job = ((run.json?.job ?? run.json) ?? {}) as Partial<ImportJob>;
    results.check("the CLI's re-import of dirty.csv completes (every created row now matches)", run.code === 0 && job.status === "completed" && job.counts?.created === 0 && job.counts?.matched === 47, `${run.ms} ms, ${JSON.stringify(job.counts)}`);
    await context.close();

    // An imported Carbon signs in to legacy-crm and finishes setting up with the imported details.
    const imported = await newContext(browser);
    const p = await imported.newPage();
    results.watch(p, "f-imported", [/images\.legacy-crm\.test/, /ERR_NAME_NOT_RESOLVED|could not be found/]);
    await p.goto(`${env.apps}/legacy-crm/`);
    await p.locator("#signin-hosted").click();
    const email = p.getByRole("textbox", { name: "Email" });
    await email.waitFor({ timeout: 30_000 });
    const after = await lastSeq(env);
    await email.fill("Ada.Byron@legacy-crm.test");
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    const code = await codeFor(env, "ada.byron@legacy-crm.test", after);
    await p.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 15_000 });
    await p.keyboard.type(code, { delay: 30 });
    const id = p.getByRole("textbox", { name: "Your id" });
    await id.waitFor({ timeout: 20_000 });
    await sleep(700);
    await shot(env, p, "f-03-finish-import");
    const prefill = {
      id: await id.inputValue(),
      name: await p.getByRole("textbox", { name: "Display name" }).inputValue(),
      timezone: await p.getByRole("combobox", { name: "Timezone" }).inputValue(),
      dob: (await p.getByRole("button", { name: "Date of birth" }).innerText()).replace(/\s+/g, " "),
    };
    results.check("the imported details are the prefill (c:ada_byron, Ada Byron, Europe/London, April 12, 1990)", prefill.id === "ada_byron" && prefill.name === "Ada Byron" && /London/.test(prefill.timezone) && /April 12, 1990/.test(prefill.dob), JSON.stringify(prefill));
    await p.getByRole("button", { name: /Create account|Finish|Continue/ }).last().click();
    const share = p.getByRole("button", { name: "Share and continue" });
    const appUrl = new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/legacy-crm/`);
    const first = await Promise.race([p.waitForURL(appUrl, { timeout: 30_000 }).then(() => "app" as const), share.waitFor({ timeout: 30_000 }).then(() => "consent" as const)]);
    if (first === "consent") {
      await share.click();
      await p.waitForURL(appUrl, { timeout: 30_000 });
    }
    const account = await appAccount(p);
    results.check("legacy-crm gets the account the import created", typeof account?.uuid === "string" && rows.some(row => row.account_uuid === account.uuid), JSON.stringify(account).slice(0, 160));
    await imported.close();
  },
};

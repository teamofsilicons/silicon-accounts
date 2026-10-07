import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../context";
import { DEVELOPER_SIGNED_OUT, REPO_ROOT, appAccount, cli, cliHome, completeDetails, developerApi, fakeApp, newContext, shot, signInOnDeveloper, signInWithCode, sleep, startAtApp } from "../lib";

const DIRTY = join(REPO_ROOT, "testkit/fixtures/imports/dirty.csv");

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

export const journey: Journey = {
  name: "f-import",
  title: "dirty.csv into legacy-crm on the developer site (signed in through its BFF; dry run, then for real) and with the CLI; an imported Carbon signs in, finishes setting up with the imported details and shares what legacy-crm requires",
  async run({ env, results, browser }) {
    const expected = (JSON.parse(readFileSync(join(REPO_ROOT, "testkit/fixtures/imports/expected.json"), "utf8")) as { files: Array<{ file: string; rows: ExpectedRow[] }> }).files.find(file => file.file === "dirty.csv")!;
    const crm = fakeApp("legacy-crm");

    // Row 40's precondition (expected.json): +12025550142 already belongs to an account.
    {
      const context = await newContext(browser);
      const page = await context.newPage();
      results.watch(page, "f-pre");
      await page.goto(`${env.site}/sign-in`);
      await signInWithCode(env, page, { phone: "+12025550142" });
      const create = page.getByRole("button", { name: "Create account" });
      const home = page.waitForURL(`${env.site}/`, { timeout: 30_000 }).then(() => "home" as const);
      if ((await Promise.race([home, create.waitFor({ timeout: 30_000 }).then(() => "signup" as const)])) === "signup") await create.click();
      await page.waitForURL(`${env.site}/`, { timeout: 30_000 });
      await context.close();
    }

    // The owner signs in to the developer site and imports on legacy-crm's Import tab: a dry run, then "Import for real".
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "f-dev", [DEVELOPER_SIGNED_OUT]);
    const signInStarted = Date.now();
    const authorize = await signInOnDeveloper(env, page, crm.owner_email, { returnTo: "/apps/legacy-crm/import" });
    results.check("the developer site signs in through the account site's hosted pages as the app `developer` (PKCE S256)", authorize.searchParams.get("app_id") === "developer" && authorize.searchParams.get("code_challenge_method") === "S256" && authorize.searchParams.get("redirect_uri") === `${env.developer}/auth/callback`, authorize.href.slice(0, 220));
    results.check("…and comes back to the page that asked (legacy-crm's Import tab)", page.url() === `${env.developer}/apps/legacy-crm/import`, page.url());
    results.metric("developer site sign-in (email code, through the BFF)", Date.now() - signInStarted);
    const cookies = await context.cookies(env.developer);
    const session = cookies.find(cookie => /sa_dev_session$/.test(cookie.name));
    results.check("the developer site keeps the sign-in in an httpOnly cookie (the browser never sees a token)", !!session?.httpOnly && !/^ey|sat_|sart_/.test(session.value), `${session?.name} httpOnly=${session?.httpOnly}`);
    const owned = await developerApi<{ items?: Array<{ app_id?: string; app?: { app_id?: string } }> }>(env, page, "/me/owned-apps");
    results.check("through the BFF the owner sees legacy-crm among their apps", owned.status === 200 && !!owned.body.items?.some(item => (item.app_id ?? item.app?.app_id) === "legacy-crm"), `${owned.status} ${JSON.stringify(owned.body).slice(0, 160)}`);

    const jobs = async () => (await developerApi<{ items: ImportJob[] }>(env, page, "/apps/legacy-crm/imports")).body.items ?? [];
    const counts = (job: ImportJob | undefined) => (job ? `created ${job.counts.created}, matched ${job.counts.matched}, updated ${job.counts.updated}, skipped ${job.counts.skipped}, error ${job.counts.error}` : "no job");
    // A kept stack walked again (scripts/e2e.sh --keep) already holds this import: its rows match instead of being
    // created, and the imported Carbon finished setting up on the first walk.
    const again = (await jobs()).some(job => !job.dry_run && job.status === "completed");
    const want = again ? "created 0, matched 47, updated 0, skipped 3, error 9" : "created 46, matched 1, updated 0, skipped 3, error 9";
    if (again) results.check("this stack was walked before: dirty.csv is in legacy-crm already, so its rows match now", true, want);

    const started = Date.now();
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
      const pageOf: { items: typeof rows; next_cursor: string | null } = (await developerApi<{ items: typeof rows; next_cursor: string | null }>(env, page, `/apps/legacy-crm/imports/${real!.id}/rows?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
      rows.push(...(pageOf.items ?? []));
      cursor = pageOf.next_cursor ?? null;
    } while (cursor);
    if (again) {
      results.check("…every row the first walk created is matched now (nothing created twice)", rows.length === expected.rows.length && !rows.some(row => row.outcome === "created"), `${rows.length} rows`);
    } else {
      const wrong = expected.rows.filter(row => {
        const got = rows.find(item => item.row_number === row.row_number);
        return !got || got.outcome !== row.outcome || (row.id_exact && row.id && got.id !== row.id);
      });
      results.check(`all ${expected.rows.length} rows match expected.json (outcomes and exact ids, the dirty ones and the c:id clashes included)`, wrong.length === 0, wrong.slice(0, 4).map(row => `row ${row.row_number}`).join(", "));
    }

    // The CLI imports the same file with the app's credentials: the created rows now match.
    const run = await cli(env, cliHome(), ["app", "import", DIRTY, "--default-country", "US", "--wait", "--json", "--app-id", "legacy-crm", "--app-secret-stdin"], { stdin: `${crm.secret}\n` });
    const job = ((run.json?.job ?? run.json) ?? {}) as Partial<ImportJob>;
    results.check("the CLI's re-import of dirty.csv completes (every created row now matches)", run.code === 0 && job.status === "completed" && job.counts?.created === 0 && job.counts?.matched === 47, `${run.ms} ms, ${JSON.stringify(job.counts)}`);
    await context.close();

    // An imported Carbon signs in to legacy-crm, finishes setting up with the imported details, and shares the email
    // legacy-crm requires (its optional phone, date of birth and timezone stay unticked).
    const imported = await newContext(browser);
    const p = await imported.newPage();
    results.watch(p, "f-imported", [/images\.legacy-crm\.test/, /ERR_NAME_NOT_RESOLVED|could not be found/]);
    await startAtApp(env, p, "legacy-crm");
    await signInWithCode(env, p, { email: "Ada.Byron@legacy-crm.test" });
    if (again) {
      const walk = await completeDetails(env, p, "legacy-crm");
      results.check("the imported Carbon (set up on the first walk) signs straight back in", walk.pages.length === 0, `${walk.pages.length} details pages`);
    } else {
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
      const finish = p.getByRole("button", { name: "Finish setup" });
      results.check("finishing an imported account says so (\"Finish setup\")", await finish.isVisible());
      await finish.click();
      const walk = await completeDetails(env, p, "legacy-crm", { shotName: "f-04-legacy-crm" });
      const optional = walk.pages[0]?.rows.filter(row => row.mode === "optional") ?? [];
      results.check("legacy-crm's page: email required, phone/dob/timezone optional and unticked", walk.pages.length === 1 && walk.pages[0]!.rows.some(row => row.field === "email" && row.mode === "required") && optional.length > 0 && optional.every(row => row.ticked === false), JSON.stringify(walk.pages[0]?.rows.map(row => `${row.field}:${row.mode}:${row.ticked}`)));
    }
    const account = await appAccount(p);
    results.check("legacy-crm gets the account the import created", typeof account?.uuid === "string" && rows.some(row => row.account_uuid === account.uuid), JSON.stringify(account).slice(0, 160));
    results.check("…with the email it requires and none of the unticked details", account?.email === "ada.byron@legacy-crm.test" && account.dob === undefined && account.timezone === undefined, JSON.stringify({ email: account?.email, dob: account?.dob, timezone: account?.timezone }));
    await imported.close();
  },
};

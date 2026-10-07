/**
 * Columns Silicon Accounts doesn't keep (an app's user base only has the columns we give): unknown-columns.csv and
 * .json are refused whole (422 unknown_columns naming them and the allowed set, nothing imported), and accepted with
 * ignore_unknown_columns, where every row is created with a warning and the ignored values are never stored.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { tag } from "../../lib";
import {
  FIXTURES,
  accountsByUuid,
  allRows,
  countsText,
  fakeApp,
  forgetImportBudgets,
  listJobs,
  postCsv,
  postJson,
  psql,
  rowsOf,
  tagCsv,
  tagJsonRows,
  waitJob,
} from "./_helpers";

const ALLOWED = ["external_id", "email", "emails", "phone", "phones", "display_name", "name", "username", "dob", "timezone", "pfp_url", "email_verified"];
const UNKNOWN = ["favorite_color", "plan", "last_login_at"];
const VALUES = ["teal", "amber", "violet", "enterprise", "business", "2026-09-30T10:00:00Z"];

export const journey: Journey = {
  name: "imports-unknown-columns",
  title: "unknown columns: 422 unknown_columns (CSV and JSON) listing them and the allowed columns, nothing imported; ignore_unknown_columns imports every row with a warning and never stores the ignored values",
  // Only the API and the CLI are under test here: the engine makes no difference, so WebKit runs skip it.
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    const crm = fakeApp("legacy-crm");
    await forgetImportBudgets(env, crm.app_id);
    const t = tag();
    const csv = tagCsv(readFileSync(join(FIXTURES, "unknown-columns.csv"), "utf8"), t, "000").text;
    const jsonRows = tagJsonRows((JSON.parse(readFileSync(join(FIXTURES, "unknown-columns.json"), "utf8")) as { rows: Array<Record<string, unknown>> }).rows, `${t}j`, "000", () => false).rows;
    const jobsBefore = (await listJobs(ctx, crm)).length;
    const accountsWithTag = () => psql(env, `select count(*) from account_emails where email like '%@${t}.legacy-crm.test' or email like '%@${t}j.legacy-crm.test'`);

    // Refused whole.
    const refused = await postCsv(ctx, crm, csv, { default_country: "US" }, { key: randomUUID() });
    const error = refused.body.error;
    const details = (error?.details ?? {}) as { unknown_columns?: string[]; allowed_columns?: string[] };
    results.check("the CSV is refused: 422 unknown_columns", refused.status === 422 && error?.code === "unknown_columns", `${refused.status} ${JSON.stringify(refused.body).slice(0, 300)}`);
    results.check("details list the three unknown columns and the twelve allowed ones", JSON.stringify(details.unknown_columns) === JSON.stringify(UNKNOWN) && JSON.stringify([...(details.allowed_columns ?? [])].sort()) === JSON.stringify([...ALLOWED].sort()), JSON.stringify(details));
    results.check("the message names each unknown column and says nothing was imported; the hint gives the fix (ignore_unknown_columns=true)", UNKNOWN.every(column => error?.message?.includes(column)) && /nothing was imported/i.test(error?.message ?? "") && /ignore_unknown_columns=true/.test(error?.hint ?? ""), `${error?.message} | ${error?.hint}`);
    const refusedJson = await postJson(ctx, crm, { rows: jsonRows, options: { default_country: "US" } }, { key: randomUUID() });
    const jsonDetails = (refusedJson.body.error?.details ?? {}) as { unknown_columns?: string[] };
    results.check("the JSON body is refused the same way (422 unknown_columns, the same three columns)", refusedJson.status === 422 && refusedJson.body.error?.code === "unknown_columns" && JSON.stringify(jsonDetails.unknown_columns) === JSON.stringify(UNKNOWN), `${refusedJson.status} ${JSON.stringify(refusedJson.body).slice(0, 300)}`);
    results.check("a refused import leaves no job and no account", (await listJobs(ctx, crm)).length === jobsBefore && (await accountsWithTag()) === "0", `${(await listJobs(ctx, crm)).length - jobsBefore} new jobs`);

    // Case and spacing of known columns never make them unknown.
    const shouted = await postCsv(ctx, crm, ` External_ID ,EMAIL, Display_Name ,Name_Is_Not_A_Column\nx-${t},shout.${t}@legacy-crm.test,Shout Case,\n`, { dry_run: true }, { key: randomUUID() });
    results.check("column names are case- and space-insensitive (only the really unknown one is named)", shouted.status === 422 && JSON.stringify((shouted.body.error?.details as { unknown_columns?: string[] } | undefined)?.unknown_columns) === JSON.stringify(["Name_Is_Not_A_Column"]), JSON.stringify(shouted.body).slice(0, 300));

    // Accepted with ignore_unknown_columns: every row created, each with a warning, the values never stored.
    const accepted = await postCsv(ctx, crm, csv, { default_country: "US", ignore_unknown_columns: true }, { key: randomUUID() });
    results.check("with ignore_unknown_columns=true the CSV is accepted (202)", accepted.status === 202 && accepted.body.job?.options.ignore_unknown_columns === true, `${accepted.status} ${JSON.stringify(accepted.body).slice(0, 300)}`);
    if (!accepted.body.job) throw new Error("the CSV with ignore_unknown_columns was refused");
    const job = await waitJob(ctx, crm, accepted.body.job.id);
    results.check("all 5 rows are created (created 5, error 0) with one warning each", job.status === "completed" && job.counts.created === 5 && job.counts.error === 0 && job.counts.warnings === 5, countsText(job.counts));
    const rows = await allRows(ctx, crm, job.id);
    const warned = rows.filter(row => {
      const warning = row.messages.find(m => m.code === "unknown_columns");
      return row.outcome === "created" && warning?.level === "warning" && UNKNOWN.every(column => warning.message.includes(column));
    });
    results.check("each row's warning is unknown_columns naming the ignored columns", warned.length === 5, rows.map(row => JSON.stringify(row.messages)).join(" | ").slice(0, 600));
    const shown = JSON.stringify(rows.map(row => row.input));
    results.check("the rows API shows which columns were ignored, never their values", rows.every(row => JSON.stringify(row.input._ignored_columns) === JSON.stringify(UNKNOWN)) && VALUES.every(value => !shown.includes(value)), shown.slice(0, 400));
    const stored = await psql(env, `select count(*) from import_job_rows where job_id = '${job.id}' and (${VALUES.map(value => `input::text like '%${value}%'`).join(" or ")})`);
    const accounts = await accountsByUuid(env, rows.map(row => row.account_uuid!).filter(Boolean));
    const profiles = JSON.stringify([...accounts.values()].map(account => account.membership?.imported_profile));
    results.check("the ignored values are stored nowhere: not in the job's rows, not in the imported profiles", stored === "0" && VALUES.every(value => !profiles.includes(value)) && accounts.size === 5, `${stored} stored rows; ${profiles.slice(0, 300)}`);

    const acceptedJson = await postJson(ctx, crm, { rows: jsonRows, options: { default_country: "US", ignore_unknown_columns: true } }, { key: randomUUID() });
    const jsonJob = acceptedJson.body.job ? await waitJob(ctx, crm, acceptedJson.body.job.id) : null;
    results.check("the JSON body with options.ignore_unknown_columns imports all 5 rows too", acceptedJson.status === 202 && jsonJob?.status === "completed" && jsonJob.counts.created === 5 && jsonJob.counts.warnings === 5, `${acceptedJson.status} ${countsText(jsonJob?.counts)}`);
    const jsonStored = jsonJob ? await rowsOf<{ n: number }>(env, `select count(*)::int as n from import_job_rows where job_id = '${jsonJob.id}' and (${VALUES.map(value => `input::text like '%${value}%'`).join(" or ")})`) : [];
    results.check("nor are the JSON body's ignored values stored", jsonStored[0]?.n === 0, JSON.stringify(jsonStored));
  },
};

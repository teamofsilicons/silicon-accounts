/**
 * The `accounts` CLI imports with the app's credentials: `accounts app import <file> --wait` follows the job to the
 * end and lists the first errors, `status`, `rows` and `list` read jobs back, --dry-run, --ignore-unknown-columns and
 * --idempotency-key do what they say, and every failure is precise (exit code, error code, hint).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "../../context";
import { cli, cliHome, tag, type CliRun } from "../../lib";
import {
  FIXTURES,
  PRECONDITION_PHONE,
  countsText,
  ensurePhoneOwned,
  expectedFor,
  fakeApp,
  forgetImportBudgets,
  freshExchange,
  lastSeq,
  messagesAfter,
  psql,
  sameCounts,
  tagCsv,
  tagJsonRows,
  taggedClean,
  type ImportCounts,
  type RowResult,
} from "./_helpers";

interface CliJob {
  id?: string;
  status?: string;
  dry_run?: boolean;
  total_rows?: number;
  processed_rows?: number;
  counts?: ImportCounts;
  first_errors?: RowResult[];
  error?: { code?: string; message?: string; hint?: string; exit_code?: number; details?: Record<string, unknown> };
}

const show = (run: CliRun) => `exit ${run.code} in ${run.ms} ms; stdout ${run.stdout.slice(0, 300).replace(/\s+/g, " ")}; stderr ${run.stderr.slice(0, 300).replace(/\s+/g, " ")}`;

export const journey: Journey = {
  name: "imports-cli",
  title: "the CLI: `accounts app import <csv|json> --wait` (counts, first errors), --dry-run, --ignore-unknown-columns, --idempotency-key, `import status|rows|list`, and precise failures (unknown columns, missing file, no or wrong secret)",
  async run(ctx) {
    // The journey writes its files (one of 51 MB) to a directory of its own and always deletes it.
    const dir = mkdtempSync(join(tmpdir(), "sa-e2e-imports-"));
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
  const home = cliHome();
  const asApp = ["--app-id", crm.app_id, "--app-secret-stdin"];
  const run = (args: string[], secret: string | null = crm.secret) => cli(env, home, [...args, ...(secret === null ? [] : asApp)], { stdin: secret === null ? "" : `${secret}\n` });

  const exchange = await freshExchange(env, ["415", "212"]);
  const clean = join(dir, `clean-${t}.csv`);
  writeFileSync(clean, (await taggedClean(env, t)).text);
  const dirtyTagged = tagCsv(readFileSync(join(FIXTURES, "dirty.csv"), "utf8"), `${t}d`, exchange, { keepRows: row => ["crm-038", "crm-039", "crm-040"].includes((row.external_id ?? "").trim()) });
  const dirty = join(dir, `dirty-${t}.csv`);
  writeFileSync(dirty, dirtyTagged.text);
  const unknown = join(dir, `unknown-${t}.csv`);
  writeFileSync(unknown, tagCsv(readFileSync(join(FIXTURES, "unknown-columns.csv"), "utf8"), `${t}u`, exchange).text);
  const jsonExchange = await freshExchange(env, ["415"]);
  const jsonFile = join(dir, `dirty-${t}.json`);
  writeFileSync(jsonFile, JSON.stringify({ rows: tagJsonRows((JSON.parse(readFileSync(join(FIXTURES, "dirty.json"), "utf8")) as { rows: Array<Record<string, unknown>> }).rows, `${t}j`, jsonExchange, row => row.external_id === "json-011").rows }));

  const help = await cli(env, home, ["app", "import", "--help"]);
  results.check("`accounts app import --help` explains the file and every option", help.code === 0 && ["--default-country", "--dry-run", "--ignore-unknown-columns", "--update-existing", "--wait", "--idempotency-key", "status", "rows", "list"].every(word => help.stdout.includes(word)), show(help));

  const seq = await lastSeq(env);
  const cleanRun = await run(["app", "import", clean, "--default-country", "US", "--wait", "--json"]);
  const cleanJob = (cleanRun.json ?? {}) as CliJob;
  results.metric("CLI import of clean.csv with --wait", cleanRun.ms, "ms");
  results.check("clean.csv with --wait: exit 0, completed, created 25, no first errors", cleanRun.code === 0 && cleanJob.status === "completed" && cleanJob.counts?.created === 25 && cleanJob.processed_rows === 25 && Array.isArray(cleanJob.first_errors) && cleanJob.first_errors.length === 0, show(cleanRun));

  const expected = expectedFor("dirty.csv");
  const dirtyRun = await run(["app", "import", dirty, "--default-country", "US", "--wait", "--json"]);
  const dirtyJob = (dirtyRun.json ?? {}) as CliJob;
  results.check("dirty.csv with --wait: exit 0 (row errors don't fail the job), expected.json's counts", dirtyRun.code === 0 && dirtyJob.status === "completed" && sameCounts(dirtyJob.counts, expected.counts), `${countsText(dirtyJob.counts)}; ${show(dirtyRun)}`);
  const errorRows = expected.rows.filter(row => row.outcome === "error").map(row => row.row_number);
  const firstErrors = dirtyJob.first_errors ?? [];
  results.check("--wait lists the first errors: every error row, with its code", firstErrors.length === errorRows.length && firstErrors.every(row => row.outcome === "error" && errorRows.includes(row.row_number) && row.messages.some(m => m.level === "error")), firstErrors.map(row => `${row.row_number}:${row.messages.filter(m => m.level === "error").map(m => m.code).join("+")}`).join(", "));

  const status = await run(["app", "import", "status", dirtyJob.id ?? "none", "--json"]);
  results.check("`import status <job>` shows the same job", status.code === 0 && (status.json as CliJob | null)?.id === dirtyJob.id && JSON.stringify((status.json as CliJob | null)?.counts) === JSON.stringify(dirtyJob.counts), show(status));
  const rows = await run(["app", "import", "rows", dirtyJob.id ?? "none", "--outcome", "error", "--json"]);
  const rowItems = ((rows.json as { items?: RowResult[] } | null)?.items ?? []);
  results.check("`import rows <job> --outcome error` returns only the error rows", rows.code === 0 && rowItems.length === errorRows.length && rowItems.every(row => row.outcome === "error"), show(rows));
  const page1 = await run(["app", "import", "rows", dirtyJob.id ?? "none", "--limit", "20", "--json"]);
  const cursor = (page1.json as { next_cursor?: string | null } | null)?.next_cursor;
  const page2 = cursor ? await run(["app", "import", "rows", dirtyJob.id ?? "none", "--limit", "20", "--cursor", cursor, "--json"]) : null;
  const firstOfPage2 = ((page2?.json as { items?: RowResult[] } | null)?.items ?? [])[0]?.row_number;
  results.check("`import rows --limit 20` pages with --cursor (the second page starts at row 21)", !!cursor && firstOfPage2 === 21, `${cursor ? "cursor" : "no cursor"}; next page starts at ${firstOfPage2}`);
  const textRows = await run(["app", "import", "rows", dirtyJob.id ?? "none", "--outcome", "skipped"]);
  results.check("in text mode `import rows` prints a table with the outcome and the message codes", textRows.code === 0 && /ROW/.test(textRows.stdout) && /OUTCOME/.test(textRows.stdout) && /duplicate_in_file/.test(textRows.stdout), show(textRows));
  const list = await run(["app", "import", "list", "--json"]);
  const listed = ((list.json as { items?: Array<{ id: string }> } | null)?.items ?? []).map(item => item.id);
  results.check("`import list` has both jobs, newest first", list.code === 0 && listed[0] === dirtyJob.id && listed.includes(cleanJob.id ?? "missing"), show(list));

  // Dry run in text mode: progress, the summary and the first errors, and nothing written.
  const dryRun = await run(["app", "import", dirty, "--default-country", "US", "--dry-run", "--wait"]);
  results.check("--dry-run --wait in text mode: the summary line, the counts and the first errors", dryRun.code === 0 && /Import [0-9a-f-]{36}: completed \(59\/59 rows\)/.test(dryRun.stdout) && /First errors:/.test(dryRun.stdout) && /row 6: .*missing_identifier/.test(dryRun.stdout), show(dryRun));
  const dryCreated = /created\s+(\d+)/.exec(dryRun.stdout)?.[1];
  const dryMatched = /matched\s+(\d+)/.exec(dryRun.stdout)?.[1];
  results.check("…a dry run of the file it just imported: every created row would now match its account (created 0, matched 47)", dryCreated === "0" && dryMatched === "47", `created ${dryCreated}, matched ${dryMatched}`);

  // JSON files.
  const json = await run(["app", "import", jsonFile, "--default-country", "US", "--wait", "--json"]);
  const jsonJob = (json.json ?? {}) as CliJob;
  results.check("a .json file imports as JSON (dirty.json's counts)", json.code === 0 && jsonJob.status === "completed" && sameCounts(jsonJob.counts, expectedFor("dirty.json").counts), `${countsText(jsonJob.counts)}; ${show(json)}`);

  // Unknown columns: refused precisely, then ignored on request.
  const refused = await run(["app", "import", unknown, "--wait", "--json"]);
  const refusal = (refused.json as CliJob | null)?.error;
  results.check("unknown columns: exit 2 with unknown_columns, the columns in details and the fix in the hint", refused.code === 2 && refusal?.code === "unknown_columns" && JSON.stringify((refusal.details as { unknown_columns?: string[] } | undefined)?.unknown_columns) === JSON.stringify(["favorite_color", "plan", "last_login_at"]) && /ignore_unknown_columns/.test(refusal.hint ?? ""), show(refused));
  const refusedText = await run(["app", "import", unknown]);
  results.check("…in text mode: `error:` with the message on stderr, `hint:` with the fix, nothing on stdout", refusedText.code === 2 && /error: The import has 3 columns/.test(refusedText.stderr) && /hint: .*ignore_unknown_columns/.test(refusedText.stderr) && refusedText.stdout.trim() === "", show(refusedText));
  const ignored = await run(["app", "import", unknown, "--ignore-unknown-columns", "--wait", "--json"]);
  const ignoredJob = (ignored.json ?? {}) as CliJob;
  results.check("--ignore-unknown-columns imports the 5 rows, each with a warning", ignored.code === 0 && ignoredJob.counts?.created === 5 && ignoredJob.counts.warnings === 5, show(ignored));

  // The same --idempotency-key twice: one job.
  const key = `cli-${t}-${Date.now()}`;
  const small = join(dir, `small-${t}.csv`);
  writeFileSync(small, `email,display_name,username\nsmall.${t}@legacy-crm.test,Small Row,small_${t}\n`);
  const once = await run(["app", "import", small, "--idempotency-key", key, "--json"]);
  const twice = await run(["app", "import", small, "--idempotency-key", key, "--json"]);
  results.check("the same --idempotency-key twice returns the same job", once.code === 0 && twice.code === 0 && !!(once.json as CliJob | null)?.id && (once.json as CliJob).id === (twice.json as CliJob | null)?.id, `${(once.json as CliJob | null)?.id} / ${(twice.json as CliJob | null)?.id}`);
  const waited = await run(["app", "import", "status", (once.json as CliJob | null)?.id ?? "none", "--wait", "--json"]);
  results.check("`import status <job> --wait` follows it to completed (created 1)", waited.code === 0 && (waited.json as CliJob | null)?.status === "completed" && (waited.json as CliJob).counts?.created === 1, show(waited));

  // Failures say what and why.
  const missing = await run(["app", "import", join(dir, "nope.csv"), "--json"]);
  results.check("a missing file: exit 2, file_not_found naming the path", missing.code === 2 && (missing.json as CliJob | null)?.error?.code === "file_not_found" && /nope\.csv/.test((missing.json as CliJob | null)?.error?.message ?? ""), show(missing));
  const noSecret = await cli(env, cliHome(), ["app", "import", small, "--app-id", crm.app_id, "--json"]);
  results.check("no secret and not signed in: exit 3, app_credentials_required with how to give one", noSecret.code === 3 && (noSecret.json as CliJob | null)?.error?.code === "app_credentials_required" && /--app-secret-stdin/.test((noSecret.json as CliJob | null)?.error?.hint ?? ""), show(noSecret));
  const wrongSecret = `sa_app_legacy-crm_${"q".repeat(40)}`;
  const wrong = await run(["app", "import", small, "--json"], wrongSecret);
  results.check("a wrong secret: exit 3, invalid_app_credentials, the secret never printed", wrong.code === 3 && (wrong.json as CliJob | null)?.error?.code === "invalid_app_credentials" && !wrong.stdout.includes(wrongSecret) && !wrong.stderr.includes(wrongSecret), show(wrong));
  // A file over the 50 MB limit, through the public origin as the CLI always goes: a precise refusal, not a crash.
  const oversized = join(dir, `oversized-${t}.csv`);
  const huge = Buffer.alloc(51 * 1024 * 1024, 0x61);
  huge.write("email,display_name\n", 0);
  writeFileSync(oversized, huge);
  const tooBig: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await run(["app", "import", oversized, "--dry-run", "--json"]);
    const error = (answer.json as CliJob | null)?.error;
    tooBig.push(`exit ${answer.code} ${error?.code ?? "?"}: ${(error?.message ?? answer.stderr).replace(/\s+/g, " ").slice(0, 160)}`);
  }
  results.check("a 51 MB file: exit 2 with payload_too_large and the 50 MB limit (2 of 2 tries)", tooBig.every(answer => answer.startsWith("exit 2 payload_too_large") && /50 MB/.test(answer)), tooBig.join(" | "));
  const nothing = await run(["app", "import", "--json"]);
  results.check("no file and no subcommand: exit 2 with an example", nothing.code === 2 && /accounts app import users\.csv/.test(JSON.stringify(nothing.json ?? nothing.stderr)), show(nothing));

  const created = await psql(env, `select count(*) from account_emails where email like '%@${t}.legacy-crm.test' or email like '%@${t}d.legacy-crm.test'`);
  results.check("the CLI's imports created each account once (24 + 43 carrying an email; the dry run and the replayed key none)", created === String(24 + 43), `${created} emails`);
  const sent = await messagesAfter(env, seq);
  results.check("no email or SMS was sent by any of these imports", sent.length === 0, sent.map(item => `${item.channel} to ${item.to}`).join(", ") || "nothing captured");
}

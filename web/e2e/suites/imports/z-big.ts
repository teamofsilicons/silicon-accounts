/**
 * A 100,000-row import (the most one import may carry) through the API: a dry run straight to accounts-api, then the
 * real import through the public origin (the account site's /v1, as an app in production calls it). Throughput is
 * measured from the job's own timestamps (rows/s), the job is followed while it runs (progress in 500-row chunks),
 * and the result is checked in the database: 100,000 unclaimed accounts, each with one address, 100,000 memberships,
 * the phones kept in the imported profiles. Last in the suite, so its 100k accounts never slow the others.
 */
import { randomUUID } from "node:crypto";
import { availableParallelism, loadavg } from "node:os";
import type { Journey } from "../../context";
import { tag } from "../../lib";
import {
  appCall,
  countsText,
  fakeApp,
  forgetImportBudgets,
  freshExchange,
  getJob,
  lastSeq,
  messagesAfter,
  postCsv,
  psql,
  waitJob,
  type ImportJob,
  type RowResult,
} from "./_helpers";

const ROWS = 100_000;
const FIRST = ["Ada", "Grace", "Alan", "Katherine", "Dorothy", "Linus", "Margaret", "Edsger", "Barbara", "Donald", "Radia", "Ken", "Frances", "Tim", "Hedy", "Claude", "Zoë", "José", "Søren", "Aiko", "Priya", "Wei", "Olu", "Noor"];
const LAST = ["Lovelace", "Hopper", "Turing", "Johnson", "Vaughan", "Torvalds", "Hamilton", "Dijkstra", "Liskov", "Knuth", "Perlman", "van Rossum", "Müller", "García", "Tanaka", "Sharma", "Zhang", "Adeyemi", "Haddad"];
const ZONES = ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney", "Africa/Lagos", "America/Sao_Paulo"];
const AREAS = ["201", "202", "206", "212", "213", "303", "305", "312", "404", "415", "503", "512", "617", "646", "650", "702", "718", "805", "917", "949"];

/** 100,000 valid rows: every one with a new email, one in five also with a new phone, all ids free. */
function bigCsv(t: string, exchange: string): { csv: string; phones: number } {
  const lines = ["external_id,email,phone,display_name,username,dob,timezone"];
  let phones = 0;
  for (let i = 1; i <= ROWS; i++) {
    const n = String(i).padStart(6, "0");
    let phone = "";
    if (i % 5 === 0) {
      phone = `+1${AREAS[phones % AREAS.length]}${exchange}${String(Math.floor(phones / AREAS.length)).padStart(4, "0")}`;
      phones++;
    }
    const dob = `${1950 + (i % 55)}-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`;
    lines.push(`${t}-${n},carbon${n}@${t}.bulk.example.test,${phone},${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]},${t}-${n},${dob},${ZONES[i % ZONES.length]}`);
  }
  return { csv: `${lines.join("\n")}\n`, phones };
}

const seconds = (from: string | null, to: string | null) => (from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : NaN);

export const journey: Journey = {
  name: "imports-big-100k",
  title: "100,000 rows through the API: a dry run straight to accounts-api, then the real import through the public origin; rows/s from the job's timestamps, progress in 500-row chunks, 100,000 accounts and memberships checked in the database",
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const crm = fakeApp("legacy-crm");
    await forgetImportBudgets(env, crm.app_id);
    const t = tag();
    const exchange = await freshExchange(env, AREAS);
    const built = Date.now();
    const { csv, phones } = bigCsv(t, exchange);
    const megabytes = Buffer.byteLength(csv) / (1024 * 1024);
    results.check("the file: 100,000 rows, 20,000 with a phone, under 50 MB", phones === 20_000 && megabytes < 50, `${megabytes.toFixed(1)} MB, ${phones} phones, built in ${Date.now() - built} ms (tag ${t}, exchange ${exchange})`);
    results.metric("100k file size", megabytes, "MB");
    const seq = await lastSeq(env);

    // A dry run, straight to accounts-api: validation and matching without writes.
    let started = Date.now();
    const dryAnswer = await postCsv(ctx, crm, csv, { dry_run: true }, { key: randomUUID(), direct: true });
    const dryAccepted = Date.now() - started;
    results.check("the dry run is accepted (202)", dryAnswer.status === 202 && dryAnswer.body.job?.total_rows === ROWS, `${dryAnswer.status} ${JSON.stringify(dryAnswer.body).slice(0, 200)}`);
    if (!dryAnswer.body.job) throw new Error(`the 100k dry run was refused: ${dryAnswer.status}`);
    const dry = await waitJob(ctx, crm, dryAnswer.body.job.id, 10 * 60_000, 500);
    const drySeconds = seconds(dry.started_at, dry.finished_at);
    results.check("the dry run reports every row as created, with no warning", dry.status === "completed" && dry.counts.created === ROWS && dry.counts.error === 0 && dry.counts.warnings === 0, countsText(dry.counts));
    results.metric("100k dry run: accepted (upload + parse) after", dryAccepted, "ms");
    results.metric("100k dry run: processing (started → finished)", drySeconds * 1000, "ms");
    results.metric("100k dry run: throughput", ROWS / drySeconds, "rows/s");
    results.check("…and wrote nothing", (await psql(env, `select count(*) from account_emails where email like '%@${t}.bulk.example.test'`)) === "0");

    // The real import, through the public origin.
    started = Date.now();
    const answer = await postCsv(ctx, crm, csv, {}, { key: randomUUID() });
    const accepted = Date.now() - started;
    results.check("the import is accepted through the account site's /v1 (202, 100,000 rows)", answer.status === 202 && answer.body.job?.total_rows === ROWS, `${answer.status} ${JSON.stringify(answer.body).slice(0, 200)}`);
    if (!answer.body.job) throw new Error(`the 100k import was refused: ${answer.status}`);
    results.metric("100k import: accepted (upload through the site + parse + 100k pending rows) after", accepted, "ms");

    // Follow it: processed_rows only grows, in whole 500-row chunks, until it completes.
    const seen: number[] = [];
    let job: ImportJob = answer.body.job;
    const deadline = Date.now() + 15 * 60_000;
    while (job.status !== "completed" && job.status !== "failed" && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 400));
      job = await getJob(ctx, crm, job.id);
      seen.push(job.processed_rows);
    }
    const doneAt = Date.now();
    const running = seen.filter(value => value > 0 && value < ROWS);
    results.check("while it runs, processed_rows only grows, in whole chunks of 500", seen.every((value, index) => index === 0 || value >= seen[index - 1]!) && running.every(value => value % 500 === 0) && running.length > 0, `${running.length} progress readings: ${running.slice(0, 8).join(", ")}…`);
    const processing = seconds(job.started_at, job.finished_at);
    const queued = seconds(job.created_at, job.started_at);
    results.check("the import completes: created 100,000, no error, no warning", job.status === "completed" && job.counts.created === ROWS && job.counts.error === 0 && job.counts.warnings === 0 && job.processed_rows === ROWS, `${job.status}: ${countsText(job.counts)} ${job.error ?? ""}`);
    results.metric("100k import: waited in the queue (created → started)", queued * 1000, "ms");
    results.metric("100k import: processing (started → finished)", processing * 1000, "ms");
    results.metric("100k import: throughput (processing)", ROWS / processing, "rows/s");
    results.metric("100k import: end to end (request → completed seen)", doneAt - started, "ms");
    results.metric("100k import: throughput end to end", ROWS / ((doneAt - started) / 1000), "rows/s");
    // The numbers depend on the machine: a debug build of accounts-api, and every other stack running beside it.
    results.metric("machine load average (1 min) at the end of the import", loadavg()[0]!, "load");
    results.metric("machine CPUs", availableParallelism(), "count");
    results.check(`throughput is reported: ${Math.round(ROWS / processing)} rows/s processing, ${Math.round(ROWS / ((doneAt - started) / 1000))} rows/s end to end`, Number.isFinite(processing) && processing > 0, `processing ${processing.toFixed(1)} s, queue ${queued.toFixed(1)} s, accepted after ${accepted} ms`);

    // What it wrote.
    const [accounts, memberships, carried, withPhones, history] = await Promise.all([
      psql(env, `select count(*) from account_emails e join accounts a on a.uuid = e.account_uuid where e.email like '%@${t}.bulk.example.test' and a.status = 'unclaimed' and e.verified_at is null and e.is_primary`),
      psql(env, `select count(*) from memberships where app_id = 'legacy-crm' and external_id like '${t}-%' and status = 'imported' and source = 'import'`),
      psql(env, `select count(*) from account_phones where ${AREAS.map(area => `phone like '+1${area}${exchange}%'`).join(" or ")}`),
      psql(env, `select count(*) from memberships where app_id = 'legacy-crm' and external_id like '${t}-%' and jsonb_array_length(imported_profile->'phones') = 1`),
      psql(env, `select count(*) from accounts where handle like 'c:${t}-%'`),
    ]);
    results.check("100,000 unclaimed accounts, each carrying its email (primary, unverified)", accounts === String(ROWS), `${accounts} accounts`);
    results.check("100,000 imported memberships with their external ids", memberships === String(ROWS), `${memberships} memberships`);
    results.check("the 20,000 phones stay in the imported profiles (an account carries one address: the email)", carried === "0" && withPhones === "20000", `${carried} phones on accounts, ${withPhones} profiles with a phone`);
    results.check("every account has the id its username asked for", history === String(ROWS), `${history} ids c:${t}-…`);
    const sample = [1, 4_242, 50_000, 99_999, 100_000];
    const sampled = await psql(env, `select string_agg(a.handle || '=' || e.email, ',' order by a.handle) from accounts a join account_emails e on e.account_uuid = a.uuid where a.handle in (${sample.map(n => `'c:${t}-${String(n).padStart(6, "0")}'`).join(",")})`);
    results.check("sampled rows map to exactly their own account (id ↔ email)", sample.every(n => sampled.includes(`c:${t}-${String(n).padStart(6, "0")}=carbon${String(n).padStart(6, "0")}@${t}.bulk.example.test`)), sampled);

    // Reading a 100k job back, and the user base it grew.
    let before = Date.now();
    const errors = await appCall<{ items: RowResult[]; next_cursor: string | null }>(ctx, crm, `/v1/apps/legacy-crm/imports/${job.id}/rows?outcome=error`);
    results.metric("rows?outcome=error on the 100k job", Date.now() - before, "ms");
    results.check("rows?outcome=error on a 100k job: none", errors.status === 200 && errors.body.items.length === 0 && errors.body.next_cursor === null, `${errors.status} ${errors.body.items?.length}`);
    before = Date.now();
    const last = await appCall<{ items: RowResult[] }>(ctx, crm, `/v1/apps/legacy-crm/imports/${job.id}/rows?limit=200&cursor=${Buffer.from(JSON.stringify(ROWS - 3)).toString("base64url")}`);
    results.metric("rows page near the end of the 100k job", Date.now() - before, "ms");
    results.check("a page near the end has the last rows with their ids", last.status === 200 && last.body.items.map(row => row.row_number).join(",") === "99998,99999,100000" && last.body.items[2]?.id === `c:${t}-100000`, `${last.status} ${last.body.items?.map(row => `${row.row_number}:${row.id}`).join(",")}`);
    before = Date.now();
    const search = await appCall<{ items: Array<{ id: string; status: string }> }>(ctx, crm, `/v1/apps/legacy-crm/users?q=${encodeURIComponent(`${t}-099999`)}`);
    results.metric("user base search (q) over legacy-crm after the 100k import", Date.now() - before, "ms");
    results.check("the user base finds one of the 100,000 by its external id", search.status === 200 && search.body.items.length === 1 && search.body.items[0]?.id === `c:${t}-099999` && search.body.items[0].status === "imported", `${search.status} ${JSON.stringify(search.body.items?.slice(0, 2))}`);
    const sent = await messagesAfter(env, seq);
    results.check("100,000 accounts created and not one email or SMS sent", sent.length === 0, `${sent.length} messages`);
  },
};

/**
 * clean.csv: 25 valid rows (email only, phone only, both; several countries) imported into legacy-crm with the app's
 * own credentials. Every row is created with its username as its id, as an unclaimed Carbon that carries one
 * unverified address, with an `imported` membership holding the cleaned row, and nobody gets an email or SMS.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { api, tag } from "../../lib";
import {
  accountsByUuid,
  allRows,
  appCall,
  countsText,
  csvRows,
  expectedFor,
  fakeApp,
  forgetImportBudgets,
  lastSeq,
  listJobs,
  messagesAfter,
  postCsv,
  psql,
  sameCounts,
  taggedClean,
  waitJob,
} from "./_helpers";

export const journey: Journey = {
  name: "imports-clean",
  title: "clean.csv into legacy-crm with the app's credentials: 25 rows created with their own ids, unclaimed accounts with one unverified address, imported memberships in the user base, no email or SMS",
  // Only the API and the CLI are under test here: the engine makes no difference, so WebKit runs skip it.
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    const crm = fakeApp("legacy-crm");
    await forgetImportBudgets(env, crm.app_id);
    const t = tag();
    const fixture = await taggedClean(env, t);
    const input = csvRows(fixture.text);
    const expected = expectedFor("clean.csv");
    results.check("the tagged copy keeps 25 rows and tags every username and external id", input.length === 25 && fixture.usernames.size === 25 && fixture.externalIds.size === 25, `${input.length} rows, ${fixture.usernames.size} usernames, ${fixture.externalIds.size} external ids (tag ${t}, exchange ${fixture.exchange})`);

    const statsBefore = (await appCall<{ stats?: { imported_unclaimed?: number; users?: number } }>(ctx, crm, "/v1/apps/legacy-crm")).body.stats;
    const seq = await lastSeq(env);
    const started = Date.now();
    const answer = await postCsv(ctx, crm, fixture.text, { default_country: "US" }, { key: randomUUID() });
    const acceptedMs = Date.now() - started;
    const queued = answer.body.job;
    results.check(
      "POST …/imports answers 202 with the queued job (csv, 25 rows, by the app, not a dry run)",
      answer.status === 202 && !!queued && queued.format === "csv" && queued.total_rows === 25 && queued.processed_rows === 0 && queued.dry_run === false && queued.created_by === "app" && queued.app_id === "legacy-crm" && queued.options.default_country === "US" && ["queued", "running"].includes(queued.status),
      `${answer.status} ${JSON.stringify(answer.body).slice(0, 400)}`,
    );
    if (!queued) throw new Error(`the import was not accepted: ${answer.status} ${JSON.stringify(answer.body)}`);
    results.metric("clean.csv accepted (202) after", acceptedMs, "ms");

    const job = await waitJob(ctx, crm, queued.id);
    results.metric("clean.csv request to completed", job.seen_done_at - started, "ms");
    if (job.started_at && job.finished_at) results.metric("clean.csv processing (started → finished)", Date.parse(job.finished_at) - Date.parse(job.started_at), "ms");
    results.check(
      "the job completes with every row created (created 25, matched 0, updated 0, skipped 0, error 0, warnings 0)",
      job.status === "completed" && sameCounts(job.counts, expected.counts) && job.counts.warnings === 0 && job.processed_rows === 25 && job.error === null && !!job.started_at && !!job.finished_at,
      `${job.status}: ${countsText(job.counts)}; processed ${job.processed_rows}; error ${job.error}`,
    );
    const listed = await listJobs(ctx, crm);
    results.check("the job heads the app's import list (newest first)", listed[0]?.id === job.id, listed.slice(0, 3).map(item => item.id).join(", "));

    // Every row: created, with exactly the id its username asked for; only an info note when a phone stays behind.
    const rows = await allRows(ctx, crm, job.id);
    const wrong: string[] = [];
    rows.forEach(row => {
      const source = input[row.row_number - 1]!;
      const wantId = `c:${source.username!.trim().toLowerCase()}`;
      const notes = row.messages.filter(m => m.level !== "info");
      const infos = row.messages.filter(m => m.level === "info");
      const both = !!source.email && !!source.phone;
      if (row.outcome !== "created" || row.id !== wantId || !row.account_uuid || notes.length) wrong.push(`row ${row.row_number}: ${row.outcome} ${row.id} (want ${wantId}) ${JSON.stringify(notes)}`);
      if (both && !(infos.length === 1 && infos[0]!.code === "identifiers_not_attached" && infos[0]!.message.includes(source.phone!.trim().replace(/[^\d+]/g, "").slice(-4)))) wrong.push(`row ${row.row_number}: expected one identifiers_not_attached note naming the phone, got ${JSON.stringify(infos)}`);
      if (!both && infos.length) wrong.push(`row ${row.row_number}: unexpected notes ${JSON.stringify(infos)}`);
    });
    results.check("all 25 rows are created with the username as their id (c:clean_…_<tag>), no warning or error", rows.length === 25 && wrong.length === 0, wrong.slice(0, 4).join(" · ") || `${rows.length} rows`);

    // The accounts and memberships the import wrote.
    const accounts = await accountsByUuid(env, rows.map(row => row.account_uuid!).filter(Boolean));
    const problems: string[] = [];
    for (const row of rows) {
      const source = input[row.row_number - 1]!;
      const account = row.account_uuid ? accounts.get(row.account_uuid) : undefined;
      if (!account) {
        problems.push(`row ${row.row_number}: no account`);
        continue;
      }
      const email = source.email?.trim().toLowerCase() ?? "";
      const phone = source.phone?.trim() ?? "";
      const say = (what: string) => problems.push(`row ${row.row_number} (${account.handle}): ${what}`);
      if (account.status !== "unclaimed") say(`status ${account.status}`);
      if (account.handle !== row.id) say(`handle ${account.handle} ≠ ${row.id}`);
      if (account.display_name !== source.display_name) say(`name ${account.display_name}`);
      if (account.dob !== source.dob) say(`dob ${account.dob} ≠ ${source.dob}`);
      if (account.timezone !== source.timezone) say(`timezone ${account.timezone} ≠ ${source.timezone}`);
      if (account.pfp_url !== `${env.iris}/pfp/carbon?id=${account.uuid}`) say(`pfp ${account.pfp_url} is not the default Carbon photo`);
      if (email) {
        if (!(account.emails.length === 1 && account.emails[0]!.email === email && account.emails[0]!.primary && !account.emails[0]!.verified)) say(`emails ${JSON.stringify(account.emails)}`);
        if (account.phones.length) say(`a phone on an account that has an email: ${JSON.stringify(account.phones)}`);
      } else if (!(account.phones.length === 1 && account.phones[0]!.phone === phone && account.phones[0]!.primary && !account.phones[0]!.verified && account.emails.length === 0)) say(`phones ${JSON.stringify(account.phones)} emails ${JSON.stringify(account.emails)}`);
      const m = account.membership;
      const profile = (m?.imported_profile ?? {}) as { emails?: string[]; phones?: string[]; display_name?: string; username?: string; dob?: string; timezone?: string; external_id?: string };
      if (!m || m.status !== "imported" || m.source !== "import" || m.external_id !== fixture.externalIds.get(row.row_number)) say(`membership ${JSON.stringify(m)}`);
      else if (JSON.stringify(profile.emails) !== JSON.stringify(email ? [email] : []) || JSON.stringify(profile.phones) !== JSON.stringify(phone ? [phone] : []) || profile.display_name !== source.display_name || profile.username !== source.username || profile.dob !== source.dob || profile.timezone !== source.timezone || profile.external_id !== m.external_id) say(`imported_profile ${JSON.stringify(profile)}`);
    }
    results.check("each account is unclaimed, has the row's name, dob, timezone and the default photo, and carries only its first address, unverified", problems.length === 0, problems.slice(0, 5).join(" · ") || `${accounts.size} accounts`);
    const history = await psql(env, `select count(*) from handle_history where changed_by = 'import' and old_handle is null and account_uuid = any(array[${rows.map(row => `'${row.account_uuid}'`).join(",")}]::text[])`);
    results.check("each new id is recorded in the id history (changed_by import)", history === "25", `${history} history rows`);

    // The ids are taken now: nobody else can claim them.
    const availability = await api<{ available?: boolean }>(ctx, `/v1/ids/available?id=${encodeURIComponent(rows[0]?.id ?? "")}`);
    results.check("an imported id is no longer available", availability.status === 200 && availability.body.available === false, `${rows[0]?.id}: ${JSON.stringify(availability.body)}`);

    // The app's user base: the 25 imported users, with what the app supplied.
    const users = await appCall<{ items: Array<{ uuid: string; status: string; source: string; external_id: string | null; email?: string | null; phone?: string | null; id: string }> }>(ctx, crm, `/v1/apps/legacy-crm/users?limit=100&q=${encodeURIComponent(`-${t}`)}`);
    const base = users.body.items ?? [];
    const baseWrong = base.filter(user => {
      const row = rows.find(item => item.account_uuid === user.uuid);
      const source = row ? input[row.row_number - 1] : undefined;
      return !source || user.status !== "imported" || user.source !== "import" || user.external_id !== fixture.externalIds.get(row!.row_number) || (source.email ? user.email !== source.email.toLowerCase() : user.phone !== source.phone);
    });
    results.check("the user base lists the 25 as imported (source import, external id, the email or phone the app gave)", users.status === 200 && base.length === 25 && baseWrong.length === 0, `${users.status}: ${base.length} found; wrong: ${JSON.stringify(baseWrong.slice(0, 2))}`);
    const statsAfter = (await appCall<{ stats?: { imported_unclaimed?: number; users?: number } }>(ctx, crm, "/v1/apps/legacy-crm")).body.stats;
    results.check("the app's stats count 25 more imported, unclaimed users", (statsAfter?.imported_unclaimed ?? 0) - (statsBefore?.imported_unclaimed ?? 0) === 25 && (statsAfter?.users ?? 0) - (statsBefore?.users ?? 0) === 25, `${JSON.stringify(statsBefore)} → ${JSON.stringify(statsAfter)}`);

    // Creating accounts by import never sends an email or SMS.
    const sent = await messagesAfter(env, seq);
    results.check("the import sent no email or SMS", sent.length === 0, sent.map(message => `${message.channel} to ${message.to}`).join(", ") || "mock email/SMS captured nothing");
  },
};

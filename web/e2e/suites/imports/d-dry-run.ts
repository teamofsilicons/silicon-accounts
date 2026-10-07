/**
 * A dry run validates and reports every row without writing anything: the same per-row outcomes as the real import
 * (expected.json), matched rows never naming the account they matched (a dry run must not be an email → account
 * lookup), no account, address, membership, id or reservation written, no email or SMS; and the real import of the
 * same file afterwards still creates every row, with exactly the ids the dry run announced.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { api, tag } from "../../lib";
import {
  FIXTURES,
  PRECONDITION_PHONE,
  allRows,
  countsText,
  describeRow,
  ensurePhoneOwned,
  expectedFor,
  fakeApp,
  forgetImportBudgets,
  freshExchange,
  lastSeq,
  messagesAfter,
  postCsv,
  psql,
  rowProblems,
  sameCounts,
  tagCsv,
  waitJob,
  writeCounts,
} from "./_helpers";

export const journey: Journey = {
  name: "imports-dry-run",
  title: "dry run of dirty.csv: expected.json's outcomes, matched accounts not named, nothing written (accounts, addresses, memberships, ids), nothing sent; the real import afterwards creates exactly what the dry run announced",
  async run(ctx) {
    const { env, results } = ctx;
    const crm = fakeApp("legacy-crm");
    await forgetImportBudgets(env, crm.app_id);
    await ensurePhoneOwned(ctx, PRECONDITION_PHONE);
    const t = tag();
    const exchange = await freshExchange(env, ["415", "212"]);
    const fixture = tagCsv(readFileSync(join(FIXTURES, "dirty.csv"), "utf8"), t, exchange, { keepRows: row => ["crm-038", "crm-039", "crm-040"].includes((row.external_id ?? "").trim()) });
    const expected = expectedFor("dirty.csv");

    const before = await writeCounts(env);
    const seq = await lastSeq(env);
    const answer = await postCsv(ctx, crm, fixture.text, { default_country: "US", dry_run: true }, { key: randomUUID() });
    results.check("the dry run is accepted as a job with dry_run true", answer.status === 202 && answer.body.job?.dry_run === true && answer.body.job.options.dry_run === true, `${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
    if (!answer.body.job) throw new Error("the dry run was refused");
    const dry = await waitJob(ctx, crm, answer.body.job.id);
    results.check("the dry run completes with the real import's counts (created 46, matched 1, updated 0, skipped 3, error 9)", dry.status === "completed" && sameCounts(dry.counts, expected.counts), `${dry.status}: ${countsText(dry.counts)}`);
    const dryRows = await allRows(ctx, crm, dry.id);
    const dryWrong = expected.rows.map(want => ({ want, got: dryRows.find(row => row.row_number === want.row_number) })).map(({ want, got }) => ({ n: want.row_number, problems: rowProblems(want, got, fixture.usernames, { dryRun: true }), got }));
    const failing = dryWrong.filter(entry => entry.problems.length);
    results.check("every one of the 59 rows has its expected.json outcome and messages", failing.length === 0, failing.slice(0, 5).map(entry => `row ${entry.n}: ${entry.problems.join("; ")} — ${describeRow(entry.got)}`).join(" · ") || "59/59");
    const matched = dryRows.find(row => row.row_number === 38);
    results.check("the matched row (c:saket's email) names no account in a dry run: account_uuid and id are null", matched?.outcome === "matched" && matched.account_uuid === null && matched.id === null, describeRow(matched));
    results.check("no row of a dry run names an account", dryRows.every(row => row.account_uuid === null), dryRows.filter(row => row.account_uuid).map(row => row.row_number).join(", ") || "none");

    const after = await writeCounts(env);
    results.check("nothing was written: accounts, emails, phones, memberships, id history, reservations, identities and account versions unchanged", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    const traces = await psql(env, `select (select count(*) from account_emails where email like '%@${t}.legacy-crm.test') + (select count(*) from memberships where app_id = 'legacy-crm' and external_id like '%-${t}') + (select count(*) from accounts where handle like '%\\_${t}')`);
    results.check("no address, membership or id of this file exists", traces === "0", `${traces} traces`);
    const wanted = dryRows.find(row => row.row_number === 1)?.id ?? `c:ada_byron_${t}`;
    const available = await api<{ available?: boolean }>(ctx, `/v1/ids/available?id=${encodeURIComponent(wanted)}`);
    results.check("the ids a dry run announces stay available", available.body.available === true, `${wanted}: ${JSON.stringify(available.body)}`);
    const sent = await messagesAfter(env, seq);
    results.check("the dry run sent no email or SMS", sent.length === 0, sent.map(item => `${item.channel} to ${item.to}`).join(", ") || "nothing captured");

    // The real import of the same file: what the dry run announced.
    const real = await postCsv(ctx, crm, fixture.text, { default_country: "US" }, { key: randomUUID() });
    if (!real.body.job) throw new Error(`the real import was refused: ${real.status} ${JSON.stringify(real.body)}`);
    const job = await waitJob(ctx, crm, real.body.job.id);
    results.check("the real import afterwards completes with the same counts", job.status === "completed" && JSON.stringify(job.counts) === JSON.stringify(dry.counts), `${countsText(job.counts)} vs dry ${countsText(dry.counts)}`);
    const rows = await allRows(ctx, crm, job.id);
    const differ = rows.filter(row => {
      const twin = dryRows.find(item => item.row_number === row.row_number);
      const codes = (list: typeof row.messages) => list.map(m => `${m.level}:${m.code}:${m.field ?? ""}`).join(",");
      return !twin || twin.outcome !== row.outcome || codes(twin.messages) !== codes(row.messages) || (row.outcome === "created" && twin.id !== row.id);
    });
    results.check("row by row, the real import has the dry run's outcomes, messages and ids", rows.length === 59 && differ.length === 0, differ.slice(0, 4).map(row => `row ${row.row_number}: real ${describeRow(row)} / dry ${describeRow(dryRows.find(item => item.row_number === row.row_number))}`).join(" · ") || "59/59 identical");
    const written = await writeCounts(env);
    results.check("…and now it wrote: 46 accounts with one address each", written.accounts! - after.accounts! === 46 && written.account_emails! + written.account_phones! - after.account_emails! - after.account_phones! === 46, `${JSON.stringify(after)} → ${JSON.stringify(written)}`);
    results.check("the real rows name their accounts", rows.filter(row => row.outcome === "created" || row.outcome === "matched").every(row => !!row.account_uuid), rows.filter(row => (row.outcome === "created" || row.outcome === "matched") && !row.account_uuid).map(row => row.row_number).join(", ") || "all named");
  },
};

/**
 * Retrying never imports twice. The same Idempotency-Key with the same request returns the same job (a replay, even
 * after the job finished, and when the retries race each other); the key with another body or other options is a 409;
 * a new key re-imports and every row now matches the account it created. And re-importing people who are already
 * members: matched (their external id kept, with a warning when the row says another) or, with update_existing,
 * updated (the membership's imported profile and external id replaced) — the account's own data never changes.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { tag } from "../../lib";
import {
  PRECONDITION_PHONE,
  accountsByUuid,
  allRows,
  countsText,
  describeRow,
  ensurePhoneOwned,
  fakeApp,
  forgetImportBudgets,
  listJobs,
  postCsv,
  postJson,
  psql,
  rowsOf,
  taggedClean,
  waitJob,
  type ImportJob,
} from "./_helpers";

export const journeys: Journey[] = [
  {
    name: "imports-idempotency",
    title: "the same Idempotency-Key returns the same job (also after it finished, and when retries race); the key with another body or options is 409; a new key re-imports and every row matches",
    async run(ctx) {
      const { env, results } = ctx;
      const crm = fakeApp("legacy-crm");
      await forgetImportBudgets(env, crm.app_id);
      const t = tag();
      const clean = await taggedClean(env, t);
      const csv = clean.text;
      const exchange = clean.exchange;
      const key = randomUUID();
      const jobsBefore = new Set((await listJobs(ctx, crm)).map(job => job.id));

      const first = await postCsv(ctx, crm, csv, { default_country: "US" }, { key });
      const second = await postCsv(ctx, crm, csv, { default_country: "US" }, { key });
      results.check("the first request starts a job (202, not a replay)", first.status === 202 && !!first.body.job && first.headers.get("idempotent-replayed") === null, `${first.status} replayed=${first.headers.get("idempotent-replayed")}`);
      results.check("the same request with the same key returns the same job (202, Idempotent-Replayed: true, the same body)", second.status === 202 && second.body.job?.id === first.body.job?.id && second.headers.get("idempotent-replayed") === "true" && JSON.stringify(second.body) === JSON.stringify(first.body), `${second.status} ${second.body.job?.id} vs ${first.body.job?.id}; replayed=${second.headers.get("idempotent-replayed")}`);
      if (!first.body.job) throw new Error("the import was refused");
      const job = await waitJob(ctx, crm, first.body.job.id);
      results.check("the job imports the 25 rows once", job.status === "completed" && job.counts.created === 25, countsText(job.counts));
      const third = await postCsv(ctx, crm, csv, { default_country: "US" }, { key });
      results.check("a retry after the job finished still returns that job, and imports nothing", third.status === 202 && third.body.job?.id === job.id && third.headers.get("idempotent-replayed") === "true", `${third.status} ${third.body.job?.id}`);
      const reused = await postCsv(ctx, crm, `${csv}clean-999-${t},late.${t}@legacy-crm.test,,Late Row,late_${t},1990-01-01,UTC\n`, { default_country: "US" }, { key });
      results.check("the key with another body is refused: 409 idempotency_key_reused", reused.status === 409 && reused.body.error?.code === "idempotency_key_reused", `${reused.status} ${JSON.stringify(reused.body).slice(0, 300)}`);
      const otherOptions = await postCsv(ctx, crm, csv, { default_country: "US", dry_run: true }, { key });
      results.check("the key with other options (dry_run=true) is refused too: the options are part of the request", otherOptions.status === 409 && otherOptions.body.error?.code === "idempotency_key_reused", `${otherOptions.status} ${JSON.stringify(otherOptions.body).slice(0, 200)}`);
      const created = await psql(env, `select count(*) from account_emails where email like '%@${t}.legacy-crm.test'`);
      const phoneOnly = await psql(env, `select count(*) from account_phones where phone = '+1303${exchange}0106'`);
      const newJobs = (await listJobs(ctx, crm)).filter(item => !jobsBefore.has(item.id));
      results.check("one job and 25 accounts in all (24 by email, 1 by phone)", newJobs.length === 1 && created === "24" && phoneOnly === "1", `${newJobs.length} new jobs; ${created} emails, ${phoneOnly} phone`);

      // Retries racing each other: one job.
      const raceKey = randomUUID();
      const body = { rows: [{ external_id: `race-${t}`, email: `race.${t}@legacy-crm.test`, display_name: "Race Condition", username: `race_${t}` }], options: {} };
      const raced = await Promise.all([1, 2, 3, 4].map(() => postJson(ctx, crm, body, { key: raceKey })));
      const ids = new Set(raced.filter(answer => answer.status === 202).map(answer => answer.body.job?.id));
      const statuses = raced.map(answer => `${answer.status}${answer.body.error?.code ? ` ${answer.body.error.code}` : ""}`);
      results.check("four racing retries with one key start one job (the others replay it or are told it is in progress)", ids.size === 1 && raced.every(answer => answer.status === 202 || (answer.status === 409 && answer.body.error?.code === "idempotency_in_progress")), statuses.join(", "));
      const racedJob = [...ids][0] ? await waitJob(ctx, crm, [...ids][0]!) : null;
      const raceAccounts = await psql(env, `select count(*) from account_emails where email = 'race.${t}@legacy-crm.test'`);
      results.check("…and one account", racedJob?.counts.created === 1 && raceAccounts === "1", `${countsText(racedJob?.counts)}; ${raceAccounts} account(s)`);

      // A new key is a new import: every row now matches the account the first one created.
      const again = await postCsv(ctx, crm, csv, { default_country: "US" }, { key: randomUUID() });
      const second2 = again.body.job ? await waitJob(ctx, crm, again.body.job.id) : null;
      results.check("the same file under a new key is a new job whose 25 rows all match (created 0, matched 25, no warning)", again.status === 202 && again.body.job?.id !== job.id && second2?.counts.created === 0 && second2.counts.matched === 25 && second2.counts.warnings === 0, `${again.status} ${countsText(second2?.counts)}`);
      if (second2) {
        const [firstRows, secondRows] = await Promise.all([allRows(ctx, crm, job.id), allRows(ctx, crm, second2.id)]);
        const mismatched = secondRows.filter(row => row.account_uuid !== firstRows.find(item => item.row_number === row.row_number)?.account_uuid || row.id !== firstRows.find(item => item.row_number === row.row_number)?.id);
        results.check("each matched row names the account (and id) the first import created", mismatched.length === 0 && secondRows.length === 25, mismatched.slice(0, 3).map(row => describeRow(row)).join(" · ") || "25/25");
      }
      const still = await psql(env, `select count(*) from account_emails where email like '%@${t}.legacy-crm.test'`);
      results.check("still 24 + 1 accounts: re-importing never duplicates anyone", still === "24", `${still} emails`);
    },
  },
  {
    name: "imports-reimport",
    title: "re-importing members: matched keeps the external id (warning external_id_differs), update_existing replaces the imported profile and external id (updated), the account's own data never changes; a phone match and two accounts in one row",
    async run(ctx) {
      const { env, results } = ctx;
      const crm = fakeApp("legacy-crm");
      await forgetImportBudgets(env, crm.app_id);
      const owner = await ensurePhoneOwned(ctx, PRECONDITION_PHONE);
      const t = tag();
      const people = [1, 2, 3].map(n => ({ external_id: `re-${n}-${t}`, email: `re${n}.${t}@legacy-crm.test`, display_name: `Re Person ${n}`, username: `re${n}_${t}`, dob: "1980-01-0" + n, timezone: "Europe/Rome" }));
      const run = async (rows: unknown[], options: Record<string, unknown>): Promise<ImportJob> => {
        const answer = await postJson(ctx, crm, { rows, options }, { key: randomUUID() });
        if (!answer.body.job) throw new Error(`import refused: ${answer.status} ${JSON.stringify(answer.body)}`);
        return waitJob(ctx, crm, answer.body.job.id);
      };
      const first = await run(people, {});
      const firstRows = await allRows(ctx, crm, first.id);
      results.check("three people are imported", first.counts.created === 3, countsText(first.counts));
      const uuids = firstRows.map(row => row.account_uuid!);
      const accountsBefore = await accountsByUuid(env, uuids);

      // Same people, new names and external ids, without update_existing: matched, the app's links kept.
      const changed = people.map((person, index) => ({ ...person, display_name: `Renamed ${index + 1}`, external_id: `re-${index + 1}-${t}-v2`, timezone: "Asia/Tokyo" }));
      const matched = await run(changed, {});
      const matchedRows = await allRows(ctx, crm, matched.id);
      results.check("without update_existing they match (matched 3, updated 0)", matched.counts.matched === 3 && matched.counts.updated === 0 && matched.counts.created === 0, countsText(matched.counts));
      results.check("…each with warning external_id_differs: the member keeps the external id the app gave it", matchedRows.every(row => row.messages.some(m => m.code === "external_id_differs" && m.level === "warning" && m.field === "external_id" && m.message.includes(`re-${row.row_number}-${t}`) && m.message.includes("update_existing"))), matchedRows.map(row => describeRow(row)).join(" · ").slice(0, 600));
      const afterMatch = await accountsByUuid(env, uuids);
      results.check("…their membership keeps its external id and imported profile", uuids.every(uuid => afterMatch.get(uuid)?.membership?.external_id === accountsBefore.get(uuid)?.membership?.external_id && JSON.stringify(afterMatch.get(uuid)?.membership?.imported_profile) === JSON.stringify(accountsBefore.get(uuid)?.membership?.imported_profile)), JSON.stringify([...afterMatch.values()].map(account => account.membership)).slice(0, 400));

      // With update_existing: updated; only the membership's imported data changes.
      const updated = await run(changed, { update_existing: true });
      const updatedRows = await allRows(ctx, crm, updated.id);
      results.check("with update_existing they are updated (updated 3)", updated.counts.updated === 3 && updated.counts.matched === 0 && updated.counts.created === 0 && updatedRows.every(row => row.outcome === "updated"), countsText(updated.counts));
      const afterUpdate = await accountsByUuid(env, uuids);
      results.check("…their membership now has the new external id and imported profile", uuids.every((uuid, index) => {
        const m = afterUpdate.get(uuid)?.membership;
        const p = (m?.imported_profile ?? {}) as { display_name?: string; timezone?: string };
        return m?.external_id === `re-${index + 1}-${t}-v2` && p.display_name === `Renamed ${index + 1}` && p.timezone === "Asia/Tokyo";
      }), JSON.stringify([...afterUpdate.values()].map(account => account.membership)).slice(0, 400));
      const own = (map: Map<string, { display_name: string; dob: string; timezone: string; handle: string | null; pfp_url: string }>) => uuids.map(uuid => { const a = map.get(uuid); return `${a?.handle}|${a?.display_name}|${a?.dob}|${a?.timezone}|${a?.pfp_url}`; }).join(",");
      results.check("…and the accounts' own data (id, name, dob, timezone, photo) never changed", own(afterUpdate) === own(accountsBefore) && own(afterMatch) === own(accountsBefore), `${own(accountsBefore)} → ${own(afterUpdate)}`);

      // An external id another member already has: error.
      const clash = await run([{ external_id: `re-1-${t}-v2`, email: `clash.${t}@legacy-crm.test`, display_name: "Clash" }], {});
      const clashRows = await allRows(ctx, crm, clash.id);
      results.check("an external id another member of the app already has is external_id_conflict (error)", clash.counts.error === 1 && clashRows[0]?.messages.some(m => m.code === "external_id_conflict" && /another member of this app/.test(m.message)) === true, describeRow(clashRows[0]));

      // A row whose only identifier is a phone an active Carbon verified: matched to that Carbon.
      const byPhone = await run([{ external_id: `phone-${t}`, phone: PRECONDITION_PHONE, display_name: "Someone Else's Name" }], {});
      const phoneRows = await allRows(ctx, crm, byPhone.id);
      const [phoneMembership] = await rowsOf<{ status: string }>(env, `select status from memberships where app_id = 'legacy-crm' and account_uuid = '${owner.uuid}'`);
      results.check("a phone an active Carbon verified matches that Carbon (matched; membership imported or still active)", phoneRows[0]?.outcome === "matched" && phoneRows[0].account_uuid === owner.uuid && ["imported", "active"].includes(phoneMembership?.status ?? ""), `${describeRow(phoneRows[0])}; membership ${phoneMembership?.status}`);

      // Two different accounts in one row: ambiguous.
      const both = await run([{ external_id: `both-${t}`, emails: [people[0]!.email, people[1]!.email], display_name: "Two People" }], {});
      const bothRows = await allRows(ctx, crm, both.id);
      results.check("a row whose emails belong to two different imported accounts is ambiguous_match (error)", both.counts.error === 1 && bothRows[0]?.messages.some(m => m.code === "ambiguous_match") === true, describeRow(bothRows[0]));
      const untouched = await accountsByUuid(env, uuids.slice(0, 2));
      results.check("…and neither account is touched", [...untouched.values()].every(account => account.membership?.external_id?.endsWith("-v2")), JSON.stringify([...untouched.values()].map(account => account.membership?.external_id)));
    },
  },
];

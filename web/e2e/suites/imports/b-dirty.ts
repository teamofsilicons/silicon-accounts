/**
 * dirty.csv and dirty.json: every messy case the importer must survive, row by row against expected.json (fixtures
 * README), then what the import wrote for each case (names, dates, timezones, photos, which address an account
 * carries, what stays in the membership's imported profile), that it never touched the existing accounts it matched,
 * and that it sent nothing. Row 40's precondition (another account owns +12025550142) is set up first.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { tag } from "../../lib";
import {
  FIXTURES,
  PRECONDITION_PHONE,
  VALID_ID,
  accountById,
  accountsByUuid,
  allRows,
  cleanName,
  countsText,
  csvRecords,
  csvRows,
  defaultDob,
  describeRow,
  ensurePhoneOwned,
  expectedFor,
  fakeApp,
  forgetImportBudgets,
  freshExchange,
  lastSeq,
  messagesAfter,
  postCsv,
  postJson,
  rowProblems,
  rowsOf,
  sameCounts,
  tagCsv,
  tagJsonRows,
  waitJob,
  type AccountRow,
  type RowResult,
} from "./_helpers";

const SEEDED_ROWS = new Set(["crm-038", "crm-039", "crm-040"]);

export const journeys: Journey[] = [
  {
    name: "imports-dirty-csv",
    title: "dirty.csv (BOM, CRLF, quoted newlines, invalid and local phones, bad dates, ambiguous matches, colliding ids, duplicate external ids…): every row's outcome and messages as expected.json, and what each case wrote",
    async run(ctx) {
      const { env, results } = ctx;
      const crm = fakeApp("legacy-crm");
      await forgetImportBudgets(env, crm.app_id);
      const precondition = await ensurePhoneOwned(ctx, PRECONDITION_PHONE);
      results.check("row 40's precondition: +12025550142 belongs to an account of its own", !!precondition.uuid, JSON.stringify(precondition));

      const t = tag();
      const exchange = await freshExchange(env, ["415", "212"]);
      const original = readFileSync(join(FIXTURES, "dirty.csv"), "utf8");
      const fixture = tagCsv(original, t, exchange, { keepRows: row => SEEDED_ROWS.has((row.external_id ?? "").trim()) });
      const originalRows = csvRows(original);
      const input = csvRows(fixture.text);
      results.check(
        "the tagged copy is still dirty: the UTF-8 BOM first, CRLF line ends, 59 data rows (one spans two lines), rows 38–40 untouched",
        fixture.text.charCodeAt(0) === 0xfeff && fixture.text.includes("\r\n") && input.length === 59 && csvRecords(fixture.text).length === 60 && fixture.text.includes('"Lin\nHopper"') && input[37]!.email === "SaketDev12@Example.TEST" && input[39]!.phone === PRECONDITION_PHONE,
        `${input.length} rows, tag ${t}, exchange ${exchange}`,
      );

      const saketBefore = await accountById(env, "c:saket");
      const [saketMembershipBefore] = await rowsOf<{ status: string; external_id: string | null }>(env, `select status, external_id from memberships where app_id = 'legacy-crm' and account_uuid = '${saketBefore?.uuid}'`);
      const expected = expectedFor("dirty.csv");
      const seq = await lastSeq(env);
      const answer = await postCsv(ctx, crm, Buffer.from(fixture.text, "utf8"), { default_country: "US" }, { key: randomUUID() });
      results.check("the file is accepted (202): the BOM is not read as part of the first column's name", answer.status === 202 && !!answer.body.job, `${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
      if (!answer.body.job) throw new Error("dirty.csv was refused");
      const job = await waitJob(ctx, crm, answer.body.job.id);
      results.check(
        `the job completes with expected.json's counts (created 46, matched 1, updated 0, skipped 3, error 9) over 59 rows`,
        job.status === "completed" && sameCounts(job.counts, expected.counts) && job.total_rows === 59 && job.processed_rows === 59,
        `${job.status}: ${countsText(job.counts)}; ${job.processed_rows}/${job.total_rows} rows; ${job.error ?? ""}`,
      );

      const rows = await allRows(ctx, crm, job.id);
      const byRow = new Map(rows.map(row => [row.row_number, row]));
      for (const want of expected.rows) {
        const got = byRow.get(want.row_number);
        const problems = rowProblems(want, got, fixture.usernames);
        results.check(`row ${want.row_number} (${want.case}): ${want.outcome}${want.messages.length ? `, ${want.messages.map(m => `${m.level} ${m.code}`).join(", ")}` : ""}`, problems.length === 0, problems.length ? `${problems.join("; ")} — got ${describeRow(got)}` : describeRow(got));
      }

      // What the messages say.
      const message = (n: number, code: string) => byRow.get(n)?.messages.find(m => m.code === code)?.message ?? "";
      results.check("duplicates name the row they repeat (rows 4 and 51 → row 1, row 52 → row 11)", /\brow 1\b/.test(message(4, "duplicate_in_file")) && /\brow 1\b/.test(message(51, "duplicate_in_file")) && /\brow 11\b/.test(message(52, "duplicate_in_file")), [message(4, "duplicate_in_file"), message(51, "duplicate_in_file"), message(52, "duplicate_in_file")].join(" | "));
      const conflict41 = /Wanted c:saket, assigned (c:saket-\d+)/.exec(message(41, "id_conflict"));
      const conflict42 = /Wanted c:shubham, assigned (c:shubham-\d+)/.exec(message(42, "id_conflict"));
      results.check("id_conflict says what was wanted and what was assigned (c:saket → c:saket-N, c:shubham → c:shubham-N)", !!conflict41 && conflict41[1] === byRow.get(41)?.id && !!conflict42 && conflict42[1] === byRow.get(42)?.id, `${message(41, "id_conflict")} | ${message(42, "id_conflict")}`);
      results.check("external_id_conflict names the row that already uses the id (row 49)", /row 49/.test(message(50, "external_id_conflict")), message(50, "external_id_conflict"));
      const ambiguous = [message(39, "ambiguous_match"), message(40, "ambiguous_match")];
      const owners = await rowsOf<{ uuid: string; handle: string }>(env, `select uuid, handle from accounts where handle in ('c:acme-dev', 'c:orbit-dev', 'c:quill-dev') or uuid = '${precondition.uuid}'`);
      results.check("ambiguous_match explains the clash without naming the accounts it found", ambiguous.every(text => /2 different accounts/.test(text) && owners.every(owner => !text.includes(owner.handle) && !text.includes(owner.uuid))), ambiguous.join(" | "));
      results.check("an invalid local number says it was read with default_country US (row 13)", /default_country US/.test(message(13, "invalid_phone")), message(13, "invalid_phone"));
      results.check("the ambiguous date (04/05/1990) says it is ambiguous (row 24)", /ambiguous/i.test(byRow.get(24)?.messages.find(m => m.field === "dob")?.message ?? ""), byRow.get(24)?.messages.map(m => m.message).join(" | "));
      results.check("missing_identifier says why: no address at all (row 14) or none left valid (row 6)", /no email or phone number/.test(message(14, "missing_identifier")) && /no valid email or phone number left/.test(message(6, "missing_identifier")), `${message(14, "missing_identifier")} | ${message(6, "missing_identifier")}`);

      // Suggested ids: valid, never the invalid or reserved username, and from the right seed.
      const id = (n: number) => byRow.get(n)?.id ?? "";
      const suggestions: Array<[number, boolean, string]> = [
        [15, id(15).startsWith("c:zoe-saldana"), "from the email (c:zoe-saldana…)"],
        [16, id(16).startsWith("c:bruce-lee"), "c:bruce-lee…"],
        [18, id(18).startsWith("c:mo-salah"), "c:mo-salah…"],
        [34, id(34).startsWith("c:short-row"), "c:short-row…"],
        [35, id(35).startsWith("c:j-smith-quoted"), "c:j-smith-quoted…"],
        [43, /^c:john-smith(-\d+)?$/.test(id(43)), "c:john-smith (from the username)"],
        [44, id(44) !== "c:ab" && VALID_ID.test(id(44)), "never c:ab"],
        [45, VALID_ID.test(id(45)) && id(45).length - 2 <= 30, "at most 30 characters"],
        [46, id(46) !== "c:admin" && VALID_ID.test(id(46)), "never c:admin"],
        [47, id(47) !== "c:support" && VALID_ID.test(id(47)), "never c:support"],
      ];
      const badSuggestions = suggestions.filter(([, ok]) => !ok);
      results.check("suggested ids are valid and come from the username, else the email (rows 15, 16, 18, 34, 35, 43–47)", badSuggestions.length === 0, (badSuggestions.length ? badSuggestions : suggestions).map(([n, , what]) => `row ${n}: ${id(n)} (${what})`).join(", "));

      // What the import wrote, case by case.
      const created = rows.filter(row => row.outcome === "created");
      const accounts = await accountsByUuid(env, created.map(row => row.account_uuid!).filter(Boolean));
      const acct = (n: number): AccountRow | undefined => {
        const row = byRow.get(n);
        return row?.account_uuid ? accounts.get(row.account_uuid) : undefined;
      };
      const profile = (n: number) => (acct(n)?.membership?.imported_profile ?? {}) as { emails?: string[]; phones?: string[]; email_verified?: boolean | null; display_name?: string };
      const emailOf = (local: string) => `${local}@${t}.legacy-crm.test`;
      const phoneOf = (area: string, line: string) => `+1${area}${exchange}${line}`;
      const shapeWrong: string[] = [];
      for (const row of created) {
        const account = row.account_uuid ? accounts.get(row.account_uuid) : undefined;
        const p = (account?.membership?.imported_profile ?? {}) as { emails?: string[]; phones?: string[] };
        const first = p.emails?.[0] ?? p.phones?.[0];
        const carries = [...(account?.emails ?? []).map(e => ({ value: e.email, primary: e.primary, verified: e.verified })), ...(account?.phones ?? []).map(e => ({ value: e.phone, primary: e.primary, verified: e.verified }))];
        const ok = !!account && account.status === "unclaimed" && account.handle === row.id && carries.length === 1 && carries[0]!.value === first && carries[0]!.primary && !carries[0]!.verified && account.membership?.status === "imported" && account.membership.source === "import" && account.membership.external_id === fixture.externalIds.get(row.row_number);
        if (!ok) shapeWrong.push(`row ${row.row_number}: ${JSON.stringify(account).slice(0, 300)}`);
      }
      results.check("all 46 new accounts are unclaimed, carry only the row's first valid address (unverified), and have an imported membership with the row's external id", created.length === 46 && shapeWrong.length === 0, shapeWrong.slice(0, 3).join(" · ") || `${created.length} accounts`);

      const a1 = acct(1);
      results.check("row 1: https photo kept; email_verified=true is informational only (the email stays unverified)", a1?.pfp_url === "https://images.legacy-crm.test/avatars/ada.png" && a1.emails[0]?.email === emailOf("ada.byron") && a1.emails[0]?.verified === false && profile(1).email_verified === true && a1.display_name === "Ada Byron" && a1.dob === "1990-04-12" && a1.timezone === "Europe/London", JSON.stringify(a1).slice(0, 400));
      results.check("row 2: the mixed-case email is stored lower-cased", acct(2)?.emails[0]?.email === emailOf("grace.murray"), JSON.stringify(acct(2)?.emails));
      const a3 = acct(3);
      results.check("row 3: every padded value is trimmed (external id, name, dob, timezone; the phone kept in the imported profile)", a3?.membership?.external_id === `crm-003-${t}` && a3.display_name === "Alan Mathison" && a3.dob === "1991-06-23" && a3.timezone === "Asia/Kolkata" && JSON.stringify(profile(3).phones) === JSON.stringify([phoneOf("415", "0103")]), JSON.stringify(a3).slice(0, 400));
      results.check("row 5: an invalid email leaves an account carrying the phone only", JSON.stringify(acct(5)?.phones.map(p => p.phone)) === JSON.stringify([phoneOf("415", "0105")]) && acct(5)?.emails.length === 0, JSON.stringify(acct(5)));
      results.check("rows 9 and 10: the invalid phone is dropped (not even in the imported profile), the row is created with its email", JSON.stringify(profile(9).phones) === "[]" && JSON.stringify(profile(10).phones) === "[]" && acct(9)?.emails[0]?.email === emailOf("barbara.liskov") && acct(10)?.emails[0]?.email === emailOf("margaret.h"), `${JSON.stringify(profile(9))} ${JSON.stringify(profile(10))}`);
      results.check("rows 11 and 12: local US numbers are normalized with default_country US", acct(11)?.phones[0]?.phone === phoneOf("415", "0123") && acct(12)?.phones[0]?.phone === phoneOf("415", "0199"), `${JSON.stringify(acct(11)?.phones)} ${JSON.stringify(acct(12)?.phones)}`);
      const names = [15, 16, 17, 18, 19, 33, 35, 36, 37].map(n => ({ n, want: cleanName(originalRows[n - 1]!.display_name ?? ""), got: acct(n)?.display_name }));
      results.check("display names are kept exactly: diacritics, CJK, Nordic, right-to-left, emoji, a quoted comma, a quoted newline (one space), escaped quotes", names.every(name => name.got === name.want) && names.find(name => name.n === 36)?.got === "Lin Hopper" && names.find(name => name.n === 35)?.got === "Smith, John" && names.find(name => name.n === 37)?.got === 'Robert "Bob" Tables', names.map(name => `${name.n}: ${name.got}${name.got === name.want ? "" : ` ≠ ${name.want}`}`).join(" | "));
      const fallback = defaultDob();
      const dobs = { 19: "2000-02-29", 20: fallback, 21: fallback, 22: fallback, 23: fallback, 24: fallback, 25: "1987-11-23", 26: "1987-11-23", 27: "1987-11-23", 28: "1987-11-23", 29: "1993-07-07", 34: fallback } as Record<number, string>;
      const dobWrong = Object.entries(dobs).filter(([n, want]) => acct(Number(n))?.dob !== want);
      results.check(`dates: a leap day is kept, invalid/impossible/ambiguous dates get the default (${fallback}), all five formats read 1987-11-23`, dobWrong.length === 0, dobWrong.map(([n, want]) => `row ${n}: ${acct(Number(n))?.dob} ≠ ${want}`).join(", ") || "all as expected");
      const zones = { 30: "UTC", 31: "UTC", 32: "UTC", 34: "UTC", 59: "Europe/Berlin" } as Record<number, string>;
      const zoneWrong = Object.entries(zones).filter(([n, want]) => acct(Number(n))?.timezone !== want);
      results.check("timezones: unknown, offset and Windows names fall back to UTC; a padded IANA name is trimmed", zoneWrong.length === 0, zoneWrong.map(([n, want]) => `row ${n}: ${acct(Number(n))?.timezone} ≠ ${want}`).join(", ") || "all as expected");
      results.check("row 53: the account carries the first email; all three stay in the imported profile", JSON.stringify(acct(53)?.emails.map(e => e.email)) === JSON.stringify([emailOf("multi.primary")]) && JSON.stringify(profile(53).emails) === JSON.stringify([emailOf("multi.primary"), emailOf("multi.second"), emailOf("multi.third")]) && byRow.get(53)!.messages.some(m => m.code === "identifiers_not_attached"), JSON.stringify({ account: acct(53)?.emails, profile: profile(53).emails }));
      results.check("row 54: three phones in mixed formats are normalized in order in the imported profile", JSON.stringify(profile(54).phones) === JSON.stringify([phoneOf("212", "0154"), phoneOf("212", "0155"), phoneOf("212", "0156")]) && acct(54)?.emails[0]?.email === emailOf("multi.phone"), JSON.stringify(profile(54)));
      results.check("row 55: an http photo falls back to the default Carbon photo", acct(55)?.pfp_url === `${env.iris}/pfp/carbon?id=${acct(55)?.uuid}`, String(acct(55)?.pfp_url));
      results.check("row 57: the same email twice in one row is one email", JSON.stringify(profile(57).emails) === JSON.stringify([emailOf("same.twice")]), JSON.stringify(profile(57).emails));
      results.check("row 59: a plus address is kept as written", acct(59)?.emails[0]?.email === emailOf("ops+crm"), JSON.stringify(acct(59)?.emails));

      // The existing account it matched is untouched; only the membership is new.
      const saketAfter = await accountById(env, "c:saket");
      const [saketMembership] = await rowsOf<{ status: string; source: string; external_id: string | null }>(env, `select status, source, external_id from memberships where app_id = 'legacy-crm' and account_uuid = '${saketAfter?.uuid}'`);
      results.check("row 38: c:saket keeps its own name, id, dob, timezone, photo and version (import never overwrites account data)", !!saketBefore && JSON.stringify(saketBefore) === JSON.stringify(saketAfter) && saketAfter?.display_name !== "Saket From CRM", `${JSON.stringify(saketBefore)} → ${JSON.stringify(saketAfter)}`);
      results.check(
        "row 38: c:saket is now in legacy-crm's user base as legacy-crm:{uuid} (imported, external id crm-038)",
        byRow.get(38)?.account_uuid === saketAfter?.uuid && (saketMembershipBefore ? saketMembership?.status === saketMembershipBefore.status : saketMembership?.status === "imported" && saketMembership.source === "import" && saketMembership.external_id === "crm-038"),
        `before ${JSON.stringify(saketMembershipBefore)} after ${JSON.stringify(saketMembership)}`,
      );
      const sent = await messagesAfter(env, seq);
      results.check("the import sent no email or SMS", sent.length === 0, sent.map(item => `${item.channel} to ${item.to}`).join(", ") || "nothing captured");
    },
  },
  {
    name: "imports-dirty-json",
    title: "dirty.json as a JSON body: the name alias, emails/phones as arrays and ;-strings, nulls, padding, email_verified, an empty object, a seeded account matched, an id collision",
    async run(ctx) {
      const { env, results } = ctx;
      const crm = fakeApp("legacy-crm");
      await forgetImportBudgets(env, crm.app_id);
      const t = tag();
      const exchange = await freshExchange(env, ["415"]);
      const original = (JSON.parse(readFileSync(join(FIXTURES, "dirty.json"), "utf8")) as { rows: Array<Record<string, unknown>> }).rows;
      const tagged = tagJsonRows(original, t, exchange, row => row.external_id === "json-011");
      const expected = expectedFor("dirty.json");
      const seq = await lastSeq(env);
      const answer = await postJson(ctx, crm, { rows: tagged.rows, options: { default_country: "US" } }, { key: randomUUID() });
      results.check("the JSON body is accepted (202, format json, default_country from the body's options)", answer.status === 202 && answer.body.job?.format === "json" && answer.body.job.total_rows === 16 && answer.body.job.options.default_country === "US", `${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
      if (!answer.body.job) throw new Error("dirty.json was refused");
      const job = await waitJob(ctx, crm, answer.body.job.id);
      results.check("the job completes with expected.json's counts (created 11, matched 1, updated 0, skipped 1, error 3)", job.status === "completed" && sameCounts(job.counts, expected.counts), `${job.status}: ${countsText(job.counts)}`);
      const rows = await allRows(ctx, crm, job.id);
      const byRow = new Map(rows.map(row => [row.row_number, row]));
      for (const want of expected.rows) {
        const got = byRow.get(want.row_number);
        const problems = rowProblems(want, got, tagged.usernames);
        results.check(`row ${want.row_number} (${want.case}): ${want.outcome}`, problems.length === 0, problems.length ? `${problems.join("; ")} — got ${describeRow(got)}` : describeRow(got));
      }
      const accounts = await accountsByUuid(env, rows.filter(row => row.outcome === "created").map(row => row.account_uuid!));
      const acct = (n: number) => {
        const row: RowResult | undefined = byRow.get(n);
        return row?.account_uuid ? accounts.get(row.account_uuid) : undefined;
      };
      const profile = (n: number) => (acct(n)?.membership?.imported_profile ?? {}) as { emails?: string[]; phones?: string[]; email_verified?: boolean | null };
      const emailOf = (local: string) => `${local}@${t}.legacy-crm.test`;
      results.check("row 1: `name` is display_name; the email is lower-cased", acct(1)?.display_name === "Json Mixed" && acct(1)?.emails[0]?.email === emailOf("json.mixed"), JSON.stringify(acct(1)).slice(0, 300));
      results.check("rows 2 and 3: emails as an array and as a ;-string; the first is the account's, both stay in the imported profile", acct(2)?.emails[0]?.email === emailOf("json.multi1") && JSON.stringify(profile(2).emails) === JSON.stringify([emailOf("json.multi1"), emailOf("json.multi2")]) && JSON.stringify(profile(3).emails) === JSON.stringify([emailOf("json.semi1"), emailOf("json.semi2")]), `${JSON.stringify(profile(2))} ${JSON.stringify(profile(3))}`);
      results.check("row 4: a phones array with a local number: both normalized, the first on the account", acct(4)?.phones[0]?.phone === `+1415${exchange}0144` && JSON.stringify(profile(4).phones) === JSON.stringify([`+1415${exchange}0144`, `+1415${exchange}0145`]), JSON.stringify(profile(4)));
      results.check("row 5: padded strings are trimmed (email, name, username, timezone)", acct(5)?.display_name === "Json Spaces" && acct(5)?.timezone === "Asia/Tokyo" && acct(5)?.emails[0]?.email === emailOf("json.spaces") && byRow.get(5)?.id === `c:json_spaces_${t}`, JSON.stringify(acct(5)).slice(0, 300));
      results.check("row 7: email_verified true is informational: the email stays unverified", acct(7)?.emails[0]?.verified === false && profile(7).email_verified === true, JSON.stringify(acct(7)?.emails));
      results.check("row 8: a unicode name and a c:-prefixed username", acct(8)?.display_name === "Siobhán Ní Bhriain" && byRow.get(8)?.id === `c:siobhan_${t}`, `${acct(8)?.display_name} ${byRow.get(8)?.id}`);
      results.check("row 12: an invalid timezone and an impossible dob fall back to UTC and the default dob", acct(12)?.timezone === "UTC" && acct(12)?.dob === defaultDob(), `${acct(12)?.timezone} ${acct(12)?.dob}`);
      results.check("row 13: an https photo is kept", acct(13)?.pfp_url === "https://images.legacy-crm.test/avatars/13.png", String(acct(13)?.pfp_url));
      results.check("row 15: the colliding username gets a free id (c:saket-N) with id_conflict", /^c:saket-\d+$/.test(byRow.get(15)?.id ?? ""), describeRow(byRow.get(15)));
      const sent = await messagesAfter(env, seq);
      results.check("the import sent no email or SMS", sent.length === 0, sent.map(item => `${item.channel} to ${item.to}`).join(", ") || "nothing captured");
    },
  },
];

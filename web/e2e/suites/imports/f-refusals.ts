/**
 * What the import API refuses, and how precisely: malformed requests and options, files past the limits (columns,
 * cells, rows, 50 MB: from the headers with or without Expect: 100-continue, chunked, through the site's rewrite, and
 * the exact byte boundary), and the app's budgets (60 requests an hour, 2,000,000 rows a day; time travel moves their
 * windows), with nothing imported by any refusal. Who may import and read jobs: the app's own credentials or its
 * owner's session (Origin-checked; the developer site's BFF in p-developer.ts), never another app, a wrong secret or another Carbon; the rows endpoint's filters,
 * pagination and 404s. And capacity: two import bodies read at once per API node (one per app), 503 imports_busy after 30 s.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { newContext, signInOnSite, sleep, tag } from "../../lib";
import {
  allRows,
  appCall,
  basicAuth,
  countsText,
  describeRaw,
  errorOfText,
  fakeApp,
  forgetImportBudgets,
  listJobs,
  lit,
  postCsv,
  postExpectContinue,
  postJson,
  postPlain,
  postTrickle,
  psql,
  rowsOf,
  waitJob,
  type ApiErrorBody,
  type ImportJob,
  type RawAnswer,
  type RowResult,
} from "./_helpers";

type Answer = { status: number; body: ApiErrorBody & { job?: ImportJob }; headers: Headers };
const code = (answer: Answer) => answer.body.error?.code ?? "";
/** The error of a raw answer body, or null when it is not a Silicon Accounts error (a proxy's "Internal Server Error"). */
const errorOf = (text: string): ApiErrorBody["error"] | null => {
  try {
    return (JSON.parse(text) as ApiErrorBody).error ?? null;
  } catch {
    return null;
  }
};
const brief = (answer: Answer) => `${answer.status} ${code(answer)}: ${answer.body.error?.message ?? JSON.stringify(answer.body).slice(0, 200)}`;

export const journeys: Journey[] = [
  {
    name: "imports-refusals",
    title: "refusals with precise errors and nothing imported: content types, options, empty files, missing identifier columns, duplicate columns, invalid UTF-8, cells over 8 KB, 201 columns, 100,001 rows, bodies over 50 MB; the hourly request and daily row budgets (time travel)",
    // Only the API and the CLI are under test here: the engine makes no difference, so WebKit runs skip it.
    engines: ["chromium"],
    timeoutMs: 8 * 60_000,
    async run(ctx) {
      const { env, results } = ctx;
      const crm = fakeApp("legacy-crm");
      await forgetImportBudgets(env, crm.app_id);
      const t = tag();
      const jobsBefore = (await listJobs(ctx, crm)).length;
      const ok = `email,display_name\nok.${t}@legacy-crm.test,Ok Row\n`;

      const plain = await postCsv(ctx, crm, ok, {}, { contentType: "text/plain" });
      results.check("text/plain is refused: 400 invalid_content_type naming what was sent", plain.status === 400 && code(plain) === "invalid_content_type" && /text\/plain/.test(plain.body.error?.message ?? ""), brief(plain));
      const none = await postCsv(ctx, crm, Buffer.from(ok), {}, { contentType: null });
      results.check("no Content-Type is refused: 400 invalid_content_type", none.status === 400 && code(none) === "invalid_content_type", brief(none));
      const country = await postCsv(ctx, crm, ok, { default_country: "XX" });
      results.check("default_country=XX: 400 invalid_query (not an ISO 3166 code)", country.status === 400 && code(country) === "invalid_query" && /ISO 3166/.test(country.body.error?.message ?? ""), brief(country));
      const flag = await postCsv(ctx, crm, ok, { dry_run: "maybe" });
      results.check("dry_run=maybe: 400 invalid_query (use true or false)", flag.status === 400 && code(flag) === "invalid_query" && /true or false/.test(flag.body.error?.message ?? ""), brief(flag));
      const unknownOption = await postCsv(ctx, crm, ok, { shoe_size: "9" });
      results.check("an unknown query parameter: 400 invalid_query listing the options", unknownOption.status === 400 && code(unknownOption) === "invalid_query" && /default_country, ignore_unknown_columns, dry_run, update_existing/.test(unknownOption.body.error?.message ?? ""), brief(unknownOption));
      const conflicting = await postJson(ctx, crm, { rows: [{ email: `json.${t}@legacy-crm.test` }], options: { dry_run: true } }, { query: { dry_run: false } });
      const fields = (conflicting.body.error?.details as { fields?: Record<string, string> } | undefined)?.fields ?? {};
      results.check("dry_run true in the body and false in the query: 422 validation_failed on options.dry_run (a silently ignored dry run would write)", conflicting.status === 422 && code(conflicting) === "validation_failed" && !!fields["options.dry_run"], `${brief(conflicting)} ${JSON.stringify(fields)}`);
      const badOption = await postJson(ctx, crm, { rows: [{ email: `json.${t}@legacy-crm.test` }], options: { colour: "red" } });
      results.check("an unknown option in the body: 422 naming options.colour", badOption.status === 422 && !!(badOption.body.error?.details as { fields?: Record<string, string> } | undefined)?.fields?.["options.colour"], brief(badOption));
      const notRows = await postJson(ctx, crm, { rows: "everyone" });
      results.check("rows that are not an array: 422 naming rows", notRows.status === 422 && !!(notRows.body.error?.details as { fields?: Record<string, string> } | undefined)?.fields?.rows, brief(notRows));
      const broken = await appCall<ApiErrorBody>(ctx, crm, "/v1/apps/legacy-crm/imports", { method: "POST", headers: { "content-type": "application/json" }, body: '{"rows": [{"email": "a@b.test"},' });
      results.check("broken JSON: 400 invalid_json saying where", broken.status === 400 && broken.body.error?.code === "invalid_json" && /line|column/.test(broken.body.error.message ?? ""), `${broken.status} ${JSON.stringify(broken.body).slice(0, 240)}`);
      const emptyRows = await postJson(ctx, crm, { rows: [] });
      results.check("an empty rows array: 422 empty_import", emptyRows.status === 422 && code(emptyRows) === "empty_import", brief(emptyRows));

      const empty = await postCsv(ctx, crm, "");
      results.check("an empty CSV: 422 empty_import", empty.status === 422 && code(empty) === "empty_import", brief(empty));
      const headerOnly = await postCsv(ctx, crm, "email,display_name\r\n");
      results.check("a header without rows: 422 empty_import", headerOnly.status === 422 && code(headerOnly) === "empty_import" && /no data rows/.test(headerOnly.body.error?.message ?? ""), brief(headerOnly));
      const noIdentifier = await postCsv(ctx, crm, `display_name,username\nNo Way,noway_${t}\n`);
      results.check("no email/phone column: 422 no_identifier_columns naming the columns it has", noIdentifier.status === 422 && code(noIdentifier) === "no_identifier_columns" && /display_name/.test(noIdentifier.body.error?.message ?? ""), brief(noIdentifier));
      const duplicate = await postCsv(ctx, crm, `email,Email\na.${t}@legacy-crm.test,b.${t}@legacy-crm.test\n`);
      results.check("the same column twice (email, Email): 422 duplicate_columns", duplicate.status === 422 && code(duplicate) === "duplicate_columns", brief(duplicate));
      const alias = await postCsv(ctx, crm, `email,name,display_name\na.${t}@legacy-crm.test,A,B\n`);
      results.check("name and display_name together: 422 duplicate_columns (name is display_name)", alias.status === 422 && code(alias) === "duplicate_columns", brief(alias));
      const latin1 = Buffer.concat([Buffer.from(`email,display_name\nlatin.${t}@legacy-crm.test,Jos`), Buffer.from([0xe9]), Buffer.from("\n")]);
      const notUtf8 = await postCsv(ctx, crm, latin1);
      results.check("a Latin-1 file: 422 invalid_csv saying it must be UTF-8 (and where)", notUtf8.status === 422 && code(notUtf8) === "invalid_csv" && /UTF-8/.test(notUtf8.body.error?.message ?? "") && /row 1|line 2/.test(notUtf8.body.error?.message ?? ""), brief(notUtf8));
      const bigCell = await postCsv(ctx, crm, `email,display_name\nbig.${t}@legacy-crm.test,${"x".repeat(9000)}\n`);
      const bigDetails = (bigCell.body.error?.details ?? {}) as { row?: number; column?: string; max_bytes?: number };
      results.check("a 9,000-byte cell: 422 value_too_large naming the row and column (limit 8 KB)", bigCell.status === 422 && code(bigCell) === "value_too_large" && bigDetails.row === 1 && bigDetails.column === "display_name" && bigDetails.max_bytes === 8192, `${brief(bigCell)} ${JSON.stringify(bigDetails)}`);
      const wide = ["email", ...Array.from({ length: 200 }, (_, i) => `extra_${i}`)];
      const tooWide = await postCsv(ctx, crm, `${wide.join(",")}\nwide.${t}@legacy-crm.test${",".repeat(200)}\n`, { ignore_unknown_columns: true });
      results.check("201 columns: 422 too_many_columns (at most 200)", tooWide.status === 422 && code(tooWide) === "too_many_columns", brief(tooWide));
      const lines = ["email"];
      for (let i = 0; i < 100_001; i++) lines.push(`r${i}.${t}@legacy-crm.test`);
      const tooLong = await postCsv(ctx, crm, `${lines.join("\n")}\n`, { dry_run: true });
      results.check("100,001 rows: 422 too_many_rows (one import takes at most 100,000)", tooLong.status === 422 && code(tooLong) === "too_many_rows" && (tooLong.body.error?.details as { max_rows?: number } | undefined)?.max_rows === 100_000, brief(tooLong));
      const huge = Buffer.alloc(51 * 1024 * 1024, 0x61);
      huge.write("email,display_name\n", 0);
      const hugeHeaders = { authorization: basicAuth(crm), "content-type": "text/csv", "x-forwarded-for": ctx.ip };
      const hugeDirect = await postExpectContinue(`${env.api}/v1/apps/legacy-crm/imports?dry_run=true`, hugeHeaders, huge);
      const directError = errorOf(hugeDirect.text);
      results.check("a 51 MB body straight to the API: 413 payload_too_large from the headers alone (the body is never sent)", hugeDirect.status === 413 && directError?.code === "payload_too_large" && !hugeDirect.sent && /50 MB/.test(directError.message ?? ""), `${hugeDirect.status} sent=${hugeDirect.sent} ${hugeDirect.text.slice(0, 240)}`);
      // Through the public origin (the account site's /v1 rewrite, as apps and the CLI call it): three tries, since
      // what comes back can depend on how far the upload got when the API answered.
      const viaSite: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const hugeSite = await postExpectContinue(`${env.site}/v1/apps/legacy-crm/imports?dry_run=true`, hugeHeaders, huge);
        const siteError = errorOf(hugeSite.text);
        viaSite.push(siteError?.code === "payload_too_large" && hugeSite.status === 413 ? "413 payload_too_large" : `${hugeSite.status} ${hugeSite.text.replace(/\s+/g, " ").slice(0, 80)}`);
      }
      results.check("a 51 MB body through the account site's /v1 gets the API's own 413 payload_too_large (3 of 3 tries)", viaSite.every(answer => answer === "413 payload_too_large"), viaSite.join(" | "));

      // Without Expect: 100-continue, the way fetch, browsers, proxies and the CLI upload: the whole body is on its way
      // when the API refuses it from the headers, and the client must still read the 413 (not a reset connection).
      const tooLarge = (answer: RawAnswer) => answer.status === 413 && errorOfText(answer.text)?.code === "payload_too_large";
      const plainDirect: RawAnswer[] = [];
      const plainSite: RawAnswer[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        plainDirect.push(await postPlain(`${env.api}/v1/apps/legacy-crm/imports?dry_run=true`, hugeHeaders, huge));
        plainSite.push(await postPlain(`${env.site}/v1/apps/legacy-crm/imports?dry_run=true`, hugeHeaders, huge));
      }
      results.check("a 51 MB body sent whole (no Expect) straight to the API: 413 payload_too_large every time (3 of 3), never a reset", plainDirect.every(tooLarge), plainDirect.map(describeRaw).join(" | "));
      results.check("…and through the account site's /v1: the API's own 413 every time (3 of 3), never the proxy's 500", plainSite.every(tooLarge), plainSite.map(describeRaw).join(" | "));
      for (const [i, answer] of plainSite.entries()) results.metric(`51 MB refused through the site, no Expect (try ${i + 1})`, answer.ms, "ms");
      // Chunked: no Content-Length, so only the body stream itself can be found too large.
      const chunkedHeaders = { authorization: basicAuth(crm), "content-type": "text/csv", "x-forwarded-for": ctx.ip };
      const chunkedDirect = await postPlain(`${env.api}/v1/apps/legacy-crm/imports?dry_run=true`, chunkedHeaders, huge, { chunked: true });
      const chunkedSite = await postPlain(`${env.site}/v1/apps/legacy-crm/imports?dry_run=true`, chunkedHeaders, huge, { chunked: true });
      results.check("a chunked 51 MB body (no length declared) is refused while it streams: 413 payload_too_large, straight and through the site", tooLarge(chunkedDirect) && tooLarge(chunkedSite), `direct ${describeRaw(chunkedDirect)} | site ${describeRaw(chunkedSite)}`);
      // 60 MB: more than the site's rewrite forwards (52 MB), declared far over the limit.
      const sixty = Buffer.alloc(60 * 1024 * 1024, 0x61);
      sixty.write("email,display_name\n", 0);
      const sixtyDirect = await postPlain(`${env.api}/v1/apps/legacy-crm/imports?dry_run=true`, hugeHeaders, sixty, { timeoutMs: 90_000 });
      const sixtySite = await postPlain(`${env.site}/v1/apps/legacy-crm/imports?dry_run=true`, hugeHeaders, sixty, { timeoutMs: 90_000 });
      results.check("a 60 MB body (more than the site's rewrite forwards) still gets the API's 413, straight and through the site", tooLarge(sixtyDirect) && tooLarge(sixtySite), `direct ${describeRaw(sixtyDirect)} | site ${describeRaw(sixtySite)}`);
      results.metric("60 MB refused through the site (no Expect)", sixtySite.ms, "ms");

      // The exact limit: 50 MB = 52,428,800 bytes of body. A JSON body of exactly that size (one row, then spaces, which
      // JSON allows) is accepted; one byte more is refused by the import itself.
      const core = JSON.stringify({ rows: [{ email: `limit.${t}@legacy-crm.test`, display_name: "Exactly At The Limit" }], options: { dry_run: true } });
      const atLimit = Buffer.alloc(52_428_800, 0x20);
      atLimit.write(core, 0);
      const jsonHeaders = { authorization: basicAuth(crm), "content-type": "application/json", "x-forwarded-for": ctx.ip };
      const exact = await postPlain(`${env.api}/v1/apps/legacy-crm/imports`, jsonHeaders, atLimit);
      const exactJob = (() => {
        try {
          return (JSON.parse(exact.text) as { job?: ImportJob }).job ?? null;
        } catch {
          return null;
        }
      })();
      results.check("a body of exactly 52,428,800 bytes (50 MB) is accepted: 202, a one-row dry run", exact.status === 202 && exactJob?.total_rows === 1 && exactJob.dry_run === true, `${describeRaw(exact)} ${exact.text.slice(0, 200)}`);
      if (exactJob) await waitJob(ctx, crm, exactJob.id);
      const overByOne = Buffer.alloc(52_428_801, 0x20);
      overByOne.write(core, 0);
      const oneMore = await postPlain(`${env.api}/v1/apps/legacy-crm/imports`, jsonHeaders, overByOne);
      const oneMoreError = errorOfText(oneMore.text);
      results.check("one byte more (52,428,801) is refused: 413 payload_too_large, the import's own (\"larger than 50 MB\", max_bytes 52428800)", oneMore.status === 413 && oneMoreError?.code === "payload_too_large" && /50 MB/.test(oneMoreError.message ?? "") && (oneMoreError.details as { max_bytes?: number } | undefined)?.max_bytes === 52_428_800, `${describeRaw(oneMore)} ${oneMore.text.slice(0, 300)}`);
      // Every 413 of the route should name that same limit: the one a client can split its files by.
      const headerLimit = (directError?.details as { limit_bytes?: number; max_bytes?: number } | undefined) ?? {};
      const stated = headerLimit.limit_bytes ?? headerLimit.max_bytes;
      results.check(
        "the 413 refused from the headers names the real limit too (52,428,800 bytes, the largest body accepted, as the import's own 413 and the CLI say)",
        stated === 52_428_800 && (directError?.message ?? "").includes("52428800"),
        `from the headers: ${directError?.message} details ${JSON.stringify(directError?.details)}; the import's own: ${oneMoreError?.message} details ${JSON.stringify(oneMoreError?.details)}`,
      );
      results.check("none of these refusals created a job (the one at the limit is the only new one)", (await listJobs(ctx, crm)).length === jobsBefore + (exactJob ? 1 : 0), `${(await listJobs(ctx, crm)).length - jobsBefore} new jobs`);

      // The hourly request budget (60 per app; every request that reaches the parser counts).
      await forgetImportBudgets(env, crm.app_id);
      const key = randomUUID();
      const done = await postCsv(ctx, crm, ok, { dry_run: true }, { key });
      if (done.body.job) await waitJob(ctx, crm, done.body.job.id);
      const bucket = lit(`import_submissions:app:${crm.app_id}`);
      await psql(env, `insert into rate_limits (bucket, window_started_at, count) values (${bucket}, now(), 60) on conflict (bucket) do update set window_started_at = now(), count = 60, blocked_until = null`);
      const limited = await postCsv(ctx, crm, `email\nlimited.${t}@legacy-crm.test\n`, { dry_run: true });
      const retryAfter = Number(limited.headers.get("retry-after"));
      results.check("the 61st request of the hour: 429 rate_limited, Retry-After about an hour, the limit and what to do", limited.status === 429 && code(limited) === "rate_limited" && retryAfter > 3500 && retryAfter <= 3600 && /60 per/.test(limited.body.error?.message ?? "") && /dry run/.test(limited.body.error?.hint ?? ""), `${brief(limited)} retry-after=${limited.headers.get("retry-after")} hint=${limited.body.error?.hint}`);
      const replay = await postCsv(ctx, crm, ok, { dry_run: true }, { key });
      results.check("a retry with the Idempotency-Key of an import that went through still gets its 202 (a replay)", replay.status === 202 && replay.body.job?.id === done.body.job?.id && replay.headers.get("idempotent-replayed") === "true", `${replay.status} ${replay.body.job?.id} vs ${done.body.job?.id}`);
      const newKey = await postCsv(ctx, crm, `email\nnewkey.${t}@legacy-crm.test\n`, { dry_run: true }, { key: randomUUID() });
      results.check("new work under a new key is still refused (429)", newKey.status === 429, brief(newKey));
      await psql(env, `update rate_limits set window_started_at = now() - interval '3601 seconds' where bucket = ${bucket}`);
      const nextHour = await postCsv(ctx, crm, `email\nnexthour.${t}@legacy-crm.test\n`, { dry_run: true });
      results.check("an hour later (time travel) the app can import again", nextHour.status === 202, brief(nextHour));

      // The daily row budget (2,000,000 rows per app, dry runs included), taken when the job is created.
      const rowsBucket = lit(`import_rows:app:${crm.app_id}`);
      await psql(env, `insert into rate_limits (bucket, window_started_at, count) values (${rowsBucket}, now(), 1999997) on conflict (bucket) do update set window_started_at = now(), count = 1999997, blocked_until = null`);
      const five = Array.from({ length: 5 }, (_, i) => `five${i}.${t}@legacy-crm.test`);
      const over = await postCsv(ctx, crm, `email\n${five.join("\n")}\n`, { dry_run: true });
      const overDetails = (over.body.error?.details ?? {}) as { remaining_rows?: number; import_rows?: number; limit_rows?: number };
      results.check("5 rows with 3 left of the day's 2,000,000: 429 saying how many are left", over.status === 429 && code(over) === "rate_limited" && overDetails.remaining_rows === 3 && overDetails.import_rows === 5 && overDetails.limit_rows === 2_000_000 && /3 are left/.test(over.body.error?.message ?? ""), `${brief(over)} ${JSON.stringify(overDetails)}`);
      const fits = await postCsv(ctx, crm, `email\n${five.slice(0, 3).join("\n")}\n`, { dry_run: true });
      results.check("3 rows fit exactly (202), and then the day is used up", fits.status === 202, brief(fits));
      if (fits.body.job) await waitJob(ctx, crm, fits.body.job.id);
      const usedUp = await postCsv(ctx, crm, `email\none.${t}@legacy-crm.test\n`, { dry_run: true });
      results.check("…one more row: 429 with 0 left", usedUp.status === 429 && (usedUp.body.error?.details as { remaining_rows?: number } | undefined)?.remaining_rows === 0, brief(usedUp));
      await forgetImportBudgets(env, crm.app_id);
    },
  },
  {
    name: "imports-access",
    title: "who may import: the app's credentials or its owner's account-site session (Origin-checked, the job says who; the developer site's BFF is imports-developer-bff), never no credentials, a wrong secret, another app or another Carbon; the rows endpoint's filters, pagination, bad queries and 404s",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const crm = fakeApp("legacy-crm");
      const briefcase = fakeApp("briefcase");
      await forgetImportBudgets(env, crm.app_id);
      const t = tag();
      const csv = `email,display_name\nacc.${t}@legacy-crm.test,Access Row\n`;

      const anonymous = await postCsv(ctx, null, csv, { dry_run: true }, { auth: null });
      results.check("no credentials: 401 unauthenticated, saying what is needed", anonymous.status === 401 && code(anonymous) === "unauthenticated" && /app's credentials|owns it/.test(anonymous.body.error?.message ?? ""), brief(anonymous));
      const wrongSecret = `sa_app_legacy-crm_${"Z".repeat(40)}`;
      const wrong = await postCsv(ctx, null, csv, { dry_run: true }, { auth: basicAuth({ app_id: "legacy-crm", secret: wrongSecret }) });
      results.check("a wrong secret: 401 invalid_app_credentials, and the error never repeats the secret", wrong.status === 401 && code(wrong) === "invalid_app_credentials" && !JSON.stringify(wrong.body).includes(wrongSecret), brief(wrong));
      const garbled = await postCsv(ctx, null, csv, { dry_run: true }, { auth: "Basic !!!not-base64" });
      results.check("garbled Basic credentials: 401 invalid_app_credentials", garbled.status === 401 && code(garbled) === "invalid_app_credentials", brief(garbled));
      const otherApp = await postCsv(ctx, briefcase, csv, { dry_run: true }, { appId: "legacy-crm" });
      results.check("briefcase's credentials on legacy-crm's imports: 403 app_mismatch", otherApp.status === 403 && code(otherApp) === "app_mismatch" && /briefcase/.test(otherApp.body.error?.message ?? ""), brief(otherApp));
      const otherList = await appCall<ApiErrorBody>(ctx, briefcase, "/v1/apps/legacy-crm/imports");
      results.check("…nor may it list legacy-crm's jobs (403)", otherList.status === 403, `${otherList.status}`);

      // A job to read back: created, skipped, an error and warnings, twelve rows.
      const rows = [
        { email: `r1.${t}@legacy-crm.test`, display_name: "Row One" },
        { email: `R1.${t}@Legacy-CRM.test`, display_name: "Row One Again" },
        { display_name: "No Identifier" },
        { email: `r4.${t}@legacy-crm.test`, phone: "+1 (555) abc" },
        { email: `r5.${t}@legacy-crm.test`, dob: "31/02/2001" },
        ...Array.from({ length: 7 }, (_, i) => ({ email: `r${i + 6}.${t}@legacy-crm.test` })),
      ];
      const started = await postJson(ctx, crm, { rows, options: {} }, { key: randomUUID() });
      if (!started.body.job) throw new Error(`the import was refused: ${started.status}`);
      const job = await waitJob(ctx, crm, started.body.job.id);
      results.check("the app's credentials import (created 10, skipped 1, error 1, warnings 2; created_by app)", job.counts.created === 10 && job.counts.skipped === 1 && job.counts.error === 1 && job.counts.warnings === 2 && job.created_by === "app", countsText(job.counts));
      const only = async (filter: Record<string, string>) => (await allRows(ctx, crm, job.id, filter)).map(row => row.row_number).join(",");
      results.check("?outcome=error → the row without an identifier", (await only({ outcome: "error" })) === "3");
      results.check("?outcome=skipped → the duplicate", (await only({ outcome: "skipped" })) === "2");
      results.check("?level=warning → the rows with warnings (invalid phone, impossible dob)", (await only({ level: "warning" })) === "4,5");
      results.check("?code=invalid_phone → that row only", (await only({ code: "invalid_phone" })) === "4");
      results.check("?outcome=created&code=invalid_dob → filters combine", (await only({ outcome: "created", code: "invalid_dob" })) === "5");
      const pages: number[][] = [];
      let cursor: string | null = null;
      do {
        const params: URLSearchParams = new URLSearchParams({ limit: "5", ...(cursor ? { cursor } : {}) });
        const page: { status: number; body: { items: RowResult[]; next_cursor: string | null } } = await appCall(ctx, crm, `/v1/apps/legacy-crm/imports/${job.id}/rows?${params.toString()}`);
        pages.push(page.body.items.map(row => row.row_number));
        cursor = page.body.next_cursor;
      } while (cursor && pages.length < 10);
      results.check("pages of 5 walk every row once, in file order (5, 5, 2)", JSON.stringify(pages) === JSON.stringify([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12]]), JSON.stringify(pages));
      const badQueries = await Promise.all(["outcome=bogus", "level=fatal", "code=Not-A-Code", "cursor=not-a-cursor"].map(async q => [q, await appCall<ApiErrorBody>(ctx, crm, `/v1/apps/legacy-crm/imports/${job.id}/rows?${q}`)] as const));
      results.check("bad filters are 400s naming the parameter (outcome, level, code, cursor)", badQueries.every(([q, answer]) => answer.status === 400 && !!answer.body.error?.message?.includes(q.split("=")[0]!)), badQueries.map(([q, answer]) => `${q} → ${answer.status} ${answer.body.error?.code}`).join(", "));
      const missing = await appCall<ApiErrorBody>(ctx, crm, `/v1/apps/legacy-crm/imports/${randomUUID()}`);
      const garbage = await appCall<ApiErrorBody>(ctx, crm, "/v1/apps/legacy-crm/imports/not-a-job/rows");
      results.check("an unknown job (or not a job id): 404 import_not_found with a hint", missing.status === 404 && missing.body.error?.code === "import_not_found" && !!missing.body.error.hint && garbage.status === 404 && garbage.body.error?.code === "import_not_found", `${missing.status} ${missing.body.error?.code} / ${garbage.status} ${garbage.body.error?.code}`);
      const crossApp = await appCall<ApiErrorBody>(ctx, briefcase, `/v1/apps/briefcase/imports/${job.id}/rows`);
      const briefcaseJobs = await appCall<{ items: ImportJob[] }>(ctx, briefcase, "/v1/apps/briefcase/imports");
      results.check("another app can't read this job under its own URL (404) and never lists it", crossApp.status === 404 && crossApp.body.error?.code === "import_not_found" && !(briefcaseJobs.body.items ?? []).some(item => item.id === job.id), `${crossApp.status} ${crossApp.body.error?.code}`);

      // Sessions: the owner may (Origin-checked), another Carbon may not.
      const ownerContext = await newContext(browser);
      const ownerPage = await ownerContext.newPage();
      results.watch(ownerPage, "imports-access-owner", [/status of 403/]);
      await signInOnSite(env, ownerPage, crm.owner_email);
      const ownerList = await ownerPage.evaluate(async () => (await fetch("/v1/apps/legacy-crm/imports")).status);
      results.check("the owner's session lists legacy-crm's imports", ownerList === 200, String(ownerList));
      const ownerImport = await ownerPage.evaluate(async body => {
        const response = await fetch("/v1/apps/legacy-crm/imports?dry_run=true", { method: "POST", headers: { "content-type": "text/csv", "idempotency-key": crypto.randomUUID() }, body });
        return { status: response.status, body: (await response.json()) as { job?: { id: string; created_by: string } } };
      }, `email,display_name\nowner.${t}@legacy-crm.test,Owner Row\n`);
      const ownerUuid = await psql(env, `select uuid from accounts where handle = ${lit(crm.owner_id)}`);
      results.check("the owner's session imports from the site (202), and the job says the owner started it", ownerImport.status === 202 && ownerImport.body.job?.created_by === ownerUuid, `${ownerImport.status} created_by=${ownerImport.body.job?.created_by} owner=${ownerUuid}`);
      const forged = await ownerContext.request.post(`${env.site}/v1/apps/legacy-crm/imports?dry_run=true`, { headers: { "content-type": "text/csv", origin: "https://evil.example" }, data: csv });
      const forgedBody = (await forged.json().catch(() => ({}))) as ApiErrorBody;
      results.check("the owner's cookie from another origin is refused: 403 origin_not_allowed (CSRF)", forged.status() === 403 && forgedBody.error?.code === "origin_not_allowed", `${forged.status()} ${forgedBody.error?.code}`);
      const noOrigin = await ownerContext.request.post(`${env.site}/v1/apps/legacy-crm/imports?dry_run=true`, { headers: { "content-type": "text/csv" }, data: csv });
      results.check("…and without an Origin header (403)", noOrigin.status() === 403, String(noOrigin.status()));
      await ownerContext.close();

      const strangerContext = await newContext(browser);
      const strangerPage = await strangerContext.newPage();
      results.watch(strangerPage, "imports-access-stranger", [/status of 403/]);
      await signInOnSite(env, strangerPage, `stranger.${t}@example.test`);
      const strangerTries = await strangerPage.evaluate(async body => {
        const list = await fetch("/v1/apps/legacy-crm/imports");
        const post = await fetch("/v1/apps/legacy-crm/imports?dry_run=true", { method: "POST", headers: { "content-type": "text/csv" }, body });
        return { list: list.status, listCode: ((await list.json()) as { error?: { code?: string } }).error?.code, post: post.status, postCode: ((await post.json()) as { error?: { code?: string } }).error?.code };
      }, csv);
      results.check("another Carbon's session: 403 not_app_owner, to list and to import", strangerTries.list === 403 && strangerTries.listCode === "not_app_owner" && strangerTries.post === 403 && strangerTries.postCode === "not_app_owner", JSON.stringify(strangerTries));
      await strangerContext.close();
      const leaked = await psql(env, `select count(*) from account_emails where email in ('acc.${t}@legacy-crm.test', 'owner.${t}@legacy-crm.test')`);
      results.check("none of the refused (or dry-run) requests wrote an account", leaked === "0", `${leaked} accounts`);
    },
  },
  {
    name: "imports-busy",
    title: "capacity: an API node reads at most 2 import bodies at once and one app at most 1 of them, so one app's stalled uploads never keep another app from importing; with both slots held by two other apps' uploads a third import waits 30 s, then 503 imports_busy (Retry-After 15, nothing imported); uploads give their slots back when their clients go away",
    // Only the API and the CLI are under test here: the engine makes no difference, so WebKit runs skip it.
    engines: ["chromium"],
    timeoutMs: 5 * 60_000,
    async run(ctx) {
      const { env, results } = ctx;
      const crm = fakeApp("legacy-crm");
      const pixel = fakeApp("pixel-studio");
      const briefcase = fakeApp("briefcase");
      for (const app of [crm, pixel, briefcase]) await forgetImportBudgets(env, app.app_id);
      const t = tag();
      const headersOf = (app: typeof crm) => ({ authorization: basicAuth(app), "content-type": "text/csv", "x-forwarded-for": ctx.ip });
      // pixel-studio starts two uploads that declare 1 MB and then send 16 bytes a second: a client on a dead slow link
      // (or one that stalls on purpose). One app holds at most one of the node's two import slots, so another app still
      // gets the other one.
      const stalls = [0, 1].map(() => postTrickle(`${env.api}/v1/apps/pixel-studio/imports?dry_run=true`, headersOf(pixel), 1024 * 1024));
      await sleep(1500);
      const csv = `email,display_name\nbusy.${t}@legacy-crm.test,Busy Row\n`;
      let started = Date.now();
      const fair = await postCsv(ctx, crm, csv, { dry_run: true }, { key: randomUUID(), direct: true });
      const fairMs = Date.now() - started;
      results.metric("legacy-crm's import while pixel-studio's two uploads stall, answered after", fairMs, "ms");
      const [pixelBudget] = await rowsOf<{ count: number }>(env, `select count from rate_limits where bucket = 'import_submissions:app:pixel-studio'`);
      results.check(
        "one app's stalled uploads don't keep another app from importing: legacy-crm's import goes through at once while pixel-studio's two uploads stall",
        fair.status === 202 && fairMs < 10_000,
        `legacy-crm got ${fair.status} ${fair.body.error?.code ?? ""} after ${fairMs} ms while pixel-studio's two uploads (16 bytes/s, ${stalls.length} connections) were open; pixel-studio's hourly import budget counted ${pixelBudget?.count ?? 0} of them`,
      );
      if (fair.body.job) await waitJob(ctx, crm, fair.body.job.id);
      for (const stall of stalls) stall.abort();

      // Both slots held by two other apps' uploads that keep a steady pace (64 KB/s, above the slowest pace a body may
      // arrive at) towards a 40 MB body: the next import waits for a slot, then is refused.
      const holders = [pixel, briefcase].map(app => postTrickle(`${env.api}/v1/apps/${app.app_id}/imports?dry_run=true`, headersOf(app), 40 * 1024 * 1024, { tickMs: 250, bytesPerTick: 16 * 1024 }));
      await sleep(1500);
      const key = randomUUID();
      started = Date.now();
      const blocked = await postCsv(ctx, crm, csv, { dry_run: true }, { key, direct: true });
      const waited = Date.now() - started;
      results.metric("an import with both slots taken was answered after", waited, "ms");
      results.check(
        "with both slots held (pixel-studio's and briefcase's uploads), the next import waits 30 s and is refused precisely: 503 imports_busy, Retry-After 15, nothing imported, retry with the same Idempotency-Key",
        blocked.status === 503 && blocked.body.error?.code === "imports_busy" && blocked.headers.get("retry-after") === "15" && /nothing was imported/.test(blocked.body.error?.message ?? "") && /Idempotency-Key/.test(blocked.body.error?.hint ?? "") && waited >= 29_000 && waited < 60_000,
        `${blocked.status} ${blocked.body.error?.code ?? ""} after ${waited} ms; Retry-After ${blocked.headers.get("retry-after")}; ${blocked.body.error?.message} | ${blocked.body.error?.hint}`,
      );
      // The uploading clients go away: their slots come back at once.
      for (const holder of holders) holder.abort();
      await sleep(300);
      started = Date.now();
      const retried = await postCsv(ctx, crm, csv, { dry_run: true }, { key, direct: true });
      const retriedMs = Date.now() - started;
      results.check("once the uploading clients are gone, the retry with the same Idempotency-Key gets a slot at once: 202 (a new job: the 503 stored nothing)", retried.status === 202 && !!retried.body.job && retried.headers.get("idempotent-replayed") === null && retriedMs < 10_000, `${retried.status} ${retried.body.job?.id ?? JSON.stringify(retried.body).slice(0, 200)} after ${retriedMs} ms; replayed=${retried.headers.get("idempotent-replayed")}`);
      if (retried.body.job) await waitJob(ctx, crm, retried.body.job.id);
      const parallel = await Promise.all([0, 1].map(i => postCsv(ctx, crm, `email\npar${i}.${t}@legacy-crm.test\n`, { dry_run: true }, { key: randomUUID(), direct: true })));
      results.check("two imports of one app side by side both go through (one after the other on its one slot, nothing left held)", parallel.every(answer => answer.status === 202), parallel.map(answer => `${answer.status} ${answer.body.error?.code ?? ""}`).join(", "));
      for (const answer of parallel) if (answer.body.job) await waitJob(ctx, crm, answer.body.job.id);
      for (const app of [crm, pixel, briefcase]) await forgetImportBudgets(env, app.app_id);
    },
  },
];

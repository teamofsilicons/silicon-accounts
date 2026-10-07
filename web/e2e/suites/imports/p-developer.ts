/**
 * Imports through the developer site (UNDERSTANDING.md: an app's user base and imports are set up on
 * developer.teamofsilicons.com; the browser only talks to that site, whose server holds the Carbon's tokens and calls
 * the API with them, 06-v2 §2). As legacy-crm's owner, through the developer site's BFF: list, a CSV dry run and a
 * JSON import (the job says the owner started it), a retry with the same Idempotency-Key, a 51 MB file refused with
 * the API's own 413 (nothing imported); refused there: writes from another origin or without one (CSRF), another
 * Carbon (not the app's owner), a browser that isn't signed in. And the account site's old developer address for the
 * import tab sends the browser to the developer site.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, newContext, tag } from "../../lib";
import {
  allRows,
  countsText,
  developerFetch,
  developerSession,
  fakeApp,
  forgetImportBudgets,
  lastSeq,
  listJobs,
  lit,
  messagesAfter,
  psql,
  waitJobViaDeveloper,
  type ApiErrorBody,
  type ImportJob,
  type RowResult,
} from "./_helpers";

type JobAnswer = ApiErrorBody & { job?: ImportJob };
const brief = (answer: { status: number; body: unknown; ms?: number }) => {
  const error = (answer.body as ApiErrorBody | null)?.error;
  return `${answer.status} ${error?.code ?? ""}: ${error?.message ?? JSON.stringify(answer.body).slice(0, 200)}${answer.ms !== undefined ? ` (${answer.ms} ms)` : ""}`;
};

export const journey: Journey = {
  name: "imports-developer-bff",
  title: "imports through the developer site's BFF as legacy-crm's owner (list, CSV dry run, JSON import by the owner, Idempotency-Key replay, a 51 MB file → the API's 413); refused: another origin or none (CSRF), another Carbon, no session; /developer/<app>/import on the account site redirects there",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results, browser } = ctx;
    const crm = fakeApp("legacy-crm");
    await forgetImportBudgets(env, crm.app_id);
    const t = tag();
    const ownerUuid = await psql(env, `select uuid from accounts where handle = ${lit(crm.owner_id)}`);
    const seq = await lastSeq(env);
    const traces = () => psql(env, `select count(*) from account_emails where email like ${lit(`%@${t}.legacy-crm.test`)}`);

    // The account site's old developer address of the import tab now lives on the developer site.
    const old = await fetch(`${env.site}/developer/legacy-crm/import`, { redirect: "manual" });
    const location = old.headers.get("location") ?? "";
    results.check("the account site's /developer/legacy-crm/import redirects (307) to the developer site's /apps/legacy-crm/import", [307, 308].includes(old.status) && location === `${env.developer}/apps/legacy-crm/import`, `${old.status} → ${location}`);

    // Not signed in: the BFF has no session to call the API with.
    const anonymous = await newContext(browser);
    const anonymousPage = await anonymous.newPage();
    results.watch(anonymousPage, "imports-developer-anonymous", [DEVELOPER_SIGNED_OUT]);
    const signedOut = await developerFetch<ApiErrorBody>(env, anonymousPage, "/apps/legacy-crm/imports");
    results.check("a browser not signed in to the developer site: 401 signed_out (no import list)", signedOut.status === 401 && signedOut.body?.error?.code === "signed_out", brief(signedOut));
    await anonymous.close();

    // The owner, signed in to the developer site.
    const owner = await developerSession(ctx, crm.owner_email, "imports-developer-owner", { returnTo: "/apps/legacy-crm/import" });
    const list = await developerFetch<{ items?: ImportJob[] }>(env, owner.page, "/apps/legacy-crm/imports?limit=5");
    results.check("the owner lists legacy-crm's imports through the developer site (200)", list.status === 200 && Array.isArray(list.body?.items), brief(list));
    const jobsBefore = (await listJobs(ctx, crm)).length;

    const csv = `external_id,email,display_name,username\ndev-1-${t},one@${t}.legacy-crm.test,Dev One,dev_one_${t}\ndev-2-${t},two@${t}.legacy-crm.test,Dev Two,dev_two_${t}\n`;
    const dry = await developerFetch<JobAnswer>(env, owner.page, "/apps/legacy-crm/imports?dry_run=true&default_country=US", { body: csv, headers: { "idempotency-key": randomUUID() } });
    results.check(
      "a CSV dry run through the developer site: 202, dry_run, 2 rows, started by the owner (created_by is their uuid)",
      dry.status === 202 && dry.body?.job?.dry_run === true && dry.body.job.total_rows === 2 && dry.body.job.created_by === ownerUuid && dry.body.job.options.default_country === "US",
      `${brief(dry)} created_by=${dry.body?.job?.created_by} owner=${ownerUuid}`,
    );
    const dryDone = dry.body?.job ? await waitJobViaDeveloper(env, owner.page, "legacy-crm", dry.body.job.id) : null;
    results.check("…the dry run completes (created 2) and writes nothing", dryDone?.status === "completed" && dryDone.counts.created === 2 && (await traces()) === "0", countsText(dryDone?.counts));

    const key = randomUUID();
    const rows = [
      { external_id: `dev-1-${t}`, email: `one@${t}.legacy-crm.test`, display_name: "Dev One", username: `dev_one_${t}` },
      { external_id: `dev-2-${t}`, email: `two@${t}.legacy-crm.test`, phone: "not a phone", display_name: "Dev Two" },
      { display_name: "Nobody" },
    ];
    const real = await developerFetch<JobAnswer>(env, owner.page, "/apps/legacy-crm/imports", { body: JSON.stringify({ rows, options: {} }), contentType: "application/json", headers: { "idempotency-key": key } });
    results.check("a JSON import through the developer site: 202, 3 rows, by the owner", real.status === 202 && real.body?.job?.format === "json" && real.body.job.total_rows === 3 && real.body.job.created_by === ownerUuid && real.body.job.dry_run === false, brief(real));
    const replay = await developerFetch<JobAnswer>(env, owner.page, "/apps/legacy-crm/imports", { body: JSON.stringify({ rows, options: {} }), contentType: "application/json", headers: { "idempotency-key": key } });
    results.check("the same request with the same Idempotency-Key through the developer site returns that job (no second import)", replay.status === 202 && !!real.body?.job && replay.body?.job?.id === real.body.job.id, `${brief(replay)} ${replay.body?.job?.id} vs ${real.body?.job?.id}`);
    const done = real.body?.job ? await waitJobViaDeveloper(env, owner.page, "legacy-crm", real.body.job.id) : null;
    results.check("…it completes: created 2 (one with the invalid phone dropped, a warning), error 1 (no identifier)", done?.status === "completed" && done.counts.created === 2 && done.counts.error === 1 && done.counts.warnings === 1, countsText(done?.counts));
    const reportRows = done ? await developerFetch<{ items?: RowResult[] }>(env, owner.page, `/apps/legacy-crm/imports/${done.id}/rows?outcome=error`) : null;
    results.check("the report's rows read through the developer site: ?outcome=error → row 3, missing_identifier", reportRows?.status === 200 && reportRows.body?.items?.length === 1 && reportRows.body.items[0]?.row_number === 3 && reportRows.body.items[0].messages.some(m => m.code === "missing_identifier"), reportRows ? brief(reportRows) : "no job");
    results.check("…and the API agrees (the app's own credentials see the same job and rows)", !!done && (await allRows(ctx, crm, done.id)).filter(row => row.outcome === "created").length === 2, done?.id ?? "no job");
    const users = await developerFetch<{ items?: Array<{ uuid: string; status: string; external_id: string | null; email?: string | null }> }>(env, owner.page, `/apps/legacy-crm/users?q=${encodeURIComponent(`dev-1-${t}`)}`);
    results.check("the user base through the developer site lists the imported Carbon (imported, its external id and the email legacy-crm gave)", users.status === 200 && users.body?.items?.length === 1 && users.body.items[0]?.status === "imported" && users.body.items[0].email === `one@${t}.legacy-crm.test`, brief(users));

    // CSRF: the developer site only takes writes from its own pages.
    const evil = await developerFetch<ApiErrorBody>(env, owner.page, "/apps/legacy-crm/imports?dry_run=true", { body: csv, origin: "https://evil.example", headers: { "idempotency-key": randomUUID() } });
    results.check("the owner's developer session from another origin: 403 cross_site_request", evil.status === 403 && evil.body?.error?.code === "cross_site_request", brief(evil));
    const noOrigin = await developerFetch<ApiErrorBody>(env, owner.page, "/apps/legacy-crm/imports?dry_run=true", { body: csv, origin: null, headers: { "idempotency-key": randomUUID() } });
    results.check("…and with no Origin at all: 403 cross_site_request", noOrigin.status === 403 && noOrigin.body?.error?.code === "cross_site_request", brief(noOrigin));
    const crossSite = await developerFetch<ApiErrorBody>(env, owner.page, "/apps/legacy-crm/imports?dry_run=true", { body: csv, headers: { "idempotency-key": randomUUID(), "sec-fetch-site": "cross-site" } });
    results.check("…and a browser that says the request is cross-site (Sec-Fetch-Site: cross-site): 403", crossSite.status === 403 && crossSite.body?.error?.code === "cross_site_request", brief(crossSite));

    // 51 MB through the developer site: the API's own 413, nothing imported.
    const huge = Buffer.alloc(51 * 1024 * 1024, 0x61);
    huge.write("email,display_name\n", 0);
    const tooBig = await developerFetch<ApiErrorBody>(env, owner.page, "/apps/legacy-crm/imports?dry_run=true", { body: huge, headers: { "idempotency-key": randomUUID() }, timeoutMs: 180_000 });
    const tooBigError = tooBig.body?.error;
    results.metric("51 MB refused through the developer site", tooBig.ms, "ms");
    results.check(
      "a 51 MB file through the developer site: the API's own 413 payload_too_large, saying 50 MB and how to split it",
      tooBig.status === 413 && tooBigError?.code === "payload_too_large" && /50 MB/.test(tooBigError.message ?? "") && /50 MB and 100,000 rows/.test(tooBigError.hint ?? ""),
      brief(tooBig),
    );
    results.check("none of the refused requests made a job (the dry run and the import are the only new ones)", (await listJobs(ctx, crm)).length === jobsBefore + 2, `${(await listJobs(ctx, crm)).length - jobsBefore} new jobs`);
    await owner.context.close();

    // Another Carbon signed in to the developer site isn't legacy-crm's owner.
    const stranger = await developerSession(ctx, `stranger.dev.${t}@example.test`, "imports-developer-stranger", { expected: [/status of 403/] });
    const strangerList = await developerFetch<ApiErrorBody>(env, stranger.page, "/apps/legacy-crm/imports");
    const strangerPost = await developerFetch<ApiErrorBody>(env, stranger.page, "/apps/legacy-crm/imports?dry_run=true", { body: csv, headers: { "idempotency-key": randomUUID() } });
    const strangerRows = done ? await developerFetch<ApiErrorBody>(env, stranger.page, `/apps/legacy-crm/imports/${done.id}/rows`) : null;
    results.check(
      "another Carbon on the developer site: 403 not_app_owner to list, to import and to read a job's rows",
      strangerList.status === 403 && strangerList.body?.error?.code === "not_app_owner" && strangerPost.status === 403 && strangerPost.body?.error?.code === "not_app_owner" && strangerRows?.status === 403,
      `${brief(strangerList)} | ${brief(strangerPost)} | ${strangerRows ? brief(strangerRows) : "-"}`,
    );
    await stranger.context.close();
    results.check("…and nothing of theirs was imported (only the owner's 2 accounts exist)", (await traces()) === "2", `${await traces()} accounts`);
    const sent = (await messagesAfter(env, seq)).filter(item => item.to.includes(t) || item.to.endsWith("legacy-crm.test"));
    results.check("the imports sent no email or SMS (only the sign-in codes went out)", sent.every(item => item.to === crm.owner_email || item.to.startsWith("stranger.dev.")), sent.map(item => `${item.channel} to ${item.to}`).join(", ") || "nothing to the imported people");
  },
};

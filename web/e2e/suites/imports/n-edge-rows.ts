/**
 * Rows at the edges of the import rules (crates/apps/src/imports/rules.rs), each with its exact outcome and message:
 * a display name past 100 characters (cut, warned), 12 emails and 12 phones (10 kept, warned), more than 5 invalid
 * emails (5 messages and one that counts the rest), a long invalid value quoted to 80 characters, external ids with a
 * control character or past 255 characters (error), a javascript: photo, two rows wanting the same new id, a 30-character
 * username, the 1900-01-01 and today date boundaries, a lower-case timezone, a list where text belongs, a blank name
 * (named from the email), an unusable email_verified. And an imported name made of HTML is only ever text: on the
 * developer site's user base and in its import report.
 */
import type { Journey } from "../../context";
import { shot, sleep, tag } from "../../lib";
import { VALID_ID, accountsByUuid, defaultDob, describeRow, developerSession, fakeApp, forgetImportBudgets, freshExchange, importRows, lastSeq, messagesAfter, type RowMessage, type RowResult } from "./_helpers";

const titled = (local: string) =>
  local
    .split(/[._+-]/)
    .filter(Boolean)
    .map(word => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

export const journey: Journey = {
  name: "imports-edge-rows",
  title: "rows at the edges of the rules: names past 100 characters, 12 emails and phones, more than 5 invalid emails, long values quoted to 80 characters, bad external ids, javascript: photos, two rows wanting one id, 30-character usernames, date and timezone boundaries, lists where text belongs, blank names; HTML in a name stays text on the developer site",
  async run(ctx) {
    const { env, results } = ctx;
    const crm = fakeApp("legacy-crm");
    await forgetImportBudgets(env, crm.app_id);
    const t = tag();
    const exchange = await freshExchange(env, ["628"]);
    const mail = (local: string) => `${local}.${t}@legacy-crm.test`;
    const today = new Date().toISOString().slice(0, 10);
    const longInvalid = `not-an-email-${"y".repeat(110)}`;
    const handle30 = `u30_${t}`.padEnd(30, "x");
    const xssName = `<img src=x onerror="window.__importXss=1">Eve ${t}`;
    const rows: Array<Record<string, unknown>> = [
      /* 1 */ { external_id: `edge-1-${t}`, email: mail("long.name"), display_name: "Ab".repeat(75) },
      /* 2 */ { external_id: `edge-2-${t}`, email: mail("eve"), display_name: xssName, username: `eve_${t}` },
      /* 3 */ { external_id: `edge-3-${t}`, emails: Array.from({ length: 12 }, (_, i) => mail(`many${i + 1}`)) },
      /* 4 */ { external_id: `edge-4-${t}`, email: mail("inv"), emails: ["bad1", "bad2@", "@bad3.test", "bad 4@x.test", "bad5@@x.test", "bad6", "bad7"] },
      /* 5 */ { external_id: `edge\t5-${t}`, email: mail("tab") },
      /* 6 */ { external_id: `e${"6".repeat(255)}`, email: mail("long.ext") },
      /* 7 */ { external_id: `edge-7-${t}`, email: mail("js"), pfp_url: "javascript:alert(1)" },
      /* 8 */ { external_id: `edge-8-${t}`, email: mail("twin.one"), username: `twin_${t}` },
      /* 9 */ { external_id: `edge-9-${t}`, email: mail("twin.two"), username: `twin_${t}` },
      /* 10 */ { external_id: `edge-10-${t}`, email: mail("thirty"), username: handle30 },
      /* 11 */ { external_id: `edge-11-${t}`, email: mail("old"), dob: "1900-01-01", timezone: "asia/kolkata" },
      /* 12 */ { external_id: `edge-12-${t}`, email: mail("today"), dob: today },
      /* 13 */ { external_id: `edge-13-${t}`, email: longInvalid, emails: [mail("long.invalid")] },
      /* 14 */ { external_id: `edge-14-${t}`, email: mail("flag"), email_verified: "maybe" },
      /* 15 */ { external_id: `edge-15-${t}`, email: mail("blank.name"), display_name: "   \t\n  " },
      /* 16 */ { external_id: `edge-16-${t}`, phones: Array.from({ length: 12 }, (_, i) => `+1628${exchange}${String(100 + i).padStart(4, "0")}`) },
      /* 17 */ { external_id: `edge-17-${t}`, email: mail("listy"), display_name: ["Not", "Text"] },
    ];
    const seq = await lastSeq(env);
    const { job, rows: got } = await importRows(ctx, crm, rows, { default_country: "US" });
    const at = (n: number): RowResult | undefined => got.find(row => row.row_number === n);
    const msgs = (n: number, code: string): RowMessage[] => at(n)?.messages.filter(m => m.code === code) ?? [];
    const accounts = await accountsByUuid(env, got.map(row => row.account_uuid ?? "").filter(Boolean));
    const acct = (n: number) => accounts.get(at(n)?.account_uuid ?? "");
    const profile = (n: number) => (acct(n)?.membership?.imported_profile ?? {}) as { emails?: string[]; phones?: string[]; email_verified?: boolean | null };
    results.check("the job completes: 17 rows, 2 errors (the two bad external ids), the rest created", job.status === "completed" && job.counts.created === 15 && job.counts.error === 2 && got.length === 17, `${job.status} ${JSON.stringify(job.counts)}`);

    const truncated = msgs(1, "display_name_truncated")[0];
    results.check("row 1: a 150-character name is cut to its first 100 (warning display_name_truncated, saying both lengths)", at(1)?.outcome === "created" && acct(1)?.display_name === "Ab".repeat(50) && truncated?.level === "warning" && truncated.field === "display_name" && truncated.message === "The display name is 150 characters; it was cut to the first 100.", `${describeRow(at(1))} → ${acct(1)?.display_name.length} characters`);
    results.check("row 2: a name made of HTML is kept exactly as text (no warning)", at(2)?.outcome === "created" && acct(2)?.display_name === xssName && at(2)!.messages.length === 0, describeRow(at(2)));
    const many = msgs(3, "too_many_emails")[0];
    results.check("row 3: 12 emails: 10 kept in the imported profile, the account carries the first, warning too_many_emails (\"the last 2 were left out\")", at(3)?.outcome === "created" && profile(3).emails?.length === 10 && profile(3).emails?.[9] === mail("many10") && acct(3)?.emails.length === 1 && acct(3)?.emails[0]?.email === mail("many1") && many?.message === "An account can have at most 10 emails; the last 2 were left out.", `${describeRow(at(3))}; profile ${profile(3).emails?.length} emails`);
    const invalid = msgs(4, "invalid_email");
    results.check("row 4: 7 invalid emails make 5 warnings and one that counts the rest (\"…and 2 more invalid emails were left out too.\"); the valid email creates the account", at(4)?.outcome === "created" && invalid.length === 6 && invalid[5]?.message === "…and 2 more invalid emails were left out too." && acct(4)?.emails[0]?.email === mail("inv"), invalid.map(m => m.message).join(" | ").slice(0, 600));
    results.check("row 5: an external id with a tab is an error (invalid_external_id: control characters), no account", at(5)?.outcome === "error" && !at(5)?.account_uuid && msgs(5, "invalid_external_id")[0]?.level === "error" && /control characters/.test(msgs(5, "invalid_external_id")[0]?.message ?? ""), describeRow(at(5)));
    results.check("row 6: a 256-character external id is an error (invalid_external_id: \"is 256 characters; it must be at most 255\")", at(6)?.outcome === "error" && /is 256 characters; it must be at most 255/.test(msgs(6, "invalid_external_id")[0]?.message ?? ""), describeRow(at(6)).slice(0, 300));
    results.check("row 7: a javascript: photo URL is dropped (warning invalid_pfp_url) and the account gets the default photo", at(7)?.outcome === "created" && msgs(7, "invalid_pfp_url")[0]?.level === "warning" && acct(7)?.pfp_url === `${env.iris}/pfp/carbon?id=${acct(7)?.uuid}`, `${describeRow(at(7))}; ${acct(7)?.pfp_url}`);
    const twin = msgs(9, "id_conflict")[0];
    results.check("rows 8 and 9 want the same new id: row 8 gets c:twin_<tag>, row 9 another one, saying row 8 took it", at(8)?.id === `c:twin_${t}` && at(9)?.outcome === "created" && at(9)?.id !== `c:twin_${t}` && VALID_ID.test(at(9)?.id ?? "") && twin?.message === `Wanted c:twin_${t}, assigned ${at(9)?.id}: row 8 of this import already took c:twin_${t}.`, `${describeRow(at(8))} / ${describeRow(at(9))}`);
    results.check("row 10: a 30-character username (the longest handle) is the id exactly", at(10)?.id === `c:${handle30}` && at(10)!.messages.length === 0, describeRow(at(10)));
    results.check("row 11: dob 1900-01-01 (the earliest allowed) is kept; \"asia/kolkata\" becomes Asia/Kolkata; no warning", acct(11)?.dob === "1900-01-01" && acct(11)?.timezone === "Asia/Kolkata" && at(11)!.messages.length === 0, `${describeRow(at(11))} ${acct(11)?.dob} ${acct(11)?.timezone}`);
    results.check(`row 12: today's date (${today}) is not in the past: warning invalid_dob, the default dob`, msgs(12, "invalid_dob")[0]?.level === "warning" && /not in the past/.test(msgs(12, "invalid_dob")[0]?.message ?? "") && acct(12)?.dob === defaultDob(), `${describeRow(at(12))} ${acct(12)?.dob}`);
    const quoted = msgs(13, "invalid_email")[0]?.message ?? "";
    results.check("row 13: a 123-character invalid email is quoted cut to 80 characters (…), never whole; the row is created with its other email", at(13)?.outcome === "created" && quoted.includes(`'${longInvalid.slice(0, 80)}…'`) && !quoted.includes(longInvalid) && acct(13)?.emails[0]?.email === mail("long.invalid"), quoted);
    results.check("row 14: email_verified \"maybe\" is ignored with warning invalid_value (email_verified); the email stays unverified", msgs(14, "invalid_value")[0]?.field === "email_verified" && acct(14)?.emails[0]?.verified === false, describeRow(at(14)));
    results.check(`row 15: a blank display name: the account is named from the email ("${titled(`blank.name.${t}`)}")`, acct(15)?.display_name === titled(`blank.name.${t}`) && at(15)!.messages.length === 0, `${describeRow(at(15))} → ${acct(15)?.display_name}`);
    const phones = msgs(16, "too_many_phones")[0];
    results.check("row 16: 12 phones: 10 kept in the imported profile, the account carries the first (unverified), warning too_many_phones", at(16)?.outcome === "created" && profile(16).phones?.length === 10 && acct(16)?.phones[0]?.phone === `+1628${exchange}0100` && acct(16)?.phones[0]?.verified === false && phones?.message === "An account can have at most 10 phone numbers; the last 2 were left out.", `${describeRow(at(16))}; ${JSON.stringify(acct(16)?.phones)}`);
    results.check("row 17: a list where the display name belongs is ignored with warning invalid_value (\"must be text, not a list or an object\"); named from the email", msgs(17, "invalid_value")[0]?.field === "display_name" && /must be text, not a list or an object/.test(msgs(17, "invalid_value")[0]?.message ?? "") && acct(17)?.display_name === titled(`listy.${t}`), `${describeRow(at(17))} → ${acct(17)?.display_name}`);
    results.check("every message is bounded (at most 2000 characters) and says something", got.every(row => row.messages.every(m => m.message.length >= 10 && m.message.length <= 2000)), got.flatMap(row => row.messages.map(m => m.message.length)).join(","));
    const sent = await messagesAfter(env, seq);
    results.check("no email or SMS went out", sent.length === 0, sent.map(item => `${item.channel} to ${item.to}`).join(", ") || "nothing captured");

    // The HTML name on the developer site, as legacy-crm's owner: text, never markup.
    const { context, page } = await developerSession(ctx, crm.owner_email, "imports-edge-rows", { returnTo: "/apps/legacy-crm/users" });
    if (!page.url().startsWith(`${env.developer}/apps/legacy-crm/users`)) await page.goto(`${env.developer}/apps/legacy-crm/users`);
    const search = page.getByRole("searchbox", { name: "Search users" }).or(page.getByRole("textbox", { name: "Search users" }));
    await search.first().fill(`eve_${t}`);
    const person = page.locator(`[data-open-user="${at(2)?.account_uuid}"]`);
    const listed = await person.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    await sleep(1200);
    const shown = listed ? await person.first().innerText() : "";
    const injected = await page.evaluate(() => ({ flag: (window as unknown as { __importXss?: number }).__importXss ?? null, images: [...document.querySelectorAll("main img")].filter(img => img.getAttribute("src") === "x").length }));
    await shot(env, page, "imports-edge-01-users");
    results.check("the user base shows the HTML name as text (no <img> made from it, nothing run)", listed && shown.includes(xssName) && injected.flag === null && injected.images === 0, `${listed ? shown.replace(/\s+/g, " ").slice(0, 200) : "not listed"}; ${JSON.stringify(injected)}`);
    await page.goto(`${env.developer}/apps/legacy-crm/import`);
    const recent = page.getByRole("region", { name: "Recent imports" }).getByRole("listitem");
    await recent.first().waitFor({ timeout: 20_000 });
    await recent.first().getByRole("button").first().click();
    const openRow = page.getByRole("button", { name: "Open row 2", exact: true });
    const reported = await openRow.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    let drawerText = "";
    if (reported) {
      await openRow.click();
      const drawer = page.getByRole("dialog");
      await drawer.waitFor({ timeout: 10_000 });
      await sleep(1000);
      drawerText = (await drawer.innerText()).replace(/\s+/g, " ");
      await shot(env, page, "imports-edge-02-report-row");
    }
    const injectedAfter = await page.evaluate(() => ({ flag: (window as unknown as { __importXss?: number }).__importXss ?? null, images: [...document.querySelectorAll("img")].filter(img => img.getAttribute("src") === "x").length }));
    results.check("the import report's row 2 shows the name as text too", reported && drawerText.includes(xssName) && injectedAfter.flag === null && injectedAfter.images === 0, `${drawerText.slice(0, 300)}; ${JSON.stringify(injectedAfter)}`);
    await context.close();
  },
};

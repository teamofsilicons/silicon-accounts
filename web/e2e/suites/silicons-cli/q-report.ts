import type { Journey } from "../../context";
import { forgetRateLimits, json, lastSeq, sleep, sql, tag } from "../../lib";
import { REPORT_RECIPIENTS, accounts, asCarbon, cliError, freshDir, loginSilicon, obj, said, short, signUpCarbon, str, until, type Json } from "./_helpers";

interface Mail {
  seq: number;
  to: string;
  recipients: string[];
  from: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  provider: string;
  channel: string;
}

/** Captured emails containing `marker`, sent after message `after`. */
async function mailsWith(env: Parameters<typeof lastSeq>[0], marker: string, after: number): Promise<Mail[]> {
  const { body } = await json<{ items?: Mail[] }>(`${env.messaging}/_messages?contains=${encodeURIComponent(marker)}&after=${after}&limit=50`);
  return body.items ?? [];
}

const PR = "https://github.com/teamofsilicons/silicon-accounts/pull/42";

export const journey: Journey = {
  name: "silicons-cli-report",
  title: "`accounts report`: each report is emailed through Postmark (the mock) to exactly saketdev12@gmail.com, shubhastro2@gmail.com and bugs@teamofsilicons.com, with the PR link when given; signed-in reports name the account; retries don't send twice; invalid input and the 5-per-hour limit are explained",
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();

    // 1. Anonymous, with a PR.
    const marker = `scli-report-${t}`;
    let after = await lastSeq(env);
    const message = `${marker}: accounts login --app remind answered 500\nSteps: sign in, ask for an SLT.`;
    const anon = await accounts(env, ["report", message, "--pr", PR, "--json"], { home: freshDir() });
    const reportId = str(anon.json?.report_id);
    results.check("`accounts report <message> --pr <link> --json` (signed out): queued for 3 recipients", anon.code === 0 && anon.json?.status === "queued" && anon.json?.recipients === 3 && anon.json?.pr_url === PR && reportId.length > 0, said(anon));
    const mails = await until(async () => {
      const found = await mailsWith(env, marker, after);
      return found.length >= 3 ? found : null;
    }, 20_000, 300);
    await sleep(1500);
    const all = await mailsWith(env, marker, after);
    const recipients = all.flatMap(mail => mail.recipients).sort();
    results.check("the mock Postmark received exactly 3 emails, to exactly the 3 maintainers, one each", !!mails && all.length === 3 && JSON.stringify(recipients) === JSON.stringify([...REPORT_RECIPIENTS].sort()) && all.every(mail => mail.recipients.length === 1 && mail.provider === "postmark" && mail.channel === "email"), short(all.map(mail => mail.recipients)));
    const first = all[0];
    results.check("…sent from accounts@teamofsilicons.com", all.every(mail => str(mail.from).includes("accounts@teamofsilicons.com")), str(first?.from));
    results.check("…subject '[Silicon Accounts bug report] <first line>'", all.every(mail => mail.subject === `[Silicon Accounts bug report] ${marker}: accounts login --app remind answered 500`), str(first?.subject));
    results.check("…the body: the report id, an anonymous caller, the whole message, the PR link", all.every(mail => str(mail.text).includes(`Bug report ${reportId} from an anonymous caller`) && str(mail.text).includes("Steps: sign in, ask for an SLT.") && str(mail.text).includes(`Pull request: ${PR}`) && str(mail.html).includes(`href="${PR}"`)), short(first?.text, 400));
    results.check("…with the CLI's version and platform appended", all.every(mail => /accounts CLI \d+\.\d+\.\d+ on \w+ \w+/.test(str(mail.text))), short(str(first?.text).split("\n").slice(-4).join(" ")));
    const stored = await sql(env, `select coalesce(account_uuid, ''), coalesce(pr_url, ''), position('${marker}' in message) > 0 from bug_reports where id = '${reportId}'`);
    results.check("the report is stored (no account, the PR link)", stored[0]?.[0] === "" && stored[0]?.[1] === PR && stored[0]?.[2] === "t", short(stored));

    // 2. Signed in (a Silicon), text mode, no PR: the account is named, and the PR suggestion is printed.
    const carbon = await signUpCarbon(env, "reporter");
    const stk = `stk-5e9047${"0".repeat(6)}`;
    const made = await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: `si:reporter-${t}`, display_name: "Reporter", stk });
    const uuid = str(obj(obj(made.body).silicon).uuid);
    const home = freshDir();
    await loginSilicon(env, home, `si:reporter-${t}`, stk);
    const marker2 = `scli-signed-${t}`;
    after = await lastSeq(env);
    const signed = await accounts(env, ["report", `${marker2}: whoami shows a stale id`], { home });
    results.check("signed in, text mode: 'Report … sent … (3 recipients)' and 'You can also open a PR at <repo>'", signed.code === 0 && /Report \S+ sent: it is emailed to the Silicon Accounts maintainers \(3 recipients\)/.test(signed.stdout) && signed.stdout.includes("You can also open a PR at https://github.com/teamofsilicons/silicon-accounts"), said(signed));
    const signedMails = await until(async () => {
      const found = await mailsWith(env, marker2, after);
      return found.length >= 3 ? found : null;
    }, 20_000, 300);
    results.check("…its emails name the Silicon who reported it (si:id and uuid)", !!signedMails && signedMails.length === 3 && signedMails.every(mail => str(mail.text).includes(`from si:reporter-${t} (uuid ${uuid})`)), short(signedMails?.[0]?.text, 300));
    const storedSigned = await sql(env, `select count(*) from bug_reports where account_uuid = '${uuid}'`);
    results.check("…and the stored report carries the account", storedSigned[0]?.[0] === "1", short(storedSigned));

    // 3. From stdin, without diagnostics.
    const marker3 = `scli-stdin-${t}`;
    after = await lastSeq(env);
    const piped = await accounts(env, ["report", "-", "--no-diagnostics", "--json"], { home: freshDir(), stdin: `${marker3}: piped in\n` });
    const pipedMails = await until(async () => {
      const found = await mailsWith(env, marker3, after);
      return found.length >= 3 ? found : null;
    }, 20_000, 300);
    results.check("`accounts report - --no-diagnostics` reads stdin and appends nothing", piped.code === 0 && !!pipedMails && pipedMails.every(mail => !/accounts CLI \d/.test(str(mail.text))), said(piped));

    // 4. A retry with the same Idempotency-Key sends nothing new.
    const marker4 = `scli-retry-${t}`;
    after = await lastSeq(env);
    const keyArgs = ["report", `${marker4}: retried`, "--idempotency-key", `scli-${t}`, "--json"];
    const once = await accounts(env, keyArgs, { home: freshDir() });
    const twice = await accounts(env, keyArgs, { home: freshDir() });
    await until(async () => ((await mailsWith(env, marker4, after)).length >= 3 ? true : null), 20_000, 300);
    await sleep(2000);
    const retryMails = await mailsWith(env, marker4, after);
    results.check("the same report retried with the same --idempotency-key: the same report id, emailed once (3 emails)", once.code === 0 && twice.code === 0 && once.json?.report_id === twice.json?.report_id && retryMails.length === 3, `${short(once.json?.report_id)} / ${short(twice.json?.report_id)}, ${retryMails.length} emails`);

    // 5. Invalid input sends nothing.
    after = await lastSeq(env);
    const http = await accounts(env, ["report", `scli-invalid-${t}`, "--pr", "http://github.com/teamofsilicons/silicon-accounts/pull/1", "--json"], { home: freshDir() });
    results.check("a PR link that isn't https: exit 2, said precisely (the CLI checks it before sending)", http.code === 2 && /is not an https URL/.test(str(cliError(http).message)), said(http));
    const httpApi = await json<Json>(`${env.site}/v1/reports`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ctx.ip }, body: JSON.stringify({ message: `scli-invalid-${t} api`, pr_url: "http://github.com/x/y/pull/1" }) });
    results.check("…and the API refuses it too: 422 validation_failed on pr_url (must use https)", httpApi.status === 422 && str(obj(obj(httpApi.body).error).code) === "validation_failed" && /https/.test(str(obj(obj(obj(obj(httpApi.body).error).details).fields).pr_url)), `${httpApi.status} ${short(httpApi.body)}`);
    const empty = await accounts(env, ["report", "   ", "--json"], { home: freshDir() });
    results.check("an empty message: exit 2, says what to write", empty.code === 2 && /empty/.test(str(cliError(empty).message)), said(empty));
    await sleep(1000);
    results.check("…neither sent an email", (await mailsWith(env, `scli-invalid-${t}`, after)).length === 0);

    // 6. Five reports an hour per network: the sixth is refused and says when to retry.
    const sent = [anon, signed, piped, once].length;
    const extra = [];
    for (let i = sent; i < 5; i++) extra.push(await accounts(env, ["report", `scli-limit-${t}-${i}`, "--json"], { home: freshDir() }));
    const sixth = await accounts(env, ["report", `scli-limit-${t}-6`, "--json"], { home: freshDir() });
    results.check("five reports an hour from one network; the sixth: exit 6, rate_limited, retry_after_seconds", extra.every(run => run.code === 0) && sixth.code === 6 && cliError(sixth).code === "rate_limited" && Number(obj(cliError(sixth).details).retry_after_seconds) > 0, `${extra.length} more ok, then ${said(sixth)}`);
    await forgetRateLimits(env, "127.0.0.1");
  },
};

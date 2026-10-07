/**
 * Import jobs across API nodes (crates/apps/src/imports/worker.rs and engine.rs), with a second accounts-api process on
 * the stack's own database and environment: another node, with its own import worker.
 *
 * - A node killed mid-job (SIGKILL: a crash, an OOM kill) leaves the job `running`; the other node's worker takes it
 *   over and finishes it from the last committed chunk. Every row is imported exactly once, and the takeover is on
 *   record (audit app.import.resumed).
 * - A job whose workers already stopped twice (two resumes on record, written here to stand for two earlier crashes) is
 *   not resumed a third time: it is marked failed with a reason that says what to do, the CLI reports it (exit 1), and
 *   importing the same file again imports the rest, every row already imported matching its account.
 * - Two apps importing the same new people on two nodes at the same moment (one file in the other's reverse order, so
 *   they meet in the middle): one account per person, both memberships on it, no row lost to the race.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { cli, cliHome, sleep, tag } from "../../lib";
import {
  basicAuth,
  countsText,
  fakeApp,
  forgetImportBudgets,
  getJob,
  jobWorkerPid,
  listenerPid,
  lit,
  psql,
  rowsOf,
  startInstance,
  waitJob,
  type FakeApp,
  type ImportJob,
  type Instance,
} from "./_helpers";

type Ctx = Parameters<Journey["run"]>[0];

/** POSTs a CSV import to one node (its own URL), as the app. */
async function submitTo(ctx: Ctx, base: string, app: FakeApp, csv: string): Promise<ImportJob> {
  const answer = await fetch(`${base}/v1/apps/${app.app_id}/imports`, {
    method: "POST",
    headers: { authorization: basicAuth(app), "content-type": "text/csv", "idempotency-key": randomUUID(), "x-forwarded-for": ctx.ip },
    body: csv,
  });
  const body = (await answer.json().catch(() => ({}))) as { job?: ImportJob };
  if (answer.status !== 202 || !body.job) throw new Error(`the import was refused by ${base}: ${answer.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.job;
}

const people = (prefix: string, domain: string, n: number, order: "forward" | "reverse" = "forward") => {
  const lines = ["external_id,email,display_name,username"];
  const indexes = Array.from({ length: n }, (_, i) => i + 1);
  if (order === "reverse") indexes.reverse();
  for (const i of indexes) {
    const k = String(i).padStart(6, "0");
    lines.push(`${prefix}-${k},p${k}@${domain},Person ${k},${prefix.replace(/-/g, "_")}_${k}`);
  }
  return `${lines.join("\n")}\n`;
};

/**
 * Submits `csv` to `node` until that node (not another) is the one working on the job, and returns once it committed
 * at least `minRows` rows (up to 3 tries: the other nodes' workers poll every 2 s and may claim it first).
 */
async function startOn(ctx: Ctx, node: Instance, others: number[], app: FakeApp, makeCsv: (attempt: number) => string, minRows: number): Promise<{ job: ImportJob; attempts: string[] }> {
  const attempts: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const queued = await submitTo(ctx, node.url, app, makeCsv(attempt));
    const deadline = Date.now() + 120_000;
    for (;;) {
      const job = await getJob(ctx, app, queued.id);
      const holder = await jobWorkerPid(ctx.env, queued.id, [node.pid, ...others]);
      if (holder === node.pid && job.processed_rows >= minRows && job.status === "running") {
        attempts.push(`try ${attempt}: ${node.url} holds job ${job.id} at ${job.processed_rows}/${job.total_rows}`);
        return { job, attempts };
      }
      if ((holder !== null && holder !== node.pid) || job.status === "completed" || job.status === "failed" || Date.now() > deadline) {
        attempts.push(`try ${attempt}: job ${job.id} ${job.status} ${job.processed_rows}/${job.total_rows}, worked on by pid ${holder} (this node ${node.pid})`);
        if (job.status === "running" || job.status === "queued") await waitJob(ctx, app, job.id, 10 * 60_000, 500);
        break;
      }
      await sleep(100);
    }
  }
  throw new Error(`the second node never worked on the import: ${attempts.join(" | ")}`);
}

export const journey: Journey = {
  name: "imports-worker-nodes",
  title: "import jobs across API nodes: a node killed mid-job is taken over by another and every row lands once; a job whose workers stopped too often fails with what to do, and re-importing the file imports the rest; two apps importing the same new people on two nodes at once make one account per person",
  // Only the API and the CLI are under test here: the engine makes no difference, so WebKit runs skip it.
  engines: ["chromium"],
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const crm = fakeApp("legacy-crm");
    const pixel = fakeApp("pixel-studio");
    await forgetImportBudgets(env, crm.app_id);
    await forgetImportBudgets(env, pixel.app_id);
    const stackPid = await listenerPid(env.base - 1);
    if (!stackPid) throw new Error(`nothing listens on accounts-api's port ${env.base - 1}`);
    const nodes: Instance[] = [];
    try {
      /* ---------------------------------------------------------------- a node dies mid-job; another takes it over */
      const t = tag();
      const N1 = 30_000;
      const nodeB = await startInstance(env, "b1");
      nodes.push(nodeB);
      // Each try has its own people (a try another node took is imported in full, and must not turn the next into matches).
      const crash = await startOn(ctx, nodeB, [stackPid], crm, attempt => people(`crash-${t}-${attempt}`, `${t}${attempt}.crash.example.test`, N1), 1_000);
      const domain1 = `${t}${crash.attempts.length}.crash.example.test`;
      const prefix1 = `crash-${t}-${crash.attempts.length}`;
      const killedAt = Date.now();
      const atKill = await getJob(ctx, crm, crash.job.id);
      await nodeB.kill();
      results.check("the second node works on the import, and is killed (SIGKILL) with it part done", !nodeB.alive() && atKill.status === "running" && atKill.processed_rows > 0 && atKill.processed_rows < N1, `${crash.attempts.join(" | ")}; at the kill ${atKill.processed_rows}/${N1}`);
      const done = await waitJob(ctx, crm, crash.job.id, 10 * 60_000, 300);
      const audit = await rowsOf<{ action: string; at: string; details: { resume?: number; processed_rows?: number } }>(env, `select action, at, details from audit_log where target_kind = 'import_job' and target_id = ${lit(crash.job.id)} order by id`);
      const resumed = audit.filter(entry => entry.action === "app.import.resumed");
      const resumedAfter = resumed[0] ? Date.parse(resumed[0].at) - killedAt : NaN;
      results.metric("job taken over by the other node after the kill", resumedAfter, "ms");
      results.check("the stack's node takes the job over (one app.import.resumed on record, resume 1, a few seconds after the kill) and completes it", done.status === "completed" && resumed.length === 1 && resumed[0]?.details.resume === 1 && resumedAfter < 30_000, `${done.status} after ${done.seen_done_at - killedAt} ms; audit ${JSON.stringify(audit).slice(0, 400)}`);
      results.check(`every row is imported once: created ${N1}, nothing else, ${N1} rows processed`, done.counts.created === N1 && done.counts.matched === 0 && done.counts.error === 0 && done.counts.skipped === 0 && done.processed_rows === N1, countsText(done.counts));
      const [written] = await rowsOf<{ emails: number; members: number; accounts: number; outcomes: number; pending: number; uuids: number }>(env, `select
          (select count(*) from account_emails where email like ${lit(`%@${domain1}`)}) as emails,
          (select count(*) from memberships where app_id = 'legacy-crm' and external_id like ${lit(`${prefix1}-%`)}) as members,
          (select count(distinct e.account_uuid) from account_emails e where e.email like ${lit(`%@${domain1}`)}) as accounts,
          (select count(*) from import_job_rows where job_id = ${lit(crash.job.id)} and outcome = 'created') as outcomes,
          (select count(*) from import_job_rows where job_id = ${lit(crash.job.id)} and outcome = 'pending') as pending,
          (select count(distinct account_uuid) from import_job_rows where job_id = ${lit(crash.job.id)}) as uuids`);
      results.check(`…in the database too: ${N1} accounts (one per email), ${N1} memberships, ${N1} row outcomes naming ${N1} different accounts, none pending`, written?.emails === N1 && written.accounts === N1 && written.members === N1 && written.outcomes === N1 && written.pending === 0 && written.uuids === N1, JSON.stringify(written));

      /* ------------------------------------------------ a job whose workers stopped too often is failed, not resumed */
      const f = tag();
      const N2 = 30_000;
      const nodeC = await startInstance(env, "b2");
      nodes.push(nodeC);
      const fail = await startOn(ctx, nodeC, [stackPid], crm, attempt => people(`fail-${f}-${attempt}`, `${f}${attempt}.fail.example.test`, N2), 1_000);
      const prefix2 = `fail-${f}-${fail.attempts.length}`;
      const domain2 = `${f}${fail.attempts.length}.fail.example.test`;
      const csv2 = people(prefix2, domain2, N2);
      // Two earlier crashes on record (as two resumes of this job would have left them), then the node dies again.
      await psql(env, `insert into audit_log (actor_kind, action, target_kind, target_id, app_id, details)
        values ('system', 'app.import.resumed', 'import_job', ${lit(fail.job.id)}, 'legacy-crm', '{"resume": 1, "written_by": "e2e: an earlier crash"}'),
               ('system', 'app.import.resumed', 'import_job', ${lit(fail.job.id)}, 'legacy-crm', '{"resume": 2, "written_by": "e2e: an earlier crash"}')`);
      const failKilledAt = Date.now();
      await nodeC.kill();
      const failed = await waitJob(ctx, crm, fail.job.id, 120_000, 300);
      const failAudit = await rowsOf<{ action: string }>(env, `select action from audit_log where target_kind = 'import_job' and target_id = ${lit(fail.job.id)} order by id`);
      results.metric("job failed after the third stop, after", failed.seen_done_at - failKilledAt, "ms");
      results.check(
        "a job whose worker stopped a third time is marked failed (not resumed again), saying it stopped more than twice and to re-submit the file to import the rest",
        failed.status === "failed" && /stopped \(the server restarted or crashed\) more than twice/.test(failed.error ?? "") && /re-submit the file to import the rest \(rows already imported match their accounts\)/.test(failed.error ?? "") && failAudit.filter(entry => entry.action === "app.import.resumed").length === 2 && failAudit.some(entry => entry.action === "app.import.failed"),
        `${failed.status}: ${failed.error}; audit ${failAudit.map(entry => entry.action).join(", ")}`,
      );
      const [kept] = await rowsOf<{ outcomes: number; pending: number; emails: number }>(env, `select
          (select count(*) from import_job_rows where job_id = ${lit(fail.job.id)} and outcome <> 'pending') as outcomes,
          (select count(*) from import_job_rows where job_id = ${lit(fail.job.id)} and outcome = 'pending') as pending,
          (select count(*) from account_emails where email like ${lit(`%@${domain2}`)}) as emails`);
      results.check("…what it imported before stopping stays, and the job says exactly how much (processed rows = rows with an outcome = accounts made)", failed.processed_rows > 0 && failed.processed_rows < N2 && kept?.outcomes === failed.processed_rows && kept.pending === N2 - failed.processed_rows && kept.emails === failed.processed_rows && failed.counts.created === failed.processed_rows, `processed ${failed.processed_rows}; ${JSON.stringify(kept)}; ${countsText(failed.counts)}`);
      const home = cliHome();
      const status = await cli(env, home, ["app", "import", "status", fail.job.id, "--wait", "--json", "--app-id", crm.app_id, "--app-secret-stdin"], { stdin: `${crm.secret}\n` });
      const statusJob = status.json as { status?: string; error?: string } | null;
      results.check("`accounts app import status <job> --wait` reports the failed job with its reason and exits 1 (as `accounts app import <file> --wait` does for a failed job)", status.code === 1 && statusJob?.status === "failed" && statusJob.error === failed.error, `exit ${status.code}; ${status.stdout.slice(0, 300)} ${status.stderr.slice(0, 200)}`);
      const statusText = await cli(env, home, ["app", "import", "status", fail.job.id, "--app-id", crm.app_id, "--app-secret-stdin"], { stdin: `${crm.secret}\n` });
      results.check("…and in text mode it says the job failed and why", statusText.stdout.includes(`Import ${fail.job.id}: failed (${failed.processed_rows}/${N2} rows).`) && statusText.stdout.includes("stopped (the server restarted or crashed) more than twice"), `exit ${statusText.code}; ${statusText.stdout.replace(/\s+/g, " ").slice(0, 400)}`);
      const again = await submitTo(ctx, env.site, crm, csv2);
      const rest = await waitJob(ctx, crm, again.id, 10 * 60_000, 300);
      results.check(`importing the same file again imports the rest: matched ${failed.processed_rows} (already imported), created ${N2 - failed.processed_rows}, no error`, rest.status === "completed" && rest.counts.matched === failed.processed_rows && rest.counts.created === N2 - failed.processed_rows && rest.counts.error === 0, countsText(rest.counts));
      const total2 = await psql(env, `select count(*) from account_emails where email like ${lit(`%@${domain2}`)}`);
      results.check(`…and no one twice: ${N2} accounts in all`, total2 === String(N2), `${total2} accounts`);

      /* ---------------------------------------------- two apps, two nodes, the same new people, at the same moment */
      const r = tag();
      const N3 = 6_000;
      const domain3 = `${r}.race.example.test`;
      const nodeD = await startInstance(env, "b3");
      nodes.push(nodeD);
      await forgetImportBudgets(env, crm.app_id);
      await forgetImportBudgets(env, pixel.app_id);
      const crmCsv = people(`race-${r}`, domain3, N3, "forward");
      const pixelCsv = people(`px-race-${r}`, domain3, N3, "reverse");
      const [crmJob, pixelJob] = await Promise.all([submitTo(ctx, env.api, crm, crmCsv), submitTo(ctx, nodeD.url, pixel, pixelCsv)]);
      // Who works on which job, sampled while they run.
      const holders = new Map<string, Set<number>>([[crmJob.id, new Set()], [pixelJob.id, new Set()]]);
      let running = true;
      const sampler = (async () => {
        while (running) {
          for (const id of holders.keys()) {
            const pid = await jobWorkerPid(env, id, [stackPid, nodeD.pid]);
            if (pid) holders.get(id)!.add(pid);
          }
          await sleep(150);
        }
      })();
      const [crmDone, pixelDone] = await Promise.all([waitJob(ctx, crm, crmJob.id, 10 * 60_000, 300), waitJob(ctx, pixel, pixelJob.id, 10 * 60_000, 300)]);
      running = false;
      await sampler;
      const overlap = Math.min(Date.parse(crmDone.finished_at ?? ""), Date.parse(pixelDone.finished_at ?? "")) - Math.max(Date.parse(crmDone.started_at ?? ""), Date.parse(pixelDone.started_at ?? ""));
      const workers = [...holders.values()].map(set => [...set].map(pid => (pid === stackPid ? "stack node" : "second node")).join("+") || "?");
      results.metric("the two jobs ran side by side for", overlap, "ms");
      results.check("the two jobs ran at the same time on two different nodes", overlap > 0 && new Set([...holders.values()].flatMap(set => [...set])).size === 2, `overlap ${overlap} ms; legacy-crm's job on ${workers[0]}, pixel-studio's on ${workers[1]}`);
      const conflicts = [crmDone, pixelDone].reduce((sum, job) => sum + job.counts.error, 0);
      results.check(
        `between them they created each of the ${N3} people once and matched them once (created ${N3} and matched ${N3} in all), no row an error`,
        crmDone.status === "completed" && pixelDone.status === "completed" && crmDone.counts.created + pixelDone.counts.created === N3 && crmDone.counts.matched + pixelDone.counts.matched === N3 && conflicts === 0,
        `legacy-crm: ${countsText(crmDone.counts)} | pixel-studio: ${countsText(pixelDone.counts)}`,
      );
      results.check("both nodes created some of them (each job created a share and matched the rest: the race was real)", crmDone.counts.created > 0 && pixelDone.counts.created > 0, `legacy-crm created ${crmDone.counts.created}, pixel-studio created ${pixelDone.counts.created}`);
      results.metric("people created by legacy-crm's job in the race", crmDone.counts.created, "count");
      results.metric("people created by pixel-studio's job in the race", pixelDone.counts.created, "count");
      const [race] = await rowsOf<{ emails: number; accounts: number; both: number }>(env, `select
          (select count(*) from account_emails where email like ${lit(`%@${domain3}`)}) as emails,
          (select count(distinct account_uuid) from account_emails where email like ${lit(`%@${domain3}`)}) as accounts,
          (select count(*) from account_emails e
             join memberships a on a.account_uuid = e.account_uuid and a.app_id = 'legacy-crm' and a.external_id = ${lit(`race-${r}-`)} || substring(e.email from '^p(\\d+)@')
             join memberships b on b.account_uuid = e.account_uuid and b.app_id = 'pixel-studio' and b.external_id = ${lit(`px-race-${r}-`)} || substring(e.email from '^p(\\d+)@')
           where e.email like ${lit(`%@${domain3}`)}) as both`);
      results.check(`one account per person (${N3} emails on ${N3} accounts), each holding both apps' memberships with the right external ids`, race?.emails === N3 && race.accounts === N3 && race.both === N3, JSON.stringify(race));
    } finally {
      for (const node of nodes) await node.kill();
    }
    results.check("every second node is stopped", nodes.every(node => !node.alive()), nodes.map(node => `${node.url} ${node.alive() ? "alive" : "stopped"}`).join(", "));
  },
};

/**
 * Latency. POST /v1/proofs/verify over HTTP: 1000 sequential verifies and 1000 more from 50 concurrent callers,
 * straight at accounts-api (how the fake apps, and app servers, call it) and through the site (the public origin, via
 * the Next proxy), with p50/p95/p99, on keep-alive connections (node:http; fetch's own overhead inflates the numbers
 * on a loaded machine).
 *
 * The gate is p95 ≤ 25 ms locally, and _latency-gate.ts decides it. A p95 taken while other stacks load the machine
 * measures the machine, so every gated run interleaves its verifies with a one-query control on the same callers and
 * the same path (GET /v1/photos/<unknown id>: one primary-key lookup, then 404): when the control leaves room for the
 * budget, verify must meet it; when the control alone would eat it, verify must cost no more than 3× the control.
 * Each gated measurement takes the best of up to three runs, waiting for the machine to calm down after a busy one,
 * and the whole benchmark holds the machine's benchmark slot (lib.ts withBenchSlot), so the twin stack of
 * scripts/e2e-all.sh never benchmarks at the same moment. A run during which this process stood still for seconds
 * (the machine slept: lib.ts watchStalls) is void and measured again, and no request waits more than 30 s. Around the gate, for reading the numbers: two more controls
 * (a verify refused before any database work, and GET /readyz), accounts-api's own duration of the same requests (its
 * log, by X-Request-Id), the database's execution time of the verify query (EXPLAIN ANALYZE) and the machine's load.
 *
 * Then the round trips: OBO dm → briefcase and ATA commit → remind and commit → waveform (a proof per app: an ATA proof
 * is always for exactly one app) through the fake apps, and an app's whole OBO cycle (issue, verify, refresh, verify,
 * revoke, verify) timed step by step.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Ctx, Journey } from "../../context";
import { FROZEN_STALL_MS, json, sql, waitForCalm, watchStalls, withBenchSlot } from "../../lib";
import { appTokens, basicAuth, describeStats, isExactlyInvalid, issueAtaFor, issueObo, machineLoad, namesOnly, refreshAs, revokeAs, serverDurations, signInToApp, stats, verifyAs, type Stats } from "./_helpers";
import { LATENCY_GATE, MAX_FROZEN_RUNS, decide, frozenVerdict, gateWords, judge, type Verdict } from "./_latency-gate";

export interface Answer {
  status: number;
  body: unknown;
  requestId: string | null;
}

/** How long a request may go without an answer: a hung endpoint fails its requests instead of the whole journey. */
const REQUEST_TIMEOUT_MS = 30_000;

/** One keep-alive connection pool per run (as an app server's HTTP client keeps one). Exported for its unit tests. */
export function client(maxSockets: number, timeoutMs = REQUEST_TIMEOUT_MS) {
  const agent = new http.Agent({ keepAlive: true, maxSockets });
  const send = (url: string, method: string, headers: Record<string, string>, body?: string) =>
    new Promise<Answer>((resolve, reject) => {
      const request = http.request(url, { method, agent, headers: body === undefined ? headers : { ...headers, "content-length": String(Buffer.byteLength(body)) } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // Not JSON.
          }
          resolve({ status: response.statusCode ?? 0, body: parsed, requestId: (response.headers["x-request-id"] as string | undefined) ?? null });
        });
        response.on("error", reject);
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
      request.on("error", reject);
      request.end(body);
    });
  return { send, close: () => agent.destroy() };
}

export type Send = (connection: ReturnType<typeof client>) => Promise<Answer>;

/** A kind of request of a run: how to send it, and which answers are right. */
export interface Kind {
  name: string;
  send: Send;
  ok: (answer: Answer) => boolean;
}

/** What one kind of request of a run saw. */
export interface Sample {
  latencies: number[];
  /** Answers that were wrong (not what `ok` wants) or never came. */
  wrong: number;
  statuses: Map<string, number>;
  requestIds: string[];
}

export interface Run {
  label: string;
  samples: Map<string, Sample>;
  requests: number;
  wallMs: number;
  load: { before: number; after: number; cores: number };
  /** The longest this process stood still during the run (lib.ts watchStalls), ms: seconds mean the machine slept. */
  stallMs: number;
}

/**
 * `perKind` requests of every kind from `concurrency` callers on keep-alive connections, the kinds taking turns
 * (request i is kinds[i % kinds.length]), so every kind sees the same moments of the machine; one latency per request.
 */
export async function measure(label: string, perKind: number, concurrency: number, kinds: Kind[]): Promise<Run> {
  const samples = new Map<string, Sample>(kinds.map(kind => [kind.name, { latencies: [], wrong: 0, statuses: new Map(), requestIds: [] }]));
  const connections = client(concurrency);
  // Open every keep-alive connection first (not measured): an app server's client is warm, and a cold run would put
  // `concurrency` TCP handshakes into the first requests (5% of a 1000-request run at 50 callers, i.e. into p95).
  await Promise.all(Array.from({ length: concurrency }, () => kinds[0]!.send(connections).catch(() => undefined)));
  const total = perKind * kinds.length;
  let next = 0;
  const before = machineLoad();
  const stalls = watchStalls();
  const started = performance.now();
  const worker = async () => {
    while (next < total) {
      const kind = kinds[next++ % kinds.length]!;
      const sample = samples.get(kind.name)!;
      const t0 = performance.now();
      let outcome = "error";
      try {
        const answer = await kind.send(connections);
        sample.latencies.push(performance.now() - t0);
        if (answer.requestId) sample.requestIds.push(answer.requestId);
        outcome = String(answer.status);
        if (!kind.ok(answer)) sample.wrong++;
      } catch (error) {
        sample.wrong++;
        outcome = `error ${(error as Error).message}`;
      }
      sample.statuses.set(outcome, (sample.statuses.get(outcome) ?? 0) + 1);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - started;
  const stallMs = stalls.stop();
  connections.close();
  return { label, samples, requests: total, wallMs, load: { before: before.load1, after: machineLoad().load1, cores: before.cores }, stallMs };
}

/** A run and the tries of it that were void because this process stood still (the machine slept) while they ran. */
export interface Measured {
  run: Run;
  voided: Run[];
  /** Every try stood still: `run` is the last of them and measured the sleep. */
  frozen: boolean;
}

const frozenText = (r: Run) => `stood still ${(r.stallMs / 1000).toFixed(1)} s (asleep), statuses ${JSON.stringify(Object.fromEntries([...r.samples].map(([kind, sample]) => [kind, Object.fromEntries(sample.statuses)])))}`;

/**
 * `measure`, again when a run was frozen: a run during which this process stood still for FROZEN_STALL_MS or more
 * measured the machine's sleep (a request in flight "took" the whole sleep, connections were reset at wake), so it is
 * set aside, never judged or counted, and measured once more, up to MAX_FROZEN_RUNS tries in all. `options` is for
 * the unit tests (test/latency.test.ts).
 */
export async function measureAwake(
  ctx: Pick<Ctx, "results">,
  label: string,
  perKind: number,
  concurrency: number,
  kinds: Kind[],
  options: { frozenMs?: number; tries?: number } = {},
): Promise<Measured> {
  const frozenMs = options.frozenMs ?? FROZEN_STALL_MS;
  const tries = options.tries ?? MAX_FROZEN_RUNS;
  const voided: Run[] = [];
  for (;;) {
    const run = await measure(label, perKind, concurrency, kinds);
    if (run.stallMs < frozenMs) return { run, voided, frozen: false };
    ctx.results.metric(`${label}: void run, the process stood still for`, run.stallMs);
    console.log(`        ${label}: void, ${frozenText(run)}; ${voided.length + 1 < tries ? "measuring again" : "giving up"}`);
    if (voided.length + 1 >= tries) return { run, voided, frozen: true };
    voided.push(run);
  }
}

const throughput = (r: Run) => (r.requests / r.wallMs) * 1000;
const loadText = (r: Run) => `load ${r.load.before}→${r.load.after} on ${r.load.cores} cores`;

/** Metrics of one kind of a run (accounts-api's own durations when its log has them). */
function report(ctx: Ctx, r: Run, kind: string, label = r.label): { s: Stats; server: Stats | null } {
  const sample = r.samples.get(kind)!;
  const s = stats(sample.latencies);
  const durations = [...serverDurations(ctx.env, sample.requestIds).values()];
  const server = durations.length ? stats(durations) : null;
  ctx.results.metric(`${label} p50`, s.p50);
  ctx.results.metric(`${label} p95`, s.p95);
  ctx.results.metric(`${label} p99`, s.p99);
  ctx.results.metric(`${label} max`, s.max);
  if (server) {
    ctx.results.metric(`${label} accounts-api p50 (whole ms)`, server.p50);
    ctx.results.metric(`${label} accounts-api p95 (whole ms)`, server.p95);
    ctx.results.metric(`${label} accounts-api p99 (whole ms)`, server.p99);
  }
  return { s, server };
}

/** The verify lookup of the proofs crate (store::verify_lookup), for EXPLAIN ANALYZE with a stored token hash. */
const VERIFY_SQL = (hashHex: string, verifier: string) =>
  `select f.id as proof_id, f.kind, f.scopes, t.expires_at as token_expires_at, ia.app_id as issuing_app_id, ia.name as issuing_app_name, ` +
  `f.account_uuid, a.handle as account_handle, a.kind as account_kind, t.expires_at <= now() as token_expired, f.revoked_at is not null as family_revoked, ` +
  `f.expires_at <= now() as family_expired, ia.status <> 'active' as issuer_inactive, coalesce(not ('${verifier}' = any(f.audiences)), true) as not_audience, ` +
  `(f.kind = 'obo' and not coalesce(tf.id is not null and tf.revoked_at is null and tf.expires_at > now() and m.status = 'active' and a.status = 'active', false)) as grant_ended ` +
  `from proof_tokens t join proof_families f on f.id = t.family_id join apps ia on ia.app_id = f.issuing_app ` +
  `left join accounts a on a.uuid = f.account_uuid left join memberships m on m.app_id = f.issuing_app and m.account_uuid = f.account_uuid ` +
  `left join token_families tf on tf.id = f.subject_family_id where t.token_hash = '\\x${hashHex}'::bytea and t.kind = 'access'`;

/** One run of a gated measurement: the verifies, the control interleaved with them, and the gate's verdict. */
interface GatedRun {
  run: Run;
  /** Tries of this run set aside because the machine slept during them. */
  voided: Run[];
  verify: Stats;
  control: Stats;
  server: Stats | null;
  verdict: Verdict;
}

export const journeys: Journey[] = [
  {
    name: "proofs-perf-latency-verify",
    title: `verify latency over HTTP: 1000 sequential + 1000 from 50 concurrent callers, straight at accounts-api and through the site, each interleaved with a one-query control on the same callers; p50/p95/p99 next to accounts-api's own durations, the query's database time and the machine load; gate ${gateWords()}`,
    timeoutMs: 25 * 60_000,
    async run(ctx) {
      const { env, results } = ctx;
      const carbon = await signInToApp(ctx, "dm");
      const subject = (await appTokens(env, "dm", carbon.uuid)).access_token;
      const obo = (await issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: ["files.write"] })).body;
      const ata = (await issueAtaFor(ctx, "commit", "remind")).body;
      results.check("an OBO proof (dm → briefcase) and an ATA proof (commit → remind) to verify", obo.proof_token?.startsWith("sap_") === true && ata.proof_token?.startsWith("sap_") === true);

      const verifySend =
        (base: string, app: string | null, token: string): Send =>
        connection =>
          connection.send(`${base}/v1/proofs/verify`, "POST", { "content-type": "application/json", accept: "application/json", ...(app ? { authorization: basicAuth(app) } : {}) }, JSON.stringify({ proof_token: token }));
      const valid = (answer: Answer) => answer.status === 200 && (answer.body as { valid?: boolean } | null)?.valid === true;
      const invalid = (answer: Answer) => answer.status === 200 && isExactlyInvalid(answer.body);
      const status = (code: number) => (answer: Answer) => answer.status === code;
      const verifyKind = (base: string, app: string | null, token: string, ok: (answer: Answer) => boolean): Kind => ({ name: "verify", send: verifySend(base, app, token), ok });
      // The gate's yardstick: one primary-key lookup in the same pool, through the same path, answering 404 (a photo
      // id nobody has; If-None-Match keeps it to an `exists` probe that never reads photo bytes).
      const control = (base: string): Kind => {
        const id = randomUUID();
        return {
          name: "control",
          send: connection => connection.send(`${base}/v1/photos/${id}`, "GET", { accept: "application/json", "if-none-match": `"${id}"` }),
          ok: answer => answer.status === 404 && (answer.body as { error?: { code?: string } } | null)?.error?.code === "photo_not_found",
        };
      };

      const slotOwner = `${env.base} ${env.engine} proofs-perf-latency-verify`;
      await withBenchSlot(slotOwner, async slot => {
        results.metric("benchmark slot wait", slot.waitedMs);
        console.log(`        benchmark slot: ${slot.held ? "held" : "NOT held (it stayed taken)"} after ${(slot.waitedMs / 1000).toFixed(1)} s${slot.heldBy ? ` (held by ${slot.heldBy})` : ""}`);

        // Warm up both paths (connections, the app credential cache, the site's proxy).
        await measure("warm-up api", 100, 10, [verifyKind(env.api, "briefcase", obo.proof_token, valid), control(env.api)]);
        await measure("warm-up site", 100, 10, [verifyKind(env.site, "briefcase", obo.proof_token, valid), control(env.site)]);

        // For reading the numbers (never gated): what the HTTP stack costs without the database, and with one round trip.
        const informational = async (label: string, n: number, concurrency: number, kind: Kind) => {
          const { run: r, voided } = await measureAwake(ctx, label, n, concurrency, [kind]);
          const { s, server } = report(ctx, r, kind.name);
          results.metric(`${label} throughput`, throughput(r), "req/s");
          console.log(`        ${label}: ${describeStats(s)}; ${throughput(r).toFixed(0)} req/s${server ? `; accounts-api ${describeStats(server)}` : ""}; ${loadText(r)}`);
          return { r, s, server, kind: kind.name, voided };
        };
        const floor = await informational("control verify refused before the database (401) api, sequential", 1000, 1, verifyKind(env.api, null, obo.proof_token, status(401)));
        const floorConcurrent = await informational("control verify refused before the database (401) api, 50 concurrent", 1000, 50, verifyKind(env.api, null, obo.proof_token, status(401)));
        const readyz = (concurrency: number) => informational(`control GET /readyz (one database round trip) api, ${concurrency === 1 ? "sequential" : `${concurrency} concurrent`}`, 1000, concurrency, { name: "readyz", send: connection => connection.send(`${env.api}/readyz`, "GET", {}), ok: status(200) });
        const ready = await readyz(1);
        const readyConcurrent = await readyz(50);

        // The gated measurements. After a run on a busy machine, wait (up to E2E_BENCH_CALM_WAIT_MS in all, default 3
        // minutes) for the load to come down before the next run.
        let calmBudget = Number(process.env.E2E_BENCH_CALM_WAIT_MS ?? 180_000);
        const gated = async (label: string, n: number, concurrency: number, base: string) => {
          const runs: GatedRun[] = [];
          for (let attempt = 1; attempt <= LATENCY_GATE.attempts; attempt++) {
            const previous = runs[runs.length - 1];
            if (previous?.verdict.window === "busy" && calmBudget > 0) {
              const calm = await waitForCalm(calmBudget);
              calmBudget -= calm.waitedMs;
              results.metric(`${label}: wait for a calmer machine before run ${attempt}`, calm.waitedMs);
              console.log(`        waited ${(calm.waitedMs / 1000).toFixed(1)} s for a calmer machine before run ${attempt}: load ${calm.load} on ${calm.cores} cores${calm.calm ? "" : " (still busy)"}`);
            }
            const measured = await measureAwake(ctx, `${label}${attempt > 1 ? ` (run ${attempt})` : ""}`, n, concurrency, [verifyKind(base, "briefcase", obo.proof_token, valid), control(base)]);
            const r = measured.run;
            const { s: verify, server } = report(ctx, r, "verify");
            const { s: controlStats } = report(ctx, r, "control", `${r.label} one-query control`);
            const verdict = measured.frozen ? frozenVerdict(verify, controlStats, r.stallMs) : judge(verify, controlStats);
            results.metric(`${r.label} throughput (verifies and controls)`, throughput(r), "req/s");
            results.metric(`${r.label} verify/control p95 ratio`, verify.p95 / controlStats.p95, "x");
            results.metric(`${r.label} load avg (1 min) at start`, r.load.before, "load");
            console.log(`        ${r.label}: ${verdict.ok ? "PASS" : "fail"} (${verdict.window}) ${verdict.reason}; ${throughput(r).toFixed(0)} req/s${server ? `; accounts-api ${describeStats(server)}` : ""}; ${loadText(r)}`);
            runs.push({ run: r, voided: measured.voided, verify, control: controlStats, server, verdict });
            if (verdict.ok) break;
          }
          return { runs, decision: decide(runs.map(run => run.verdict)) };
        };
        const seq = await gated("verify OBO api, 1000 sequential", 1000, 1, env.api);
        const conc = await gated("verify OBO api, 1000 from 50 concurrent", 1000, 50, env.api);
        const siteSeq = await gated("verify OBO site, 1000 sequential", 1000, 1, env.site);
        const siteConc = await gated("verify OBO site, 1000 from 50 concurrent", 1000, 50, env.site);

        // More verdicts, timed but not gated: an ATA proof, an unknown token, and an app that is not an audience.
        const ataSeq = await informational("verify ATA api, 300 sequential", 300, 1, verifyKind(env.api, "remind", ata.proof_token, valid));
        const unknown = `sap_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
        const invalidSeq = await informational("verify unknown token api, 300 sequential", 300, 1, verifyKind(env.api, "briefcase", unknown, invalid));
        const nonAudience = await informational("verify non-audience api, 300 sequential", 300, 1, verifyKind(env.api, "remind", obo.proof_token, invalid));

        // The verify query in the database itself (EXPLAIN ANALYZE, 20 times): what is left of a verify once HTTP, the
        // connection pool and the machine's scheduling are taken away.
        const [[hash] = []] = await sql(env, `select encode(token_hash, 'hex') from proof_tokens where family_id = '${obo.proof_id}' and kind = 'access'`);
        const executions: number[] = [];
        const nodes = new Set<string>();
        const walk = (node: { "Node Type"?: string; "Relation Name"?: string; "Index Name"?: string; Plans?: unknown[] }) => {
          nodes.add(`${node["Node Type"]}${node["Relation Name"] ? ` ${node["Relation Name"]}` : ""}${node["Index Name"] ? ` (${node["Index Name"]})` : ""}`);
          for (const child of node.Plans ?? []) walk(child as typeof node);
        };
        for (let i = 0; i < 20 && hash; i++) {
          const out = (await sql(env, `explain (analyze, format json) ${VERIFY_SQL(hash, "briefcase")}`)).map(cells => cells.join("|")).join("\n");
          const parsed = JSON.parse(out) as Array<{ "Execution Time": number; Plan: Parameters<typeof walk>[0] }>;
          executions.push(parsed[0]!["Execution Time"]);
          if (i === 0) walk(parsed[0]!.Plan);
        }
        const db = stats(executions);
        results.metric("verify query execution in Postgres (EXPLAIN ANALYZE) p50", db.p50);
        results.metric("verify query execution in Postgres (EXPLAIN ANALYZE) max", db.max);
        console.log(`        verify query in Postgres: ${describeStats(db)}; plan: ${[...nodes].join(", ")}`);

        // Answers are judged in every run that was measured. A run frozen in every try (the machine slept through it)
        // is excused for requests that got no answer (cut at wake, or out of time while asleep), never for a wrong one.
        const gatedRuns = [seq, conc, siteSeq, siteConc].flatMap(m => m.runs);
        const verifies = [...gatedRuns.map(g => ({ run: g.run, sample: g.run.samples.get("verify")! })), ...[ataSeq, invalidSeq, nonAudience].map(m => ({ run: m.r, sample: m.r.samples.get(m.kind)! }))];
        const sent = (sample: Sample) => [...sample.statuses.values()].reduce((sum, count) => sum + count, 0);
        const unanswered = (sample: Sample) => [...sample.statuses].reduce((sum, [outcome, count]) => sum + (outcome.startsWith("error") ? count : 0), 0);
        const wrong = (run: Run, sample: Sample) => (run.stallMs >= FROZEN_STALL_MS ? sample.wrong - unanswered(sample) : sample.wrong);
        const excused = (run: Run, sample: Sample) => (run.stallMs >= FROZEN_STALL_MS && unanswered(sample) ? ` (${unanswered(sample)} unanswered while the machine slept)` : "");
        results.check(
          "every verify of the benchmark answered 200 with the right verdict (valid for the audience, exactly invalid otherwise)",
          verifies.every(v => wrong(v.run, v.sample) === 0 && v.sample.latencies.length > 0),
          verifies.map(v => `${v.run.label}: ${wrong(v.run, v.sample)} wrong of ${sent(v.sample)}${excused(v.run, v.sample)}`).join("; "),
        );
        const controls = gatedRuns.map(g => ({ run: g.run, sample: g.run.samples.get("control")! }));
        results.check(
          "every one-query control of the gated runs answered 404 photo_not_found (the yardstick the gate compares verify with)",
          controls.every(c => wrong(c.run, c.sample) === 0 && c.sample.latencies.length > 0),
          controls.map(c => `${c.run.label}: ${wrong(c.run, c.sample)} wrong, statuses ${JSON.stringify(Object.fromEntries(c.sample.statuses))}${excused(c.run, c.sample)}`).join("; "),
        );
        const voided = [...[seq, conc, siteSeq, siteConc].flatMap(m => m.runs.flatMap(g => g.voided)), ...[floor, floorConcurrent, ready, readyConcurrent, ataSeq, invalidSeq, nonAudience].flatMap(m => m.voided)];
        if (voided.length) console.log(`        ${voided.length} run(s) measured again because the machine slept during them: ${voided.map(r => `${r.label} ${frozenText(r)}`).join("; ")}`);

        // Most telling first (the report keeps 2000 characters): the deciding run's verdict, every run in short, then
        // the context (the other controls, the query's own time, the plan).
        const context =
          `controls: refused before the database p50/p95 ${floor.s.p50.toFixed(2)}/${floor.s.p95.toFixed(2)} ms sequential, ${floorConcurrent.s.p50.toFixed(2)}/${floorConcurrent.s.p95.toFixed(2)} ms at 50; ` +
          `GET /readyz ${ready.s.p50.toFixed(2)}/${ready.s.p95.toFixed(2)} ms sequential, ${readyConcurrent.s.p50.toFixed(2)}/${readyConcurrent.s.p95.toFixed(2)} ms at 50; ` +
          `verify query in Postgres p50 ${db.p50.toFixed(3)} ms (${[...nodes].join(", ")})`;
        const detail = (m: { runs: GatedRun[]; decision: { ok: boolean; index: number } }) => {
          const deciding = m.runs[m.decision.index];
          if (!deciding) return "no run";
          const r = deciding.run;
          const verifySample = r.samples.get("verify")!;
          return (
            `[${r.label}] ${deciding.verdict.reason}; p99 ${deciding.verify.p99.toFixed(2)} ms` +
            `${deciding.server ? `; accounts-api own time ${describeStats(deciding.server)}` : ""}; ${throughput(r).toFixed(0)} req/s; ` +
            `verify statuses ${JSON.stringify(Object.fromEntries(verifySample.statuses))}; ${loadText(r)} || runs: ` +
            m.runs.map(g => `${g.verdict.ok ? "pass" : "fail"} ${g.verdict.frozenMs !== undefined ? "frozen" : g.verdict.window}: verify ${g.verify.p50.toFixed(1)}/${g.verify.p95.toFixed(1)}, control ${g.control.p50.toFixed(1)}/${g.control.p95.toFixed(1)} ms p50/p95 (load ${g.run.load.before})${g.voided.length ? ` after ${g.voided.length} void (asleep ${g.voided.map(v => `${(v.stallMs / 1000).toFixed(1)} s`).join(", ")})` : ""}`).join(", ") +
            ` || ${context}`
          );
        };
        const gate = gateWords();
        results.check(`1000 sequential verifies straight at accounts-api: ${gate} (best of up to ${LATENCY_GATE.attempts} runs)`, seq.decision.ok, detail(seq));
        results.check(`1000 verifies from 50 concurrent callers straight at accounts-api: ${gate} (best of up to ${LATENCY_GATE.attempts} runs)`, conc.decision.ok, detail(conc));
        results.check(`1000 sequential verifies through the site (public origin): ${gate} (best of up to ${LATENCY_GATE.attempts} runs)`, siteSeq.decision.ok, detail(siteSeq));
        results.check(`1000 verifies from 50 concurrent callers through the site: ${gate} (best of up to ${LATENCY_GATE.attempts} runs)`, siteConc.decision.ok, detail(siteConc));
      });
    },
  },
  {
    name: "proofs-perf-latency-roundtrip",
    title: "round-trip timings: 50 OBO saves dm → briefcase and 50 rounds of ATA notifies commit → remind and commit → waveform at once (a proof per app) through the fake apps, and 50 whole OBO cycles of an app (issue, verify, refresh, verify, revoke, verify) step by step",
    timeoutMs: 12 * 60_000,
    async run(ctx) {
      const { env, results } = ctx;
      const carbon = await signInToApp(ctx, "dm");
      const N = 50;

      // OBO through the fake apps.
      const obo: Record<string, number[]> = { issue_ms: [], verify_ms: [], call_ms: [], total_ms: [] };
      let oboOk = 0;
      const oboLoad = machineLoad();
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const answer = await json<{ ok?: boolean; timings?: Record<string, number | null> }>(`${env.apps}/dm/actions/save-to-briefcase`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uuid: carbon.uuid, filename: `bench-${i}.txt` }) });
        (obo.client_ms ??= []).push(performance.now() - t0);
        if (answer.status === 200 && answer.body.ok === true) oboOk++;
        for (const key of Object.keys(obo)) if (typeof answer.body.timings?.[key] === "number") obo[key]!.push(answer.body.timings[key] as number);
      }
      for (const [key, values] of Object.entries(obo)) {
        const s = stats(values);
        results.metric(`OBO save via fake apps ${key} p50`, s.p50);
        results.metric(`OBO save via fake apps ${key} p95`, s.p95);
        results.metric(`OBO save via fake apps ${key} max`, s.max);
      }
      results.check(
        `${N} OBO saves dm → briefcase through the fake apps all succeeded (issued, verified, stored)`,
        oboOk === N,
        `${oboOk}/${N}; ${Object.entries(obo).map(([key, values]) => `${key} ${describeStats(stats(values))}`).join("; ")}; load ${oboLoad.load1} on ${oboLoad.cores} cores`,
      );

      // ATA through the fake apps: Commit talks to Remind and to Waveform at once, as an app notifying two apps would,
      // with a proof for each app (UNDERSTANDING.md: an ATA proof is always for exactly one app).
      type Notify = { ok?: boolean; proof?: { proof_id?: string }; timings?: { issue_ms?: number; total_ms?: number; verify_ms?: Record<string, number | null> } };
      const ataApps = ["remind", "waveform"] as const;
      const ata: Record<string, number[]> = { both_ms: [] };
      for (const app of ataApps) for (const key of ["issue_ms", "verify_ms", "total_ms"]) ata[`${app}_${key}`] = [];
      let ataOk = 0;
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const answers = await Promise.all(ataApps.map(app => json<Notify>(`${env.apps}/commit/actions/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ audiences: [app], message: `bench ${i}` }) })));
        ata.both_ms!.push(performance.now() - t0);
        if (answers.every((answer, k) => answer.status === 200 && answer.body.ok === true && namesOnly(answer.body.proof, ataApps[k]!)) && answers[0]!.body.proof?.proof_id !== answers[1]!.body.proof?.proof_id) ataOk++;
        answers.forEach((answer, k) => {
          const app = ataApps[k]!;
          const t = answer.body.timings;
          if (typeof t?.issue_ms === "number") ata[`${app}_issue_ms`]!.push(t.issue_ms);
          if (typeof t?.verify_ms?.[app] === "number") ata[`${app}_verify_ms`]!.push(t.verify_ms[app]!);
          if (typeof t?.total_ms === "number") ata[`${app}_total_ms`]!.push(t.total_ms);
        });
      }
      for (const [key, values] of Object.entries(ata)) {
        const s = stats(values);
        results.metric(`ATA notify via fake apps ${key} p50`, s.p50);
        results.metric(`ATA notify via fake apps ${key} p95`, s.p95);
      }
      results.check(
        `${N} rounds of ATA notifies through the fake apps, commit → remind and commit → waveform at once, each with a proof for that app alone, all succeeded`,
        ataOk === N,
        `${ataOk}/${N}; ${Object.entries(ata).map(([key, values]) => `${key} ${describeStats(stats(values))}`).join("; ")}`,
      );

      // An app's whole OBO cycle, step by step, straight at accounts-api (as an app server calls it).
      const subject = (await appTokens(env, "dm", carbon.uuid)).access_token;
      const steps: Record<string, number[]> = { issue: [], verify: [], refresh: [], verify_refreshed: [], revoke: [], verify_revoked: [], cycle: [] };
      let cycleOk = 0;
      const time = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
        const t0 = performance.now();
        const value = await action();
        steps[name]!.push(performance.now() - t0);
        return value;
      };
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const issued = await time("issue", () => issueObo(ctx, "dm", subject, { receiving_app: "briefcase", scopes: ["bench"], access_ttl_seconds: 300 }, { direct: true }));
        const v1 = await time("verify", () => verifyAs(ctx, "briefcase", issued.body.proof_token, { direct: true }));
        const refreshed = await time("refresh", () => refreshAs(ctx, "dm", issued.body.proof_refresh_token, {}, { direct: true }));
        const v2 = await time("verify_refreshed", () => verifyAs(ctx, "briefcase", refreshed.body.proof_token, { direct: true }));
        const revoked = await time("revoke", () => revokeAs(ctx, "dm", { proof_id: issued.body.proof_id }, { direct: true }));
        const v3 = await time("verify_revoked", () => verifyAs(ctx, "briefcase", refreshed.body.proof_token, { direct: true }));
        steps.cycle!.push(performance.now() - t0);
        if (issued.status === 201 && v1.body.valid === true && refreshed.status === 200 && v2.body.valid === true && revoked.status === 204 && isExactlyInvalid(v3.body)) cycleOk++;
      }
      for (const [name, values] of Object.entries(steps)) {
        const s = stats(values);
        results.metric(`OBO cycle ${name} p50`, s.p50);
        results.metric(`OBO cycle ${name} p95`, s.p95);
        results.metric(`OBO cycle ${name} max`, s.max);
      }
      const load = machineLoad();
      results.check(
        `${N} whole OBO cycles straight at accounts-api (issue 201, verify valid, refresh 200, verify valid, revoke 204, verify exactly invalid) all behaved`,
        cycleOk === N,
        `${cycleOk}/${N}; ${Object.entries(steps).map(([name, values]) => `${name} ${describeStats(stats(values))}`).join("; ")}; load ${load.load1} on ${load.cores} cores`,
      );
    },
  },
];

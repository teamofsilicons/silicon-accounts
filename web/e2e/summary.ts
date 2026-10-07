/**
 * Merges the reports of several e2e runs (scripts/e2e-all.sh: one isolated stack per suite and browser) into
 * e2e/.artifacts/summary.json and summary.md: pass or fail per run, journey and check, timings and metrics.
 *
 *   tsx e2e/summary.ts <runs.json> [out-dir]
 *
 * runs.json lists the runs: [{ "suite": "core", "engine": "chromium", "base": 9600, "exit_code": 0, "dir": "…" }];
 * each run's directory holds its run.log and the report.json its walk wrote (scripts/e2e-all.sh copies it there from
 * e2e/.artifacts/<base>/). A run without a report (its stack never came up, or it was stopped) counts as failed, with
 * the end of its log. Exit 1 when anything failed, 2 when the input is unusable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { E2E_DIR } from "./lib";


interface Run {
  suite: string;
  engine: string;
  base: number;
  exit_code: number;
  /** The run's directory: run.log, report.json, report.md, shots/, logs/. */
  dir: string;
  seconds?: number;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  at_ms: number;
}

interface JourneyReport {
  suite: string;
  name: string;
  title: string;
  file: string;
  status: "pass" | "fail" | "skipped";
  seconds: number;
  passed: number;
  failed: number;
  checks: Check[];
  problems: string[];
  metrics: Array<{ name: string; value: number; unit: string }>;
  error?: string;
  skipped_reason?: string;
  failure_shots?: string[];
}

interface Report {
  site: string;
  engine: string;
  base: number;
  started_at: string;
  finished_at: string;
  seconds: number;
  totals: { journeys: number; passed: number; failed: number; skipped: number; checks: number; failed_checks: number; problems: number };
  journeys: JourneyReport[];
}

const [runsFile, outArg] = process.argv.slice(2);
if (!runsFile) {
  console.error("error: which runs?\nhint: tsx e2e/summary.ts <runs.json> [out-dir]");
  process.exit(2);
}
const out = outArg ?? join(E2E_DIR, ".artifacts");
const runs = JSON.parse(readFileSync(runsFile, "utf8")) as Run[];

const tail = (path: string | undefined, lines = 25) => {
  if (!path || !existsSync(path)) return "";
  return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
};

const merged = runs.map(run => {
  const reportPath = join(run.dir, "report.json");
  const log = join(run.dir, "run.log");
  const report = existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, "utf8")) as Report) : null;
  const status = report && run.exit_code === 0 && report.totals.failed === 0 ? "pass" : "fail";
  return {
    suite: run.suite,
    engine: run.engine,
    base: run.base,
    status,
    exit_code: run.exit_code,
    seconds: run.seconds ?? report?.seconds ?? null,
    report: report ? relative(out, join(run.dir, "report.md")) : null,
    log: relative(out, log),
    ...(report ? {} : { error: `no report: the run stopped before the walk finished (exit ${run.exit_code})`, log_tail: tail(log) }),
    ...(report && run.exit_code !== 0 && report.totals.failed === 0 ? { error: `the run exited with ${run.exit_code} after a passing walk (see its log)`, log_tail: tail(log) } : {}),
    totals: report?.totals ?? null,
    walk_seconds: report?.seconds ?? null,
    journeys: (report?.journeys ?? []).map(journey => ({
      name: journey.name,
      suite: journey.suite,
      file: journey.file,
      status: journey.status,
      seconds: journey.seconds,
      passed: journey.passed,
      failed: journey.failed,
      problems: journey.problems,
      checks: journey.checks.map(check => ({ name: check.name, ok: check.ok, at_ms: check.at_ms, ...(check.ok ? {} : { detail: check.detail }) })),
      metrics: journey.metrics,
      ...(journey.error ? { error: journey.error } : {}),
      ...(journey.skipped_reason ? { skipped_reason: journey.skipped_reason } : {}),
      ...(journey.failure_shots ? { failure_shots: journey.failure_shots.map(shot => relative(out, join(run.dir, shot))) } : {}),
    })),
  };
});

const sum = (pick: (run: (typeof merged)[number]) => number) => merged.reduce((total, run) => total + pick(run), 0);
const totals = {
  runs: merged.length,
  runs_failed: merged.filter(run => run.status === "fail").length,
  journeys: sum(run => run.totals?.journeys ?? 0),
  journeys_failed: sum(run => run.totals?.failed ?? 0),
  journeys_skipped: sum(run => run.totals?.skipped ?? 0),
  checks: sum(run => run.totals?.checks ?? 0),
  checks_failed: sum(run => run.totals?.failed_checks ?? 0),
  problems: sum(run => run.totals?.problems ?? 0),
};
const summary = { generated_at: new Date().toISOString(), status: totals.runs_failed ? "fail" : "pass", totals, runs: merged };
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const lines: string[] = [];
lines.push(`# Silicon Accounts e2e summary: ${totals.runs_failed ? `${totals.runs_failed} of ${totals.runs} runs failed` : `all ${totals.runs} runs passed`}`, "");
lines.push(`${totals.journeys} journeys (${totals.journeys_failed} failed${totals.journeys_skipped ? `, ${totals.journeys_skipped} skipped` : ""}), ${totals.checks} checks (${totals.checks_failed} failed), ${totals.problems} browser problems. Generated ${summary.generated_at}.`, "");
lines.push("| | suite | browser | base | journeys | failed | checks | failed checks | problems | walk s | run s |", "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const run of merged) {
  const t = run.totals;
  lines.push(`| ${run.status === "pass" ? "pass" : "**FAIL**"} | ${run.suite} | ${run.engine} | ${run.base} | ${t?.journeys ?? "–"} | ${t?.failed ?? "–"} | ${t?.checks ?? "–"} | ${t?.failed_checks ?? "–"} | ${t?.problems ?? "–"} | ${run.walk_seconds ?? "–"} | ${run.seconds ?? "–"} |`);
}
lines.push("", "## Journeys", "", "| | run | journey | checks | failed | problems | seconds |", "| --- | --- | --- | ---: | ---: | ---: | ---: |");
for (const run of merged) {
  for (const journey of run.journeys) {
    lines.push(`| ${journey.status === "pass" ? "pass" : journey.status === "skipped" ? "skip" : "**FAIL**"} | ${run.suite} · ${run.engine} · ${run.base} | ${journey.suite}/${journey.name} | ${journey.passed + journey.failed} | ${journey.failed} | ${journey.problems.length} | ${journey.seconds} |`);
  }
}
const failing = merged.filter(run => run.status === "fail");
if (failing.length) {
  lines.push("", "## Failures");
  for (const run of failing) {
    lines.push("", `### ${run.suite} · ${run.engine} · base ${run.base}${run.log ? ` (log: ${run.log})` : ""}`);
    if ("error" in run && run.error) lines.push("", run.error);
    if ("log_tail" in run && run.log_tail) lines.push("", "```", run.log_tail, "```");
    for (const journey of run.journeys.filter(j => j.status === "fail")) {
      lines.push("", `- **${journey.suite}/${journey.name}** (${journey.file})${journey.error ? `: ${journey.error.split("\n")[0]}` : ""}`);
      for (const check of journey.checks.filter(c => !c.ok)) lines.push(`  - FAIL ${check.name}${"detail" in check && check.detail ? ` — ${String(check.detail).slice(0, 300)}` : ""}`);
      for (const problem of journey.problems) lines.push(`  - PROBLEM ${problem.slice(0, 300)}`);
      for (const shot of journey.failure_shots ?? []) lines.push(`  - screenshot: ${shot}`);
    }
  }
}
const metrics = merged.flatMap(run => run.journeys.flatMap(journey => journey.metrics.map(metric => ({ run: `${run.suite} · ${run.engine}`, journey: `${journey.suite}/${journey.name}`, ...metric }))));
if (metrics.length) {
  lines.push("", "## Metrics", "", "| run | journey | metric | value |", "| --- | --- | --- | ---: |");
  for (const metric of metrics) lines.push(`| ${metric.run} | ${metric.journey} | ${metric.name} | ${metric.value} ${metric.unit} |`);
}
writeFileSync(join(out, "summary.md"), `${lines.join("\n")}\n`);
console.log(`summary: ${relative(process.cwd(), join(out, "summary.md"))} (and summary.json): ${totals.runs_failed ? `${totals.runs_failed} of ${totals.runs} runs failed` : `all ${totals.runs} runs passed`}; ${totals.journeys} journeys, ${totals.checks} checks, ${totals.checks_failed} failed, ${totals.problems} browser problems`);
process.exit(totals.runs_failed ? 1 : 0);

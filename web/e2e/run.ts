/**
 * The browser end-to-end walk of Silicon Accounts: journeys in a real browser against a running stack (the site,
 * accounts-api behind it, the testkit's mocks and fake apps). README.md (this directory) is the guide.
 *
 *   scripts/e2e.sh [--suite <name>] [prefix…]   an isolated stack of its own (ports, database, build), this, teardown
 *   pnpm -C web e2e [options] [prefix…]         against a running stack (scripts/dev.sh's, or E2E_PORT_BASE / E2E_*)
 *
 *   --list                  every suite and journey, then exit (--list-suites: only the suites' names)
 *   --suite <name>          only this suite (repeat it, or comma-separate names); "core" is e2e/journeys
 *   --engine <name>         chromium (default, or E2E_ENGINE) or webkit
 *   prefix…                 only journeys whose name starts with one of these ("a-sign", "core/b", "silicons/")
 *
 * Journeys are found, not listed: every e2e/journeys/*.ts (the core suite) and e2e/suites/<suite>/*.ts file exports
 * `journey` or `journeys` (files whose name starts with "_" are helpers, never journeys). A selected journey brings
 * along the journeys that provide what it `needs`, which run first. The report lands in e2e/.artifacts/<base>/
 * (report.json, report.md, shots/), so runs against different stacks never overwrite each other.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Ctx, Journey, Shared } from "./context";
import { E2E_DIR, Results, envFromProcess, launch, randomIp, setRunEnv, type CheckResult, type Engine, type Metric } from "./lib";

interface Found {
  journey: Journey;
  suite: string;
  /** Relative to e2e/. */
  file: string;
  order: number;
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
  checks: CheckResult[];
  problems: string[];
  notes: number;
  metrics: Metric[];
  error?: string;
  skipped_reason?: string;
  /** Screenshots taken when it failed, relative to the artifacts directory. */
  failure_shots?: string[];
}

const CORE = "core";

function usage(problem: string): never {
  console.error(`error: ${problem}\nhint: pnpm -C web e2e [--list] [--suite <name>] [--engine chromium|webkit] [prefix…]  (e2e/README.md)`);
  process.exit(2);
}

/** Every journey file: e2e/journeys/*.ts (core), then e2e/suites/<suite>/*.ts, suites and files in name order. */
function journeyFiles(): Array<{ suite: string; path: string }> {
  const files: Array<{ suite: string; path: string }> = [];
  const add = (suite: string, dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".ts") || name.endsWith(".d.ts") || name.startsWith("_") || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isFile()) files.push({ suite, path });
    }
  };
  add(CORE, join(E2E_DIR, "journeys"));
  const suites = join(E2E_DIR, "suites");
  if (existsSync(suites)) {
    for (const suite of readdirSync(suites).sort()) {
      if (suite.startsWith(".") || suite.startsWith("_") || !statSync(join(suites, suite)).isDirectory()) continue;
      if (suite === CORE) usage(`e2e/suites/${CORE} would clash with the core suite (e2e/journeys); give the folder another name`);
      add(suite, join(suites, suite));
    }
  }
  return files;
}

function isJourney(value: unknown): value is Journey {
  const candidate = value as Partial<Journey> | null;
  return !!candidate && typeof candidate === "object" && typeof candidate.name === "string" && typeof candidate.title === "string" && typeof candidate.run === "function";
}

async function discover(): Promise<Found[]> {
  const found: Found[] = [];
  const byName = new Map<string, Found>();
  for (const { suite, path } of journeyFiles()) {
    const file = relative(E2E_DIR, path);
    const loaded = (await import(pathToFileURL(path).href)) as { journey?: unknown; journeys?: unknown };
    const exported = [...(loaded.journey !== undefined ? [loaded.journey] : []), ...(Array.isArray(loaded.journeys) ? loaded.journeys : loaded.journeys !== undefined ? [loaded.journeys] : [])];
    if (!exported.length) usage(`${file} exports neither \`journey\` nor \`journeys\` (helpers belong in files whose name starts with "_")`);
    for (const journey of exported) {
      if (!isJourney(journey)) usage(`${file} exports a journey without a name, a title and a run function`);
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(journey.name)) usage(`${file}: the journey name "${journey.name}" must be lowercase letters, digits, ".", "_" and "-"`);
      const clash = byName.get(journey.name);
      if (clash) usage(`two journeys are called "${journey.name}" (${clash.file} and ${file}); journey names are unique across every suite`);
      const entry = { journey, suite, file, order: found.length };
      byName.set(journey.name, entry);
      found.push(entry);
    }
  }
  return found;
}

/** The selection plus whatever provides what it needs (transitively), providers first, else in discovery order. */
function plan(all: Found[], selected: Found[]): Found[] {
  const provider = new Map<string, Found>();
  for (const entry of all) for (const key of entry.journey.provides ?? []) if (!provider.has(key)) provider.set(key, entry);
  const ordered: Found[] = [];
  const state = new Map<Found, "visiting" | "done">();
  const visit = (entry: Found, path: string[]) => {
    if (state.get(entry) === "done") return;
    if (state.get(entry) === "visiting") usage(`the journeys need each other in a circle: ${[...path, entry.journey.name].join(" → ")}`);
    state.set(entry, "visiting");
    for (const need of entry.journey.needs ?? []) {
      const from = provider.get(need);
      if (!from) usage(`${entry.journey.name} needs "${need}", which no journey provides (declare provides: ["${need}"] on the journey that hands it over)`);
      if (from !== entry) visit(from, [...path, entry.journey.name]);
    }
    state.set(entry, "done");
    ordered.push(entry);
  };
  for (const entry of [...selected].sort((a, b) => a.order - b.order)) visit(entry, []);
  return ordered;
}

function parseArgs(argv: string[]): { list: boolean; listSuites: boolean; suites: string[]; prefixes: string[]; engine?: Engine } {
  const suites: string[] = [];
  const prefixes: string[] = [];
  let list = false;
  let listSuites = false;
  let engine: Engine | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => inline ?? argv[++i] ?? usage(`${flag} needs a value`);
    if (flag === "--list") list = true;
    else if (flag === "--list-suites") listSuites = true;
    else if (flag === "--suite" || flag === "-s") suites.push(...value().split(",").map(name => name.trim()).filter(Boolean));
    else if (flag === "--engine") {
      const wanted = value();
      if (wanted !== "chromium" && wanted !== "webkit") usage(`--engine is chromium or webkit, not "${wanted}"`);
      engine = wanted;
    } else if (flag === "--webkit") engine = "webkit";
    else if (flag === "--chromium") engine = "chromium";
    else if (arg.startsWith("-")) usage(`unknown option ${arg}`);
    else prefixes.push(arg);
  }
  return { list, listSuites, suites, prefixes, engine };
}

const firstLines = (failure: unknown) => (failure instanceof Error ? failure.message.split("\n").slice(0, 8).join("\n") : String(failure));

function markdown(report: { site: string; engine: string; base: number; started_at: string; seconds: number; totals: Record<string, number>; journeys: JourneyReport[] }): string {
  const lines: string[] = [];
  const t = report.totals;
  lines.push(`# Silicon Accounts e2e: ${t.failed ? `${t.failed} of ${t.journeys} journeys failed` : `all ${t.journeys - t.skipped} journeys passed`}`, "");
  lines.push(`Site ${report.site} (${report.engine}), stack base ${report.base}, started ${report.started_at}, ${report.seconds} s. ${t.checks} checks, ${t.failed_checks} failed, ${t.problems} browser problems${t.skipped ? `, ${t.skipped} skipped` : ""}.`, "");
  lines.push("| | suite | journey | checks | failed | problems | seconds |", "| --- | --- | --- | ---: | ---: | ---: | ---: |");
  for (const j of report.journeys) lines.push(`| ${j.status === "pass" ? "pass" : j.status === "skipped" ? "skip" : "**FAIL**"} | ${j.suite} | ${j.name} | ${j.passed + j.failed} | ${j.failed} | ${j.problems.length} | ${j.seconds} |`);
  const failing = report.journeys.filter(j => j.status === "fail");
  if (failing.length) {
    lines.push("", "## Failures");
    for (const j of failing) {
      lines.push("", `### ${j.suite}/${j.name} (${j.file})`);
      if (j.error) lines.push("", "```", j.error, "```");
      for (const check of j.checks.filter(c => !c.ok)) lines.push(`- FAIL ${check.name}${check.detail ? ` — ${check.detail.slice(0, 300)}` : ""}`);
      for (const problem of j.problems) lines.push(`- PROBLEM ${problem.slice(0, 300)}`);
      for (const shot of j.failure_shots ?? []) lines.push(`- screenshot: ${shot}`);
    }
  }
  const skipped = report.journeys.filter(j => j.status === "skipped");
  if (skipped.length) {
    lines.push("", "## Skipped");
    for (const j of skipped) lines.push(`- ${j.suite}/${j.name}: ${j.skipped_reason}`);
  }
  const metrics = report.journeys.flatMap(j => j.metrics.map(m => ({ journey: `${j.suite}/${j.name}`, ...m })));
  if (metrics.length) {
    lines.push("", "## Metrics", "", "| journey | metric | value |", "| --- | --- | ---: |");
    for (const m of metrics) lines.push(`| ${m.journey} | ${m.name} | ${m.value} ${m.unit} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const all = await discover();
  const suites = [...new Set(all.map(entry => entry.suite))];
  if (args.listSuites) {
    for (const suite of suites) console.log(suite);
    process.exit(0);
  }
  if (args.list) {
    for (const suite of suites) {
      console.log(`${suite}${suite === CORE ? " (e2e/journeys)" : ` (e2e/suites/${suite})`}`);
      for (const entry of all.filter(e => e.suite === suite)) {
        const extra = [entry.journey.needs?.length ? `needs ${entry.journey.needs.join(", ")}` : "", entry.journey.engines ? `only ${entry.journey.engines.join(", ")}` : ""].filter(Boolean).join("; ");
        console.log(`  ${entry.journey.name.padEnd(24)} ${entry.journey.title}${extra ? `  [${extra}]` : ""}`);
      }
    }
    process.exit(0);
  }
  for (const suite of args.suites) if (!suites.includes(suite)) usage(`there is no suite "${suite}" (suites: ${suites.join(", ")})`);
  const matches = (entry: Found) => {
    if (args.suites.length && !args.suites.includes(entry.suite)) return false;
    if (!args.prefixes.length) return true;
    return args.prefixes.some(prefix => {
      const slash = prefix.indexOf("/");
      if (slash < 0) return entry.journey.name.startsWith(prefix);
      return entry.suite === prefix.slice(0, slash) && entry.journey.name.startsWith(prefix.slice(slash + 1));
    });
  };
  const selected = all.filter(matches);
  if (!selected.length) usage(`nothing matches ${[...args.suites.map(s => `--suite ${s}`), ...args.prefixes].join(" ") || "the selection"} (pnpm -C web e2e --list)`);
  const steps = plan(all, selected);

  const env = envFromProcess(args.engine);
  setRunEnv(env);
  const browser = await launch(env);
  const shared: Shared = {};
  const providerOf = new Map<string, string>();
  for (const entry of all) for (const key of entry.journey.provides ?? []) if (!providerOf.has(key)) providerOf.set(key, entry.journey.name);
  const timeoutDefault = Number(process.env.E2E_JOURNEY_TIMEOUT_MS ?? 600_000);
  const reports: JourneyReport[] = [];
  const startedAt = new Date();
  console.log(`Silicon Accounts e2e against ${env.site} (${env.engine}); fake apps ${env.apps}; ${steps.length} journeys${args.suites.length ? ` (suites ${args.suites.join(", ")})` : ""}`);

  for (const { journey, suite, file } of steps) {
    const results = new Results();
    results.journey = journey.name;
    const base: Omit<JourneyReport, "status" | "seconds" | "passed" | "failed"> = { suite, name: journey.name, title: journey.title, file, checks: results.checks, problems: results.problems, notes: 0, metrics: results.metrics };
    console.log(`\n######## ${suite}/${journey.name}: ${journey.title}`);
    if (journey.engines && !journey.engines.includes(env.engine)) {
      console.log(`  skip  only runs in ${journey.engines.join(", ")}`);
      reports.push({ ...base, status: "skipped", seconds: 0, passed: 0, failed: 0, skipped_reason: `only runs in ${journey.engines.join(", ")}` });
      continue;
    }
    const missing = (journey.needs ?? []).filter(key => shared[key] === undefined);
    const started = Date.now();
    results.started = started;
    let error: string | undefined;
    if (missing.length) {
      error = `needs ${missing.map(key => `"${key}" (from ${providerOf.get(key) ?? "no journey"})`).join(", ")}, which was not handed over: that journey failed first`;
      console.log(`  FAIL  ${error}`);
    } else {
      const ctx: Ctx = { env, results, browser, shared, suite, ip: randomIp() };
      const timeoutMs = journey.timeoutMs ?? timeoutDefault;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          journey.run(ctx),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`the journey did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
          }),
        ]);
      } catch (failure) {
        error = firstLines(failure);
        console.log(`  FAIL  the journey stopped: ${error}`);
      } finally {
        clearTimeout(timer);
      }
    }
    const failedChecks = results.checks.filter(check => !check.ok).length;
    const failed = failedChecks + (error ? 1 : 0);
    const report: JourneyReport = {
      ...base,
      status: failed || results.problems.length ? "fail" : "pass",
      seconds: Math.round((Date.now() - started) / 100) / 10,
      passed: results.checks.filter(check => check.ok).length,
      failed,
      notes: results.notes.length,
      ...(error ? { error } : {}),
    };
    // What the pages looked like when it failed (journeys close their contexts as they finish; a failure leaves them).
    if (report.status === "fail") {
      const shots: string[] = [];
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          const path = join(env.shots, `FAILED-${journey.name}-${shots.length + 1}.png`);
          if (await page.screenshot({ path }).then(() => true, () => false)) shots.push(relative(env.artifacts, path));
        }
      }
      if (shots.length) report.failure_shots = shots;
    }
    // Contexts a failed journey left open would keep its pages (and their polling) alive under the next journey.
    for (const context of browser.contexts()) await context.close().catch(() => undefined);
    for (const problem of results.problems) console.log(`  PROBLEM  ${problem.slice(0, 400)}`);
    reports.push(report);
  }
  await browser.close();

  const count = (status: JourneyReport["status"]) => reports.filter(entry => entry.status === status).length;
  const totals = {
    journeys: reports.length,
    passed: count("pass"),
    failed: count("fail"),
    skipped: count("skipped"),
    checks: reports.reduce((sum, entry) => sum + entry.passed + entry.failed, 0),
    failed_checks: reports.reduce((sum, entry) => sum + entry.failed, 0),
    problems: reports.reduce((sum, entry) => sum + entry.problems.length, 0),
  };
  console.log("\n######## summary");
  for (const entry of reports) {
    const mark = entry.status === "pass" ? "pass" : entry.status === "skipped" ? "skip" : "FAIL";
    console.log(`  ${mark}  ${`${entry.suite}/${entry.name}`.padEnd(30)} ${String(entry.passed + entry.failed).padStart(3)} checks${entry.failed ? `, ${entry.failed} failed` : ""}${entry.problems.length ? `, ${entry.problems.length} browser problems` : ""}  ${entry.seconds} s`);
  }
  console.log(totals.failed ? `\n${totals.failed} of ${totals.journeys} journeys failed` : `\nall ${totals.passed} journeys passed (${totals.checks} checks)${totals.skipped ? `, ${totals.skipped} skipped` : ""}`);
  const finishedAt = new Date();
  const report = {
    version: 1,
    site: env.site,
    engine: env.engine,
    base: env.base,
    suites: [...new Set(steps.map(step => step.suite))],
    selection: process.argv.slice(2),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    seconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 100) / 10,
    totals,
    journeys: reports,
  };
  mkdirSync(env.artifacts, { recursive: true });
  writeFileSync(join(env.artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(env.artifacts, "report.md"), markdown(report));
  console.log(`report: ${relative(process.cwd(), join(env.artifacts, "report.md"))} (and report.json)`);
  process.exit(totals.failed ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

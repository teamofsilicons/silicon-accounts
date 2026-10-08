import type { Journey } from "../../context";
import { forgetRateLimits, tag } from "../../lib";
import { PANIC, accounts, accountsIntoClosedPipe, asCarbon, freshDir, loginSilicon, said, short, signUpCarbon, type PipedRun } from "./_helpers";

interface Case {
  /** The kind of output it writes (one check per kind). */
  group: string;
  label: string;
  args: string[];
  /** The exit code the command has with a reader (also accepted: 141, ended by SIGPIPE). */
  exit: number;
  home?: string;
  url?: string | null;
  stdin?: string;
}

/** Ended quietly: the exit code it has anyway (or 141, SIGPIPE), and no panic on stderr. */
const quiet = (run: PipedRun, exit: number) => !run.timedOut && (run.code === exit || run.code === 141) && !PANIC.test(run.stderr);

const told = (run: PipedRun) => `exit ${run.code}${run.timedOut ? " (killed: timed out)" : ""} in ${run.ms} ms; stderr ${short(run.stderr.trim() || "(empty)", 260)}`;

export const journey: Journey = {
  name: "silicons-cli-epipe",
  title: "a reader that goes away (EPIPE): when what reads the CLI's output is gone (`accounts … | head -c 1`, a closed pipe), every kind of output — the help tree, docs, results and errors in text and JSON, network answers — ends quietly with the exit code it has anyway (or SIGPIPE's), never a Rust panic; what the command did still stands",
  // No browser: the CLI and the API only, so the engine changes nothing (the browser journeys run in WebKit too).
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const out = freshDir();
    const carbon = await signUpCarbon(env, "epipe");
    const sid = `si:epipe-${t}`;
    const stk = `stk-e9${"1fe".repeat(4)}0`;
    const made = await asCarbon(env, carbon, "POST", "/v1/me/silicons", { id: sid, display_name: `Epipe ${t}`, stk });
    const signedIn = freshDir();
    const login = await loginSilicon(env, signedIn, sid, stk);
    results.check("setup: a Silicon (made by its custodian) signed in to a CLI home", made.status === 201 && login.code === 0, `${made.status} ${said(login)}`);

    // 1. stdout is a pipe whose reader has gone before the CLI writes: its first write fails with EPIPE.
    const cases: Case[] = [
      { group: "the help tree and the bundled docs (text and JSON)", label: "`silicon-accounts` (the whole tree as text, 19 KB)", args: [], exit: 0, url: null },
      { group: "the help tree and the bundled docs (text and JSON)", label: "`silicon-accounts --json` (the tree as JSON)", args: ["--json"], exit: 0, url: null },
      { group: "the help tree and the bundled docs (text and JSON)", label: "`silicon-accounts help --json`", args: ["help", "--json"], exit: 0, url: null },
      { group: "clap's own --help and --version", label: "`silicon-accounts --help`", args: ["--help"], exit: 0, url: null },
      { group: "clap's own --help and --version", label: "`silicon-accounts --version`", args: ["--version"], exit: 0, url: null },
      { group: "the help tree and the bundled docs (text and JSON)", label: "`silicon-accounts docs silicons` (a bundled guide)", args: ["docs", "silicons"], exit: 0, url: null },
      { group: "the help tree and the bundled docs (text and JSON)", label: "`silicon-accounts docs silicons --json`", args: ["docs", "silicons", "--json"], exit: 0, url: null },
      { group: "errors written to stdout as JSON", label: "`accounts frobnicate --json` (an argument error as JSON)", args: ["frobnicate", "--json"], exit: 2, url: null },
      { group: "errors written to stdout as JSON", label: "`silicon-accounts whoami --json` signed out (a CLI error as JSON)", args: ["whoami", "--json"], exit: 3, home: out },
      { group: "`login status` signed out (JSON and text, exit 1)", label: "`silicon-accounts login status --json` signed out", args: ["login", "status", "--json"], exit: 1, home: out },
      { group: "`login status` signed out (JSON and text, exit 1)", label: "`silicon-accounts login status` signed out (text)", args: ["login", "status"], exit: 1, home: out },
      { group: "answers from the service (JSON and text)", label: "`silicon-accounts id available <si:id> --json` (an answer from the service)", args: ["id", "available", `si:epipe-free-${t}`, "--json"], exit: 0, home: out },
      { group: "answers from the service (JSON and text)", label: "`silicon-accounts login status --json` signed in (checked with the service)", args: ["login", "status", "--json"], exit: 0, home: signedIn },
      { group: "answers from the service (JSON and text)", label: "`silicon-accounts whoami` signed in (text)", args: ["whoami"], exit: 0, home: signedIn },
    ];
    const runs: Array<Case & { run: PipedRun }> = [];
    for (const entry of cases) {
      const run = await accountsIntoClosedPipe(env, entry.args, { home: entry.home ?? freshDir(), url: entry.url === undefined ? env.site : entry.url, stdin: entry.stdin });
      runs.push({ ...entry, run });
    }
    // One check per kind of output, naming every command of it that did not end quietly.
    for (const group of [...new Set(cases.map(entry => entry.group))]) {
      const members = runs.filter(entry => entry.group === group);
      const loud = members.filter(entry => !quiet(entry.run, entry.exit));
      results.check(
        `stdout closed before the CLI writes, ${group}: ${members.map(entry => entry.label.replace(/ \(.*\)$/, "")).join(", ")} end quietly (their own exit code or 141, no panic)`,
        loud.length === 0,
        loud.length ? `${loud.length} of ${members.length} did not: ${short(loud.map(entry => `${entry.label} → ${told(entry.run)}`), 1400)}` : members.map(entry => `${entry.label}: exit ${entry.run.code}`).join("; "),
      );
    }
    const panicked = runs.filter(({ run }) => PANIC.test(run.stderr));
    results.metric("commands writing into a closed pipe", runs.length, "count");
    results.metric("…that panicked", panicked.length, "count");

    // 2. What it did still stands: a sign-in whose answer nobody read is saved all the same.
    const home = freshDir();
    const blind = await accountsIntoClosedPipe(env, ["login", "--silicon", sid, "--stk-stdin", "--json"], { home, stdin: `${stk}\n` });
    const after = await accounts(env, ["login", "status", "--json"], { home });
    results.check("`silicon-accounts login --silicon … --json` into a closed pipe: no panic, and the sign-in it made is kept (`login status` afterwards: authenticated as the Silicon)", quiet(blind, 0) && after.code === 0 && after.json?.authenticated === true && after.json?.id === sid, `${told(blind)} | ${said(after)}`);
    const slt = await accountsIntoClosedPipe(env, ["login", "--app", "remind", "--json"], { home: signedIn });
    results.check("`silicon-accounts login --app remind --json` into a closed pipe: no panic (the token is simply not delivered)", quiet(slt, 0), told(slt));

    // 3. A reader that takes one byte and goes (`| head -c 1`): the usual shape of the problem.
    for (const args of [[], ["--json"], ["docs", "apps"]]) {
      const run = await accountsIntoClosedPipe(env, args, { home: freshDir(), url: null, reader: "head" });
      results.check(`\`accounts ${args.join(" ")}\` | head -c 1: ends quietly (exit 0 or 141, no panic)`.replace("`accounts ` |", "`silicon-accounts` |"), quiet(run, 0), told(run));
    }

    // 4. stderr into the closed pipe too (stdout to /dev/null): what goes to stderr (an error, the next steps) is dropped, the exit code stays.
    const stderrGone = [
      { args: ["frobnicate"], exit: 2, url: null as string | null },
      { args: ["login", "status"], exit: 1, url: env.site as string | null },
    ];
    for (const entry of stderrGone) {
      const run = await accountsIntoClosedPipe(env, entry.args, { home: out, url: entry.url, stderr: "gone" });
      results.check(`\`accounts ${entry.args.join(" ")}\` with stderr into a closed pipe: exit ${entry.exit} all the same`, !run.timedOut && run.code === entry.exit, told(run));
    }
  },
};

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { forgetRateLimits, tag } from "../../lib";
import { accounts, asCarbon, cliError, freshDir, said, signUpCarbon, str, type Json } from "./_helpers";

const modeOf = (path: string) => {
  try {
    return (statSync(path).mode & 0o777).toString(8);
  } catch {
    return "missing";
  }
};

export const journey: Journey = {
  name: "silicons-cli-config-home",
  title: "`accounts config home <dir>`: refuses a file or a missing path with 'not a directory', points the CLI's state at a directory (pointer in SILICON_HOME or ~), which then holds the session; --home and ACCOUNTS_HOME win; a home that disappears or SILICON_HOME/--home/ACCOUNTS_HOME that are not directories say so precisely",
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const base = realpathSync(freshDir("sa-e2e-scli-base-"));
    const env1 = { SILICON_HOME: base };
    const run = (args: string[], options: { env?: Record<string, string | undefined>; home?: string | null; stdin?: string } = {}) =>
      accounts(env, args, { home: options.home ?? null, env: { ...env1, ...options.env }, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });

    // 1. The default: SILICON_HOME when set.
    const shown = await run(["config", "home", "--json"]);
    results.check("`accounts config home --json` with SILICON_HOME set: that directory, from SILICON_HOME", shown.code === 0 && shown.json?.home === base && shown.json?.source === "env:SILICON_HOME" && shown.json?.state_dir === join(base, ".accounts"), said(shown));

    // 2. Not a directory: a file, a missing path.
    const file = join(base, `notes-${t}.txt`);
    writeFileSync(file, "not a directory\n");
    const onFile = await run(["config", "home", file, "--json"]);
    results.check("a file: exit 2, not_a_directory, 'not a directory: <path> (it is a file)'", onFile.code === 2 && cliError(onFile).code === "not_a_directory" && cliError(onFile).message === `not a directory: ${file} (it is a file)`, said(onFile));
    const onFileText = await run(["config", "home", file]);
    results.check("…in text mode the same on stderr ('error: not a directory: …') with a hint", onFileText.code === 2 && onFileText.stderr.includes(`error: not a directory: ${file} (it is a file)`) && onFileText.stderr.includes("hint:") && onFileText.stdout.trim() === "", said(onFileText));
    const missing = join(base, `missing-${t}`, "deeper");
    const onMissing = await run(["config", "home", missing, "--json"]);
    results.check("a path that doesn't exist: exit 2, not_a_directory '(it does not exist)', hint: mkdir -p", onMissing.code === 2 && cliError(onMissing).message === `not a directory: ${missing} (it does not exist)` && str(cliError(onMissing).hint).includes(`mkdir -p ${missing}`), said(onMissing));
    results.check("…and nothing was configured", !existsSync(join(base, ".accounts", "home")), "");

    // 3. A directory: the pointer is written; the state goes there.
    const dir = realpathSync(freshDir("sa-e2e-scli-configured-"));
    const set = await run(["config", "home", dir, "--json"]);
    const pointer = join(base, ".accounts", "home");
    results.check("a directory: configured, the pointer kept in SILICON_HOME/.accounts/home (mode 600)", set.code === 0 && set.json?.configured === true && set.json?.home === dir && set.json?.pointer === pointer && readFileSync(pointer, "utf8").trim() === dir && modeOf(pointer) === "600", said(set));
    const now = await run(["config", "home", "--json"]);
    results.check("`accounts config home` now names it, from the config", now.json?.home === dir && now.json?.source === "config", said(now));
    const got = await run(["config", "get", "home", "--json"]);
    results.check("`accounts config get home --json` agrees", got.code === 0 && got.json?.value === dir && got.json?.source === "config", said(got));
    const carbon = await signUpCarbon(env, "homes");
    const stk = `stk-40be${"0".repeat(8)}`;
    await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: `si:homed-${t}`, display_name: "Homed", stk });
    const login = await run(["login", "--silicon", `si:homed-${t}`, "--stk-stdin", "--json"], { stdin: `${stk}\n` });
    results.check("a sign-in without --home lands in the configured home (session.json 600 inside a 700 .accounts)", login.code === 0 && existsSync(join(dir, ".accounts", "session.json")) && modeOf(join(dir, ".accounts", "session.json")) === "600" && modeOf(join(dir, ".accounts")) === "700" && !existsSync(join(base, ".accounts", "session.json")), said(login));
    const status = await run(["login", "status", "--json"]);
    results.check("…and later commands find it there", status.code === 0 && status.json?.id === `si:homed-${t}`, said(status));

    // 4. --home and ACCOUNTS_HOME win over the configured home.
    const other = realpathSync(freshDir("sa-e2e-scli-other-"));
    const flag = await run(["login", "status", "--json"], { home: other });
    const flagHome = await run(["config", "home", "--json"], { home: other });
    results.check("--home wins: nobody is signed in there; config home says flag", flag.code === 1 && flagHome.json?.home === other && flagHome.json?.source === "flag", `${said(flag)} | ${said(flagHome)}`);
    const viaEnv = await run(["config", "home", "--json"], { env: { ACCOUNTS_HOME: other } });
    results.check("ACCOUNTS_HOME wins over the configured home", viaEnv.json?.home === other && viaEnv.json?.source === "env:ACCOUNTS_HOME", said(viaEnv));
    const notice = await run(["config", "home", dir], { env: { ACCOUNTS_HOME: other } });
    results.check("…setting the home while ACCOUNTS_HOME is set says that it still takes precedence", notice.code === 0 && notice.stderr.includes("ACCOUNTS_HOME is set and takes precedence"), said(notice));

    // 5. The configured directory disappears: every command says so, and --reset recovers.
    rmSync(dir, { recursive: true, force: true });
    const gone = await run(["login", "status", "--json"]);
    results.check("the configured home was deleted: commands fail with exit 2, not_a_directory, naming `accounts config home` and --reset", gone.code === 2 && cliError(gone).code === "not_a_directory" && str(cliError(gone).message).includes("does not exist; set by `accounts config home`") && str(cliError(gone).hint).includes("--reset"), said(gone));
    const reset = await run(["config", "home", "--reset", "--json"]);
    const back = await run(["config", "home", "--json"]);
    results.check("`accounts config home --reset`: back to SILICON_HOME", reset.code === 0 && reset.json?.configured === false && back.json?.home === base && back.json?.source === "env:SILICON_HOME" && !existsSync(pointer), `${said(reset)} | ${said(back)}`);

    // 6. SILICON_HOME, --home and ACCOUNTS_HOME that are not directories.
    const silFile = await accounts(env, ["login", "status", "--json"], { home: null, env: { SILICON_HOME: file } });
    results.check("SILICON_HOME is a file: exit 2, not a directory (it is a file; set by SILICON_HOME)", silFile.code === 2 && str(cliError(silFile).message) === `not a directory: ${file} (it is a file; set by SILICON_HOME)`, said(silFile));
    const homeFile = await accounts(env, ["login", "status", "--json"], { home: file });
    results.check("--home is a file: exit 2, not a directory (set by --home)", homeFile.code === 2 && str(cliError(homeFile).message).endsWith("(it is a file; set by --home)"), said(homeFile));
    const envMissing = await accounts(env, ["login", "status", "--json"], { home: null, env: { ACCOUNTS_HOME: missing } });
    results.check("ACCOUNTS_HOME doesn't exist: exit 2, not a directory (it does not exist; set by ACCOUNTS_HOME)", envMissing.code === 2 && str(cliError(envMissing).message) === `not a directory: ${missing} (it does not exist; set by ACCOUNTS_HOME)`, said(envMissing));

    // 7. Without SILICON_HOME the base is ~ (HOME), and the pointer lives there.
    const user = realpathSync(freshDir("sa-e2e-scli-tilde-"));
    const tilde = await accounts(env, ["config", "home", "--json"], { home: null, env: { HOME: user, SILICON_HOME: undefined } });
    results.check("without SILICON_HOME the home is ~ (source default)", tilde.json?.home === user && tilde.json?.source === "default", said(tilde));
    const target = join(user, "agents", "scout");
    mkdirSync(target, { recursive: true });
    const tildeSet = await accounts(env, ["config", "home", target, "--json"], { home: null, env: { HOME: user, SILICON_HOME: undefined } });
    results.check("…and `accounts config home` keeps its pointer in ~/.accounts/home", tildeSet.code === 0 && readFileSync(join(user, ".accounts", "home"), "utf8").trim() === realpathSync(target), said(tildeSet));
  },
};

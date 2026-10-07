import type { Journey } from "../../context";
import { forgetRateLimits, tag } from "../../lib";
import { accounts, appSecret, asCarbon, freshDir, loginCarbon, loginSilicon, obj, pool, short, signUpCarbon, str, type Json, type Run } from "./_helpers";

const pathOf = (command: string) => command.replace(/^accounts /, "").split(" ").filter(word => word && !/^[<[]/.test(word));
const UUID = "01a11111-1111-7111-8111-111111111111";

/** What a --json run must look like: one JSON document on stdout, JSON lines only on stderr, the exit code matching. */
function judge(run: Run, okExits: number[] = [0]): string | null {
  if (run.timedOut) return "timed out";
  if (!run.json) return `stdout is not one JSON document: ${short(run.stdout, 120)}`;
  if (/\u001b\[/.test(run.stdout)) return "ANSI escapes in stdout";
  const stray = run.stderr.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("{"));
  if (stray.length) return `non-JSON stderr: ${short(stray[0], 120)}`;
  const error = obj(run.json.error);
  if (run.json.error !== undefined) {
    if (!str(error.code) || !str(error.message)) return `error without code/message: ${short(error)}`;
    if (error.exit_code !== run.code) return `error.exit_code ${String(error.exit_code)} but the process exited ${run.code}`;
    if (run.code === 0) return "an error with exit 0";
    return null;
  }
  return okExits.includes(run.code ?? -1) ? null : `a result with exit ${run.code}`;
}

export const journey: Journey = {
  name: "silicons-cli-json",
  title: "--json on every command: signed out, as a Carbon, as a Silicon and as an app, every command prints exactly one JSON document on stdout (results or {\"error\":{code,message,exit_code}}), only JSON lines on stderr, and an exit code that matches",
  // No browser: the CLI and the API only, so the engine changes nothing (the browser journeys run in WebKit too).
  engines: ["chromium"],
  timeoutMs: 8 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const SI = `si:json-${t}`;
    const ARGS: Record<string, string[]> = {
      login: ["--silicon", SI, "--stk", "stk-000000000000"],
      "id available": [SI],
      "id change": [`c:json-${t}`],
      lookup: [SI],
      "profile set": ["--display-name", "Json"],
      "email add": ["json@example.test"],
      "email verify": [UUID, "123456"],
      "email primary": ["json@example.test"],
      "email remove": ["json@example.test"],
      "phone add": ["+15005550006"],
      "phone verify": [UUID, "123456"],
      "phone primary": ["+15005550006"],
      "phone remove": ["+15005550006"],
      "identities remove": ["google", "123"],
      "apps remove": ["remind"],
      "proofs revoke": [UUID],
      "sessions revoke": [UUID],
      "silicon create": ["--id", SI],
      "silicon show": [SI],
      "silicon update": [SI, "--display-name", "x"],
      "silicon id": [SI, `${SI}-2`],
      "silicon rotate-stk": [SI],
      "silicon webhook set": [SI, "https://example.test/hook"],
      "silicon webhook remove": [SI],
      "silicon transfer": [SI, "--to", "c:nobody"],
      "silicon cancel-transfer": [SI],
      "silicon delete": [SI, "--confirm", SI],
      "silicon request status": [UUID],
      "webhook set": ["https://example.test/hook"],
      "custodian accept": [UUID],
      "custodian decline": [UUID],
      "device show": ["ABCD-EFGH"],
      "device approve": ["ABCD-EFGH"],
      "device deny": ["ABCD-EFGH"],
      "app use": ["remind"],
      "app new": ["--no-browser"],
      "app config set": ["/nonexistent/patch.json"],
      "app user": ["abc"],
      "app import": ["/nonexistent/users.csv"],
      "app import status": [UUID],
      "app import rows": [UUID],
      "app token exchange": ["--code", "sac_x", "--redirect-uri", "https://example.test/cb"],
      "app token slt": ["slt_x"],
      "app token refresh": ["x"],
      "app token introspect": ["x"],
      "app token revoke": ["x"],
      "app token verify": ["x"],
      "app userinfo": ["x"],
      "app proof obo": ["--subject-token", "x", "--to", "briefcase"],
      "app proof ata": ["--to", "remind"],
      "app proof verify": ["sap_x"],
      "app proof refresh": ["sapr_x"],
      "app proof revoke": [UUID],
      "app webhook set": ["https://example.test/hook"],
      "app webhook delivery": [UUID],
      "app webhook replay": [UUID],
      "app lookup": [SI],
      "config set": ["telemetry", "on"],
      "config unset": ["telemetry"],
      "config telemetry": ["on"],
      // An http PR link is refused before anything is sent, so the sweep never emails the maintainers.
      report: ["json sweep", "--pr", "http://insecure.example/pr"],
      "delete-account": ["--confirm", "c:nobody"],
    };

    // The commands: every leaf of the tree, plus the two groups that also run on their own.
    const tree = await accounts(env, ["--json"], { home: freshDir(), url: null });
    const paths = ((tree.json?.commands ?? []) as Json[]).map(entry => pathOf(str(entry.command)));
    const under = (parent: string[], child: string[]) => child.length > parent.length && parent.every((word, i) => child[i] === word);
    const groups = paths.filter(path => paths.some(other => under(path, other)));
    const runnable = paths.filter(path => !groups.includes(path) || ["login", "app import"].includes(path.join(" ")));
    results.check("the sweep covers every runnable command of the tree", runnable.length >= 85, `${runnable.length} commands, ${groups.length} groups`);

    // 1. Signed out, each in a fresh home.
    const outRuns = await pool(runnable, 6, async path => ({ path: path.join(" "), run: await accounts(env, [...path, ...(ARGS[path.join(" ")] ?? []), "--json"], { home: freshDir(), timeoutMs: 60_000 }) }));
    const outBad = outRuns.map(({ path, run }) => ({ path, problem: judge(run, path === "login status" ? [1] : [0]) })).filter(entry => entry.problem);
    results.check(`signed out: all ${outRuns.length} commands answer with one JSON document, JSON-only stderr and a matching exit code`, outBad.length === 0, short(outBad.map(entry => `${entry.path}: ${entry.problem}`), 1200));
    const errors = outRuns.filter(({ run }) => run.json?.error !== undefined).length;
    results.metric("signed-out sweep: commands", outRuns.length, "count");
    results.metric("signed-out sweep: JSON errors", errors, "count");
    const notSignedIn = outRuns.filter(({ path }) => ["whoami", "history", "silicon list", "custodian requests", "sessions list"].includes(path));
    results.check("…commands that need a session say not_signed_in with exit 3", notSignedIn.length === 5 && notSignedIn.every(({ run }) => obj(run.json?.error).code === "not_signed_in" && run.code === 3), short(notSignedIn.map(({ path, run }) => [path, obj(run.json?.error).code, run.code])));

    // 2. A group without its subcommand, with --json.
    const bareGroups = await pool(["silicon", "app", "config", "custodian"], 4, async group => ({ group, run: await accounts(env, [group, "--json"], { home: freshDir(), url: null }) }));
    const groupBad = bareGroups.filter(({ run }) => !run.json || run.code !== 2);
    results.check("a group without its subcommand under --json still answers in JSON (exit 2)", groupBad.length === 0, short(groupBad.map(({ group, run }) => `${group}: exit ${run.code}, stdout ${short(run.stdout, 40)}, stderr ${short(run.stderr, 60)}`), 600));

    // 3. Signed in as a Carbon.
    const carbon = await signUpCarbon(env, "json");
    const homeC = freshDir();
    await loginCarbon(env, homeC, carbon);
    const carbonCommands = [["whoami"], ["profile", "show"], ["email", "list"], ["phone", "list"], ["identities", "list"], ["apps", "list"], ["proofs", "list"], ["sessions", "list"], ["history"], ["silicon", "list"], ["custodian", "requests"], ["app", "list"], ["login", "status"], ["config", "get"], ["config", "home"], ["id", "available", SI], ["lookup", carbon.uuid], ["docs"], ["help"]];
    const carbonRuns = await pool(carbonCommands, 4, async args => ({ path: args.join(" "), run: await accounts(env, [...args, "--json"], { home: homeC }) }));
    const carbonBad = carbonRuns.map(({ path, run }) => ({ path, problem: judge(run) ?? (run.json?.error ? `error ${short(run.json.error)}` : null) })).filter(entry => entry.problem);
    results.check(`as a Carbon: ${carbonRuns.length} read commands succeed with JSON`, carbonBad.length === 0, short(carbonBad.map(entry => `${entry.path}: ${entry.problem}`), 1200));

    // 4. Signed in as a Silicon: its commands, and Carbon-only ones refused in JSON.
    const stk = `stk-15${"0".repeat(10)}`;
    await asCarbon<Json>(env, carbon, "POST", "/v1/me/silicons", { id: SI, display_name: "Json", stk });
    const homeS = freshDir();
    await loginSilicon(env, homeS, SI, stk);
    const siliconCommands = [["whoami"], ["profile", "show"], ["apps", "list"], ["sessions", "list"], ["history"], ["login", "status"], ["webhook", "test"], ["silicon", "list"], ["custodian", "requests"], ["device", "show", "ABCD-EFGH"]];
    const siliconRuns = await pool(siliconCommands, 4, async args => ({ path: args.join(" "), run: await accounts(env, [...args, "--json"], { home: homeS }) }));
    const siliconBad = siliconRuns.map(({ path, run }) => ({ path, problem: judge(run) })).filter(entry => entry.problem);
    results.check(`as a Silicon: ${siliconRuns.length} commands answer with JSON`, siliconBad.length === 0, short(siliconBad.map(entry => `${entry.path}: ${entry.problem}`), 1200));
    const refusedKinds = siliconRuns.filter(({ path }) => ["silicon list", "custodian requests"].includes(path));
    results.check("…Carbon-only commands say wrong_account_kind (exit 3)", refusedKinds.every(({ run }) => obj(run.json?.error).code === "wrong_account_kind" && run.code === 3), short(refusedKinds.map(({ path, run }) => [path, obj(run.json?.error).code])));

    // 5. As an app (credentials from the environment).
    const appEnv = { ACCOUNTS_APP_ID: "remind", ACCOUNTS_APP_SECRET: appSecret("remind") };
    const appCommands = [["app", "show"], ["app", "config", "get"], ["app", "config", "history"], ["app", "users"], ["app", "import", "list"], ["app", "proof", "list"], ["app", "webhook", "deliveries"], ["app", "token", "introspect", "x"], ["app", "lookup", carbon.uuid]];
    const appRuns = await pool(appCommands, 4, async args => ({ path: args.join(" "), run: await accounts(env, [...args, "--json"], { home: freshDir(), env: appEnv }) }));
    // A token that isn't active is a verdict, not an error: exit 2 with the RFC 7662 answer, like `app proof verify`.
    const appBad = appRuns.map(({ path, run }) => ({ path, problem: judge(run, path === "app token introspect x" ? [2] : [0]) ?? (run.json?.error ? `error ${short(run.json.error)}` : null) })).filter(entry => entry.problem);
    results.check(`as the app remind: ${appRuns.length} commands succeed with JSON`, appBad.length === 0, short(appBad.map(entry => `${entry.path}: ${entry.problem}`), 1200));
    const introspect = appRuns.find(({ path }) => path === "app token introspect x")?.run;
    results.check("`app token introspect` of a dead token: exit 2 with exactly {\"active\": false}", introspect?.code === 2 && JSON.stringify(introspect.json) === '{"active":false}', short(introspect?.stdout));
    const verify = await accounts(env, ["app", "proof", "verify", "sap_not-a-proof", "--json"], { home: freshDir(), env: appEnv });
    results.check("`app proof verify` of an invalid proof: exit 2 with a JSON verdict ({valid: false, expires_at: null})", verify.code === 2 && verify.json?.valid === false && verify.json?.expires_at === null, `${verify.code} ${short(verify.stdout)}`);
    const secretShown = appRuns.some(({ run }) => run.stdout.includes(appSecret("remind")));
    results.check("no command prints the app secret", !secretShown);
  },
};

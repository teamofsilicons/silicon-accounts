import type { Journey } from "../../context";
import { json } from "../../lib";
import { accounts, cliError, freshDir, obj, pool, said, short, str, type Json } from "./_helpers";

/** `silicon-accounts silicon webhook set <SILICON> <URL>` → ["silicon", "webhook", "set"]. */
const pathOf = (command: string) => command.replace(/^accounts /, "").split(" ").filter(word => word && !/^[<[]/.test(word));

const TOPICS = ["getting-started", "silicons", "custodians", "apps", "proofs", "webhooks", "imports", "ids", "troubleshooting", "links"];

export const journey: Journey = {
  name: "silicons-cli-help-tree",
  title: "the CLI is a tree you can walk with --help: the root shows every command, the bundled docs, environment, exit codes and links (the account site and the developer platform); every command's --help works and says what it is for; `help`, `docs`, missing and unknown commands behave; `app new` points at the developer platform",
  // No browser: the CLI and the API only, so the engine changes nothing (the browser journeys run in WebKit too).
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    const home = freshDir();
    const local = (args: string[]) => accounts(env, args, { home, url: null });

    // 1. The root.
    const root = await local(["--help"]);
    const tree = await local(["--json"]);
    const commands = ((tree.json?.commands ?? []) as Json[]).map(entry => ({ command: str(entry.command), about: str(entry.about) }));
    results.check("`silicon-accounts --json` (no command) is the whole tree as JSON, every entry with what it is for", tree.code === 0 && commands.length >= 100 && commands.every(entry => entry.command.startsWith("accounts ") && entry.about.trim().length >= 5), `${commands.length} commands; shortest: ${short(commands.map(entry => entry.about).sort((a, b) => a.length - b.length)[0])}`);
    const topLevel = [...new Set(commands.map(entry => pathOf(entry.command)[0]!))];
    const missingTop = topLevel.filter(name => !root.stdout.includes(`\n  ${name}`));
    results.check("`silicon-accounts --help` (exit 0) lists every command of the tree", root.code === 0 && missingTop.length === 0 && root.stdout.includes("Command tree"), `${topLevel.length} top-level; missing ${short(missingTop)}`);
    // The tree prints each command's full path, indented by depth ("      silicon request status <REQUEST_ID>").
    const absent = commands.filter(entry => !new RegExp(`\\n {2,}${pathOf(entry.command).join(" ").replace(/[-]/g, "\\-")}( |\\n)`).test(root.stdout));
    results.check("…down to the nested commands, each with its full path (e.g. silicon request status, app webhook replay)", absent.length === 0 && root.stdout.includes("silicon request status <REQUEST_ID>") && root.stdout.includes("app webhook replay"), short(absent.map(entry => entry.command)));
    results.check("…the bundled docs topics", TOPICS.every(topic => root.stdout.includes(`  ${topic}`)), short(TOPICS.filter(topic => !root.stdout.includes(topic))));
    results.check("…environment (ACCOUNTS_URL, ACCOUNTS_HOME, SILICON_HOME, ACCOUNTS_STK…), exit codes and links (docs, GitHub, the Rust package)", ["Environment:", "ACCOUNTS_URL", "ACCOUNTS_HOME", "SILICON_HOME", "ACCOUNTS_STK", "Exit codes:", "3 sign-in required or refused", "Docs ", "/docs", "https://github.com/teamofsilicons/silicon-accounts", "silicon-accounts-client"].every(text => root.stdout.includes(text)), "");
    // UNDERSTANDING.md: "the service and the account site at `accounts.teamofsilicons.com`" (it was account.… before).
    const defaultUrl = await local(["config", "get", "url", "--json"]);
    const siteLinks = [...new Set(root.stdout.match(/https?:\/\/[a-z.]*teamofsilicons\.com[^\s\])]*/g) ?? [])];
    results.check(
      "the CLI talks to and links the account site where UNDERSTANDING.md puts it: https://accounts.teamofsilicons.com (default URL, docs link)",
      defaultUrl.json?.value === "https://accounts.teamofsilicons.com" && defaultUrl.json?.source === "default" && root.stdout.includes("https://accounts.teamofsilicons.com/docs") && !/\baccount\.teamofsilicons\.com/.test(root.stdout),
      `default url ${short(defaultUrl.json)}; links in --help: ${short(siteLinks)}`,
    );
    results.check("…and that updates belong to Silicon Apps (the CLI never updates itself)", root.stdout.includes("Updates are managed by Silicon Apps; this CLI never updates itself."));
    // UNDERSTANDING.md "Where things live": a Carbon's own account at accounts.…, building apps at developer.….
    const links = root.stdout.slice(root.stdout.indexOf("Links:"));
    results.check(
      "its links name both sites: the account (https://accounts.teamofsilicons.com) and the developer platform (https://developers.teamofsilicons.com, the apps' sign-in setup)",
      /Account\s+https:\/\/accounts\.teamofsilicons\.com\b/.test(links) && /Developer\s+https:\/\/developers\.teamofsilicons\.com\b/.test(links),
      short(links.split("\n").slice(0, 7).join(" | "), 400),
    );
    // `silicon-accounts app new` points at where apps are made and set up, the developer site's address coming from the service.
    const meta = await accounts(env, ["app", "new", "--no-browser", "--json"], { home });
    const served = obj((await json<Json>(`${env.site}/v1/meta`)).body);
    results.check(
      "`silicon-accounts app new --no-browser --json`: Silicon Apps' URL, and the developer platform's from GET /v1/meta (this stack's developer site), nothing opened",
      meta.code === 0 && meta.json?.developer_url === env.developer && served.developer_url === env.developer && str(meta.json?.silicon_apps_url).startsWith("https://") && meta.json?.opened === false,
      `${said(meta)} | meta developer_url ${short(served.developer_url)}`,
    );
    const shortHelp = await local(["-h"]);
    results.check("`-h` is the short form and points at --help for the whole tree", shortHelp.code === 0 && shortHelp.stdout.length < root.stdout.length && shortHelp.stdout.includes("Run `silicon-accounts --help` for the whole command tree"), `${shortHelp.stdout.length} vs ${root.stdout.length} chars`);
    const helpJson = await local(["help", "--json"]);
    results.check("`silicon-accounts help --json` gives the same tree", helpJson.code === 0 && JSON.stringify(helpJson.json) === JSON.stringify(tree.json));
    const version = await local(["--version"]);
    results.check("`silicon-accounts --version`", version.code === 0 && /^accounts \d+\.\d+\.\d+/.test(version.stdout.trim()), version.stdout.trim());

    // 2. Every command's --help. It says what the command is for: its one-line summary (the tree's "about"), or a longer
    //    description in its place (clap shows a command's long description with --help and the summary with -h).
    const bad: string[] = [];
    const noExamples: string[] = [];
    const helps = await pool(commands, 8, async entry => ({ entry, run: await local([...pathOf(entry.command), "--help"]) }));
    for (const { entry, run } of helps) {
      const path = pathOf(entry.command);
      const usage = `Usage: accounts ${path.join(" ")}`;
      const first = entry.about.split(/[.:(]/)[0]!.trim().slice(0, 40);
      const flat = run.stdout.replace(/\s+/g, " ");
      let says = flat.includes(first);
      let why = `exit ${run.code}`;
      if (!says && run.code === 0 && run.stdout.includes(usage)) {
        // A long description instead of the summary: -h must show the summary, and --help a description of its own.
        const brief = await local([...path, "-h"]);
        const described = run.stdout.slice(0, run.stdout.indexOf("Usage:")).replace(/\s+/g, " ").trim();
        says = brief.code === 0 && brief.stdout.replace(/\s+/g, " ").includes(first) && described.length >= 40;
        why = `--help starts "${described.slice(0, 60)}", -h ${brief.code === 0 ? "lacks" : "fails on"} "${first}"`;
      }
      if (run.code !== 0 || !run.stdout.includes(usage) || !says) bad.push(`${path.join(" ")} (${why})`);
      if (path.length === 1 && path[0] !== "help" && !run.stdout.includes("Examples:")) noExamples.push(path.join(" "));
    }
    results.check(`every one of the ${commands.length} commands answers --help (exit 0) with its usage and what it is for`, bad.length === 0, short(bad));
    results.check("every top-level command's --help shows examples", noExamples.length === 0, short(noExamples));
    const paths = commands.map(entry => pathOf(entry.command));
    const under = (parent: string[], child: string[]) => child.length === parent.length + 1 && parent.every((word, i) => child[i] === word);
    const groups = paths.filter(path => paths.some(other => under(path, other)));
    const byPath = new Map(helps.map(({ entry, run }) => [pathOf(entry.command).join(" "), run.stdout]));
    const unlisted = groups.flatMap(group => paths.filter(child => under(group, child) && !(byPath.get(group.join(" ")) ?? "").includes(`  ${child.at(-1)}`)).map(child => child.join(" ")));
    results.check(`every group's --help lists its subcommands (${groups.length} groups)`, groups.length >= 15 && unlisted.length === 0, short(unlisted));
    const create = await local(["silicon", "create", "--help"]);
    results.check("help says how commands work together (silicon create → custodian accept, silicon request status)", create.stdout.includes("silicon-accounts custodian") && create.stdout.includes("silicon-accounts silicon request status"), "");

    // 3. `help <command>`, docs, missing and unknown commands.
    const viaHelp = await local(["help", "silicon", "create"]);
    results.check("`silicon-accounts help silicon create` = `silicon-accounts silicon create --help`", viaHelp.code === 0 && viaHelp.stdout.includes("Usage: silicon-accounts silicon create") && viaHelp.stdout.includes("--self-create"), said(viaHelp));
    const helpTopic = await local(["help", "proofs"]);
    const docsList = await local(["docs", "--json"]);
    const topics = ((docsList.json?.topics ?? []) as Json[]).map(entry => str(entry.topic));
    results.check("`silicon-accounts help proofs` and `silicon-accounts docs --json` reach the bundled docs (10 topics)", helpTopic.code === 0 && /User verification|App verification/.test(helpTopic.stdout) && JSON.stringify(topics) === JSON.stringify(TOPICS), short(topics));
    const silicons = await local(["docs", "silicons", "--json"]);
    results.check("`silicon-accounts docs silicons --json`: the guide on how a Silicon gets an account", silicons.code === 0 && silicons.json?.topic === "silicons" && /custodian/i.test(str(silicons.json?.content)) && /STK/.test(str(silicons.json?.content)), said(silicons));
    const unknownTopic = await local(["docs", "nonsense", "--json"]);
    results.check("an unknown docs topic: exit 4, unknown_topic, listing the topics", unknownTopic.code === 4 && cliError(unknownTopic).code === "unknown_topic" && str(cliError(unknownTopic).hint).includes("getting-started"), said(unknownTopic));
    const group = await local(["silicon"]);
    results.check("a group without its subcommand prints its help (exit 2)", group.code === 2 && `${group.stdout}${group.stderr}`.includes("Usage: silicon-accounts silicon"), said(group));
    const unknown = await local(["frobnicate", "--json"]);
    results.check("an unknown command with --json: exit 2 and a JSON error (invalid_arguments)", unknown.code === 2 && cliError(unknown).code === "invalid_arguments" && /frobnicate/.test(str(cliError(unknown).message)), said(unknown));
    const unknownText = await local(["frobnicate"]);
    results.check("…in text mode: exit 2, says what it didn't recognize", unknownText.code === 2 && /unrecognized subcommand 'frobnicate'/.test(unknownText.stderr), said(unknownText));
    const unknownFlag = await local(["login", "status", "--frobnicate", "--json"]);
    results.check("an unknown flag with --json: exit 2, JSON error naming it", unknownFlag.code === 2 && /--frobnicate/.test(str(cliError(unknownFlag).message)), said(unknownFlag));
  },
};

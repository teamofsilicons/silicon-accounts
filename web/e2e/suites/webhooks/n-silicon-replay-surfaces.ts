/**
 * Where a Silicon finds the replay of its own webhook deliveries outside the HTTP API. UNDERSTANDING "Rust Package &
 * CLI": the package is the primary interface, "Everything should work through the CLI first", and the CLI "is built
 * for both Carbons and Silicons, but it'll mostly be used by Silicons"; "Docs": instructive docs written for Silicons;
 * "Webhooks": failed deliveries can be replayed, and Silicon webhooks "follow these same rules". The API has
 * GET /v1/me/webhook/deliveries and POST /v1/me/webhook/replay (and the custodian's /v1/me/silicons/{uuid}/webhook/…),
 * so two journeys, one per surface:
 *
 * - webhooks-silicon-replay-cli: the CLI, signed in as the Silicon, lists its failed deliveries and replays one (the
 *   event arrives again with the same event_id); its custodian's `accounts silicon webhook` has the same; the bundled
 *   CLI docs (`accounts docs webhooks`) say how;
 * - webhooks-silicon-replay-docs: the docs site (/docs/…md) tells a Silicon how to do it, and no longer says there is
 *   no listing or replay endpoint.
 */
import type { Journey } from "../../context";
import { cli, cliHome, forgetRateLimits } from "../../lib";
import { ageDelivery, createSilicon, must, newCarbon, setFaults, setInboxSecret, short, storedEvents, uid, waitAttempts, waitEvent } from "./_helpers";

const said = (run: { code: number | null; stdout: string; stderr: string }) => `exit ${run.code}; stdout ${short(run.stdout.trim(), 300)}; stderr ${short(run.stderr.trim(), 300)}`;

/** The command names a clap help page lists under "Commands:". */
function commandsOf(help: string): string[] {
  const block = help.split(/\nCommands:\n/)[1]?.split(/\n\n/)[0] ?? "";
  return block.split("\n").map(line => line.trim().split(/\s+/)[0] ?? "").filter(Boolean);
}

const cliJourney: Journey = {
  name: "webhooks-silicon-replay-cli",
  title: "a Silicon (and its custodian) can list and replay the Silicon's webhook deliveries through the CLI, and the CLI's bundled docs say how",
  timeoutMs: 4 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const keeper = await newCarbon(ctx, "surfaces");
    const sink = `hooks/wh-surf-${uid()}`;
    const silicon = await createSilicon(keeper, "surfaces", { webhookUrl: `${env.apps}/${sink}` });
    await setInboxSecret(env, sink, silicon.webhookSecret);
    await waitEvent(env, sink, { type: "silicon.created", uuid: silicon.uuid });

    // A delivery that failed for good, to list and replay.
    await setFaults(env, sink, 1000, 503);
    const since = Date.now();
    must("the custodian renames the Silicon", await keeper.visitor.call("PATCH", `/v1/me/silicons/${silicon.uuid}`, { json: { display_name: `WH Surfaces ${uid()}` } }), 200);
    const row = (await storedEvents(env, { target: silicon.uuid, type: "silicon.updated", afterMs: since - 1 })).at(-1);
    if (!row) throw new Error("no silicon.updated was stored");
    await waitAttempts(env, row.delivery_id, 1);
    await ageDelivery(env, row.delivery_id, 72);
    const failed = await waitAttempts(env, row.delivery_id, 2);
    await setFaults(env, sink, 0);
    results.check("setup: the Silicon's silicon.updated delivery failed for good", failed?.status === "failed", short(failed));

    // ---- the CLI, as the Silicon ------------------------------------------------------------------------------------------
    await forgetRateLimits(env, "127.0.0.1");
    const home = cliHome();
    const login = await cli(env, home, ["login", "--silicon", silicon.id, "--stk-stdin", "--json"], { stdin: `${silicon.stk}\n` });
    results.check("setup: the Silicon signs in to the CLI", login.code === 0, said(login));
    const help = await cli(env, home, ["webhook", "--help"]);
    const own = commandsOf(help.stdout);
    const list = await cli(env, home, ["webhook", "deliveries", "--status", "failed", "--json"]);
    const listed = JSON.stringify(list.json ?? {}).includes(row.delivery_id);
    const replay = await cli(env, home, ["webhook", "replay", row.delivery_id, "--json"]);
    const arrived = replay.code === 0 ? await waitEvent(env, sink, { event_id: row.event_id }, 15_000) : null;
    results.check(
      "CLI (as the Silicon): `accounts webhook` lists its failed deliveries and replays one, which arrives again with the same event_id",
      own.includes("deliveries") && own.includes("replay") && list.code === 0 && listed && replay.code === 0 && !!arrived,
      `accounts webhook commands: [${own.join(", ")}] | deliveries --status failed: ${said(list)} | replay: ${said(replay)} | arrived: ${!!arrived}`,
    );

    // ---- the CLI, as the custodian (its help) --------------------------------------------------------------------------------
    const custodianHelp = await cli(env, home, ["silicon", "webhook", "--help"]);
    const custodian = commandsOf(custodianHelp.stdout);
    results.check("CLI (as the custodian): `accounts silicon webhook` can list and replay a Silicon's deliveries too", custodian.includes("deliveries") && custodian.includes("replay"), `accounts silicon webhook commands: [${custodian.join(", ")}]`);

    // ---- the CLI's bundled docs ---------------------------------------------------------------------------------------------
    const bundled = await cli(env, home, ["docs", "webhooks"]);
    results.check(
      "CLI docs (`accounts docs webhooks`): say how a Silicon replays its own failed deliveries",
      bundled.code === 0 && /accounts webhook replay|\/v1\/me\/webhook\/replay/.test(bundled.stdout),
      `exit ${bundled.code}; replay lines: ${short(bundled.stdout.split("\n").filter(line => /replay/i.test(line)).join(" / "), 500)}`,
    );
  },
};

const docsJourney: Journey = {
  name: "webhooks-silicon-replay-docs",
  title: "the docs site tells a Silicon how to list and replay its own webhook deliveries (learn/webhooks, reference/api) and no longer says it can't",
  timeoutMs: 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const page = async (path: string) => {
      const response = await fetch(`${env.site}/docs/${path}.md`, { signal: AbortSignal.timeout(15_000) });
      return { status: response.status, text: await response.text() };
    };
    const learn = await page("learn/webhooks");
    const stale = learn.text.split("\n").find(line => /no listing or replay endpoint/i.test(line)) ?? null;
    results.check(
      "docs site, learn/webhooks: no longer says a Silicon webhook has \"no listing or replay endpoint yet\"",
      learn.status === 200 && !stale,
      `${learn.status}; ${stale ? `still says: ${short(stale.trim(), 300)}` : "no such line"}`,
    );
    // The API reference: its index (reference/api) and its pages for Silicons and webhooks.
    const pages = await Promise.all(["reference/api", "reference/api/silicons", "reference/api/webhooks"].map(async path => ({ path, ...(await page(path)) })));
    const reference = pages.map(entry => entry.text).join("\n");
    const routes: Array<[string, RegExp]> = [
      ["GET /v1/me/webhook/deliveries", /GET \/v1\/me\/webhook\/deliveries\b/],
      ["POST /v1/me/webhook/replay", /POST \/v1\/me\/webhook\/replay\b/],
      ["GET /v1/me/silicons/{uuid}/webhook/deliveries", /GET \/v1\/me\/silicons\/\{[^}]+\}\/webhook\/deliveries\b/],
      ["POST /v1/me/silicons/{uuid}/webhook/replay", /POST \/v1\/me\/silicons\/\{[^}]+\}\/webhook\/replay\b/],
    ];
    const missing = routes.filter(([, pattern]) => !pattern.test(reference)).map(([route]) => route);
    results.check("docs site, API reference (reference/api, its Silicons and webhooks pages): documents the Silicon's and the custodian's delivery and replay routes", pages.every(entry => entry.status === 200) && missing.length === 0, `${pages.map(entry => `${entry.path} ${entry.status}`).join(", ")}; missing: ${missing.join(", ") || "none"}`);
  },
};

export const journeys: Journey[] = [cliJourney, docsJourney];

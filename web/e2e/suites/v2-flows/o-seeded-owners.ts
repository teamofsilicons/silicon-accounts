/**
 * The stack itself: every page a journey opens loads nothing from the internet (web/e2e/README.md "Mock Iris": every
 * account's default photo comes from the stack's mock Iris, ACCOUNTS_IRIS_BASE_URL). The fake apps' owners are seeded
 * by accounts-seed (scripts/dev.sh), and the developer site shows their photo once they sign in there (the ATA journey
 * signs in as commit's owner), so their stored default photo must be the stack's Iris too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { REPO_ROOT, sql } from "../../lib";

/** Every fake app's owner (testkit/fake-apps.json), as accounts-seed creates them. */
function seededOwners(): string[] {
  const apps = (JSON.parse(readFileSync(join(REPO_ROOT, "testkit/fake-apps.json"), "utf8")) as { apps: Array<{ owner_id: string }> }).apps;
  return [...new Set(apps.map(app => app.owner_id))].sort();
}

export const journey: Journey = {
  name: "v2-flows-seeded-owner-photos",
  title: "the fake apps' seeded owners (who sign in to the developer site) have their default photo on the stack's own Iris, not the production one",
  async run(ctx) {
    const { env, results } = ctx;
    const ids = seededOwners();
    const rows = await sql(env, `select handle, pfp_url from accounts where handle in (${ids.map(id => `'${id}'`).join(", ")}) order by handle`);
    const elsewhere = rows.filter(row => !(row[1] ?? "").startsWith(`${env.iris}/`));
    results.check(
      `the seeded owners ${ids.join(", ")} have default photos from the stack's Iris (${env.iris})`,
      rows.length === ids.length && elsewhere.length === 0,
      `${rows.length} of ${ids.length} found; ${elsewhere.length ? `outside the stack: ${elsewhere.map(row => `${row[0]} ${row[1]}`).join(", ")} (scripts/dev.sh base_env runs accounts-seed without ACCOUNTS_IRIS_BASE_URL, so Settings falls back to https://iris.teamofsilicons.com)` : "all on the stack's Iris"}`,
    );
    // Carbons the API itself created on this stack (the suite's journeys signed some up) get the stack's Iris: the API
    // runs with the variable, only the seed does not.
    const made = await sql(env, `select pfp_url from accounts where kind = 'carbon' and handle is not null and handle not in (${ids.map(id => `'${id}'`).join(", ")}) and pfp_url like '%/pfp/carbon?id=%' order by created_at desc limit 20`);
    if (made.length) {
      const off = made.filter(row => !(row[0] ?? "").startsWith(`${env.iris}/`));
      results.check("…while the Carbons the API signed up on this stack have the stack's Iris (the API has the variable)", off.length === 0, `${made.length - off.length} of ${made.length} on the stack's Iris${off.length ? `; elsewhere: ${off.map(row => row[0]).join(", ")}` : ""}`);
    }
  },
};

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { openApi } from "../lib/agent/openapi";
import { robotsTxt } from "../lib/agent/robots";
import { resetStatusCache, runChecks, secondsLeft, statusReport, statusTargets, summarize } from "../lib/status";

const SELF = "http://developer.test";
const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that answers each address from a table, and never answers (until the time limit) for "hang". */
function fakeFetch(table: Record<string, Response | "hang" | "refuse">, calls: string[] = []) {
  return (url: string, init: RequestInit) => {
    calls.push(url);
    const answer = table[url];
    if (answer === "hang") return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    if (answer === "refuse" || !answer) return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(answer.clone());
  };
}

const healthy = () => ({
  "https://accounts.teamofsilicons.com/readyz": json(200, { database: "ok" }),
  "https://accounts.teamofsilicons.com/v1/meta": json(200, { name: "Silicon Accounts", version: "0.4.0" }),
  "https://apps.teamofsilicons.com/health": json(200, { service: "silicon-apps", status: "ok", version: "0.1.2" }),
  [`${SELF}/openapi.json`]: json(200, { openapi: "3.1.0" }),
});

test("status: every service up, with its version, response time and check time", async () => {
  const report = await runChecks({ fetch: fakeFetch(healthy()), targets: statusTargets(SELF), now: () => new Date("2026-10-09T12:00:00Z") });
  assert.equal(report.status, "up");
  assert.equal(report.summary, "All three services are up.");
  assert.equal(report.checked_at, "2026-10-09T12:00:00.000Z");
  assert.deepEqual(report.services.map(service => [service.id, service.status, service.version]), [["accounts", "up", "0.4.0"], ["apps", "up", "0.1.2"], ["developer", "up", version]]);
  for (const service of report.services) {
    assert.equal(typeof service.response_ms, "number");
    assert.equal(service.checked_at, report.checked_at);
    assert.equal(service.error, null);
  }
  assert.equal(report.services[0]!.checks.length, 2);
  assert.ok(report.not_published_yet.some(line => /SLA/.test(line)));
  assert.ok(report.not_published_yet.some(line => /incident history/.test(line)));
});

test("status: a refusal, a not-ready answer, a time limit and an unreachable service are each down, in plain words", async () => {
  const table = {
    ...healthy(),
    "https://accounts.teamofsilicons.com/readyz": json(503, { database: "unavailable" }),
    "https://apps.teamofsilicons.com/health": json(200, { status: "degraded", version: "0.1.2" }),
    [`${SELF}/openapi.json`]: "hang" as const,
  };
  const report = await runChecks({ fetch: fakeFetch(table), targets: statusTargets(SELF), timeoutMs: 50 });
  assert.equal(report.status, "down");
  const [accounts, apps, developer] = report.services;
  assert.deepEqual([accounts!.status, accounts!.error?.code, accounts!.version], ["down", "http_status", "0.4.0"]);
  assert.match(accounts!.error!.message, /503/);
  assert.deepEqual([apps!.status, apps!.error?.code], ["down", "not_ready"]);
  assert.deepEqual([developer!.status, developer!.error?.code, developer!.response_ms], ["down", "timeout", null]);
  assert.equal(developer!.error!.message, "Did not answer within 50 ms.");

  const partial = await runChecks({ fetch: fakeFetch({ ...healthy(), "https://apps.teamofsilicons.com/health": "refuse" }), targets: statusTargets(SELF) });
  assert.equal(partial.status, "partial");
  assert.equal(partial.summary, "Silicon Apps is down right now. Everything else is up.");
  assert.deepEqual([partial.services[1]!.error?.code, partial.services[1]!.version], ["unreachable", null]);
  assert.equal(summarize([{ name: "A", status: "down" }, { name: "B", status: "down" }, { name: "C", status: "up" }]).summary, "A and B are down right now. Everything else is up.");
});

test("status: one round is kept for 30 seconds and shared, then checked again", async () => {
  resetStatusCache();
  const calls: string[] = [];
  let now = 1_000_000;
  const options = { fetch: fakeFetch(healthy(), calls), targets: statusTargets(SELF), clock: () => now };
  const [first, second] = await Promise.all([statusReport(options), statusReport(options)]);
  assert.equal(first, second);
  assert.equal(calls.length, 4);
  now += 29_000;
  assert.equal(await statusReport(options), first);
  assert.equal(calls.length, 4);
  assert.equal(secondsLeft(first, now), 1);
  now += 1_000;
  const third = await statusReport(options);
  assert.notEqual(third, first);
  assert.equal(calls.length, 8);
  assert.equal(secondsLeft(third, now), 30);
  resetStatusCache();
});

test("status: robots.txt allows it and openapi.json describes it, with the MIT licence", () => {
  assert.match(robotsTxt(), /^Allow: \/status$/m);
  assert.match(robotsTxt(), /^Allow: \/status\.json$/m);
  const spec = openApi();
  assert.deepEqual(spec.info.license, { name: "MIT", identifier: "MIT" });
  assert.ok(spec.paths["/status.json"].get);
  assert.equal(spec["x-status"].json, "https://developers.teamofsilicons.com/status.json");
  assert.ok(spec.components.schemas.StatusReport);
});

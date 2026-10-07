/**
 * The measuring of proofs-perf-latency-verify (../latency.ts client, measureAwake) against a local server: a run
 * during which the process stood still (as when the machine sleeps) is measured again and never judged, and a
 * request without an answer fails after its timeout instead of hanging the journey.
 *
 *   web/node_modules/.bin/tsx --test web/e2e/suites/proofs-perf/test/latency.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { client, measureAwake, type Kind } from "../latency";

let server: Server;
let base = "";
const hanging = new Set<import("node:http").ServerResponse>();

before(async () => {
  server = createServer((request, response) => {
    if (request.url === "/hang") {
      hanging.add(response);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  for (const response of hanging) response.destroy();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
});

/** Blocks this thread for `ms` (nothing of the process runs, as when the machine sleeps). */
const standStill = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A kind that answers from the local server and stands still for `stallMs` on the given calls (1 = the warm-up). */
function kind(stallMs: number, onCalls: (call: number) => boolean): Kind & { calls: () => number } {
  let calls = 0;
  return {
    name: "ok",
    send: async connection => {
      calls++;
      if (onCalls(calls)) standStill(stallMs);
      return connection.send(`${base}/`, "GET", {});
    },
    ok: answer => answer.status === 200,
    calls: () => calls,
  };
}

const metrics: Array<[string, number]> = [];
const ctx = { results: { metric: (name: string, value: number) => void metrics.push([name, value]) } } as unknown as Parameters<typeof measureAwake>[0];

describe("measureAwake", () => {
  it("keeps a run in which the process kept running", async () => {
    const measured = await measureAwake(ctx, "steady", 20, 1, [kind(0, () => false)], { frozenMs: 300 });
    assert.equal(measured.frozen, false);
    assert.equal(measured.voided.length, 0);
    assert.equal(measured.run.samples.get("ok")!.latencies.length, 20);
    assert.ok(measured.run.stallMs < 300);
  });

  it("sets aside a run during which the process stood still and measures it again", async () => {
    // Call 1 is the warm-up (not watched); call 5 is inside the first measured run.
    const measured = await measureAwake(ctx, "slept once", 20, 1, [kind(500, call => call === 5)], { frozenMs: 300 });
    assert.equal(measured.frozen, false);
    assert.equal(measured.voided.length, 1);
    assert.ok(measured.voided[0]!.stallMs >= 450, `void run stall ${measured.voided[0]!.stallMs}`);
    assert.ok(measured.run.stallMs < 300);
    assert.equal(measured.run.label, "slept once");
    assert.equal(measured.run.samples.get("ok")!.wrong, 0);
    assert.ok(metrics.some(([name, value]) => name === "slept once: void run, the process stood still for" && value >= 450));
  });

  it("gives up after the last try, saying the run is frozen", async () => {
    const always = kind(400, call => call > 1 && call % 2 === 0);
    const measured = await measureAwake(ctx, "always asleep", 6, 1, [always], { frozenMs: 300, tries: 2 });
    assert.equal(measured.frozen, true);
    assert.equal(measured.voided.length, 1);
    assert.ok(measured.run.stallMs >= 350);
  });
});

describe("client", () => {
  it("fails a request that gets no answer within its timeout instead of waiting for ever", async () => {
    const connection = client(1, 300);
    const started = performance.now();
    await assert.rejects(connection.send(`${base}/hang`, "GET", {}), /no answer within 0\.3 s/);
    assert.ok(performance.now() - started < 3000);
    connection.close();
  });

  it("answers status, body and request id", async () => {
    const connection = client(1);
    const answer = await connection.send(`${base}/`, "GET", {});
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: true });
    connection.close();
  });
});

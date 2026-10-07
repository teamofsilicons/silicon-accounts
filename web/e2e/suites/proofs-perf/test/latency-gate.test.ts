/**
 * The verify latency gate (../_latency-gate.ts) on numbers measured by proofs-perf-latency-verify and by a probe that
 * interleaved candidates with the same one-query control: a quiet machine, the busy one of the run that failed the old
 * p95-only gate (load 46 to 112, about ten stacks on one Postgres), and a busy machine (load 48 to 173) on which the real
 * verify was compared with a verify followed by one or three more one-query round trips.
 *
 *   web/node_modules/.bin/tsx --test web/e2e/suites/proofs-perf/test/latency-gate.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LATENCY_GATE, MAX_FROZEN_RUNS, decide, deltaLimit, frozenVerdict, gateWords, judge, type GateSettings, type RunNumbers } from "../_latency-gate";

const settings: GateSettings = { ...LATENCY_GATE, strict: false };
const strict: GateSettings = { ...LATENCY_GATE, strict: true };
const at = (p50: number, p95: number) => ({ p50, p95 });
/** A run's numbers; the server times are the quiet machine's unless given (whole ms, every verify found). */
const run = (verify: [number, number], control: [number, number], server: [number, number] | null = [0, 1], coverage = 1, controlServer: [number, number] | null = [0, 1]): RunNumbers => ({
  verify: at(...verify),
  control: at(...control),
  server: server ? at(...server) : null,
  controlServer: controlServer ? at(...controlServer) : null,
  serverCoverage: coverage,
});

describe("a quiet machine", () => {
  it("passes the real verify (straight at accounts-api and through the site, sequential and at 50 concurrent)", () => {
    for (const numbers of [
      run([0.354, 0.509], [0.19, 0.235]), // api sequential: verify vs GET /readyz
      run([1.675, 3.284], [1.372, 2.295], [0, 1]), // api 50 concurrent
      run([1.43, 1.96], [1.32, 1.78]), // site sequential: verify vs the one-query control through the proxy
      run([3.64, 5.98], [3.1, 5.2], [1, 2]), // site 50 concurrent
    ]) {
      const verdict = judge(numbers, settings);
      assert.equal(verdict.ok, true, verdict.reason);
      assert.ok(verdict.limitDeltaP50 < 6 && verdict.limitDeltaP95 < 17, `${verdict.limitDeltaP50} / ${verdict.limitDeltaP95}`);
    }
  });

  it("fails a verify whose own server time is over 15 ms at p95 (plus the control's 1 ms), however close it is to the control", () => {
    const verdict = judge(run([18, 22], [17.5, 21], [16, 18]), settings);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.limitServerP95, 16);
    assert.match(verdict.reason, /server time p95 ≤ 16\.00 ms \(18\.00 ms\)/);
  });

  it("gives the server time no allowance when the control's own server time is not in the log", () => {
    const verdict = judge(run([2, 4], [1.5, 3.5], [3, 15.5], 1, null), settings);
    assert.equal(verdict.limitServerP95, 15);
    assert.equal(verdict.ok, false);
  });

  it("fails a verify that costs more than 5 ms over the control at p50, or 15 ms at p95", () => {
    const median = judge(run([6.5, 8], [0.4, 0.6], [6, 7]), settings);
    assert.equal(median.ok, false);
    assert.match(median.reason, /verify − control p50/);
    const tail = judge(run([1, 20], [0.4, 1], [1, 9]), settings);
    assert.equal(tail.ok, false);
    assert.match(tail.reason, /verify − control p95/);
  });

  it("never passes a run whose server time could not be read for most verifies", () => {
    for (const numbers of [run([0.35, 0.5], [0.19, 0.23], null, 0), run([0.35, 0.5], [0.19, 0.23], [0, 1], 0.5)]) {
      const verdict = judge(numbers, settings);
      assert.equal(verdict.ok, false);
      assert.match(verdict.reason, /not measured/);
    }
  });

  it("never passes a run without numbers", () => {
    assert.equal(judge(run([Number.NaN, Number.NaN], [1, 2]), settings).ok, false);
    assert.equal(judge(run([1, 2], [Number.NaN, Number.NaN]), settings).ok, false);
  });
});

describe("a busy machine", () => {
  it("passes the real verify, which costs what its interleaved control costs, at every load measured (raw p95 up to 485 ms)", () => {
    for (const [verify, control] of [
      [[53.51, 247.78], [51.46, 214.08]], // api, 50 concurrent, load 112 (GET /readyz)
      [[2.23, 24.23], [1.55, 19.78]], // api, sequential, load 110
      [[30.18, 65.78], [23.56, 73.91]], // api, 50 concurrent, load 46
      [[12.19, 27.68], [11.56, 26.77]], // api, 50 concurrent, load 59
      [[45.74, 155.48], [44.69, 132.95]], // site, 50 concurrent, load 59
      [[26.11, 216.21], [27.38, 212.69]], // api, 50 concurrent, load 93
      [[2.45, 34.9], [2.15, 29.11]], // site, sequential, load 100
      [[162.5, 485.62], [153.12, 475.11]], // site, 50 concurrent, load 159
    ] as const) {
      const verdict = judge(run([...verify], [...control], [2, 12]), settings);
      assert.equal(verdict.ok, true, verdict.reason);
      assert.equal(judge(run([...verify], [...control], [2, 12]), strict).ok, false, "strict judges the raw p95 too");
    }
  });

  it("fails a verify that does three more database round trips' worth of work, at every load measured", () => {
    for (const [verify, control] of [
      [[6.17, 100.95], [1.16, 18.14]], // api, sequential, load 54
      [[228.29, 396.28], [36.19, 171.92]], // api, 50 concurrent, load 96
      [[13.61, 194.65], [2.37, 62.57]], // site, sequential, load 131
      [[373.78, 795.76], [81.03, 262.01]], // site, 50 concurrent, load 173
    ] as const) {
      const verdict = judge(run([...verify], [...control], [3, 12]), settings);
      assert.equal(verdict.ok, false, verdict.reason);
      assert.match(verdict.reason, /over the gate: .*verify − control/);
    }
  });

  it("adds what accounts-api spent on the control at the same moments to the server-time limit", () => {
    // A starved machine: a bare /readyz takes 30 ms of server time at p95, verify 38 ms.
    const starved = judge(run([45, 160], [41, 150], [9, 38], 1, [7, 30]), settings);
    assert.equal(starved.limitServerP95, 45);
    assert.equal(starved.ok, true, starved.reason);
    // The same verify server time beside a control that took 1 ms: verify itself is slow.
    const slow = judge(run([45, 160], [41, 150], [9, 38], 1, [0, 1]), settings);
    assert.equal(slow.ok, false);
    assert.equal(judge(run([45, 160], [41, 150], [9, 38], 1, [7, 30]), strict).limitServerP95, 15);
  });

  it("widens the allowed difference by a quarter of the control's own latency, and not at all when strict", () => {
    assert.equal(deltaLimit(5, 0.2, settings), 5.05);
    assert.equal(deltaLimit(15, 200, settings), 65);
    assert.equal(deltaLimit(15, 200, strict), 15);
    assert.equal(deltaLimit(5, -1, settings), 5);
  });
});

describe("best of up to three runs", () => {
  it("takes the first run that passed", () => {
    const runs = [judge(run([228.29, 396.28], [36.19, 171.92], [3, 12]), settings), judge(run([1.5, 40], [1.2, 2]), settings), judge(run([1.4, 2], [1.3, 1.8]), settings)];
    assert.deepEqual(decide(runs), { ok: true, index: 2 });
  });

  it("reports the run closest to its limits when none passed, and no run at all as a failure", () => {
    const far = judge(run([150, 900], [50, 200], [40, 90]), settings);
    const near = judge(run([150, 620], [50, 200], [10, 16]), settings);
    const missing = judge(run([Number.NaN, Number.NaN], [1, 2]), settings);
    assert.equal(far.ok || near.ok, false);
    assert.deepEqual(decide([missing, far, near]), { ok: false, index: 2 });
    assert.deepEqual(decide([]), { ok: false, index: -1 });
  });

  it("names the gate the way the checks do", () => {
    assert.equal(gateWords(settings), "accounts-api's own time p95 ≤ 15 ms (+ the control's own server time), and verify − control ≤ 5 ms at p50 and ≤ 15 ms at p95 (+25% of the control's own latency)");
    assert.equal(gateWords(strict), "accounts-api's own time p95 ≤ 15 ms, and verify − control ≤ 5 ms at p50 and ≤ 15 ms at p95, raw p95 ≤ 15 ms (strict)");
  });
});

describe("a run the machine slept through", () => {
  // The run of 12:19 IST: the Mac slept 12:19:36–12:34:37 (pmset -g log), one control request "took" 900 009 ms.
  const asleep = frozenVerdict(run([0.63, 1.84], [0.47, 1.29]), 899_500);

  it("fails, says it measured nothing, and names the stall", () => {
    assert.equal(asleep.ok, false);
    assert.equal(asleep.frozenMs, 899_500);
    assert.match(asleep.reason, /not measured/);
    assert.match(asleep.reason, /899\.5 s/);
    assert.match(asleep.reason, new RegExp(`${MAX_FROZEN_RUNS} tries`));
  });

  it("is never the run closest to its limits, even with small numbers", () => {
    const slow = judge(run([40, 90], [20, 25], [20, 30]), settings);
    assert.equal(slow.ok, false);
    assert.deepEqual(decide([asleep, slow]), { ok: false, index: 1 });
    assert.deepEqual(decide([slow, asleep]), { ok: false, index: 0 });
  });

  it("does not hide a later run that passed, and fails when every run slept", () => {
    const fine = judge(run([0.6, 1.8], [0.5, 1.3]), settings);
    assert.deepEqual(decide([asleep, fine]), { ok: true, index: 1 });
    assert.deepEqual(decide([asleep, asleep]), { ok: false, index: 0 });
  });
});

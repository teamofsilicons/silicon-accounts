/**
 * The verify latency gate (../_latency-gate.ts) on numbers measured by proofs-perf-latency-verify and by a probe that
 * interleaved candidates with the same one-query control: a quiet machine (load 9 on 14 cores), the busy one of the
 * run that failed the old p95-only gate (load 46 to 112, about ten stacks on one Postgres), and a busy machine (load 48
 * to 172) on which the real verify was compared with a verify followed by one or three more one-query round trips.
 *
 *   web/node_modules/.bin/tsx --test web/e2e/suites/proofs-perf/test/latency-gate.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LATENCY_GATE, MAX_FROZEN_RUNS, decide, frozenVerdict, gateWords, judge, quietControlP95, type GateSettings } from "../_latency-gate";

const settings: GateSettings = { ...LATENCY_GATE, strict: false };
const strict: GateSettings = { ...LATENCY_GATE, strict: true };
const at = (p50: number, p95: number) => ({ p50, p95 });

describe("the budget on a quiet machine", () => {
  it("passes the quiet machine's verifies (control p95 0.19 ms sequential, 1.78 ms at 50 concurrent)", () => {
    for (const [verify, control] of [
      [at(0.25, 0.27), at(0.18, 0.19)],
      [at(1.43, 1.96), at(1.32, 1.78)],
      [at(3.64, 5.98), at(3.1, 5.2)],
    ] as const) {
      const verdict = judge(verify, control, settings);
      assert.equal(verdict.ok, true, verdict.reason);
      assert.equal(verdict.window, "quiet");
      assert.equal(verdict.limitP95Ms, 25);
    }
  });

  it("fails a verify over 25 ms at p95 when the control left room to measure it: verify itself is slow", () => {
    const verdict = judge(at(1.5, 40), at(1.2, 2), settings);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.window, "quiet");
    assert.match(verdict.reason, /verify itself is slow/);
  });

  it("measures the budget up to a control p95 of 8 ms (3 × 8 + 1 = 25), and lets the limit grow smoothly above it", () => {
    assert.equal(quietControlP95(settings), 8);
    const quiet = judge(at(5, 25.2), at(3, 8), settings);
    assert.equal(quiet.window, "quiet");
    assert.equal(quiet.limitP95Ms, 25);
    assert.equal(quiet.ok, false);
    const busy = judge(at(5, 25.2), at(3, 8.1), settings);
    assert.equal(busy.window, "busy");
    assert.ok(Math.abs(busy.limitP95Ms - 25.3) < 1e-9, String(busy.limitP95Ms));
    assert.equal(busy.ok, true, busy.reason);
  });
});

describe("a machine too busy to measure 25 ms", () => {
  it("passes the failed run's verifies, which cost what one query costs: the old gate blamed the endpoint for the machine", () => {
    // Interleaved on the same 50 callers at load 112: verify p50 53.51 / p95 247.78 ms, GET /readyz 51.46 / 214.08 ms.
    const paired = judge(at(53.51, 247.78), at(51.46, 214.08), settings);
    assert.equal(paired.window, "busy");
    assert.equal(paired.ok, true, paired.reason);
    // Sequential at load 110: verify 2.23 / 24.23 ms (within 25 ms anyway), /readyz 1.55 / 19.78 ms.
    const sequential = judge(at(2.23, 24.23), at(1.55, 19.78), settings);
    assert.equal(sequential.ok, true, sequential.reason);
    assert.equal(sequential.limitP95Ms, 25);
    // 50 concurrent at load 46: verify's best run 30.18 / 65.78 ms; /readyz 23.56 / 73.91 ms.
    const concurrent = judge(at(30.18, 65.78), at(23.56, 73.91), settings);
    assert.equal(concurrent.window, "busy");
    assert.equal(concurrent.ok, true, concurrent.reason);
    assert.match(concurrent.reason, /cannot be measured/);
  });

  it("passes the real verify at load 59 to 159, which the old gate failed whenever p95 was over 25 ms", () => {
    for (const [verify, control] of [
      [at(12.19, 27.68), at(11.56, 26.77)], // api, 50 concurrent, load 59
      [at(45.74, 155.48), at(44.69, 132.95)], // site, 50 concurrent, load 59
      [at(26.11, 216.21), at(27.38, 212.69)], // api, 50 concurrent, load 93
      [at(2.45, 34.9), at(2.15, 29.11)], // site, sequential, load 100
      [at(162.5, 485.62), at(153.12, 475.11)], // site, 50 concurrent, load 159
    ] as const) {
      const verdict = judge(verify, control, settings);
      assert.equal(verdict.window, "busy");
      assert.equal(verdict.ok, true, verdict.reason);
      assert.equal(judge(verify, control, strict).ok, false);
    }
  });

  it("leaves room for one more query: verify followed by one more one-query round trip passes", () => {
    for (const [verify, control] of [
      [at(3.94, 36.45), at(1.45, 15.22)], // api, sequential, load 48
      [at(53.78, 220.68), at(22.65, 166.51)], // api, 50 concurrent, load 93
      [at(5.48, 81.24), at(2.24, 30.89)], // site, sequential, load 112
      [at(330.84, 731.9), at(140.11, 423.89)], // site, 50 concurrent, load 163
    ] as const) {
      const verdict = judge(verify, control, settings);
      assert.equal(verdict.ok, true, verdict.reason);
    }
  });

  it("fails a verify that does several queries' worth of work (three more round trips), however busy the machine", () => {
    for (const [verify, control] of [
      [at(6.17, 100.95), at(1.16, 18.14)], // api, sequential, load 54
      [at(228.29, 396.28), at(36.19, 171.92)], // api, 50 concurrent, load 96
      [at(13.61, 194.65), at(2.37, 62.57)], // site, sequential, load 131
      [at(373.78, 795.76), at(81.03, 262.01)], // site, 50 concurrent, load 173
    ] as const) {
      const verdict = judge(verify, control, settings);
      assert.equal(verdict.window, "busy");
      assert.equal(verdict.ok, false, verdict.reason);
      assert.match(verdict.reason, /more than 3× a one-query request/);
    }
  });

  it("fails on the median too: a verify whose typical request is slow is not saved by the control's long tail", () => {
    const verdict = judge(at(40, 200), at(10, 150), settings);
    assert.equal(verdict.window, "busy");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.limitP50Ms, 31);
  });

  it("passes a p95 within the budget in a busy window: a busy machine only adds latency", () => {
    const verdict = judge(at(9, 20), at(0.5, 12), settings);
    assert.equal(verdict.window, "busy");
    assert.equal(verdict.ok, true);
  });

  it("E2E_LATENCY_GATE=strict judges the budget only, and says to measure on a quiet machine", () => {
    const verdict = judge(at(53.51, 247.78), at(51.46, 214.08), strict);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /strict judges the budget only/);
    assert.equal(judge(at(1.43, 1.96), at(1.32, 1.78), strict).ok, true);
    assert.equal(gateWords(strict), "p95 ≤ 25 ms (strict)");
  });

  it("never passes a run without numbers", () => {
    assert.equal(judge(at(Number.NaN, Number.NaN), at(1, 2), settings).ok, false);
    assert.equal(judge(at(1, 2), at(Number.NaN, Number.NaN), settings).ok, false);
  });
});

describe("best of up to three runs", () => {
  it("takes the first run that passed", () => {
    const runs = [judge(at(228.29, 396.28), at(36.19, 171.92), settings), judge(at(1.5, 40), at(1.2, 2), settings), judge(at(1.4, 2), at(1.3, 1.8), settings)];
    assert.deepEqual(decide(runs), { ok: true, index: 2 });
  });

  it("reports the run closest to its limit when none passed, and no run at all as a failure", () => {
    const far = judge(at(150, 900), at(50, 200), settings);
    const near = judge(at(150, 620), at(50, 200), settings);
    const missing = judge(at(Number.NaN, Number.NaN), at(1, 2), settings);
    assert.equal(far.ok || near.ok, false);
    assert.deepEqual(decide([missing, far, near]), { ok: false, index: 2 });
    assert.deepEqual(decide([]), { ok: false, index: -1 });
  });

  it("names the gate the way the checks do", () => {
    assert.equal(gateWords(settings), "p95 ≤ 25 ms, or on a machine too busy to measure that, ≤ 3× a one-query control on the same callers");
  });
});

describe("a run the machine slept through", () => {
  // The run of 12:19 IST: the Mac slept 12:19:36–12:34:37 (pmset -g log), one control request "took" 900 009 ms.
  const asleep = frozenVerdict(at(0.63, 1.84), at(0.47, 1.29), 899_500);

  it("fails, says it measured nothing, and names the stall", () => {
    assert.equal(asleep.ok, false);
    assert.equal(asleep.frozenMs, 899_500);
    assert.match(asleep.reason, /not measured/);
    assert.match(asleep.reason, /899\.5 s/);
    assert.match(asleep.reason, new RegExp(`${MAX_FROZEN_RUNS} tries`));
  });

  it("is never the run closest to its limit, even with small numbers", () => {
    const slow = judge(at(40, 90), at(20, 25), settings);
    assert.equal(slow.ok, false);
    assert.deepEqual(decide([asleep, slow]), { ok: false, index: 1 });
    assert.deepEqual(decide([slow, asleep]), { ok: false, index: 0 });
  });

  it("does not hide a later run that passed, and fails when every run slept", () => {
    const fine = judge(at(0.6, 1.8), at(0.5, 1.3), settings);
    assert.deepEqual(decide([asleep, fine]), { ok: true, index: 1 });
    assert.deepEqual(decide([asleep, asleep]), { ok: false, index: 0 });
  });
});

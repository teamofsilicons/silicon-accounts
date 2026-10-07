/**
 * The verify latency gate of proofs-perf-latency-verify, as pure functions (unit tests: test/latency-gate.test.ts).
 *
 * The budget is p95 ≤ 25 ms locally. A p95 measured on a machine that other stacks keep busy is mostly the machine:
 * in the run that failed the gate (load average 46 to 112 on 14 cores, about ten stacks on one Postgres), GET /readyz
 * (one database round trip) had p95 74 ms from 50 concurrent callers, against 2 ms on a quiet machine, so no endpoint
 * could have met 25 ms there. Every gated run therefore interleaves the verifies with a one-query control (an indexed
 * lookup that answers 404) on the same callers, through the same path, so both see the same moments of the machine:
 *
 * - When the control leaves room for the budget (factor × control p95 + slack ≤ budget, i.e. control p95 ≤ 8 ms),
 *   the run is quiet enough to measure the budget, and verify must meet it: p95 ≤ 25 ms.
 * - When the control alone would eat the budget, 25 ms cannot be measured. Verify must then cost no more than the
 *   control does, within a factor: p95 ≤ 3 × control p95 + 1 ms and p50 ≤ 3 × control p50 + 1 ms. A busy machine
 *   slows both alike, while a verify that does more work keeps its distance however busy the machine is. Measured at
 *   load 48 to 172 on 14 cores, interleaved on the same callers, straight and through the site, sequential and at 50:
 *   the real verify 0.95–1.35× the control at p50 and 1.02–1.53× at p95; the real verify followed by one more
 *   one-query round trip 2.4–2.7× at p50 (passes: room for one more query); followed by three more, 4.6–6.3× at p50
 *   (fails in every configuration).
 *
 * A verify p95 within the budget passes in any window (a busy machine only adds latency). The gate takes the best of
 * up to three runs. E2E_LATENCY_GATE=strict turns the busy-machine rule off (only p95 ≤ budget passes), for a
 * benchmark on a machine kept quiet on purpose.
 *
 * A run during which the benchmark's process stalled for seconds (lib.ts watchStalls, FROZEN_STALL_MS) measured a
 * machine that was not running, not load: the Mac slept (12:19:36–12:34:37 by `pmset -g log` in one run, a control
 * request then "took" 900 s and the run's throughput read 2 req/s; in another, a keep-alive connection was reset at
 * wake). Such a run is measured again, up to MAX_FROZEN_RUNS times; only a measurement frozen every time gets
 * frozenVerdict, which fails (nothing was measured) and never counts as the closest run.
 */

export interface Percentiles {
  p50: number;
  p95: number;
}

export interface GateSettings {
  /** The budget: verify's p95 in milliseconds. */
  budgetP95Ms: number;
  /** On a busy machine, verify may take this many times the control (p50 and p95)… */
  factor: number;
  /** …plus this many milliseconds (room for timer and scheduling jitter on sub-millisecond numbers). */
  slackMs: number;
  /** Only the budget decides (E2E_LATENCY_GATE=strict). */
  strict: boolean;
  /** Runs per measurement, stopping at the first that passes. */
  attempts: number;
}

export const LATENCY_GATE: GateSettings = {
  budgetP95Ms: 25,
  factor: 3,
  slackMs: 1,
  strict: process.env.E2E_LATENCY_GATE === "strict",
  attempts: 3,
};

export interface Verdict {
  ok: boolean;
  /** "quiet": the control left room to measure the budget; "busy": the control alone would have eaten it. */
  window: "quiet" | "busy";
  verify: Percentiles;
  control: Percentiles;
  /** What verify's p95 (and on a busy machine its p50) had to stay within in this run. */
  limitP95Ms: number;
  limitP50Ms: number | null;
  reason: string;
  /** Set when every try of the run was frozen (the longest stall of the last one, ms): nothing was measured. */
  frozenMs?: number;
}

/** Tries of one run whose process stalled (the machine slept) before the run is given up as unmeasurable. */
export const MAX_FROZEN_RUNS = 3;

const ms = (value: number) => `${value.toFixed(2)} ms`;

/** The highest control p95 at which the budget can still be measured: factor × p95 + slack ≤ budget. */
export function quietControlP95(settings: GateSettings = LATENCY_GATE): number {
  return (settings.budgetP95Ms - settings.slackMs) / settings.factor;
}

/** One run: verify's percentiles next to the control's, interleaved on the same callers. */
export function judge(verify: Percentiles, control: Percentiles, settings: GateSettings = LATENCY_GATE): Verdict {
  const budget = settings.budgetP95Ms;
  const relative95 = settings.factor * control.p95 + settings.slackMs;
  const relative50 = settings.factor * control.p50 + settings.slackMs;
  const window = relative95 > budget ? "busy" : "quiet";
  const base = { window, verify, control } as const;
  const head = `verify p95 ${ms(verify.p95)}, p50 ${ms(verify.p50)}; one-query control p95 ${ms(control.p95)}, p50 ${ms(control.p50)}`;
  const quietLimit = ms(quietControlP95(settings));
  if (![verify.p50, verify.p95, control.p50, control.p95].every(Number.isFinite)) {
    return { ...base, ok: false, limitP95Ms: budget, limitP50Ms: null, reason: `${head}: a run without numbers cannot pass` };
  }
  if (verify.p95 <= budget) {
    const where = window === "quiet" ? "quiet enough to measure" : "although the machine was busy";
    return { ...base, ok: true, limitP95Ms: budget, limitP50Ms: null, reason: `${head}: p95 within the ${budget} ms budget (${where})` };
  }
  if (window === "quiet") {
    return {
      ...base,
      ok: false,
      limitP95Ms: budget,
      limitP50Ms: null,
      reason: `${head}: p95 over the ${budget} ms budget while the control left room to measure it (control p95 ≤ ${quietLimit}), so verify itself is slow`,
    };
  }
  if (settings.strict) {
    return {
      ...base,
      ok: false,
      limitP95Ms: budget,
      limitP50Ms: null,
      reason: `${head}: p95 over the ${budget} ms budget on a busy machine (the control alone was over ${quietLimit} at p95); E2E_LATENCY_GATE=strict judges the budget only, so measure on a quiet machine`,
    };
  }
  const ok = verify.p95 <= relative95 && verify.p50 <= relative50;
  const limits = `p95 ≤ ${settings.factor} × ${ms(control.p95)} + ${settings.slackMs} = ${ms(relative95)}, p50 ≤ ${settings.factor} × ${ms(control.p50)} + ${settings.slackMs} = ${ms(relative50)}`;
  return {
    ...base,
    ok,
    limitP95Ms: relative95,
    limitP50Ms: relative50,
    reason: ok
      ? `${head}: busy machine (the control alone was over ${quietLimit} at p95, so the ${budget} ms budget cannot be measured), and verify cost no more than the control allows (${limits})`
      : `${head}: busy machine, and verify costs more than ${settings.factor}× a one-query request (${limits})`,
  };
}

/** How far over its limit a run was (at most 1: within it; a run without numbers is infinitely far). */
const overLimit = (verdict: Verdict) => {
  if (verdict.frozenMs !== undefined) return Number.POSITIVE_INFINITY;
  const p95 = verdict.verify.p95 / verdict.limitP95Ms;
  const over = verdict.limitP50Ms === null ? p95 : Math.max(p95, verdict.verify.p50 / verdict.limitP50Ms);
  return Number.isFinite(over) ? over : Number.POSITIVE_INFINITY;
};

/** A run that was frozen in every try (stallMs: the last try's longest stall): it measured the sleep, so it fails. */
export function frozenVerdict(verify: Percentiles, control: Percentiles, stallMs: number, tries = MAX_FROZEN_RUNS, settings: GateSettings = LATENCY_GATE): Verdict {
  return {
    ok: false,
    window: "busy",
    verify,
    control,
    limitP95Ms: settings.budgetP95Ms,
    limitP50Ms: null,
    frozenMs: stallMs,
    reason:
      `not measured: this benchmark's process stood still for ${(stallMs / 1000).toFixed(1)} s in each of ${tries} tries ` +
      `(the machine was asleep or stopped, see \`pmset -g log\`), so its numbers are the sleep's, not verify's ` +
      `(verify p95 ${ms(verify.p95)}, control p95 ${ms(control.p95)}); keep the machine awake (\`caffeinate -i\`) and measure again`,
  };
}

/** Best of the runs: the first that passed, else the one closest to its limit (index -1: no run at all). */
export function decide(verdicts: Verdict[]): { ok: boolean; index: number } {
  const passed = verdicts.findIndex(verdict => verdict.ok);
  if (passed >= 0) return { ok: true, index: passed };
  let best = -1;
  verdicts.forEach((verdict, index) => {
    if (best < 0 || overLimit(verdict) < overLimit(verdicts[best]!)) best = index;
  });
  return { ok: false, index: best };
}

/** The gate in the words of a check name (the same for every measurement). */
export function gateWords(settings: GateSettings = LATENCY_GATE): string {
  return settings.strict
    ? `p95 ≤ ${settings.budgetP95Ms} ms (strict)`
    : `p95 ≤ ${settings.budgetP95Ms} ms, or on a machine too busy to measure that, ≤ ${settings.factor}× a one-query control on the same callers`;
}

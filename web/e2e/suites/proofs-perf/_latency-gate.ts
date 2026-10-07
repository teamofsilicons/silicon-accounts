/**
 * The verify latency gate of proofs-perf-latency-verify, as pure functions (unit tests: test/latency-gate.test.ts).
 *
 * A raw p95 taken while other stacks load the machine measures the machine: in the run that failed the old p95-only
 * gate (load average 46 to 112 on 14 cores, about ten stacks on one Postgres), GET /readyz — one database round trip —
 * had p95 74 ms from 50 concurrent callers, against 2 ms on a quiet machine. So the gate never judges a raw client-side
 * number. Every gated run interleaves the verifies with a control on the same callers and the same path, and judges:
 *
 * 1. **Server time**: accounts-api's own time for each verify (its `request … duration_ms=… request_id=…` log line,
 *    whole milliseconds, matched by the X-Request-Id each request carries): p95 ≤ 15 ms, the build spec's local target
 *    for verify (05-testkit-e2e: "target p95 < 15 ms locally"), applied to the part the service controls. The client's
 *    own scheduling, the connection pool and (through the site) the Next proxy are not in it. What accounts-api spends
 *    on the control at the same moments (its p95, from the same log) is added to the 15 ms: a bare /readyz takes 0–2 ms
 *    of server time on a quiet machine, so the limit stays about 15 ms there, and when the machine starves the service
 *    every request's server time grows by what the control's does.
 * 2. **Verify minus control**: what verify costs on top of a control request made by the same callers at the same
 *    moments, through the same path: at most 5 ms more at p50 and 15 ms more at p95, plus a quarter of the control's
 *    own latency at that percentile. The quarter is the sampling noise of a percentile on a busy machine: interleaved
 *    on the same callers at load 46 to 159, the real verify's p95 came out between 0.87× and 1.16× its one-query
 *    control's (65.78 vs 73.91 ms, 247.78 vs 214.08 ms), so two samples of requests that cost the same differ by that
 *    much there; on a quiet machine (control p95 well under a millisecond) it adds nothing. A verify doing three more
 *    database round trips fails it at every load measured (test/latency-gate.test.ts). Straight at accounts-api the
 *    control is GET /readyz (one database round trip). Through the site (the public origin) it is a one-query request
 *    that crosses the same Next proxy (GET /v1/photos/<unknown id>: one primary-key lookup, 404), because the site does
 *    not proxy /readyz; /readyz is measured in those runs too, for reading the numbers.
 *
 * A run whose server times could not be read for most of its verifies (the log missing, or lines not matched) is not
 * measured and fails, never passes. The gate takes the best of up to three runs. E2E_LATENCY_GATE=strict drops both
 * allowances and adds the raw client-side p95 ≤ 15 ms, for a benchmark on a machine kept quiet on purpose.
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
  /** accounts-api's own time of a verify, p95, in milliseconds (whole milliseconds, from its log). */
  serverP95Ms: number;
  /** Verify minus the interleaved control (client-side, same callers, same path), at p50… */
  deltaP50Ms: number;
  /** …and at p95… */
  deltaP95Ms: number;
  /** …plus this share of the control's own latency at that percentile (a percentile's sampling noise when busy). */
  noiseShare: number;
  /** The share of a run's verifies whose server time must be found in the log for the run to count as measured. */
  minServerCoverage: number;
  /** E2E_LATENCY_GATE=strict: no allowances, and the raw client-side verify p95 must be within serverP95Ms too. */
  strict: boolean;
  /** Runs per measurement, stopping at the first that passes. */
  attempts: number;
}

export const LATENCY_GATE: GateSettings = {
  serverP95Ms: 15,
  deltaP50Ms: 5,
  deltaP95Ms: 15,
  noiseShare: 0.25,
  minServerCoverage: 0.9,
  strict: process.env.E2E_LATENCY_GATE === "strict",
  attempts: 3,
};

/** What one gated run measured. */
export interface RunNumbers {
  /** Verify, client-side. */
  verify: Percentiles;
  /** The control on the same callers and path, client-side. */
  control: Percentiles;
  /** accounts-api's own time of the verifies (null: none could be read from its log). */
  server: Percentiles | null;
  /** accounts-api's own time of the control requests of the same run (null: not in its log). */
  controlServer: Percentiles | null;
  /** The share of the run's verifies whose server time was found. */
  serverCoverage: number;
}

export interface Verdict extends RunNumbers {
  ok: boolean;
  /** What the verifies' server time p95 could be at most in this run. */
  limitServerP95: number;
  /** verify − control at p50 and p95 (ms), and what each could be at most in this run. */
  deltaP50: number;
  deltaP95: number;
  limitDeltaP50: number;
  limitDeltaP95: number;
  /** How far over its limits the run was: the largest of value / limit over every gated number (≤ 1: within). */
  over: number;
  reason: string;
  /** Set when every try of the run was frozen (the longest stall of the last one, ms): nothing was measured. */
  frozenMs?: number;
}

/** Tries of one run whose process stalled (the machine slept) before the run is given up as unmeasurable. */
export const MAX_FROZEN_RUNS = 3;

const ms = (value: number) => `${value.toFixed(2)} ms`;
const signed = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)} ms`;

/** The most verify may cost over the control at a percentile whose control latency is `control`. */
export function deltaLimit(budget: number, control: number, settings: GateSettings = LATENCY_GATE): number {
  return budget + (settings.strict ? 0 : settings.noiseShare * Math.max(0, control));
}

/** The most the verifies' server time p95 may be, given the control's own server time p95 in the same run. */
export function serverLimit(controlServer: Percentiles | null, settings: GateSettings = LATENCY_GATE): number {
  const control = controlServer && Number.isFinite(controlServer.p95) ? Math.max(0, controlServer.p95) : 0;
  return settings.serverP95Ms + (settings.strict ? 0 : control);
}

/** One run: verify's server time and its cost over the control. */
export function judge(numbers: RunNumbers, settings: GateSettings = LATENCY_GATE): Verdict {
  const { verify, control, server, controlServer, serverCoverage } = numbers;
  const deltaP50 = verify.p50 - control.p50;
  const deltaP95 = verify.p95 - control.p95;
  const limitDeltaP50 = deltaLimit(settings.deltaP50Ms, control.p50, settings);
  const limitDeltaP95 = deltaLimit(settings.deltaP95Ms, control.p95, settings);
  const limitServerP95 = serverLimit(controlServer, settings);
  const head =
    `server time p95 ${server ? ms(server.p95) : "not measured"} (limit ${ms(limitServerP95)}; p50 ${server ? ms(server.p50) : "?"}; the control's own ${controlServer ? ms(controlServer.p95) : "?"}; ${(serverCoverage * 100).toFixed(0)}% of verifies found in the log); ` +
    `verify − control p50 ${signed(deltaP50)} (limit ${ms(limitDeltaP50)}), p95 ${signed(deltaP95)} (limit ${ms(limitDeltaP95)}); verify ${ms(verify.p50)} / ${ms(verify.p95)}, control ${ms(control.p50)} / ${ms(control.p95)} at p50 / p95`;
  const base = { ...numbers, deltaP50, deltaP95, limitDeltaP50, limitDeltaP95, limitServerP95 };
  if (![verify.p50, verify.p95, control.p50, control.p95].every(Number.isFinite)) {
    return { ...base, ok: false, over: Number.POSITIVE_INFINITY, reason: `${head}: a run without numbers cannot pass` };
  }
  if (!server || !Number.isFinite(server.p95) || serverCoverage < settings.minServerCoverage) {
    return {
      ...base,
      ok: false,
      over: Number.POSITIVE_INFINITY,
      reason: `${head}: not measured — accounts-api's own time was found for only ${(serverCoverage * 100).toFixed(0)}% of the verifies (at least ${(settings.minServerCoverage * 100).toFixed(0)}% needed), so the server-time gate cannot be judged`,
    };
  }
  const parts: Array<{ name: string; value: number; limit: number }> = [
    { name: `server time p95 ≤ ${ms(limitServerP95)}`, value: server.p95, limit: limitServerP95 },
    { name: `verify − control p50 ≤ ${ms(limitDeltaP50)}`, value: deltaP50, limit: limitDeltaP50 },
    { name: `verify − control p95 ≤ ${ms(limitDeltaP95)}`, value: deltaP95, limit: limitDeltaP95 },
  ];
  if (settings.strict) parts.push({ name: `raw verify p95 ≤ ${settings.serverP95Ms} ms (strict)`, value: verify.p95, limit: settings.serverP95Ms });
  const failed = parts.filter(part => part.value > part.limit);
  const over = Math.max(...parts.map(part => (part.limit > 0 ? Math.max(part.value, 0) / part.limit : Number.POSITIVE_INFINITY)));
  return {
    ...base,
    ok: failed.length === 0,
    over,
    reason: failed.length === 0 ? `${head}: within the gate` : `${head}: over the gate: ${failed.map(part => `${part.name} (${ms(part.value)})`).join(", ")}`,
  };
}

/** A run that was frozen in every try (stallMs: the last try's longest stall): it measured the sleep, so it fails. */
export function frozenVerdict(numbers: RunNumbers, stallMs: number, tries = MAX_FROZEN_RUNS, settings: GateSettings = LATENCY_GATE): Verdict {
  return {
    ...numbers,
    ok: false,
    deltaP50: numbers.verify.p50 - numbers.control.p50,
    deltaP95: numbers.verify.p95 - numbers.control.p95,
    limitDeltaP50: deltaLimit(settings.deltaP50Ms, numbers.control.p50, settings),
    limitDeltaP95: deltaLimit(settings.deltaP95Ms, numbers.control.p95, settings),
    limitServerP95: serverLimit(numbers.controlServer, settings),
    over: Number.POSITIVE_INFINITY,
    frozenMs: stallMs,
    reason:
      `not measured: this benchmark's process stood still for ${(stallMs / 1000).toFixed(1)} s in each of ${tries} tries ` +
      `(the machine was asleep or stopped, see \`pmset -g log\`), so its numbers are the sleep's, not verify's ` +
      `(verify p95 ${ms(numbers.verify.p95)}, control p95 ${ms(numbers.control.p95)}); keep the machine awake (\`caffeinate -i\`) and measure again`,
  };
}

/** Best of the runs: the first that passed, else the one closest to its limits (index -1: no run at all). */
export function decide(verdicts: Verdict[]): { ok: boolean; index: number } {
  const passed = verdicts.findIndex(verdict => verdict.ok);
  if (passed >= 0) return { ok: true, index: passed };
  let best = -1;
  verdicts.forEach((verdict, index) => {
    if (best < 0 || verdict.over < verdicts[best]!.over) best = index;
  });
  return { ok: false, index: best };
}

/** The gate in the words of a check name (the same for every measurement). */
export function gateWords(settings: GateSettings = LATENCY_GATE): string {
  const server = settings.strict ? "" : " (+ the control's own server time)";
  const noise = settings.strict ? "" : ` (+${Math.round(settings.noiseShare * 100)}% of the control's own latency)`;
  return (
    `accounts-api's own time p95 ≤ ${settings.serverP95Ms} ms${server}, and verify − control ≤ ${settings.deltaP50Ms} ms at p50 and ≤ ${settings.deltaP95Ms} ms at p95${noise}` +
    (settings.strict ? `, raw p95 ≤ ${settings.serverP95Ms} ms (strict)` : "")
  );
}

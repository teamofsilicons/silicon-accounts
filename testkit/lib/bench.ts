// Latency measurement for e2e benchmarks (e.g. 1000 sequential proof verifies, then 50 concurrent).

export interface LatencyStats {
  count: number;
  errors: number;
  concurrency: number;
  min_ms: number;
  mean_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  total_ms: number;
  throughput_per_s: number;
}

/** Nearest-rank percentile of an ascending-sorted list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

export function summarize(samples: number[], errors: number, totalMs: number, concurrency: number): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    errors,
    concurrency,
    min_ms: round(sorted[0] ?? Number.NaN),
    mean_ms: round(sorted.length ? sum / sorted.length : Number.NaN),
    p50_ms: round(percentile(sorted, 50)),
    p95_ms: round(percentile(sorted, 95)),
    p99_ms: round(percentile(sorted, 99)),
    max_ms: round(sorted.at(-1) ?? Number.NaN),
    total_ms: round(totalMs),
    throughput_per_s: round(totalMs > 0 ? (sorted.length / totalMs) * 1000 : 0),
  };
}

/**
 * Runs `fn` `count` times with at most `concurrency` calls in flight and reports latency
 * percentiles. A call that throws counts as an error (its time is not sampled).
 *
 *   const stats = await measure(1000, 1, () => app.verifyProof(token));
 *   const burst = await measure(50, 50, () => app.verifyProof(token));
 */
export async function measure(count: number, concurrency: number, fn: (index: number) => Promise<unknown>): Promise<LatencyStats> {
  const samples: number[] = [];
  let errors = 0;
  let next = 0;
  const started = performance.now();
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      const t0 = performance.now();
      try {
        await fn(index);
        samples.push(performance.now() - t0);
      } catch {
        errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, () => worker()));
  return summarize(samples, errors, performance.now() - started, concurrency);
}

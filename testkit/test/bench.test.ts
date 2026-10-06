import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measure, percentile } from '../lib/bench.ts';

test('percentile uses nearest rank', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 95);
  assert.equal(percentile(sorted, 99), 99);
  assert.equal(percentile([7], 99), 7);
});

test('measure respects concurrency and counts errors', async () => {
  let inFlight = 0;
  let peak = 0;
  const stats = await measure(40, 8, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight -= 1;
    if (i % 10 === 0) throw new Error('boom');
  });
  assert.equal(peak, 8);
  assert.equal(stats.errors, 4);
  assert.equal(stats.count, 36);
  assert.ok(stats.p50_ms >= 1 && stats.p99_ms >= stats.p50_ms);
});

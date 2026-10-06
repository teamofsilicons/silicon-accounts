// `pnpm -C testkit journeys [name…]`: runs the journeys (all, or those whose file name starts with
// one of the given names, e.g. `c` or `e-import`) against a running stack, one process each, and
// prints a summary. Exit 1 when any journey failed. scripts/journeys.sh starts a fresh stack first.
//
// Each journey sends X-Forwarded-For from its own random 10.x address (TESTKIT_FORWARDED_FOR=random,
// honoured when accounts-api runs with ACCOUNTS_TRUST_FORWARDED_FOR=true), so the per-network limit
// of 30 codes per 10 minutes applies per journey instead of to the whole run.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const wanted = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => /^[a-z]-[a-z0-9-]+\.ts$/.test(f))
  .sort()
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)));
if (files.length === 0) {
  console.error(`error: no journey matches ${wanted.join(', ')}\nhint: journeys are ${readdirSync(dir).filter((f) => /^[a-z]-/.test(f)).join(', ')}`);
  process.exit(2);
}

const results: Array<{ file: string; code: number | null; seconds: number }> = [];
for (const file of files) {
  console.log(`\n######## ${file}`);
  const started = performance.now();
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(tsx, [`${dir}${file}`], {
      stdio: 'inherit',
      env: { ...process.env, TESTKIT_FORWARDED_FOR: process.env.TESTKIT_FORWARDED_FOR ?? 'random' },
    });
    child.on('close', resolve);
  });
  results.push({ file, code, seconds: Math.round((performance.now() - started) / 100) / 10 });
}

console.log('\n######## summary');
for (const r of results) console.log(`  ${r.code === 0 ? 'pass' : 'FAIL'}  ${r.file.padEnd(26)} ${String(r.seconds).padStart(6)} s`);
const failed = results.filter((r) => r.code !== 0);
console.log(failed.length ? `\n${failed.length} of ${results.length} journeys failed` : `\nall ${results.length} journeys passed`);
process.exitCode = failed.length ? 1 : 0;

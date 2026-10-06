// Writes fixtures/imports/big.csv: N valid rows (default 100,000) for import throughput runs.
//   pnpm -C testkit gen:big [--rows 100000] [--seed 42] [--tag bulk] [--phone-ratio 0.2] [--out path]
// Rows are deterministic for a seed + tag. Use a new --tag per run to import into a database
// that already holds an earlier big import (emails, usernames and external ids carry the tag;
// phones do not, so pass --phone-ratio 0 for repeated runs in one database).

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { bigCsvLines, importFixturePath } from '../../lib/fixtures.ts';

const args = process.argv.slice(2);
const options: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? '';
  const eq = arg.indexOf('=');
  const name = (eq < 0 ? arg : arg.slice(0, eq)).replace(/^--/, '');
  const inline = eq < 0 ? undefined : arg.slice(eq + 1);
  if (!arg.startsWith('--') || !['rows', 'seed', 'tag', 'phone-ratio', 'out'].includes(name)) {
    process.stderr.write(`error: unexpected argument "${arg}"\nhint: pnpm -C testkit gen:big [--rows 100000] [--seed 42] [--tag bulk] [--phone-ratio 0.2] [--out path]\n`);
    process.exit(2);
  }
  const value = inline ?? args[++i];
  if (value === undefined) {
    process.stderr.write(`error: --${name} needs a value\n`);
    process.exit(2);
  }
  options[name] = value;
}

const rows = Number(options.rows ?? 100_000);
const seed = Number(options.seed ?? 42);
const phoneRatio = Number(options['phone-ratio'] ?? 0.2);
if (!Number.isInteger(rows) || rows < 1 || rows > 100_000) {
  process.stderr.write(`error: --rows must be an integer from 1 to 100000 (the import limit), got "${options.rows}"\n`);
  process.exit(2);
}
if (!(phoneRatio >= 0 && phoneRatio <= 1)) {
  process.stderr.write(`error: --phone-ratio must be between 0 and 1, got "${options['phone-ratio']}"\n`);
  process.exit(2);
}
const out = options.out ?? importFixturePath('big.csv');
const started = performance.now();
const stream = createWriteStream(out);
let bytes = 0;
for (const line of bigCsvLines({ rows, seed, tag: options.tag ?? 'bulk', phoneRatio })) {
  const chunk = `${line}\n`;
  bytes += Buffer.byteLength(chunk);
  if (!stream.write(chunk)) await once(stream, 'drain');
}
stream.end();
await once(stream, 'finish');
process.stdout.write(`wrote ${out}: ${rows} rows, ${(bytes / 1_048_576).toFixed(1)} MB in ${Math.round(performance.now() - started)} ms\n`);

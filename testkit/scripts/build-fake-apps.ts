// Writes testkit/fake-apps.json from src/fake-apps/definitions.ts + dev-credentials.json.
//   pnpm -C testkit gen:apps            # write the file
//   pnpm -C testkit gen:apps --check    # exit 1 if the committed file is stale

import { readFileSync, writeFileSync } from 'node:fs';
import { FAKE_APPS_PATH, loadDevCredentials } from '../src/credentials.ts';
import { buildFakeApps } from '../src/fake-apps/definitions.ts';

const rendered = `${JSON.stringify(buildFakeApps(loadDevCredentials()), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(FAKE_APPS_PATH, 'utf8');
  } catch {
    // treated as stale below
  }
  if (current !== rendered) {
    process.stderr.write(`error: ${FAKE_APPS_PATH} is out of date with src/fake-apps/definitions.ts.\nhint: run \`pnpm -C testkit gen:apps\`.\n`);
    process.exit(1);
  }
  process.stdout.write('fake-apps.json is up to date\n');
} else {
  writeFileSync(FAKE_APPS_PATH, rendered);
  process.stdout.write(`wrote ${FAKE_APPS_PATH}\n`);
}

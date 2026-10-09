// `pnpm -C testkit start` (alias `pnpm -C testkit mocks`): starts mock-oidc (8591),
// mock-messaging (8592), the fake app server (8593) and mock-iris (8594, the default profile
// photos), and with --silicon-apps-port the stand-in Silicon Apps API, until Ctrl-C / SIGTERM.
//
// Flags (env in brackets):
//   --host <ip>              [TESTKIT_HOST]          bind address (default 127.0.0.1)
//   --oidc-port <n>          [MOCK_OIDC_PORT]        default 8591
//   --messaging-port <n>     [MOCK_MESSAGING_PORT]   default 8592
//   --fake-apps-port <n>     [FAKE_APPS_PORT]        default 8593
//   --iris-port <n>          [MOCK_IRIS_PORT]        default 8594
//   --silicon-apps-port <n>  [MOCK_SILICON_APPS_PORT] the stand-in Silicon Apps API (the developer site's APPS_API_URL);
//                                                    not started without it
//   --accounts-url <url>     [ACCOUNTS_URL]          Silicon Accounts for the fake apps (default http://127.0.0.1:8589)
//   --ready-file <path>                              write {"oidc","messaging","fake_apps","iris","silicon_apps"} URLs as JSON once listening
//   --log                    [TESTKIT_LOG=1]         one line per request on stderr
//   --quiet                                          only print errors

import { writeFileSync } from 'node:fs';
import { startTestkit } from './testkit.ts';

function usage(problem: string): never {
  process.stderr.write(`error: ${problem}\nhint: pnpm -C testkit start [--host 127.0.0.1] [--oidc-port 8591] [--messaging-port 8592] [--fake-apps-port 8593] [--iris-port 8594] [--silicon-apps-port 8596] [--accounts-url http://127.0.0.1:8589] [--ready-file path] [--log] [--quiet]\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = new Map<string, string | true>();
const VALUE_FLAGS = new Set(['host', 'oidc-port', 'messaging-port', 'fake-apps-port', 'iris-port', 'silicon-apps-port', 'accounts-url', 'ready-file']);
const BOOLEAN_FLAGS = new Set(['log', 'quiet', 'help']);
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? '';
  if (!arg.startsWith('--')) usage(`unexpected argument "${arg}"`);
  const eq = arg.indexOf('=');
  const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
  const inline = eq < 0 ? undefined : arg.slice(eq + 1);
  if (BOOLEAN_FLAGS.has(name)) {
    flags.set(name, true);
    continue;
  }
  if (!VALUE_FLAGS.has(name)) usage(`unknown flag --${name}`);
  const value = inline ?? args[++i];
  if (value === undefined || value.startsWith('--')) usage(`--${name} needs a value`);
  flags.set(name, value);
}
if (flags.has('help')) {
  process.stdout.write('Starts the Silicon Accounts testkit: mock-oidc, mock-messaging, the fake app server and mock-iris. See testkit/README.md.\n');
  process.exit(0);
}

function port(flag: string, envName: string, fallback: number): number {
  const raw = flags.get(flag) ?? process.env[envName];
  if (raw === undefined || raw === true) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) usage(`--${flag} / ${envName} must be a port number (0-65535), got "${raw}"`);
  return n;
}

const quiet = flags.has('quiet');
const log = flags.has('log') || process.env.TESTKIT_LOG === '1';
const host = (flags.get('host') as string | undefined) ?? process.env.TESTKIT_HOST ?? '127.0.0.1';
const accountsUrl = (flags.get('accounts-url') as string | undefined) ?? process.env.ACCOUNTS_URL ?? 'http://127.0.0.1:8589';

let kit: Awaited<ReturnType<typeof startTestkit>>;
try {
  kit = await startTestkit({
    host,
    oidcPort: port('oidc-port', 'MOCK_OIDC_PORT', 8591),
    messagingPort: port('messaging-port', 'MOCK_MESSAGING_PORT', 8592),
    fakeAppsPort: port('fake-apps-port', 'FAKE_APPS_PORT', 8593),
    irisPort: port('iris-port', 'MOCK_IRIS_PORT', 8594),
    ...(flags.has('silicon-apps-port') || process.env.MOCK_SILICON_APPS_PORT ? { siliconAppsPort: port('silicon-apps-port', 'MOCK_SILICON_APPS_PORT', 0) } : {}),
    accountsUrl,
    log,
  });
} catch (error) {
  process.stderr.write(`error: the testkit could not start: ${(error as Error).message}\n`);
  process.exit(1);
}

const urls = { oidc: kit.oidc?.url ?? null, messaging: kit.messaging?.url ?? null, fake_apps: kit.fakeApps?.url ?? null, iris: kit.iris?.url ?? null, silicon_apps: kit.siliconApps?.url ?? null, accounts_url: accountsUrl };
const readyFile = flags.get('ready-file');
if (typeof readyFile === 'string') writeFileSync(readyFile, `${JSON.stringify(urls, null, 2)}\n`);

if (!quiet) {
  process.stdout.write(
    [
      'Silicon Accounts testkit is running',
      `  mock-oidc        ${urls.oidc}   (Google issuer ${kit.oidc?.issuer.google}, Apple issuer ${kit.oidc?.issuer.apple})`,
      `  mock-messaging   ${urls.messaging}   (Postmark ${kit.messaging?.postmarkApiUrl}, Twilio ${kit.messaging?.twilioApiUrl})`,
      `  fake apps        ${urls.fake_apps}/   (${kit.fakeApps?.apps.length ?? 0} apps, talking to Silicon Accounts at ${accountsUrl})`,
      `  mock-iris        ${urls.iris}   (default profile photos: ACCOUNTS_IRIS_BASE_URL)`,
      ...(urls.silicon_apps ? [`  silicon apps     ${urls.silicon_apps}   (the stand-in Silicon Apps API: the developer site's APPS_API_URL)`] : []),
      '',
      'Point Silicon Accounts at the mocks with: pnpm -s -C testkit accounts-env > .env.mocks (see testkit/README.md)',
      'Press Ctrl-C to stop.',
      '',
    ].join('\n'),
  );
}
process.stdout.write(`testkit ready ${JSON.stringify(urls)}\n`);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    process.stderr.write(`received ${signal} again; exiting immediately\n`);
    process.exit(1);
  }
  stopping = true;
  if (!quiet) process.stdout.write(`\nreceived ${signal}; stopping the testkit…\n`);
  const timer = setTimeout(() => {
    process.stderr.write('error: the testkit did not stop within 5 s; exiting anyway\n');
    process.exit(1);
  }, 5_000);
  timer.unref();
  await kit.stop();
  if (!quiet) process.stdout.write('testkit stopped\n');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

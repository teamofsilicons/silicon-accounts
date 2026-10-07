// `pnpm -s -C testkit accounts-env [--format dotenv|shell|json] [--oidc-url URL] [--messaging-url URL]
//                                  [--iris-url URL] [--api-port N] [--public-url URL] [--no-topology]`
// prints the ACCOUNTS_* variables for a local Silicon Accounts: the testkit mocks (email/SMS to
// mock-messaging, managed Google/Apple to mock-oidc, default profile photos from mock-iris) and the topology (accounts-api on
// 127.0.0.1:8589 behind the account site on http://localhost:8590, client addresses taken from
// X-Forwarded-For). --no-topology prints the mock settings only.
//   pnpm -s -C testkit accounts-env > .env.mocks                 # dotenv (default)
//   eval "$(pnpm -s -C testkit accounts-env --format shell)"     # export into the current shell

import { accountsEnvForMocks, accountsTopologyEnv, toDotenv, toShellExports } from '../lib/env.ts';

const USAGE = 'pnpm -s -C testkit accounts-env [--format dotenv|shell|json] [--oidc-url URL] [--messaging-url URL] [--iris-url URL] [--api-port N] [--public-url URL] [--no-topology]';
const args = process.argv.slice(2);
const options: Record<string, string> = {};
let topology = true;
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? '';
  if (arg === '--no-topology') {
    topology = false;
    continue;
  }
  const eq = arg.indexOf('=');
  const name = (eq < 0 ? arg : arg.slice(0, eq)).replace(/^--/, '');
  const inline = eq < 0 ? undefined : arg.slice(eq + 1);
  if (!arg.startsWith('--') || !['format', 'oidc-url', 'messaging-url', 'iris-url', 'api-port', 'public-url'].includes(name)) {
    process.stderr.write(`error: unexpected argument "${arg}"\nhint: ${USAGE}\n`);
    process.exit(2);
  }
  const value = inline ?? args[++i];
  if (!value) {
    process.stderr.write(`error: --${name} needs a value\nhint: ${USAGE}\n`);
    process.exit(2);
  }
  options[name] = value;
}

// Empty variables count as unset.
const apiPortRaw = options['api-port'] || process.env.ACCOUNTS_API_PORT || '8589';
const apiPort = Number(apiPortRaw);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535) {
  process.stderr.write(`error: --api-port must be a port number, got "${apiPortRaw}"\nhint: ${USAGE}\n`);
  process.exit(2);
}
const publicUrl = options['public-url'] || process.env.ACCOUNTS_PUBLIC_URL || `http://localhost:${process.env.ACCOUNTS_PORT || 8590}`;
if (topology && !URL.canParse(publicUrl)) {
  process.stderr.write(`error: --public-url must be an absolute URL like http://localhost:8590, got "${publicUrl}"\nhint: ${USAGE}\n`);
  process.exit(2);
}

const env = {
  ...accountsEnvForMocks({
    oidcUrl: options['oidc-url'] ?? `http://127.0.0.1:${process.env.MOCK_OIDC_PORT ?? 8591}`,
    messagingUrl: options['messaging-url'] ?? `http://127.0.0.1:${process.env.MOCK_MESSAGING_PORT ?? 8592}`,
    irisUrl: options['iris-url'] ?? `http://127.0.0.1:${process.env.MOCK_IRIS_PORT ?? 8594}`,
  }),
  ...(topology ? accountsTopologyEnv({ apiPort, publicUrl }) : {}),
};
const format = options.format ?? 'dotenv';
if (format === 'json') process.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
else if (format === 'shell') process.stdout.write(toShellExports(env));
else if (format === 'dotenv') process.stdout.write(`# Silicon Accounts → testkit mocks (development only)\n${toDotenv(env)}`);
else {
  process.stderr.write(`error: --format must be dotenv, shell or json, got "${format}"\n`);
  process.exit(2);
}

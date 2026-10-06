// `pnpm -s -C testkit accounts-env [--format dotenv|shell|json] [--oidc-url URL] [--messaging-url URL]`
// prints the ACCOUNTS_* variables that point Silicon Accounts at the testkit mocks.
//   pnpm -s -C testkit accounts-env > .env.mocks                 # dotenv (default)
//   eval "$(pnpm -s -C testkit accounts-env --format shell)"     # export into the current shell

import { accountsEnvForMocks, toDotenv, toShellExports } from '../lib/env.ts';

const args = process.argv.slice(2);
const options: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? '';
  const eq = arg.indexOf('=');
  const name = (eq < 0 ? arg : arg.slice(0, eq)).replace(/^--/, '');
  const inline = eq < 0 ? undefined : arg.slice(eq + 1);
  if (!arg.startsWith('--') || !['format', 'oidc-url', 'messaging-url'].includes(name)) {
    process.stderr.write(`error: unexpected argument "${arg}"\nhint: pnpm -s -C testkit accounts-env [--format dotenv|shell|json] [--oidc-url URL] [--messaging-url URL]\n`);
    process.exit(2);
  }
  const value = inline ?? args[++i];
  if (!value) {
    process.stderr.write(`error: --${name} needs a value\n`);
    process.exit(2);
  }
  options[name] = value;
}

const env = accountsEnvForMocks({
  oidcUrl: options['oidc-url'] ?? `http://127.0.0.1:${process.env.MOCK_OIDC_PORT ?? 8591}`,
  messagingUrl: options['messaging-url'] ?? `http://127.0.0.1:${process.env.MOCK_MESSAGING_PORT ?? 8592}`,
});
const format = options.format ?? 'dotenv';
if (format === 'json') process.stdout.write(`${JSON.stringify(env, null, 2)}\n`);
else if (format === 'shell') process.stdout.write(toShellExports(env));
else if (format === 'dotenv') process.stdout.write(`# Silicon Accounts → testkit mocks (development only)\n${toDotenv(env)}`);
else {
  process.stderr.write(`error: --format must be dotenv, shell or json, got "${format}"\n`);
  process.exit(2);
}

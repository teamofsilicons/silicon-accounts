// Generates testkit/dev-credentials.json: mock-only Google/Apple client credentials
// (managed + bring-your-own), Postmark/Twilio tokens and the mock providers' signing keys.
//
//   pnpm -C testkit gen:credentials           # refuses to overwrite an existing file
//   pnpm -C testkit gen:credentials --force   # rotate everything, then run `pnpm -C testkit gen:apps`
//
// fake-apps.json embeds the bring-your-own credentials, so after --force regenerate it.

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { DEV_CREDENTIALS_PATH, type AppleClientCredentials, type DevCredentials, type GoogleClientCredentials } from '../src/credentials.ts';
import { randomHex, randomLowerAlnum, randomUpperAlnum } from '../src/shared/util.ts';

function googleClient(): GoogleClientCredentials {
  // Deliberately invalid for real providers; safe to commit without resembling live credentials.
  return {
    client_id: `mock-google-${randomLowerAlnum(32)}.invalid`,
    client_secret: `mock-google-secret-${randomHex(28)}`,
  };
}

function appleClient(servicesId: string): AppleClientCredentials {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    services_id: servicesId,
    team_id: randomUpperAlnum(10),
    key_id: randomUpperAlnum(10),
    private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function rsaSigningKey(provider: string): { kid: string; private_key_pem: string } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid: `mock-${provider}-${randomHex(12)}`, private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

const force = process.argv.includes('--force');
if (existsSync(DEV_CREDENTIALS_PATH) && !force) {
  process.stderr.write(
    `error: ${DEV_CREDENTIALS_PATH} already exists.\nhint: pass --force to rotate every credential, then run \`pnpm -C testkit gen:apps\` so fake-apps.json picks up the new bring-your-own clients.\n`,
  );
  process.exit(1);
}

const credentials: DevCredentials = {
  _comment:
    'Development-only credentials for the Silicon Accounts testkit mocks (mock Google/Apple, mock Postmark/Twilio). They are accepted by nothing except the testkit; never use them in production.',
  version: 1,
  generated_at: new Date().toISOString(),
  managed: {
    google: googleClient(),
    apple: appleClient('com.teamofsilicons.accounts.dev'),
  },
  byo: {
    'acme-notes': { google: googleClient() },
    'orbit-games': { apple: appleClient('test.orbit-games.signin') },
  },
  messaging: {
    postmark: { server_token: randomUUID(), from: 'accounts@teamofsilicons.com', message_stream: 'outbound' },
    twilio: {
      account_sid: `mock-twilio-${randomHex(32)}`,
      auth_token: randomHex(32),
      messaging_service_sid: `MG${randomHex(32)}`,
      // Twilio's magic "valid" test sender number.
      from: '+15005550006',
    },
  },
  mock_oidc_signing_keys: {
    google: rsaSigningKey('google'),
    apple: rsaSigningKey('apple'),
  },
};

writeFileSync(DEV_CREDENTIALS_PATH, `${JSON.stringify(credentials, null, 2)}\n`);
process.stdout.write(`wrote ${DEV_CREDENTIALS_PATH}\nnext: pnpm -C testkit gen:apps\n`);

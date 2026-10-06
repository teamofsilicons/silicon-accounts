// Development-only credentials for the mock providers: the "managed" Google client and
// Apple Services ID that Silicon Accounts uses for one-click sign-in, the bring-your-own
// clients of the fake apps acme-notes (Google) and orbit-games (Apple), the Postmark and
// Twilio tokens mock-messaging accepts, and the mock providers' own id_token signing keys.
// Generated once by scripts/generate-dev-credentials.ts and committed: none of these
// values work anywhere except against the testkit mocks.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface GoogleClientCredentials {
  client_id: string;
  client_secret: string;
}

export interface AppleClientCredentials {
  services_id: string;
  team_id: string;
  key_id: string;
  /** The p8 key (PKCS#8 PEM, EC P-256). */
  private_key_pem: string;
  public_key_pem: string;
}

export interface DevCredentials {
  _comment: string;
  version: number;
  generated_at: string;
  managed: {
    google: GoogleClientCredentials;
    apple: AppleClientCredentials;
  };
  byo: {
    'acme-notes': { google: GoogleClientCredentials };
    'orbit-games': { apple: AppleClientCredentials };
  };
  messaging: {
    postmark: { server_token: string; from: string; message_stream: string };
    twilio: { account_sid: string; auth_token: string; messaging_service_sid: string; from: string };
  };
  mock_oidc_signing_keys: {
    google: { kid: string; private_key_pem: string };
    apple: { kid: string; private_key_pem: string };
  };
}

export const TESTKIT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEV_CREDENTIALS_PATH = fileURLToPath(new URL('../dev-credentials.json', import.meta.url));
export const FAKE_APPS_PATH = fileURLToPath(new URL('../fake-apps.json', import.meta.url));

export function loadDevCredentials(path: string = DEV_CREDENTIALS_PATH): DevCredentials {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read the testkit dev credentials at ${path}: ${(error as Error).message}. Generate them with \`pnpm -C testkit gen:credentials\` (then \`pnpm -C testkit gen:apps\`).`,
    );
  }
  const parsed = JSON.parse(raw) as DevCredentials;
  if (parsed.version !== 1 || !parsed.managed?.google?.client_id || !parsed.managed?.apple?.private_key_pem) {
    throw new Error(`${path} is not a version-1 testkit credentials file (managed.google / managed.apple missing).`);
  }
  return parsed;
}

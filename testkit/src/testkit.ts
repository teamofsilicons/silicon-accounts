// Starts the testkit servers in-process, wired to the dev credentials:
// mock-oidc knows the managed Google/Apple clients and the bring-your-own clients of
// acme-notes (Google) and orbit-games (Apple); mock-messaging accepts the dev
// Postmark/Twilio credentials; the fake app server talks to Silicon Accounts at accountsUrl;
// mock-iris draws the default profile photos (ACCOUNTS_IRIS_BASE_URL).

import { accountsEnvForMocks } from '../lib/env.ts';
import { loadDevCredentials, type DevCredentials } from './credentials.ts';
import { start as startFakeApps, type FakeAppServer } from './fake-app-server.ts';
import { loadFakeApps } from './fake-apps/load.ts';
import type { SiliconAppsApp } from './fake-apps/types.ts';
import { start as startIris, type MockIris } from './mock-iris.ts';
import { start as startMessaging, type MockMessaging } from './mock-messaging.ts';
import { start as startOidc, type MockOidc, type OidcClientInput } from './mock-oidc.ts';

export interface TestkitOptions {
  host?: string;
  /** Ports (defaults 8591/8592/8593/8594; 0 = any free port). */
  oidcPort?: number;
  messagingPort?: number;
  fakeAppsPort?: number;
  irisPort?: number;
  /** Silicon Accounts for the fake apps' server-to-server calls (default $ACCOUNTS_URL or http://127.0.0.1:8589). */
  accountsUrl?: string;
  /** Silicon Accounts as browsers see it (default $ACCOUNTS_PUBLIC_URL, else discovered via /v1/meta). */
  accountsPublicUrl?: string;
  credentials?: DevCredentials;
  apps?: SiliconAppsApp[];
  /** Set false to skip a server. */
  oidc?: boolean;
  messaging?: boolean;
  fakeApps?: boolean;
  iris?: boolean;
  log?: boolean | ((line: string) => void);
}

export interface RunningTestkit {
  oidc: MockOidc | null;
  messaging: MockMessaging | null;
  fakeApps: FakeAppServer | null;
  iris: MockIris | null;
  credentials: DevCredentials;
  /** ACCOUNTS_* variables pointing Silicon Accounts at these mocks. */
  accountsEnv: Record<string, string>;
  stop(): Promise<void>;
}

/** The provider clients mock-oidc must know: managed + the fake apps' bring-your-own clients. */
export function oidcClientsFromCredentials(credentials: DevCredentials, apps: SiliconAppsApp[] = []): OidcClientInput[] {
  const logo = (appId: string): string | null => apps.find((a) => a.app_id === appId)?.logo_url ?? null;
  return [
    {
      provider: 'google',
      client_id: credentials.managed.google.client_id,
      client_secret: credentials.managed.google.client_secret,
      display_name: 'Silicon Accounts',
      label: 'managed',
    },
    {
      provider: 'apple',
      client_id: credentials.managed.apple.services_id,
      team_id: credentials.managed.apple.team_id,
      key_id: credentials.managed.apple.key_id,
      public_key_pem: credentials.managed.apple.public_key_pem,
      display_name: 'Silicon Accounts',
      label: 'managed',
    },
    {
      provider: 'google',
      client_id: credentials.byo['acme-notes'].google.client_id,
      client_secret: credentials.byo['acme-notes'].google.client_secret,
      display_name: 'Acme Notes',
      logo_url: logo('acme-notes'),
      label: 'byo:acme-notes',
    },
    {
      provider: 'apple',
      client_id: credentials.byo['orbit-games'].apple.services_id,
      team_id: credentials.byo['orbit-games'].apple.team_id,
      key_id: credentials.byo['orbit-games'].apple.key_id,
      public_key_pem: credentials.byo['orbit-games'].apple.public_key_pem,
      display_name: 'Orbit Games',
      logo_url: logo('orbit-games'),
      label: 'byo:orbit-games',
    },
  ];
}

export async function startTestkit(options: TestkitOptions = {}): Promise<RunningTestkit> {
  const credentials = options.credentials ?? loadDevCredentials();
  const apps = options.apps ?? loadFakeApps();
  const started: Array<{ stop(): Promise<void> }> = [];
  try {
    const oidc =
      options.oidc === false
        ? null
        : await startOidc({
            ...(options.host ? { host: options.host } : {}),
            port: options.oidcPort ?? 8591,
            clients: oidcClientsFromCredentials(credentials, apps),
            signingKeys: credentials.mock_oidc_signing_keys,
            log: options.log ?? false,
          });
    if (oidc) started.push(oidc);
    const messaging =
      options.messaging === false
        ? null
        : await startMessaging({
            ...(options.host ? { host: options.host } : {}),
            port: options.messagingPort ?? 8592,
            postmark: { serverTokens: [credentials.messaging.postmark.server_token], senders: [credentials.messaging.postmark.from], messageStreams: [credentials.messaging.postmark.message_stream, 'broadcast'] },
            twilio: {
              accountSid: credentials.messaging.twilio.account_sid,
              authToken: credentials.messaging.twilio.auth_token,
              messagingServiceSids: [credentials.messaging.twilio.messaging_service_sid],
              fromNumbers: [credentials.messaging.twilio.from],
            },
            log: options.log ?? false,
          });
    if (messaging) started.push(messaging);
    const fakeApps =
      options.fakeApps === false
        ? null
        : await startFakeApps({
            ...(options.host ? { host: options.host } : {}),
            port: options.fakeAppsPort ?? 8593,
            ...(options.accountsUrl ? { accountsUrl: options.accountsUrl } : {}),
            ...(options.accountsPublicUrl ? { accountsPublicUrl: options.accountsPublicUrl } : {}),
            apps,
            log: options.log ?? false,
          });
    if (fakeApps) started.push(fakeApps);
    const iris =
      options.iris === false
        ? null
        : await startIris({
            ...(options.host ? { host: options.host } : {}),
            port: options.irisPort ?? 8594,
            log: options.log ?? false,
          });
    if (iris) started.push(iris);
    return {
      oidc,
      messaging,
      fakeApps,
      iris,
      credentials,
      accountsEnv: accountsEnvForMocks(
        { oidcUrl: oidc?.url ?? 'http://127.0.0.1:8591', messagingUrl: messaging?.url ?? 'http://127.0.0.1:8592', irisUrl: iris?.url ?? 'http://127.0.0.1:8594' },
        credentials,
      ),
      async stop() {
        await Promise.all(started.map((s) => s.stop()));
      },
    };
  } catch (error) {
    await Promise.all(started.map((s) => s.stop()));
    throw error;
  }
}

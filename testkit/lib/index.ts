// @silicon-accounts/testkit — everything the e2e suites need in one import.

export * from './accounts.ts';
export * from './bench.ts';
export * from './env.ts';
export * from './fake-apps.ts';
export * from './fixtures.ts';
export * from './http.ts';
export * from './mocks.ts';
export * from './pkce.ts';
export * from './signature.ts';
export type * from './types.ts';

export { start as startMockOidc, DEFAULT_IDENTITIES, DEFAULT_MOCK_OIDC_PORT, type MockOidc, type MockOidcOptions, type OidcClientInput, type OidcIdentityInput } from '../src/mock-oidc.ts';
export { start as startMockMessaging, DEFAULT_MOCK_MESSAGING_PORT, extractCodes, type MockMessaging, type MockMessagingOptions } from '../src/mock-messaging.ts';
export { start as startFakeAppServer, DEFAULT_FAKE_APPS_PORT, SESSION_COOKIE, type FakeAppServer, type FakeAppServerOptions } from '../src/fake-app-server.ts';
export { startTestkit, oidcClientsFromCredentials, type RunningTestkit, type TestkitOptions } from '../src/testkit.ts';
export { loadDevCredentials, DEV_CREDENTIALS_PATH, FAKE_APPS_PATH, type DevCredentials } from '../src/credentials.ts';

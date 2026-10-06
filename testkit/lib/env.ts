// The ACCOUNTS_* environment that points Silicon Accounts at the testkit mocks.

import { loadDevCredentials, type DevCredentials } from '../src/credentials.ts';

export interface MockUrls {
  /** mock-oidc base URL (default http://127.0.0.1:8591). */
  oidcUrl?: string;
  /** mock-messaging base URL (default http://127.0.0.1:8592). */
  messagingUrl?: string;
}

/**
 * Environment variables for accounts-api so that:
 * - email/SMS go to mock-messaging (ACCOUNTS_DELIVERY=providers + Postmark/Twilio URLs and tokens),
 * - managed Google/Apple sign-in goes to mock-oidc with the dev managed credentials.
 * The Apple private key value contains real newlines (PEM).
 */
export function accountsEnvForMocks(urls: MockUrls = {}, credentials: DevCredentials = loadDevCredentials()): Record<string, string> {
  const oidc = (urls.oidcUrl ?? 'http://127.0.0.1:8591').replace(/\/+$/, '');
  const messaging = (urls.messagingUrl ?? 'http://127.0.0.1:8592').replace(/\/+$/, '');
  const { google, apple } = credentials.managed;
  const { postmark, twilio } = credentials.messaging;
  return {
    ACCOUNTS_DELIVERY: 'providers',
    ACCOUNTS_POSTMARK_API_URL: `${messaging}/postmark`,
    ACCOUNTS_POSTMARK_SERVER_TOKEN: postmark.server_token,
    ACCOUNTS_POSTMARK_FROM: postmark.from,
    ACCOUNTS_TWILIO_API_URL: `${messaging}/twilio`,
    ACCOUNTS_TWILIO_ACCOUNT_SID: twilio.account_sid,
    ACCOUNTS_TWILIO_AUTH_TOKEN: twilio.auth_token,
    ACCOUNTS_TWILIO_MESSAGING_SERVICE_SID: twilio.messaging_service_sid,
    ACCOUNTS_TWILIO_FROM: twilio.from,
    ACCOUNTS_GOOGLE_CLIENT_ID: google.client_id,
    ACCOUNTS_GOOGLE_CLIENT_SECRET: google.client_secret,
    ACCOUNTS_GOOGLE_AUTH_URL: `${oidc}/google/authorize`,
    ACCOUNTS_GOOGLE_TOKEN_URL: `${oidc}/google/token`,
    ACCOUNTS_GOOGLE_JWKS_URL: `${oidc}/google/jwks`,
    ACCOUNTS_GOOGLE_ISSUERS: `${oidc}/google`,
    ACCOUNTS_APPLE_SERVICES_ID: apple.services_id,
    ACCOUNTS_APPLE_TEAM_ID: apple.team_id,
    ACCOUNTS_APPLE_KEY_ID: apple.key_id,
    ACCOUNTS_APPLE_PRIVATE_KEY: apple.private_key_pem,
    ACCOUNTS_APPLE_AUTH_URL: `${oidc}/apple/authorize`,
    ACCOUNTS_APPLE_TOKEN_URL: `${oidc}/apple/token`,
    ACCOUNTS_APPLE_JWKS_URL: `${oidc}/apple/jwks`,
    ACCOUNTS_APPLE_ISSUER: `${oidc}/apple`,
    ACCOUNTS_WEBHOOK_ALLOW_PRIVATE: 'true',
  };
}

export interface Topology {
  /** accounts-api's port on 127.0.0.1 (default 8589). */
  apiPort?: number;
  /** The public origin browsers, apps and the CLI use: the account site (default http://localhost:8590). */
  publicUrl?: string;
}

/**
 * The topology of a local stack: accounts-api listens on 127.0.0.1:<apiPort> behind the account
 * site (Next.js) on the public URL, which proxies /v1/* and /.well-known/* to it. The site passes
 * X-Forwarded-For through, so accounts-api takes the client address from it
 * (ACCOUNTS_TRUST_FORWARDED_FOR=true; the right-most entry wins).
 */
export function accountsTopologyEnv(topology: Topology = {}): Record<string, string> {
  const apiPort = topology.apiPort ?? 8589;
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65_535) throw new Error(`apiPort must be a port number, got ${apiPort}`);
  const publicUrl = (topology.publicUrl ?? 'http://localhost:8590').replace(/\/+$/, '');
  return {
    ACCOUNTS_BIND_ADDR: `127.0.0.1:${apiPort}`,
    ACCOUNTS_PUBLIC_URL: publicUrl,
    ACCOUNTS_TRUST_FORWARDED_FOR: 'true',
  };
}

/**
 * Renders env vars as a .env file for dotenvy (what accounts-api loads in development):
 * values needing quotes are double-quoted with \\, \", \$ and \n escapes, so the multi-line
 * Apple PEM stays on one line.
 */
export function toDotenv(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([key, value]) =>
      /[\s"'#\\$]/.test(value)
        ? `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('\n', '\\n')}"`
        : `${key}=${value}`,
    )
    .join('\n')}\n`;
}

/** Renders env vars as POSIX shell `export` lines (single-quoted, newlines preserved). */
export function toShellExports(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([key, value]) => `export ${key}='${value.replaceAll("'", `'"'"'`)}'`)
    .join('\n')}\n`;
}

// Read access to testkit/fake-apps.json for tests: app credentials, redirect URIs, owners.

import { loadFakeApps } from '../src/fake-apps/load.ts';
import type { SiliconAppsApp } from '../src/fake-apps/types.ts';

export type { SiliconAppsApp };

let cache: SiliconAppsApp[] | null = null;

/** Every fake app (cached). */
export function fakeApps(): SiliconAppsApp[] {
  cache ??= loadFakeApps();
  return cache;
}

export function fakeApp(appId: string): SiliconAppsApp {
  const app = fakeApps().find((a) => a.app_id === appId);
  if (!app) throw new Error(`Unknown fake app "${appId}". Known: ${fakeApps().map((a) => a.app_id).join(', ')}.`);
  return app;
}

/** {app_id, secret} for HTTP Basic auth as that app. */
export function appCredentials(appId: string): { app_id: string; secret: string } {
  const app = fakeApp(appId);
  return { app_id: app.app_id, secret: app.secret };
}

/**
 * The redirect URI registered for `appId`, re-based onto `fakeAppsUrl` when the fake app
 * server runs elsewhere (Silicon Accounts matches 127.0.0.1 redirect URIs ignoring the port).
 */
export function redirectUri(appId: string, fakeAppsUrl: string = process.env.FAKE_APPS_URL ?? 'http://127.0.0.1:8593'): string {
  return `${fakeAppsUrl.replace(/\/+$/, '')}/${appId}/callback`;
}

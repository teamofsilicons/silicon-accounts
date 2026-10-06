// Reads testkit/fake-apps.json (or another file with the same shape).

import { readFileSync } from 'node:fs';
import { FAKE_APPS_PATH } from '../credentials.ts';
import type { FakeAppsFile, SiliconAppsApp } from './types.ts';

export function loadFakeAppsFile(path: string = FAKE_APPS_PATH): FakeAppsFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read fake apps at ${path}: ${(error as Error).message}. Generate it with \`pnpm -C testkit gen:apps\`.`);
  }
  const parsed = JSON.parse(raw) as FakeAppsFile | SiliconAppsApp[];
  // Accept a bare list too, so a SiliconAppsApp[] export from Silicon Apps works as-is.
  if (Array.isArray(parsed)) return { _comment: '', version: 1, fake_app_server: 'http://127.0.0.1:8593', apps: parsed };
  if (!Array.isArray(parsed.apps)) throw new Error(`${path} has no "apps" array.`);
  return parsed;
}

export function loadFakeApps(path?: string): SiliconAppsApp[] {
  return loadFakeAppsFile(path).apps;
}

export function findFakeApp(apps: SiliconAppsApp[], appId: string): SiliconAppsApp {
  const app = apps.find((a) => a.app_id === appId);
  if (!app) throw new Error(`Unknown fake app "${appId}". Known: ${apps.map((a) => a.app_id).join(', ')}.`);
  return app;
}

/**
 * The tabs of an app (`/apps/[appId]/[[...tab]]`; no tab = overview). Framework-free and free of icons, so proxy.ts can
 * answer an unknown tab with a real 404 before anything renders; lib/navigation.ts re-exports these for the pages.
 */
export const APP_TABS = ["overview", "sign-in", "details", "flows", "pages", "users", "import", "webhooks", "ata", "embed"] as const;
export type AppTab = (typeof APP_TABS)[number];

/** The tab a `[[...tab]]` segment list names, or null when it names none (that address is not a page: 404). */
export function appTabFrom(segments: string[] | undefined): AppTab | null {
  if (!segments || segments.length === 0) return "overview";
  if (segments.length > 1) return null;
  const tab = segments[0] as AppTab;
  return (APP_TABS as readonly string[]).includes(tab) && tab !== "overview" ? tab : null;
}

/** For a pathname under /apps/<appId>/…: true when it names no tab. Other paths, the overview and its tabs are false. */
export function isUnknownAppTab(pathname: string): boolean {
  const match = /^\/apps\/[^/]+\/(.+)$/.exec(pathname);
  if (!match) return false;
  const segments = (match[1] ?? "").split("/").filter(Boolean);
  return appTabFrom(segments) === null;
}

/** Tabs of the account site's old developer pages, now named otherwise here (its /developer/{app}/{tab} redirects land on them). */
const RENAMED: Record<string, AppTab> = { branding: "pages", proofs: "ata" };

/** The current address of an old tab's address (`/apps/briefcase/branding` → `/apps/briefcase/pages`), or null. */
export function renamedAppTab(pathname: string): string | null {
  const match = /^(\/apps\/[^/]+)\/([^/]+)\/?$/.exec(pathname);
  const tab = match ? RENAMED[match[2] ?? ""] : undefined;
  return match && tab ? `${match[1]}/${tab}` : null;
}

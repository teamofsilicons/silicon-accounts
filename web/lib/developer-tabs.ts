/**
 * The tabs of an app in the developer area (`/developer/[appId]/[[...tab]]`; no tab = overview). Framework-free and
 * free of icons, so proxy.ts can answer an unknown tab with a real 404 before anything renders; lib/navigation.ts
 * re-exports these for the pages.
 */
export const DEVELOPER_TABS = ["overview", "sign-in", "branding", "users", "import", "webhooks", "proofs", "embed"] as const;
export type DeveloperTab = (typeof DEVELOPER_TABS)[number];

/** The tab a `[[...tab]]` segment list names, or null when it names none (that address is not a page: 404). */
export function developerTabFrom(segments: string[] | undefined): DeveloperTab | null {
  if (!segments || segments.length === 0) return "overview";
  if (segments.length > 1) return null;
  const tab = segments[0] as DeveloperTab;
  return (DEVELOPER_TABS as readonly string[]).includes(tab) ? tab : null;
}

/**
 * For a pathname under /developer/<appId>/…: true when it names no tab (`/developer/briefcase/bogus`,
 * `/developer/briefcase/sign-in/extra`). Other paths, the app's overview and its tabs are false.
 */
export function isUnknownDeveloperTab(pathname: string): boolean {
  const match = /^\/developer\/[^/]+\/(.+)$/.exec(pathname);
  if (!match) return false;
  const segments = (match[1] ?? "").split("/").filter(Boolean);
  return developerTabFrom(segments) === null;
}

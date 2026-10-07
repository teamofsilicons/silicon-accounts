/**
 * Document titles of an app's pages. The page (app/(shell)/apps/[appId]/[[...tab]]) names the tab on a first load
 * through Next's metadata; switching tabs changes only the address (app-scope.tsx), so the scope sets the same title in
 * the browser. Not a client module: the server page imports it too.
 */
import { DEVELOPER_TAB_LABELS, type DeveloperTab } from "@/lib/navigation";

/** "Sign-in · briefcase"; the root layout's title template adds the site's name after it. */
export function developerTitle(tab: DeveloperTab, appId: string): string {
  return `${tab === "overview" ? "Overview" : DEVELOPER_TAB_LABELS[tab]} · ${appId}`;
}

/** The whole document title, as the root layout's template ("%s · Silicon Developer") renders it. */
export function developerDocumentTitle(tab: DeveloperTab, appId: string): string {
  return `${developerTitle(tab, appId)} · Silicon Developer`;
}

/**
 * Every path of the developer site, and the tabs of an app. Link with `paths`, never string literals.
 *
 * The developer area's code was ported from the account site (web/components/developer), whose names it keeps:
 * `paths.developer` is the apps home here, `paths.developerApp(appId, tab)` an app's tab, `DEVELOPER_TABS` the tabs.
 */
import { APP_TABS, appTabFrom, type AppTab } from "./app-tabs";

export const paths = {
  home: "/",
  signIn: "/sign-in",
  docs: "/docs",
  settings: "/settings",
  invitations: "/invitations",
  appVerification: (appId?: string) => `/app-verification${appId ? `?app_id=${encodeURIComponent(appId)}` : ""}`,
  /** The apps home. */
  developer: "/",
  developerApp: (appId: string, tab?: AppTab) => `/apps/${encodeURIComponent(appId)}${tab && tab !== "overview" ? `/${tab}` : ""}`,
  authSignIn: (returnTo?: string, prompt?: "login" | "select_account") => {
    const query = new URLSearchParams();
    if (returnTo) query.set("return_to", returnTo);
    if (prompt) query.set("prompt", prompt);
    const text = query.toString();
    return `/auth/sign-in${text ? `?${text}` : ""}`;
  },
} as const;

export { APP_TABS as DEVELOPER_TABS, appTabFrom as developerTabFrom, type AppTab as DeveloperTab };

export const DEVELOPER_TAB_LABELS: Record<AppTab, string> = {
  overview: "Overview",
  publishing: "Publishing",
  releases: "Releases",
  authors: "Authors",
  history: "History",
  "sign-in": "Sign-in",
  details: "Details",
  flows: "Flows",
  pages: "Pages",
  users: "Users",
  import: "Import",
  webhooks: "Webhooks",
  ata: "App verification",
  embed: "Embed",
};

/** The tab index of a path under an app (-1 elsewhere), for the direction of page transitions. */
function tabIndex(pathname: string): number {
  const match = /^\/apps\/[^/]+(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return -1;
  return APP_TABS.indexOf((match[1] ?? "overview") as AppTab);
}

/** The view-transition type for moving between two paths: forward to a later tab, back to an earlier one, else a fade. */
export function navigationType(from: string, to: string): "nav-forward" | "nav-back" | "nav-fade" {
  const a = tabIndex(from);
  const b = tabIndex(to);
  if (a < 0 || b < 0 || a === b) return "nav-fade";
  return b > a ? "nav-forward" : "nav-back";
}

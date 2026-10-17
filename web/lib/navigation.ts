/**
 * The account site's four pillars (the dock, the phone sheet, number-key shortcuts and the command palette all read
 * SECTIONS) and the route paths every page links to. Link with `paths`, never string literals.
 *
 * The pillars follow the jobs in "Silicon Accounts Redesign Design Review": Identity (who you are), Security (your ways
 * in), Access (apps that can act as you or see you) and Custodianship (Silicons you answer for). Pages that are part of
 * a pillar without being its front page (Proofs, Activity) are listed under it in `includes`, so the dock marks the
 * right pillar there, and reached from the palette (MORE_DESTINATIONS) and from links, not from the dock.
 *
 * Building apps is not part of the account site. The developer site and its docs (developers.teamofsilicons.com,
 * `developer_url` in GET /v1/meta) are ELSEWHERE: quiet links in the top row, the phone sheet's foot and the command
 * palette, never a dock section. /developer[/*] here redirects there (proxy.ts).
 */
import type { LucideIcon } from "lucide-react";
import { BookOpen, Braces, Cpu, History, IdCard, KeyRound, LayoutGrid, ShieldCheck } from "lucide-react";

/** The developer site when GET /v1/meta does not name one (servers before it existed). */
export const DEFAULT_DEVELOPER_URL = "https://developers.teamofsilicons.com";

/**
 * The developer site's address from GET /v1/meta `developer_url`, when it is a usable http(s) address; else the
 * production one. Trailing slashes are dropped, so paths can be appended.
 */
export function developerSiteUrl(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    try {
      const url = new URL(value.trim());
      if (url.protocol === "https:" || url.protocol === "http:") return url.href.replace(/\/+$/, "");
    } catch {
      // Not an address: the default below.
    }
  }
  return DEFAULT_DEVELOPER_URL;
}

/** Shared public documentation, on the same configured origin as app management. */
export function developerDocsUrl(developerUrl: string = DEFAULT_DEVELOPER_URL): string {
  return `${developerUrl.replace(/\/+$/, "")}/docs`;
}

/** Every route of the web app. */
export const paths = {
  home: "/",
  signIn: "/sign-in",
  authorize: "/authorize",
  flow: (id: string) => `/authorize/flow/${encodeURIComponent(id)}`,
  device: "/device",
  signInMethods: "/sign-in-methods",
  apps: "/apps",
  silicons: "/silicons",
  proofs: "/proofs",
  activity: "/activity",
  settings: "/settings",
  docs: "/docs",
  embedButtons: "/embed/v1/buttons",
  kitchen: "/__kitchen",
} as const;

export type SectionKey = "identity" | "security" | "access" | "custodianship";

export interface Section {
  key: SectionKey;
  label: string;
  /** One line for the command palette and the phone sheet. */
  description: string;
  /** A path of this site. */
  href: string;
  icon: LucideIcon;
  /** The number key that jumps here. */
  shortcut: string;
  /** Other paths of this pillar (and everything under them). */
  includes?: readonly string[];
}

export const SECTIONS: readonly Section[] = [
  { key: "identity", label: "Identity", description: "Your card: name, id, photo and details", href: paths.home, icon: IdCard, shortcut: "1" },
  { key: "security", label: "Security", description: "Your ways in, where you are signed in, and activity", href: paths.signInMethods, icon: KeyRound, shortcut: "2", includes: [paths.activity] },
  { key: "access", label: "Access", description: "Apps you signed into, what they can see, and apps acting for you", href: paths.apps, icon: LayoutGrid, shortcut: "3", includes: [paths.proofs] },
  { key: "custodianship", label: "Custodianship", description: "Silicons you are custodian of", href: paths.silicons, icon: Cpu, shortcut: "4" },
];

/** Account pages that belong to a pillar but are not in the dock: reached from the command palette and from links. */
export const MORE_DESTINATIONS = [
  { key: "proofs", label: "User verification", description: "Apps acting on your behalf at other apps", href: paths.proofs, icon: ShieldCheck },
  { key: "activity", label: "Activity", description: "Sign-ins and changes, by day", href: paths.activity, icon: History },
] as const;

/** Another site the account site points to: always a full navigation, marked with an arrow, never the active section. */
export interface Elsewhere {
  key: "developer" | "docs";
  label: string;
  description: string;
  icon: LucideIcon;
  /** The live address, from the developer site's address the service names (developerSiteUrl). */
  href: (developerUrl: string) => string;
}

export const ELSEWHERE: readonly Elsewhere[] = [
  { key: "developer", label: "Developers", description: "Add Silicon Accounts to the apps you build", icon: Braces, href: url => url },
  { key: "docs", label: "Docs", description: "How Silicon Apps and Silicon Accounts work", icon: BookOpen, href: url => developerDocsUrl(url) },
];

/** The section a path belongs to (Settings belongs to none: the dock shows no active section there). */
export function sectionFor(pathname: string): Section | undefined {
  if (pathname === "/" || pathname === "") return SECTIONS[0];
  const within = (path: string) => path !== "/" && (pathname === path || pathname.startsWith(`${path}/`));
  return SECTIONS.find(section => within(section.href) || section.includes?.some(within));
}

export function sectionIndex(pathname: string): number {
  const section = sectionFor(pathname);
  return section ? SECTIONS.indexOf(section) : -1;
}

/**
 * The view-transition type for moving between two paths along the dock: "nav-forward" to the right, "nav-back" to
 * the left, "nav-fade" when either side is not a section (Settings, a nested page).
 */
export function navigationType(from: string, to: string): "nav-forward" | "nav-back" | "nav-fade" {
  const a = sectionIndex(from);
  const b = sectionIndex(to);
  if (a < 0 || b < 0 || a === b) return "nav-fade";
  return b > a ? "nav-forward" : "nav-back";
}

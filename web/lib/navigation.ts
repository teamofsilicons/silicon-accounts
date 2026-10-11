/**
 * The account site's top-level sections (the dock, the phone sheet, number-key shortcuts and the command palette all
 * read this list) and the route paths every page links to. Link with `paths`, never string literals.
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

export type SectionKey = "identity" | "sign-in" | "apps" | "silicons" | "proofs" | "activity";

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
}

export const SECTIONS: readonly Section[] = [
  { key: "identity", label: "Identity", description: "Your card: name, id, photo and details", href: paths.home, icon: IdCard, shortcut: "1" },
  { key: "sign-in", label: "Sign-in", description: "Emails, phone numbers and Google or Apple", href: paths.signInMethods, icon: KeyRound, shortcut: "2" },
  { key: "apps", label: "Apps", description: "Apps you signed into and what they can see", href: paths.apps, icon: LayoutGrid, shortcut: "3" },
  { key: "silicons", label: "Silicons", description: "Silicons you are custodian of", href: paths.silicons, icon: Cpu, shortcut: "4" },
  { key: "proofs", label: "User verification", description: "Apps acting on your behalf", href: paths.proofs, icon: ShieldCheck, shortcut: "5" },
  { key: "activity", label: "Activity", description: "Sign-ins and changes, by day", href: paths.activity, icon: History, shortcut: "6" },
];

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
  return SECTIONS.find(section => section.href !== "/" && (pathname === section.href || pathname.startsWith(`${section.href}/`)));
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

/**
 * The account site's top-level sections (the dock, the phone sheet, number-key shortcuts and the command palette all
 * read this list) and the route paths every page links to. Link with `paths`, never string literals.
 *
 * Building apps is not part of the account site: the Developer section leads to the developer site
 * (developers.teamofsilicons.com, `developer_url` in GET /v1/meta), and /developer[/*] here redirects there (proxy.ts).
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

export type SectionKey = "identity" | "sign-in" | "apps" | "silicons" | "proofs" | "activity" | "developer" | "docs";

export interface Section {
  key: SectionKey;
  label: string;
  /** One line for the command palette and the phone sheet. */
  description: string;
  /** A path of this site, or (external) the default address of another site: use `sectionHref` for the live one. */
  href: string;
  icon: LucideIcon;
  /** The number key that jumps here. */
  shortcut: string;
  /** Another site (the developer site): a full navigation, never a page of the shell. */
  external?: boolean;
}

export const SECTIONS: readonly Section[] = [
  { key: "identity", label: "Identity", description: "Your card: name, id, photo and details", href: paths.home, icon: IdCard, shortcut: "1" },
  { key: "sign-in", label: "Sign-in", description: "Emails, phone numbers and Google or Apple", href: paths.signInMethods, icon: KeyRound, shortcut: "2" },
  { key: "apps", label: "Apps", description: "Apps you signed into and what they can see", href: paths.apps, icon: LayoutGrid, shortcut: "3" },
  { key: "silicons", label: "Silicons", description: "Silicons you are custodian of", href: paths.silicons, icon: Cpu, shortcut: "4" },
  { key: "proofs", label: "User verification", description: "Apps acting on your behalf", href: paths.proofs, icon: ShieldCheck, shortcut: "5" },
  { key: "activity", label: "Activity", description: "Sign-ins and changes, by day", href: paths.activity, icon: History, shortcut: "6" },
  { key: "developer", label: "Developer", description: "Set up sign-in for the apps you build", href: DEFAULT_DEVELOPER_URL, icon: Braces, shortcut: "7", external: true },
  { key: "docs", label: "Docs", description: "Build with Silicon Apps and Silicon Accounts", href: developerDocsUrl(), icon: BookOpen, shortcut: "8", external: true },
];

/** Where a section leads: its path, or for the developer site the address the service names (developerSiteUrl). */
export function sectionHref(section: Section, developerUrl: string = DEFAULT_DEVELOPER_URL): string {
  return section.key === "developer" ? developerUrl : section.key === "docs" ? developerDocsUrl(developerUrl) : section.href;
}

/** The section a path belongs to (Settings belongs to none: the dock shows no active section there). */
export function sectionFor(pathname: string): Section | undefined {
  if (pathname === "/" || pathname === "") return SECTIONS[0];
  return SECTIONS.find(section => !section.external && section.href !== "/" && (pathname === section.href || pathname.startsWith(`${section.href}/`)));
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

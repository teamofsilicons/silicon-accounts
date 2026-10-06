/**
 * The account site's top-level sections (the dock, the phone sheet, number-key shortcuts and the command palette all
 * read this list) and the route paths every page links to.
 */
import type { Component } from "solid-js";
import type { LucideProps } from "lucide-solid";
import { Braces, Cpu, History, IdCard, KeyRound, LayoutGrid, ShieldCheck } from "lucide-solid";

/** Every route of the web app. Use these instead of string literals. */
export const paths = {
  home: "/",
  signIn: "/sign-in",
  authorize: "/authorize",
  flow: (id: string) => `/authorize/flow/${encodeURIComponent(id)}`,
  device: "/device",
  identity: "/identity",
  signInMethods: "/sign-in-methods",
  apps: "/apps",
  silicons: "/silicons",
  proofs: "/proofs",
  activity: "/activity",
  settings: "/settings",
  developer: "/developer",
  developerApp: (appId: string, tab?: DeveloperTab) => `/developer/${encodeURIComponent(appId)}${tab && tab !== "overview" ? `/${tab}` : ""}`,
  kitchen: "/__kitchen",
} as const;

/** Tabs of an app in the developer area (`/developer/:appId/:tab?`). */
export const DEVELOPER_TABS = ["overview", "sign-in", "branding", "users", "import", "webhooks", "proofs", "embed"] as const;
export type DeveloperTab = (typeof DEVELOPER_TABS)[number];
export const DEVELOPER_TAB_LABELS: Record<DeveloperTab, string> = {
  overview: "Overview",
  "sign-in": "Sign-in",
  branding: "Branding",
  users: "Users",
  import: "Import",
  webhooks: "Webhooks",
  proofs: "Proofs",
  embed: "Embed",
};

export interface Section {
  key: "identity" | "sign-in" | "apps" | "silicons" | "proofs" | "activity" | "developer";
  label: string;
  /** One line for the command palette. */
  description: string;
  href: string;
  icon: Component<LucideProps>;
  /** The number key that jumps here. */
  shortcut: string;
}

export const SECTIONS: readonly Section[] = [
  { key: "identity", label: "Identity", description: "Your card: name, id, photo and details", href: paths.identity, icon: IdCard, shortcut: "1" },
  { key: "sign-in", label: "Sign-in", description: "Emails, phone numbers and Google or Apple", href: paths.signInMethods, icon: KeyRound, shortcut: "2" },
  { key: "apps", label: "Apps", description: "Apps you signed into and what they can see", href: paths.apps, icon: LayoutGrid, shortcut: "3" },
  { key: "silicons", label: "Silicons", description: "Silicons you are custodian of", href: paths.silicons, icon: Cpu, shortcut: "4" },
  { key: "proofs", label: "Proofs", description: "Proofs apps hold on your behalf", href: paths.proofs, icon: ShieldCheck, shortcut: "5" },
  { key: "activity", label: "Activity", description: "Sign-ins and changes, by day", href: paths.activity, icon: History, shortcut: "6" },
  { key: "developer", label: "Developer", description: "Apps you own and how they sign people in", href: paths.developer, icon: Braces, shortcut: "7" },
];

/** The section a path belongs to (the identity home also lives at /). */
export function sectionFor(pathname: string): Section | undefined {
  if (pathname === "/" || pathname === "") return SECTIONS[0];
  return SECTIONS.find(section => pathname === section.href || pathname.startsWith(`${section.href}/`));
}

export function sectionIndex(pathname: string): number {
  const section = sectionFor(pathname);
  return section ? SECTIONS.indexOf(section) : -1;
}

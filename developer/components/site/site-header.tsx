/**
 * The public pages' header (server-rendered): the brand, the main navigation, search, the theme switch, and Sign in
 * (or Your apps once signed in). Below 900 px the navigation moves into a menu: a native popover, so it opens, closes
 * on Escape or an outside tap, and keeps focus without any script of ours (its close button carries autofocus, so opening
 * it moves focus into it, and closing it gives focus back to the menu button). Links are plain links: every public page is
 * a full HTML document.
 */
import type { ReactNode } from "react";
import { Menu, Search, X } from "lucide-react";
import { BrandMark } from "./brand";
import { Action } from "./action";
import { ThemeToggle } from "./theme-controls";
import styles from "./site.module.css";

const NAV: Array<{ href: string; label: string }> = [
  { href: "/docs", label: "Docs" },
  { href: "/docs/apps", label: "Silicon Apps" },
  { href: "/docs/accounts", label: "Silicon Accounts" },
  { href: "/#for-silicons", label: "For Silicons" },
];

/**
 * "page" on the link to this very page, "true" on the link to the closest section it sits in (/docs/apps for an Apps
 * page, not /docs as well), nothing on the others.
 */
function currentOf(href: string, path: string): "page" | "true" | undefined {
  if (href === path) return "page";
  const inside = (candidate: string) => !candidate.includes("#") && candidate !== "/" && path.startsWith(`${candidate}/`);
  if (!inside(href)) return undefined;
  return NAV.some(other => other.href !== href && other.href.startsWith(`${href}/`) && (other.href === path || inside(other.href))) ? undefined : "true";
}

export interface SiteHeaderProps {
  /** This page's path, to mark the links that lead to it or to its sections. */
  path: string;
  signedIn: boolean;
  /** The search control: the docs' search island, or (by default) a plain link to /docs/search. */
  search?: ReactNode;
  /** More of the menu below the main links (the docs navigation on a docs page, which then holds the product links). */
  menu?: ReactNode;
  /** The docs use the full width; the home page a narrower column. */
  wide?: boolean;
}

export function SiteHeader({ path, signedIn, search, menu, wide = false }: SiteHeaderProps) {
  const account = signedIn ? { href: "/apps", label: "Your apps" } : { href: "/sign-in", label: "Sign in" };
  return (
    <header className={styles.header} data-wide={wide ? "" : undefined}>
      <a className="skip-link" data-sq="surface" href="#main">Skip to content</a>
      <div className={styles.bar}>
        <a href="/" className={styles.brand} data-sq="surface" aria-label="Silicon Developer, home">
          <BrandMark className={styles.brandMark} />
          <span className={styles.brandText} aria-hidden="true">Silicon <span className={styles.brandMuted}>Developer</span></span>
        </a>
        <nav className={styles.nav} aria-label="Main">
          <ul role="list" className={styles.navList}>
            {NAV.map(item => (
              <li key={item.href}>
                <a href={item.href} className={styles.navLink} data-sq="surface" aria-current={currentOf(item.href, path)}>{item.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.actions}>
          {search ?? (
            <a href="/docs/search" className={styles.iconButton} data-sq="surface" aria-label="Search the docs">
              <Search size={17} strokeWidth={1.75} aria-hidden="true" />
            </a>
          )}
          <ThemeToggle />
          <Action href={account.href} size="sm" className={styles.account}>{account.label}</Action>
          <button type="button" className={`${styles.iconButton} ${styles.menuButton}`} data-sq="surface" popoverTarget="site-menu" aria-label="Open the menu">
            <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div id="site-menu" popover="auto" className={styles.menu} data-sq="surface" role="dialog" aria-label="Menu">
        <div className={styles.menuHead}>
          <span className={styles.menuTitle}>Menu</span>
          <button type="button" className={styles.iconButton} data-sq="surface" popoverTarget="site-menu" popoverTargetAction="hide" aria-label="Close the menu" autoFocus>
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <nav aria-label="Main menu" className={styles.menuNav}>
          <ul role="list">
            <li><a href="/" className={styles.menuLink} data-sq="surface" aria-current={path === "/" ? "page" : undefined}>Home</a></li>
            {(menu ? NAV.filter(item => !item.href.startsWith("/docs/")) : NAV).map(item => (
              <li key={item.href}><a href={item.href} className={styles.menuLink} data-sq="surface" aria-current={currentOf(item.href, path)}>{item.label}</a></li>
            ))}
            <li><a href="/docs/search" className={styles.menuLink} data-sq="surface">Search the docs</a></li>
          </ul>
        </nav>
        {menu ? <div className={styles.menuExtra}>{menu}</div> : null}
        <div className={styles.menuFoot}>
          <Action href={account.href} size="md" className={styles.menuAction}>{account.label}</Action>
        </div>
      </div>
    </header>
  );
}

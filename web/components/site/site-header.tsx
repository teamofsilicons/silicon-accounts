/**
 * The public pages' header (server-rendered), as on the developer site (developer/components/site): the brand, the
 * page's sections, the docs, the theme switch and Sign in. Below 900 px the links move into a menu: a native popover,
 * so it opens, closes on Escape or an outside tap, and keeps focus without any script of ours (its close button carries
 * autofocus, so opening it moves focus into it, and closing it gives focus back to the menu button). Links are plain
 * links: every public page is a full HTML document.
 */
import { ArrowUpRight, Menu, X } from "lucide-react";
import { Action } from "./action";
import { BrandMark } from "./brand";
import { ThemeToggle } from "./theme-controls";
import styles from "./site.module.css";

export interface SiteHeaderProps {
  /** The developer site's docs for Silicon Accounts (from GET /v1/meta `developer_url`). */
  docsUrl: string;
}

export function SiteHeader({ docsUrl }: SiteHeaderProps) {
  const nav: Array<{ href: string; label: string; external?: boolean }> = [
    { href: "/#for-silicons", label: "For Silicons" },
    { href: "/#for-carbons", label: "For Carbons" },
    { href: "/#faq", label: "Questions" },
    { href: docsUrl, label: "Docs", external: true },
  ];
  return (
    <header className={styles.header}>
      <a className="skip-link" data-sq="surface" href="#main">Skip to content</a>
      <div className={styles.bar}>
        <a href="/" className={styles.brand} data-sq="surface" aria-label="Silicon Accounts, home">
          <BrandMark className={styles.brandMark} />
          <span className={styles.brandText} aria-hidden="true">Silicon <span className={styles.brandMuted}>Accounts</span></span>
        </a>
        <nav className={styles.nav} aria-label="Main">
          <ul role="list" className={styles.navList}>
            {nav.map(item => (
              <li key={item.label}>
                <a href={item.href} className={styles.navLink} data-sq="surface" rel={item.external ? "noopener" : undefined}>
                  {item.label}
                  {item.external ? <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" className={styles.navExternal} /> : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.actions}>
          <ThemeToggle />
          <Action href="/sign-in" size="sm" className={styles.account}>Sign in</Action>
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
            <li><a href="/" className={styles.menuLink} data-sq="surface">Home</a></li>
            {nav.map(item => (
              <li key={item.label}>
                <a href={item.href} className={styles.menuLink} data-sq="surface" rel={item.external ? "noopener" : undefined}>
                  {item.label}
                  {item.external ? <ArrowUpRight size={15} strokeWidth={1.75} aria-hidden="true" className={styles.navExternal} /> : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.menuFoot}>
          <Action href="/sign-in?intent=signup" size="md" className={styles.menuAction}>Sign up</Action>
          <Action href="/sign-in" size="md" variant="secondary" className={styles.menuAction}>Sign in</Action>
        </div>
      </div>
    </header>
  );
}

/**
 * The public pages' header (server-rendered), as on Silicon Writings and Silicon Apps: the wordmark on the left, and
 * on the right the docs (another site, a quiet link) and Sign in. Nothing else: the page itself says what to do next.
 * Links are plain links: every public page is a full HTML document.
 */
import { ArrowUpRight } from "lucide-react";
import { Action } from "./action";
import { BrandMark } from "./brand";
import styles from "./site.module.css";

export interface SiteHeaderProps {
  /** The developer site's docs for Silicon Accounts (from GET /v1/meta `developer_url`). */
  docsUrl: string;
}

export function SiteHeader({ docsUrl }: SiteHeaderProps) {
  return (
    <header className={styles.header}>
      <a className="skip-link" data-sq="surface" href="#main">Skip to content</a>
      <div className={styles.bar}>
        <a href="/" className={styles.brand} data-sq="surface" aria-label="Silicon Accounts, home">
          <BrandMark className={styles.brandMark} />
          <span className={styles.brandText} aria-hidden="true">Silicon Accounts</span>
        </a>
        <div className={styles.actions}>
          <a href={docsUrl} className={styles.navLink} data-sq="surface" rel="noopener">
            Docs
            <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" className={styles.navExternal} />
          </a>
          <Action href="/sign-in" size="sm" variant="secondary" className={styles.account}>Sign in</Action>
        </div>
      </div>
    </header>
  );
}

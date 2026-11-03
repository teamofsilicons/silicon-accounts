/**
 * The public pages' header (server-rendered), as on Silicon Writings and Silicon Apps: the wordmark on the left and
 * Sign in on the right. Nothing else: the page itself says what to do next, and the docs (another site) are in the
 * footer. Links are plain links: every public page is a full HTML document.
 */
import { Action } from "./action";
import { BrandMark } from "./brand";
import styles from "./site.module.css";

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <a className="skip-link" data-sq="surface" href="#main">Skip to content</a>
      <div className={styles.bar}>
        <a href="/" className={styles.brand} data-sq="surface" aria-label="Silicon Accounts, home">
          <BrandMark className={styles.brandMark} />
          <span className={styles.brandText} aria-hidden="true">Silicon Accounts</span>
        </a>
        <div className={styles.actions}>
          <Action href="/sign-in" size="sm" variant="secondary" className={styles.account}>Sign in</Action>
        </div>
      </div>
    </header>
  );
}

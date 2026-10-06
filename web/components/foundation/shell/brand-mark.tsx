/** The squircle brand mark (also the favicon, app/icon.svg) and the wordmark beside it. */
import styles from "./shell.module.css";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span data-sq="clip" className={className ?? styles.brandMark} aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <circle cx="32" cy="24" r="9" fill="currentColor" />
        <path fill="currentColor" d="M14 50c2.7-8.4 9.6-13.2 18-13.2S47.3 41.6 50 50c-4.8 3.2-10.9 4.9-18 4.9S18.8 53.2 14 50Z" />
      </svg>
    </span>
  );
}

/** "Silicon Accounts" with the mark, as the site's home link text. */
export function Wordmark() {
  return (
    <>
      <BrandMark />
      <span className={styles.brandText}>
        Silicon <span className={styles.brandMuted}>Accounts</span>
      </span>
    </>
  );
}

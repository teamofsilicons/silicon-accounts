/** The developer site's squircle mark: the Silicon Accounts squircle in brand blue, with braces for building. */
import styles from "./shell.module.css";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span data-sq="clip" className={className ?? styles.brandMark} aria-hidden="true">
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M25 16c-5 0-7 2.5-7 7v4.5c0 2.5-1.5 4.5-4 4.5 2.5 0 4 2 4 4.5V41c0 4.5 2 7 7 7" />
        <path d="M39 16c5 0 7 2.5 7 7v4.5c0 2.5 1.5 4.5 4 4.5-2.5 0-4 2-4 4.5V41c0 4.5-2 7-7 7" />
      </svg>
    </span>
  );
}

/** "Silicon Developer" with the mark. */
export function Wordmark() {
  return (
    <>
      <BrandMark />
      <span className={styles.brandText}>
        Silicon <span className={styles.brandMuted}>Developer</span>
      </span>
    </>
  );
}

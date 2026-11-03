/**
 * The Silicon Accounts mark: a rounded square beside a circle. The top row draws the bare glyph in ink beside the
 * wordmark, as Silicon Writings and Silicon Apps do; AccountsIcon is the app icon in its light colours (#181818 on grey
 * #E3E3E3), as app/icon.svg and the PNG icons draw it. Plain SVG.
 */
import styles from "./shell.module.css";

/** The square and the circle, in currentColor, cropped to their own bounds (110.92 × 59). */
export function AccountsGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="45 70 110.92 59" fill="currentColor" aria-hidden="true" focusable="false">
      <rect x="45" y="74.72" width="49.56" height="49.56" rx="4.72" />
      <circle cx="126.42" cy="99.5" r="29.5" />
    </svg>
  );
}

/** The app icon in its light colours: the glyph in #181818 on a grey square. */
export function AccountsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <rect width="200" height="200" fill="#E3E3E3" />
      <rect x="45" y="74.72" width="49.56" height="49.56" rx="4.72" fill="#181818" />
      <circle cx="126.42" cy="99.5" r="29.5" fill="#181818" />
    </svg>
  );
}

/** The top row's mark: the glyph in ink. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={className ?? styles.brandMark} aria-hidden="true">
      <AccountsGlyph />
    </span>
  );
}

/** "Silicon Accounts" with the mark, as the site's home link text. */
export function Wordmark() {
  return (
    <>
      <BrandMark />
      <span className={styles.brandText}>Silicon Accounts</span>
    </>
  );
}

/** The developer site's squircle mark in the signed-in shell (the glyph itself is components/site/brand.tsx). */
import { BrandGlyph } from "@/components/site/brand";
import styles from "./shell.module.css";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span data-sq="clip" className={className ?? styles.brandMark} aria-hidden="true">
      <BrandGlyph />
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

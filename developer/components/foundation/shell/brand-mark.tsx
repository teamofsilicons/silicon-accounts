/** The developer site's mark in the signed-in shell: the bare glyph in ink (the glyph itself is components/site/brand.tsx). */
import { BrandGlyph } from "@/components/site/brand";
import styles from "./shell.module.css";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={className ?? styles.brandMark} aria-hidden="true">
      <BrandGlyph />
    </span>
  );
}

/** "Silicon Developer" with the mark. */
export function Wordmark() {
  return (
    <>
      <BrandMark />
      <span className={styles.brandText}>Silicon Developer</span>
    </>
  );
}

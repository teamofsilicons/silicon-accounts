import type { Page } from "@/lib/api/types";
import { formatCount } from "@/lib/format";
import styles from "./parts.module.css";

/**
 * Says so when a list is longer than the page reads (25 pages of 200, parts/queries.ts), instead of leaving the rest
 * out silently: the CLI lists every item.
 */
export function ListCap({ page, noun, command }: { page: Page<unknown> | undefined; noun: string; command: string }) {
  if (!page?.next_cursor) return null;
  return (
    <p className={styles.listCap} role="note">
      This page shows the first {formatCount(page.items.length)} {noun}. <code>{command}</code> lists every one.
    </p>
  );
}

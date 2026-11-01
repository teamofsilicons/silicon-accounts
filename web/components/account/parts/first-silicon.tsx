/**
 * The forest banner for Silicons with grain and a Geist Serif heading (Anil, 2026-10-31): "Create your first Silicon"
 * on Home's Your Silicons while there are none, and the Silicons page's opening on a first visit (its own title and
 * line, no action: the ways to add a Silicon follow it). The caller gives any action (a link to /silicons?new, or a
 * button that opens the create panel).
 */
import type { ReactNode } from "react";
import styles from "./first-silicon.module.css";

export function FirstSiliconBanner({
  title = "Create your first Silicon",
  line = "Give your AI agent its own identity to sign in to apps. You look after it.",
  action,
  as: Heading = "h3",
}: { title?: string; line?: ReactNode; action?: ReactNode; as?: "h2" | "h3" }) {
  return (
    <div data-sq="clip" className={styles.first}>
      <Heading className={styles.firstTitle}>{title}</Heading>
      <p className={styles.firstLine}>{line}</p>
      {action ? <span className={styles.firstAction}>{action}</span> : null}
    </div>
  );
}

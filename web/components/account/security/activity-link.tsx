/**
 * The Security pillar's way to the evidence trail: Activity lists every sign-in and change, by day.
 */
import { ArrowRight, History } from "lucide-react";
import { ButtonLink } from "@/components/foundation/button-link";
import { Section } from "@/components/foundation/layout/layout";
import { paths } from "@/lib/navigation";
import styles from "./activity-link.module.css";

export function ActivityLink() {
  return (
    <Section title="Activity" description="Every sign-in and every change to your account, by day, in your local time.">
      <div data-sq="surface" className={styles.card}>
        <History size={20} strokeWidth={1.75} aria-hidden="true" className={styles.icon} />
        <p className={styles.text}>Check here when something looks wrong: a sign-in you don&apos;t recognise, a new way in, an app you removed.</p>
        <ButtonLink href={paths.activity} variant="secondary" size="sm">
          See activity
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </ButtonLink>
      </div>
    </Section>
  );
}

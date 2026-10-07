/** Any address the site does not know (and every `notFound()`). */
import type { Metadata } from "next";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { ButtonLink } from "@/components/foundation/button-link";
import styles from "./status-page.module.css";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className={styles.problem}>
      <EmptyState
        icon={<Compass width={24} height={24} strokeWidth={1.5} />}
        title="Nothing lives at this address"
        description="This is not a page of the developer site. Check the link, or start again from your apps."
        action={<ButtonLink href="/" variant="secondary">Open your apps</ButtonLink>}
      />
    </main>
  );
}

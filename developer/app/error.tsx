"use client";

/** A page crashed while rendering: say so plainly, keep the digest for a report, and offer to try again. */
import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import styles from "./status-page.module.css";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className={styles.problem}>
      <div>
        <EmptyState
          icon={<RotateCcw width={24} height={24} strokeWidth={1.5} />}
          title="This page stopped working"
          description={`Something in the page failed: ${error.message || "an unexpected error"}. Try again; if it keeps happening, report it with \`accounts report\`.`}
          action={<Button variant="secondary" onClick={reset}>Try again</Button>}
        />
        {error.digest ? <p className={styles.details}>Reference {error.digest}</p> : null}
      </div>
    </main>
  );
}

"use client";

/**
 * A page crashed while rendering: say so plainly, keep the digest for a report, and offer to try again.
 */
import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { ButtonLink } from "@teamofsilicons/silicon-ui/button-link";
import styles from "./status-page.module.css";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className={styles.problem}>
      <div className={styles.box}>
        <span className={styles.icon} data-sq="surface" aria-hidden="true"><RotateCcw size={24} strokeWidth={1.5} /></span>
        <h1 className={styles.title}>This page stopped working</h1>
        <p className={styles.text}>
          Something in the page failed: {error.message || "an unexpected error"}. Try again; if it keeps happening, report it with{" "}
          <code>silicon-accounts report</code>.
        </p>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={reset}>Try again</Button>
          {/* A plain <a>, so a full load: the page that failed may have broken the client router. */}
          <ButtonLink href="/" variant="ghost">Go to your account</ButtonLink>
        </div>
        {error.digest ? <p className={styles.details}>Reference {error.digest}</p> : null}
      </div>
    </main>
  );
}

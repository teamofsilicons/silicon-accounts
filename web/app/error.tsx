"use client";

/**
 * A page crashed while rendering: say so plainly, keep the digest for a report, and offer to try again. Plain elements
 * in Arc's button styles (no motion library), as on the developer site: this boundary is part of every page's script,
 * the public landing page included.
 */
import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import buttonStyles from "@/components/arc/button/button.module.css";
import linkStyles from "@/components/foundation/button-link.module.css";
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
          <button type="button" data-sq="surface" className={`${buttonStyles.button} ${buttonStyles.secondary} ${buttonStyles.md}`} onClick={reset}>Try again</button>
          {/* A full load: the page that failed may have broken the client router. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" data-sq="surface" data-variant="ghost" className={`${buttonStyles.button} ${buttonStyles.ghost} ${buttonStyles.md} ${linkStyles.link}`}>Go to your account</a>
        </div>
        {error.digest ? <p className={styles.details}>Reference {error.digest}</p> : null}
      </div>
    </main>
  );
}

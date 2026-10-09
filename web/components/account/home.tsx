"use client";

/**
 * "/" for a browser with a session cookie: the identity home. A page load of "/" whose cookie the API refuses gets the
 * public landing page from the server instead (proxy.ts asks GET /v1/session first), so signed out here only happens
 * when the session ends while this tab is open: a short card leads to sign in again, or to the landing page.
 */
import { LogIn } from "lucide-react";
import { ButtonLink } from "@/components/foundation/button-link";
import { paths } from "@/lib/navigation";
import { useSession } from "@/lib/query/session";
import { Identity } from "./identity/identity";
import styles from "./home.module.css";

export function Home() {
  const { status } = useSession();
  if (status === "signed_in") return <Identity />;
  if (status === "signed_out") return <SignedOut />;
  return null;
}

function SignedOut() {
  return (
    <main id="main" className={styles.signedOut}>
      <div className={styles.card} data-sq="surface">
        <h1 className={styles.title}>You&apos;re signed out</h1>
        <p className={styles.text}>Your session in this browser ended. Sign in again to see your account, your apps and your Silicons.</p>
        <div className={styles.actions}>
          <ButtonLink href={paths.signIn} size="lg" external><LogIn size={16} strokeWidth={1.75} aria-hidden="true" />Sign in</ButtonLink>
          <ButtonLink href={paths.home} size="lg" variant="ghost" external>About Silicon Accounts</ButtonLink>
        </div>
      </div>
    </main>
  );
}

"use client";

/**
 * "/" for a browser with a session cookie: Home (the column the page draws, redesign/decisions.md 2026-10-30). A page
 * load of "/" whose cookie the API refuses gets the public landing page from the server instead (proxy.ts asks
 * GET /v1/session first), so signed out here only happens when the session ends while this tab is open: a short card
 * leads to sign in again, or to the landing page. Every section returns nothing without an account, so without this
 * card the page would be blank.
 */
import { LogIn } from "lucide-react";
import { ButtonLink } from "@/components/foundation/button-link";
import { Page as Column } from "@/components/foundation/layout/layout";
import { paths } from "@/lib/navigation";
import { useSession } from "@/lib/query/session";
import { HomeCards } from "./home-cards";
import { HomeIdentity } from "./home-identity";
import { HomeNeeds } from "./home-needs";
import { HomeSilicons } from "./home-sections";
import styles from "./home.module.css";

export function Home() {
  const { status } = useSession();
  if (status === "signed_out") return <SignedOut />;
  return (
    <Column>
      <HomeIdentity />
      <HomeNeeds />
      <HomeCards />
      <HomeSilicons />
    </Column>
  );
}

function SignedOut() {
  return (
    <main id="main" className={styles.signedOut}>
      <div className={styles.card} data-sq="surface">
        <h1 className={styles.title}>You&apos;re signed out</h1>
        <p className={styles.text}>Your session in this browser ended. Sign in again to see your account, your apps and your Silicons.</p>
        <div className={styles.actions}>
          <ButtonLink href={paths.signIn} size="lg" external><LogIn size={16} strokeWidth={2} aria-hidden="true" />Sign In</ButtonLink>
          <ButtonLink href={paths.home} size="lg" variant="ghost" external>About Silicon Accounts</ButtonLink>
        </div>
      </div>
    </main>
  );
}

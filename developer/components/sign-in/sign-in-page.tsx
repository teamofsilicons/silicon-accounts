"use client";

/**
 * The sign-in card of the developer site. The visitor signs in with their Silicon Accounts account (the first-party app
 * `developer`, through the accounts site's hosted pages); the developer site only ever holds that sign-in on its server.
 * A failed sign-in shows fixed words for its error code: the address's own description is never shown (anyone could
 * put their words in a link).
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleAlert, LogOut } from "lucide-react";
import { ButtonLink } from "@/components/foundation/button-link";
import { BrandMark } from "@/components/foundation/shell/brand-mark";
import { paths } from "@/lib/navigation";
import { sameSitePath, useMeta, useSession } from "@/lib/query/session";
import styles from "./sign-in-page.module.css";

const ERRORS: Record<string, string> = {
  access_denied: "You cancelled the sign-in, so you are not signed in to the developer site.",
  state_mismatch: "That sign-in was started in another tab, or took longer than 10 minutes. Start it again from here.",
  missing_code: "The sign-in came back without a code. Start it again.",
  exchange_failed: "Silicon Accounts did not accept the sign-in's code. Start again; if it keeps happening, report it with `silicon-accounts report`.",
  api_unreachable: "Silicon Accounts could not be reached to finish the sign-in. Check your connection, then try again.",
  login_required: "Silicon Accounts needs you to sign in again.",
  interaction_required: "Silicon Accounts needs you to sign in again.",
  server_error: "Silicon Accounts had a problem finishing the sign-in. Try again in a moment.",
  temporarily_unavailable: "Silicon Accounts is busy for a moment. Try again shortly.",
  unauthorized_client: "This deployment of the developer site is not set up as a Silicon Accounts app yet (its sign-in was refused). Its maintainers need to register the `developer` app.",
  invalid_request: "The sign-in request was refused by Silicon Accounts. Start again; if it keeps happening, report it with `silicon-accounts report`.",
};

export function SignInPage({ error, returnTo, signedOut }: { error: string | null; returnTo: string | null; signedOut: boolean }) {
  const router = useRouter();
  const { status } = useSession();
  const meta = useMeta();
  const back = sameSitePath(returnTo) ?? "/";
  const accountsUrl = meta.data?.public_url?.replace(/\/+$/, "") || "https://accounts.teamofsilicons.com";

  // Already signed in (another tab finished it): go on.
  useEffect(() => {
    if (status === "signed_in" && !error) router.replace(back);
  }, [status, error, back, router]);

  const message = error ? ERRORS[error] ?? "The sign-in did not finish. Start it again." : null;

  return (
    <main className={styles.page}>
      <div className={styles.column}>
        <div className={styles.brand}>
          <BrandMark className={styles.mark} />
          <span>Silicon <span className={styles.muted}>Developer</span></span>
        </div>
        <section data-sq="surface" className={styles.card} aria-labelledby="sign-in-title">
          <h1 id="sign-in-title" className={styles.title}>Build with Silicon</h1>
          <p className={styles.lede}>
            Create and publish apps, and set up how they sign Carbons and Silicons in: methods, Google and Apple, the details you ask for, your
            flows and pages, your users, webhooks and app verification.
          </p>
          {message ? (
            <p className={styles.notice} data-tone="danger" role="alert"><CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />{message}</p>
          ) : signedOut ? (
            <p className={styles.notice} role="status"><LogOut size={16} strokeWidth={1.75} aria-hidden="true" />You are signed out of the developer site. Your Silicon Accounts sign-in is untouched.</p>
          ) : null}
          {/* A plain link (external): a full navigation, never prefetched, since starting a sign-in sets a cookie. */}
          <ButtonLink href={paths.authSignIn(back)} external size="lg" className={styles.cta}>
            Continue with Silicon Accounts<ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </ButtonLink>
          <p className={styles.fine}>
            You sign in on Silicon Accounts with your own account. The developer site keeps that sign-in on its server
            and never hands your tokens to the browser.
          </p>
        </section>
        <p className={styles.footer}>
          Your own account (emails, phones, apps and Silicons) lives at{" "}
          <a href={accountsUrl} target="_blank" rel="noopener">{accountsUrl.replace(/^https?:\/\//, "")}</a>.
        </p>
      </div>
    </main>
  );
}

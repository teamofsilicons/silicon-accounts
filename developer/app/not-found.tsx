/** Any address the site does not know (and every notFound() outside the docs): a public page, server-rendered. */
import type { Metadata } from "next";
import { Compass } from "lucide-react";
import { Action } from "@/components/site/action";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { isSignedIn } from "@/lib/server/signed-in";
import styles from "./status-page.module.css";

export const metadata: Metadata = { title: { absolute: "Not found · Silicon Developer" }, robots: { index: false, follow: true } };

export default async function NotFound() {
  const signedIn = await isSignedIn();
  return (
    <>
      <SiteHeader path="/404" signedIn={signedIn} />
      <main id="main" className={styles.problem}>
        <div className={styles.box}>
          <span className={styles.icon} data-sq="surface" aria-hidden="true"><Compass size={24} strokeWidth={1.5} /></span>
          <h1 className={styles.title}>Nothing lives at this address</h1>
          <p className={styles.text}>This is not a page of the developer site. Check the link, or start again from the home page or the docs.</p>
          <div className={styles.actions}>
            <Action href={signedIn ? "/apps" : "/"}>{signedIn ? "Open your apps" : "Go to the home page"}</Action>
            <Action href="/docs" variant="secondary">Read the docs</Action>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}

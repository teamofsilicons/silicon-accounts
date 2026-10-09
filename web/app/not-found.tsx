/**
 * Any address the site does not know (and every `notFound()`): server-rendered, no client code (it renders outside
 * the app's providers, under the root layout alone).
 */
import type { Metadata } from "next";
import { Compass } from "lucide-react";
import { Action } from "@/components/site/action";
import styles from "./status-page.module.css";

export const metadata: Metadata = { title: { absolute: "Not found · Silicon Accounts" }, robots: { index: false, follow: true } };

export default function NotFound() {
  return (
    <main id="main" className={styles.problem}>
      <div className={styles.box}>
        <span className={styles.icon} data-sq="surface" aria-hidden="true"><Compass size={24} strokeWidth={1.5} /></span>
        <h1 className={styles.title}>Nothing lives at this address</h1>
        <p className={styles.text}>This is not a page of Silicon Accounts. Check the link, or start again from your account.</p>
        <div className={styles.actions}>
          <Action href="/">Go to your account</Action>
        </div>
      </div>
    </main>
  );
}

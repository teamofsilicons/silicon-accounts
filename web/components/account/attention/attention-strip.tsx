"use client";

/**
 * The attention strip: one place for everything that needs a decision from you, at the top of the identity home (after
 * Google's "Protect your account"). It renders only when something is waiting, so most of the time it is not there.
 *
 * Sources today: custodian requests (a Silicon asking you to be its custodian, or a Carbon handing one to you), answered
 * here with the request deck. Account-verification requests belong here too once the web API lists them for the
 * signed-in account (web/README.md, "Silicon UI").
 */
import { Inbox } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import type { Me } from "@/lib/api/types";
import { asCarbon, describeError, useNow } from "../parts/common";
import { useEveryCustodianRequest } from "../parts/queries";
import { RequestDeck } from "../silicons/request-deck";
import styles from "./attention.module.css";

/** The strip's id, for links that lead to it ("Answer it on your identity page"). */
export const ATTENTION_ID = "needs-you";

export function AttentionStrip({ me }: { me: Me }) {
  const carbon = asCarbon(me);
  const requests = useEveryCustodianRequest();
  const now = useNow(30_000);
  if (!carbon) return null;
  const waiting = requests.data?.items ?? [];

  if (requests.error && !requests.data) {
    return (
      <div id={ATTENTION_ID} className={styles.place}>
        <Alert tone="danger" title="Requests waiting for you did not load">
          {describeError(requests.error)} A Silicon may be asking you to be its custodian; requests last 14 days.
          <span className={styles.action}><Button variant="secondary" size="sm" onClick={() => void requests.refetch()}>Try again</Button></span>
        </Alert>
      </div>
    );
  }
  if (!waiting.length) return null;

  return (
    <section id={ATTENTION_ID} data-sq="surface" className={`${styles.place} ${styles.strip}`} aria-labelledby={`${ATTENTION_ID}-title`} tabIndex={-1}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true"><Inbox size={20} strokeWidth={1.75} /></span>
        <div className={styles.text}>
          <h2 id={`${ATTENTION_ID}-title`} className={styles.title}>
            Needs your decision <Badge size="sm" tone="info">{waiting.length}</Badge>
          </h2>
          <p className={styles.description}>Each request lasts 14 days. A declined Silicon&apos;s account is released; a declined transfer changes nothing.</p>
        </div>
      </div>
      {/* When the last request is answered the strip goes; focus returns to the page. */}
      <RequestDeck requests={waiting} now={now} onEmptied={() => document.getElementById("main")?.focus({ preventScroll: true })} />
    </section>
  );
}

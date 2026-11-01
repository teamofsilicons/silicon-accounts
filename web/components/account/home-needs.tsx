"use client";

/**
 * Home's Needs you, under the greeting (Anil, 2026-10-31): what is waiting on the Carbon, one row each, shown only when
 * something waits:
 *
 * - a Silicon asking them to be its custodian, with Decline and Review;
 * - a Carbon handing them a Silicon, with Review;
 * - a device signed in but not used for 7 days (components/account/parts/checkup.ts), with Keep and Sign out.
 *
 * Nothing shows when nothing waits. The setup checklist is off Home for now (the step cards are archived in
 * redesign/archive/setup-step-cards.md). Its heading sits on the page; its rows are a white list in the introduction's
 * soft grey tile.
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Laptop, X } from "lucide-react";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import type { CustodianRequest, SessionInfo } from "@/lib/api/types";
import { formatRelative } from "@/lib/format";
import { useDeclineCustodianRequest } from "@/lib/query/silicons";
import { useMe } from "@/lib/query/session";
import { NEEDS_YOU_ID } from "./parts/anchors";
import { keepSession, readKept, staleSession, subscribeKept } from "./parts/checkup";
import { asCarbon, describeError, msUntil, personLabel, spanText, useNow } from "./parts/common";
import { useEveryCustodianRequest, useEverySession, useSignOutSession } from "./parts/queries";
import { SiliconMark } from "./parts/silicon-mark";
import { sessionName } from "./security/sessions";
import { RequestDeck } from "./silicons/request-deck";
import styles from "./home-needs.module.css";

const siliconName = (request: CustodianRequest) => request.silicon.display_name || request.silicon.id || "A Silicon";

export function HomeNeeds() {
  const me = useMe();
  const carbon = asCarbon(me.data);
  const requests = useEveryCustodianRequest();
  const sessions = useEverySession();
  const now = useNow(30_000);
  const kept = useSyncExternalStore(subscribeKept, readKept, () => "");
  if (!carbon) return null;

  // The requests are part of the answer: wait for them rather than say "all set" too early.
  if (!requests.data && !requests.error) return null;
  const waiting = requests.data?.items ?? [];
  const failed = !!requests.error && !requests.data;
  const stale = staleSession(sessions.data?.items, now, kept);

  // Nothing waiting: nothing to show (no "You're all set", Anil 2026-10-31).
  if (!waiting.length && !failed && !stale) return null;

  return (
    <div id={NEEDS_YOU_ID} className={styles.group} tabIndex={-1}>
      <Requests id={NEEDS_YOU_ID} title="Needs you" waiting={waiting} failed={failed} error={requests.error} retry={() => void requests.refetch()} stale={stale} now={now} />
    </div>
  );
}

/* Needs you ------------------------------------------------------------------------------------------------------- */

/**
 * The Silicons page's "Waiting for you" (Anil, 2026-11-01): the same rows and dialogs as Needs you, only the custodian
 * requests and handovers (no devices); nothing while none wait.
 */
export function SiliconRequests() {
  const requests = useEveryCustodianRequest();
  const now = useNow(30_000);
  const waiting = requests.data?.items ?? [];
  const failed = !!requests.error && !requests.data;
  if (!waiting.length && !failed) return null;
  return <Requests id="silicon-requests" title="Waiting for you" waiting={waiting} failed={failed} error={requests.error} retry={() => void requests.refetch()} stale={undefined} now={now} />;
}

function Requests({ id, title, waiting, failed, error, retry, stale, now }: { id: string; title: string; waiting: CustodianRequest[]; failed: boolean; error: unknown; retry: () => void; stale: SessionInfo | undefined; now: number }) {
  const decline = useDeclineCustodianRequest();
  const signOut = useSignOutSession();
  const [reviewing, setReviewing] = useState<CustodianRequest | null>(null);
  const [declining, setDeclining] = useState<CustodianRequest | null>(null);
  const count = waiting.length + (failed ? 1 : 0) + (stale ? 1 : 0);
  const timeLeft = (request: CustodianRequest) => {
    const left = msUntil(request.expires_at, now);
    return left > 0 ? `${spanText(left)} left` : "Ends today";
  };

  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.head}>
        <h2 id={`${id}-title`} className={styles.title}>{title}</h2>
        <Badge size="sm" tone="warning">{count}</Badge>
      </div>
      <div data-sq="surface" className={styles.tile}>
        <ul data-sq="clip" className={styles.rows}>
          {failed ? (
            <Row lead={<span data-sq="surface" className={styles.icon} aria-hidden="true"><X size={16} strokeWidth={1.75} /></span>} title="Requests waiting for you did not load" detail={describeError(error)}>
              <Button variant="secondary" size="sm" onClick={retry}>Try again</Button>
            </Row>
          ) : null}
          {waiting.map(request => request.kind === "transfer" ? (
            <Row key={request.id} lead={<SiliconMark seed={request.silicon.uuid} size={36} />} title={`${personLabel(request.from)} is handing ${siliconName(request)} to you`} detail={timeLeft(request)}>
              <Button variant="primary" size="sm" onClick={() => setReviewing(request)}>Review</Button>
            </Row>
          ) : (
            <Row key={request.id} lead={<SiliconMark seed={request.silicon.uuid} size={36} pending />} title={`${siliconName(request)} wants you to look after it`} detail={timeLeft(request)}>
              <Button variant="secondary" size="sm" onClick={() => setDeclining(request)}>Decline</Button>
              <Button variant="primary" size="sm" onClick={() => setReviewing(request)}>Review</Button>
            </Row>
          ))}
          {stale ? (
            <Row lead={<span data-sq="surface" className={styles.icon} aria-hidden="true"><Laptop size={16} strokeWidth={1.75} /></span>} title={`Still using ${sessionName(stale)}?`} detail={`Last used ${formatRelative(stale.last_seen_at ?? stale.created_at, now)}`}>
              <Button variant="ghost" size="sm" onClick={() => keepSession(stale.id)}>Keep</Button>
              <Button variant="secondary" size="sm" loading={signOut.isPending} onClick={() => void signOut.mutateAsync(stale.id).catch(() => undefined)}>Sign out</Button>
            </Row>
          ) : null}
        </ul>
      </div>
      <Dialog open={!!reviewing} onOpenChange={open => { if (!open) setReviewing(null); }}>
        {reviewing ? (
          <DialogContent title={reviewing.kind === "transfer" ? `${personLabel(reviewing.from)} is handing ${siliconName(reviewing)} to you` : `${siliconName(reviewing)} wants you to look after it`} description="Each request lasts 14 days. A declined Silicon's account is released; a declined transfer changes nothing.">
            <RequestDeck requests={[reviewing]} now={now} onEmptied={() => setReviewing(null)} />
          </DialogContent>
        ) : null}
      </Dialog>
      <Dialog open={!!declining} onOpenChange={open => { if (!open) setDeclining(null); }}>
        {declining ? (
          <DialogContent title={`Decline ${siliconName(declining)}?`}>
            <p className={styles.dialogText}>
              It can&apos;t sign in anywhere, its account is removed, and <span className={styles.mono}>{declining.silicon.id ?? declining.silicon.uuid}</span> is free for anyone at once.
            </p>
            <div className={styles.dialogActions}>
              <Button variant="secondary" onClick={() => setDeclining(null)}>Cancel</Button>
              <Button variant="danger" loading={decline.isPending} onClick={() => void decline.mutateAsync(declining.id).then(() => setDeclining(null), () => undefined)}>Decline</Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}

function Row({ lead, title, detail, children }: { lead: ReactNode; title: string; detail: string; children: ReactNode }) {
  return (
    <li className={styles.row}>
      {lead}
      <span className={styles.text}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowDetail}>{detail}</span>
      </span>
      <span className={styles.actions}>{children}</span>
    </li>
  );
}

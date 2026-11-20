"use client";

/**
 * Home's Needs you, under the greeting (Anil, 2026-10-31): the newest item waiting on the Carbon, with the total in the badge:
 *
 * - a Silicon asking them to be its custodian, with Review (Accept and Decline are in the review);
 * - a Carbon handing them a Silicon, with Review;
 * - a device signed in but not used for 7 days (components/account/parts/checkup.ts), with Keep and Sign out.
 *
 * Nothing shows when nothing waits. The compact boxed design (Anil, 2026-11-11, picked from /__needs): one white list
 * with a clear border; each row a 28px mark (a Silicon's, or the browser's logo), the title over one line (a request's
 * time left, grey over a week, amber from a week, red under 3 days, "Ends today" under a day; or the device's last use),
 * and at most one outlined button, so nothing in the list is filled; the device also has Keep, a soft grey button (Anil, 2026-11-11). The next item appears when the current one is handled.
 *
 * With more than one waiting, "1 of 5" and previous and next buttons beside the heading step through them, the new item
 * sliding in from the side it comes from (Anil, 2026-11-21, the Arrows design in /__needs).
 */
import Image from "next/image";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Laptop, TriangleAlert } from "lucide-react";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { ButtonLink } from "@teamofsilicons/silicon-ui/button-link";
import type { CustodianRequest, SessionInfo } from "@/lib/api/types";
import { useMe } from "@/lib/query/session";
import { NEEDS_YOU_ID } from "./parts/anchors";
import { browserLogo, browserOf } from "./parts/browser";
import { keepSession, readKept, staleSessions, STALE_MS, subscribeKept } from "./parts/checkup";
import { asCarbon, describeError, msUntil, personLabel, spanText, useNow } from "./parts/common";
import { useEveryCustodianRequest, useEverySession, useSignOutSession } from "./parts/queries";
import { SiliconMark } from "./parts/silicon-mark";
import { sessionName } from "./security/sessions";
import { requestHref } from "./silicons/request-page";
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
  const stale = staleSessions(sessions.data?.items, now, kept);

  // Nothing waiting: nothing to show (no "You're all set", Anil 2026-10-31).
  if (!waiting.length && !failed && !stale.length) return null;

  return (
    <div id={NEEDS_YOU_ID} className={styles.group} tabIndex={-1}>
      <Requests id={NEEDS_YOU_ID} title="Needs you" limit={1} waiting={waiting} failed={failed} error={requests.error} retry={() => void requests.refetch()} stale={stale} now={now} />
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
  return <Requests id="silicon-requests" title="Waiting for you" waiting={waiting} failed={failed} error={requests.error} retry={() => void requests.refetch()} stale={[]} now={now} />;
}

/** How long a request has left, in the tone its row shows it: grey over a week, amber from a week, red under 3 days. */
const DAY = 86_400_000;
function timeLeft(request: CustodianRequest, now: number): { text: string; tone: "neutral" | "warning" | "danger"; used: number } {
  const left = msUntil(request.expires_at, now);
  const span = Date.parse(request.expires_at) - Date.parse(request.created_at);
  const used = span > 0 ? Math.min(1, Math.max(0, 1 - left / span)) : 1;
  if (left < DAY) return { text: "Ends today", tone: "danger", used: 1 };
  return { text: `${spanText(left)} left`, tone: left < 3 * DAY ? "danger" : left <= 7 * DAY ? "warning" : "neutral", used };
}

function Requests({ id, title, limit, waiting, failed, error, retry, stale, now }: { id: string; title: string; limit?: number; waiting: CustodianRequest[]; failed: boolean; error: unknown; retry: () => void; stale: SessionInfo[]; now: number }) {
  const signOut = useSignOutSession();
  // Paging (only with a limit): which item leads, and the way the last step went, so the new one slides in from there.
  const [page, setPage] = useState<{ start: number; step: "next" | "previous" | null }>({ start: 0, step: null });
  const items = [
    ...waiting.map(request => ({ kind: "request" as const, id: request.id, date: Date.parse(request.created_at), request })),
    ...stale.map(session => ({ kind: "device" as const, id: session.id, date: Date.parse(session.last_seen_at ?? session.created_at) + STALE_MS, session })),
  ].sort((a, b) => b.date - a.date || a.id.localeCompare(b.id));
  const paged = !!limit && items.length > limit;
  // An item handled elsewhere can shorten the list: stay on the last one there is.
  const start = paged ? Math.min(page.start, items.length - limit) : 0;
  const go = (step: "next" | "previous") => setPage({ start: start + (step === "next" ? 1 : -1), step });

  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.head}>
        <h2 id={`${id}-title`} className={styles.title}>{title}</h2>
        {items.length > 0 ? <Badge size="sm" tone="neutral">{items.length}</Badge> : null}
        {paged ? (
          <span className={styles.pager}>
            <span className={styles.position} aria-live="polite">{start + 1} of {items.length}</span>
            <Button variant="ghost" size="sm" aria-label="Previous" disabled={start === 0} onClick={() => go("previous")}><ChevronLeft size={16} strokeWidth={2} aria-hidden="true" /></Button>
            <Button variant="ghost" size="sm" aria-label="Next" disabled={start + limit >= items.length} onClick={() => go("next")}><ChevronRight size={16} strokeWidth={2} aria-hidden="true" /></Button>
          </span>
        ) : null}
      </div>
      <ul data-sq="surface" className={styles.rows}>
        {failed && items.length === 0 ? (
          <Row lead={<span data-sq="surface" className={`${styles.icon} ${styles.iconDanger}`} aria-hidden="true"><TriangleAlert size={16} strokeWidth={2} /></span>} title="Requests waiting for you did not load" detail={describeError(error)}>
            <Button variant="secondary" size="sm" onClick={retry}>Try Again</Button>
          </Row>
        ) : null}
        {items.slice(start, limit ? start + limit : undefined).map(item => {
          if (item.kind === "device") {
            const session = item.session;
            return (
              <Row key={`device-${session.id}`} enter={page.step} lead={<DeviceIcon session={session} />} title={`Still using ${sessionName(session)}?`} detail={`Last active ${spanText(now - Date.parse(session.last_seen_at ?? session.created_at))} ago`}>
                <Button variant="soft" size="sm" onClick={() => keepSession(session.id)}>Keep</Button>
                <Button variant="secondary" size="sm" loading={signOut.isPending} onClick={() => void signOut.mutateAsync(session.id).catch(() => undefined)}>Sign Out</Button>
              </Row>
            );
          }
          const request = item.request;
          const time = timeLeft(request, now);
          const transfer = request.kind === "transfer";
          return (
            <Row key={request.id} enter={page.step} lead={<SiliconMark seed={request.silicon.uuid} photo={request.silicon.pfp_url} size={28} pending={!transfer} />}
              title={transfer ? `${personLabel(request.from)} is handing ${siliconName(request)} to you` : `${siliconName(request)} wants you to look after it`}
              when={{ text: time.text, tone: time.tone }}>
              <ButtonLink href={requestHref(request.id)} variant="secondary" size="sm">Review</ButtonLink>
            </Row>
          );
        })}
      </ul>
    </section>
  );
}

/** A device row's icon: its browser's own logo, bare, when it is a known browser (parts/browser.ts), else a laptop on a grey tile. */
function DeviceIcon({ session }: { session: SessionInfo }) {
  const browser = browserOf(session);
  return (
    <span data-sq="surface" className={`${styles.icon} ${browser ? styles.iconLogo : ""}`} aria-hidden="true">
      {browser ? <Image className={styles.logo} src={browserLogo(browser)} alt="" width={24} height={24} unoptimized /> : <Laptop size={16} strokeWidth={2} />}
    </span>
  );
}

/**
 * One row (the boxed compact design, Anil 2026-11-11): the mark, the title over one line (a request's time left in its
 * colour, or a device's last use, or an error), and at most one outlined button (a device also has a quiet Keep).
 */
function Row({ lead, title, detail, when, enter, children }: { lead: ReactNode; title: string; detail?: string; when?: { text: string; tone: "neutral" | "warning" | "danger" }; enter?: "next" | "previous" | null; children: ReactNode }) {
  // A row that arrives by a step slides in from that side (keyed by item, so only the new one does).
  return (
    <li className={styles.row} data-enter={enter ?? undefined}>
      {lead}
      <span className={styles.text}>
        <span className={styles.rowTitle}>{title}</span>
        {when ? <span className={styles.when} data-tone={when.tone}>{when.text}</span> : detail ? <span className={styles.rowDetail}>{detail}</span> : null}
      </span>
      <span className={styles.actions}>{children}</span>
    </li>
  );
}

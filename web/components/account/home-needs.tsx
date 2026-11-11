"use client";

/**
 * Home's Needs you, under the greeting (Anil, 2026-10-31): what is waiting on the Carbon, one row each, shown only when
 * something waits:
 *
 * - a Silicon asking them to be its custodian, with Review (Accept and Decline are in the review);
 * - a Carbon handing them a Silicon, with Review;
 * - a device signed in but not used for 7 days (components/account/parts/checkup.ts), with Keep and Sign out.
 *
 * Nothing shows when nothing waits. The compact boxed design (Anil, 2026-11-11, picked from /__needs): one white list
 * with a clear border; each row a 28px mark (a Silicon's, or the browser's logo), the title over one line (a request's
 * time left, grey over a week, amber from a week, red under 3 days, "Ends today" under a day; or the device's last use),
 * and at most one outlined button, so nothing in the list is filled; the device also has Keep, a soft grey button (Anil, 2026-11-11). Soonest first,
 * the device last; the count is a neutral badge.
 */
import Image from "next/image";
import { useSyncExternalStore, type ReactNode } from "react";
import { Laptop, TriangleAlert } from "lucide-react";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { ButtonLink } from "@teamofsilicons/silicon-ui/button-link";
import type { CustodianRequest, SessionInfo } from "@/lib/api/types";
import { useMe } from "@/lib/query/session";
import { NEEDS_YOU_ID } from "./parts/anchors";
import { browserLogo, browserOf } from "./parts/browser";
import { keepSession, readKept, staleSession, subscribeKept } from "./parts/checkup";
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

/** How long a request has left, in the tone its row shows it: grey over a week, amber from a week, red under 3 days. */
const DAY = 86_400_000;
function timeLeft(request: CustodianRequest, now: number): { text: string; tone: "neutral" | "warning" | "danger"; used: number } {
  const left = msUntil(request.expires_at, now);
  const span = Date.parse(request.expires_at) - Date.parse(request.created_at);
  const used = span > 0 ? Math.min(1, Math.max(0, 1 - left / span)) : 1;
  if (left < DAY) return { text: "Ends today", tone: "danger", used: 1 };
  return { text: `${spanText(left)} left`, tone: left < 3 * DAY ? "danger" : left <= 7 * DAY ? "warning" : "neutral", used };
}

function Requests({ id, title, waiting, failed, error, retry, stale, now }: { id: string; title: string; waiting: CustodianRequest[]; failed: boolean; error: unknown; retry: () => void; stale: SessionInfo | undefined; now: number }) {
  const signOut = useSignOutSession();
  const count = waiting.length + (failed ? 1 : 0) + (stale ? 1 : 0);
  // The soonest to run out first; a device has no deadline, so it comes last.
  const byDeadline = [...waiting].sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));

  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <div className={styles.head}>
        <h2 id={`${id}-title`} className={styles.title}>{title}</h2>
        <Badge size="sm" tone="neutral">{count}</Badge>
      </div>
      <ul data-sq="surface" className={styles.rows}>
        {failed ? (
          <Row lead={<span data-sq="surface" className={`${styles.icon} ${styles.iconDanger}`} aria-hidden="true"><TriangleAlert size={16} strokeWidth={2} /></span>} title="Requests waiting for you did not load" detail={describeError(error)}>
            <Button variant="secondary" size="sm" onClick={retry}>Try Again</Button>
          </Row>
        ) : null}
        {byDeadline.map(request => {
          const time = timeLeft(request, now);
          const transfer = request.kind === "transfer";
          return (
            <Row key={request.id} lead={<SiliconMark seed={request.silicon.uuid} size={28} pending={!transfer} />}
              title={transfer ? `${personLabel(request.from)} is handing ${siliconName(request)} to you` : `${siliconName(request)} wants you to look after it`}
              when={{ text: time.text, tone: time.tone }}>
              <ButtonLink href={requestHref(request.id)} variant="secondary" size="sm">Review</ButtonLink>
            </Row>
          );
        })}
        {stale ? (
          <Row lead={<DeviceIcon session={stale} />} title={`Still using ${sessionName(stale)}?`} detail={`Last active ${spanText(now - Date.parse(stale.last_seen_at ?? stale.created_at))} ago`}>
            <Button variant="soft" size="sm" onClick={() => keepSession(stale.id)}>Keep</Button>
            <Button variant="secondary" size="sm" loading={signOut.isPending} onClick={() => void signOut.mutateAsync(stale.id).catch(() => undefined)}>Sign Out</Button>
          </Row>
        ) : null}
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
function Row({ lead, title, detail, when, children }: { lead: ReactNode; title: string; detail?: string; when?: { text: string; tone: "neutral" | "warning" | "danger" }; children: ReactNode }) {
  return (
    <li className={styles.row}>
      {lead}
      <span className={styles.text}>
        <span className={styles.rowTitle}>{title}</span>
        {when ? <span className={styles.when} data-tone={when.tone}>{when.text}</span> : detail ? <span className={styles.rowDetail}>{detail}</span> : null}
      </span>
      <span className={styles.actions}>{children}</span>
    </li>
  );
}

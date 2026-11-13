"use client";

/**
 * /silicons/requests/[id], one request waiting for you, as the prototype draws it (Anil, 2026-11-12): Silicons above
 * it, then one card: who asks (a Silicon asking you to look after it, or a Carbon handing one to you) drawn as marks with
 * arrows to you, what it is, what Accept and Decline each do side by side, the two buttons, and the days left under it.
 * Declining a Silicon's own request asks first (its account is released); accepting goes to the Silicon's page.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Inbox } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { ButtonLink } from "@teamofsilicons/silicon-ui/button-link";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
import type { CustodianRequest } from "@/lib/api/types";
import { paths } from "@/lib/navigation";
import { useMe } from "@/lib/query/session";
import { describeError, msUntil, personLabel, spanText, useNow } from "../parts/common";
import { PageBar } from "../parts/page-bar";
import { useDecideRequest, useEveryCustodianRequest, type Decision } from "../parts/queries";
import { SiliconMark } from "../parts/silicon-mark";
import styles from "./request-page.module.css";

/** A request's own page. */
export const requestHref = (id: string) => `${paths.silicons}/requests/${encodeURIComponent(id)}`;

const nameOf = (request: CustodianRequest) => request.silicon.display_name || request.silicon.id || "A Silicon";

export function RequestPage({ id }: { id: string }) {
  const requests = useEveryCustodianRequest();
  const me = useMe();
  const now = useNow(60_000);
  const request = requests.data?.items.find(item => item.id === id);
  const transfer = request?.kind === "transfer";
  const parent = { label: "Silicons", href: paths.silicons };

  return (
    <div>
      <PageBar parent={parent} title={transfer ? "Handover" : "Request"} />
      <Page>
        {requests.error && !requests.data ? (
          <Alert tone="danger" title="This request did not load">
            {describeError(requests.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void requests.refetch()}>Try Again</Button></span>
          </Alert>
        ) : !requests.data ? (
          <div className={styles.skeleton} aria-busy="true" aria-label="Loading the request"><Skeleton label="Loading" lines={5} avatar /></div>
        ) : !request ? (
          <EmptyState
            icon={<Inbox width={24} height={24} strokeWidth={1.5} />}
            title="No request here"
            description="It was answered, it ran out, or it was never for you."
            action={<ButtonLink href={paths.silicons} variant="secondary" size="sm">Your Silicons</ButtonLink>}
          />
        ) : (
          <Decision request={request} you={{ name: me.data?.display_name ?? "You", photo: me.data?.pfp_url }} now={now} />
        )}
      </Page>
    </div>
  );
}

function Decision({ request, you, now }: { request: CustodianRequest; you: { name: string; photo?: string }; now: number }) {
  const decide = useDecideRequest();
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const transfer = request.kind === "transfer";
  const name = nameOf(request);
  const from = personLabel(request.from);
  const left = msUntil(request.expires_at, now);

  const answer = async (decision: Decision) => {
    setError(null);
    setDeciding(decision);
    try {
      await decide.mutateAsync({ id: request.id, decision });
      setAsking(false);
      await decide.settle(request.id, decision);
      router.push(decision === "accept" ? `${paths.silicons}/${encodeURIComponent(request.silicon.uuid)}` : paths.silicons);
    } catch (raw) {
      setError(describeError(raw));
    } finally {
      setDeciding(null);
    }
  };

  return (
    <>
      <section data-sq="surface" className={styles.card} aria-labelledby="request-title">
        <div className={styles.who} aria-hidden="true">
          {transfer ? (
            <>
              <Avatar name={from} src={request.from?.pfp_url} size="lg" />
              <ArrowRight className={styles.arrow} size={18} strokeWidth={2} />
            </>
          ) : null}
          <SiliconMark seed={request.silicon.uuid} photo={request.silicon.pfp_url} size={48} pending={!transfer} />
          <ArrowRight className={styles.arrow} size={18} strokeWidth={2} />
          <Avatar name={you.name} src={you.photo} size="lg" />
        </div>
        <h2 id="request-title" className={styles.title}>{transfer ? `${from} is handing ${name} to you` : `${name} wants you to look after it`}</h2>
        {transfer ? null : (
          <p className={styles.lead}>It made its own account as <strong className="mono">{request.silicon.id ?? request.silicon.uuid}</strong>. Accept only if you know who set it up.</p>
        )}
        <div className={styles.choices}>
          <div data-sq="surface" className={styles.choice} data-yes="">
            <span className={styles.choiceTitle}>Accept</span>
            <span className={styles.choiceText}>{transfer ? "You look after it. It keeps working as before." : "It can sign in to apps as itself. You manage its account."}</span>
          </div>
          <div data-sq="surface" className={styles.choice}>
            <span className={styles.choiceTitle}>Decline</span>
            <span className={styles.choiceText}>{transfer ? `${from} keeps it.` : "It can’t sign in, and its id is freed."}</span>
          </div>
        </div>
        {error && !asking ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.buttons}>
          <Button size="lg" loading={deciding === "accept"} disabled={!!deciding} onClick={() => void answer("accept")}>Accept</Button>
          <Button variant="secondary" size="lg" loading={!asking && deciding === "decline"} disabled={!!deciding} onClick={() => (transfer ? void answer("decline") : setAsking(true))}>Decline</Button>
        </div>
      </section>
      <p className={styles.left}>{left > 0 ? `${spanText(left)} left` : "This request has run out."}</p>
      <Dialog open={asking} onOpenChange={open => { if (!open && !deciding) setAsking(false); }}>
        {asking ? (
          <DialogContent title={`Decline ${name}?`} description={<>It can&rsquo;t sign in anywhere, its account is released, and <strong>{request.silicon.id ?? name}</strong> is freed.</>}>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setAsking(false)} disabled={!!deciding}>Cancel</Button>
              <Button variant="danger" loading={deciding === "decline"} onClick={() => void answer("decline")}>Decline</Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

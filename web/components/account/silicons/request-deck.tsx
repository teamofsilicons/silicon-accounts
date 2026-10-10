"use client";

/**
 * Custodian requests waiting for you, as a stacked deck: the top card is the one to answer (a Silicon asking you to be
 * its custodian, or a Carbon handing a Silicon to you); the next ones peek out behind it. Accepting sends the card up
 * and away, declining drops it, and the next card rises into place with the keyboard focus. When the last one is
 * answered the deck goes, and the page decides where focus goes next (`onEmptied`).
 */
import { useRef, useState, type CSSProperties } from "react";
import { animate } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Avatar } from "@/components/silicon-ui/avatar/avatar";
import { Button } from "@/components/silicon-ui/button/button";
import { ConfirmMorph } from "@/components/silicon-ui/confirm-morph/confirm-morph";
import { motionTokens } from "@/components/silicon-ui/lib/motion-tokens";
import type { CustodianRequest } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { durationText, msUntil, reportFailure } from "../parts/common";
import { FitPrompt } from "../parts/fit-prompt";
import { useDecideRequest, type Decision } from "../parts/queries";
import styles from "./request-deck.module.css";

const VISIBLE = 3;
const exitEase = [...motionTokens.ease.exit] as [number, number, number, number];
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface RequestDeckProps {
  requests: CustodianRequest[];
  now: number;
  /**
   * The last request was answered and the deck is gone, with the focus its card had. Called once the Silicons list has
   * been read again, so after an accept the Silicon's tile is there to take it.
   */
  onEmptied: (siliconUuid: string, decision: Decision) => void;
}

export function RequestDeck({ requests, now, onEmptied }: RequestDeckProps) {
  const deck = useRef<HTMLDivElement>(null);
  const decide = useDecideRequest();
  const visible = requests.slice(0, VISIBLE);
  // The answered card leaves with the focus it had: hand it to the next request's main action, or, when that was the
  // last request, let the page place it.
  const decided = (request: CustodianRequest, decision: Decision) => {
    const hadFocus = !!deck.current?.contains(document.activeElement) || document.activeElement === document.body;
    const refreshed = decide.settle(request.id, decision);
    if (!hadFocus) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const next = deck.current?.querySelector<HTMLElement>("[data-top] [data-deck-primary]");
      if (next) next.focus({ preventScroll: true });
      // The deck unmounted (its ref is gone): that was the last request.
      else if (!deck.current) void refreshed.then(() => onEmptied(request.silicon.uuid, decision));
    }));
  };
  return (
    <div ref={deck} className={styles.deck} style={{ "--behind": String(Math.max(0, visible.length - 1)) } as CSSProperties} role="list" aria-label="Custodian requests">
      {visible.map((request, index) => (
        <DeckCard
          key={request.id}
          request={request}
          index={index}
          total={requests.length}
          now={now}
          decide={(decision: Decision) => decide.mutateAsync({ id: request.id, decision })}
          onDecided={decision => decided(request, decision)}
        />
      ))}
    </div>
  );
}

interface DeckCardProps {
  request: CustodianRequest;
  index: number;
  total: number;
  now: number;
  decide: (decision: Decision) => Promise<unknown>;
  onDecided: (decision: Decision) => void;
}

function DeckCard({ request, index, total, now, decide, onDecided }: DeckCardProps) {
  const card = useRef<HTMLDivElement>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const top = index === 0;
  const silicon = request.silicon;
  const from = request.from;
  const left = msUntil(request.expires_at, now);

  const leave = async (decision: Decision) => {
    const node = card.current;
    if (node && !reducedMotion()) {
      const exit = decision === "accept"
        ? { x: [0, 56], y: [0, -28], rotate: [0, 3], opacity: [1, 0] }
        : { y: [0, 36], scale: [1, 0.96], opacity: [1, 0] };
      await animate(node, exit, { duration: motionTokens.duration.considered * 0.7, ease: exitEase });
    }
    onDecided(decision);
  };

  const accept = async () => {
    setAccepting(true);
    setError(null);
    try {
      await decide("accept");
      await leave("accept");
    } catch (raw) {
      setError(reportFailure(raw, "The request was not accepted"));
      setAccepting(false);
    }
  };

  const decline = async () => {
    setError(null);
    try {
      await decide("decline");
    } catch (raw) {
      setError(reportFailure(raw, "The request was not declined"));
      throw raw;
    }
    // "Declined" shows in place, then the card drops away.
    window.setTimeout(() => void leave("decline"), 650);
  };

  const id = silicon.id ?? "This Silicon";
  const sender = from?.id;
  const sentence = request.kind === "initial"
    ? `${id} created its own account and named you as its custodian. Accepting makes you responsible for its account: its details, its id and its STK. Declining releases its account.`
    : `${sender ?? "Its custodian"} wants to hand ${id} over to you. Accept and you become its custodian; ${sender ? `${sender} stops` : "they stop"} being one.`;

  // A list item of the deck (a div: an <article> may not take the listitem role).
  return (
    <div
      ref={card}
      data-sq="surface"
      className={styles.card}
      role="listitem"
      style={{ "--i": String(index) } as CSSProperties}
      data-top={top || undefined}
      aria-hidden={top ? undefined : "true"}
      inert={!top || undefined}
      aria-label={`${request.kind === "initial" ? "Custodian request from" : "Transfer of"} ${silicon.id ?? silicon.display_name}`}
    >
      <header className={styles.head}>
        <Avatar name={silicon.display_name} src={silicon.pfp_url} size="lg" />
        <div className={styles.who}>
          <span className={styles.name}>{silicon.display_name}</span>
          <span className={styles.id}>{silicon.id ?? silicon.uuid}</span>
        </div>
        <span className={styles.count}>{index + 1} of {total}</span>
      </header>
      {request.kind === "transfer" && from ? (
        <div className={styles.handover} aria-hidden="true">
          <span className={styles.party}><Avatar name={from.display_name} src={from.pfp_url} size="sm" /><span className="mono">{from.id ?? from.uuid}</span></span>
          <ArrowRight size={14} strokeWidth={1.75} />
          <span className={styles.party}><span>you</span></span>
        </div>
      ) : null}
      <p className={styles.sentence}>{sentence}</p>
      <p className={styles.expiry}>
        {left > 0 ? `Answer within ${durationText(left / 1000)} (by ${formatDate(request.expires_at)}). After that the request expires.` : "This request has expired."}
      </p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <ConfirmMorph
          label="Decline"
          prompt={<FitPrompt full={request.kind === "initial" ? "Decline the request?" : "Decline the transfer?"} short="Decline it?" tiny="Decline?" />}
          confirmLabel="Decline"
          pendingLabel="Declining"
          doneLabel="Declined"
          onConfirm={decline}
          disabled={accepting}
        />
        <Button data-deck-primary="" onClick={() => void accept()} loading={accepting}>{request.kind === "initial" ? "Accept and become custodian" : "Accept the transfer"}</Button>
      </div>
    </div>
  );
}

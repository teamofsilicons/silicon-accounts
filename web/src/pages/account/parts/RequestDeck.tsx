/**
 * Custodian requests waiting for you, as a stacked deck: the top card is the one to answer (a Silicon asking you to
 * be its custodian, or a Carbon handing a Silicon to you); the next ones peek out behind it. Accepting sends the card
 * up and away, declining drops it, and the next card rises into place.
 */
import { For, Show, createMemo, createSignal } from "solid-js";
import { ArrowRight } from "lucide-solid";
import type { AccountSummary, CustodianRequest } from "../../../api";
import { Avatar } from "../../../arc/avatar/avatar";
import { Button } from "../../../arc/button/button";
import { ConfirmMorph } from "../../../arc/confirm-morph/confirm-morph";
import { animate, motionTokens, prefersReducedMotion } from "../../../arc/lib/motion";
import { useSquircle } from "../../../arc/lib/squircle";
import { formatDate } from "../../../lib/format";
import { msUntil, reportFailure, spanText } from "./common";
import styles from "./deck.module.css";

export type Decision = "accept" | "decline";

export interface RequestDeckProps {
  requests: CustodianRequest[];
  now: number;
  /** Performs the decision; reject with the API error. */
  decide: (request: CustodianRequest, decision: Decision) => Promise<unknown>;
  /** Called once the card has left (remove it from the list here). */
  onDecided: (request: CustodianRequest, decision: Decision) => void;
}

const VISIBLE = 3;

export function RequestDeck(props: RequestDeckProps) {
  let deck: HTMLDivElement | undefined;
  const visible = createMemo(() => props.requests.slice(0, VISIBLE));
  // The answered card leaves with the focus it had: hand it to the next request's main action.
  const decided = (request: CustodianRequest, decision: Decision) => {
    const hadFocus = !!deck?.contains(document.activeElement) || document.activeElement === document.body;
    props.onDecided(request, decision);
    if (hadFocus) requestAnimationFrame(() => deck?.querySelector<HTMLElement>("[data-top] [data-deck-primary]")?.focus({ preventScroll: true }));
  };
  return (
    <div ref={deck} class={styles.deck} style={{ "--behind": String(Math.max(0, visible().length - 1)) }} role="list" aria-label="Custodian requests">
      <For each={visible()}>
        {(request, index) => (
          <DeckCard request={request} index={index()} total={props.requests.length} now={props.now} decide={props.decide} onDecided={decided} />
        )}
      </For>
    </div>
  );
}

interface DeckCardProps {
  request: CustodianRequest;
  index: number;
  total: number;
  now: number;
  decide: RequestDeckProps["decide"];
  onDecided: RequestDeckProps["onDecided"];
}

function DeckCard(props: DeckCardProps) {
  let card: HTMLElement | undefined;
  const [accepting, setAccepting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const top = () => props.index === 0;
  const silicon = () => props.request.silicon;
  const from = (): AccountSummary | null => props.request.from;
  const left = () => msUntil(props.request.expires_at, props.now);

  const leave = async (decision: Decision) => {
    if (card && !prefersReducedMotion()) {
      const exit = decision === "accept"
        ? { x: [0, 56], y: [0, -28], rotate: [0, 3], opacity: [1, 0] }
        : { y: [0, 36], scale: [1, 0.96], opacity: [1, 0] };
      await animate(card, exit, { duration: motionTokens.duration.considered * 0.7, ease: [...motionTokens.ease.exit] as [number, number, number, number] });
    }
    props.onDecided(props.request, decision);
  };

  const accept = async () => {
    setAccepting(true);
    setError(null);
    try {
      await props.decide(props.request, "accept");
      await leave("accept");
    } catch (raw) {
      setError(reportFailure(raw, "The request was not accepted"));
    } finally {
      setAccepting(false);
    }
  };

  const decline = async () => {
    setError(null);
    await props.decide(props.request, "decline");
    window.setTimeout(() => void leave("decline"), 650);
  };

  const sentence = () => {
    const id = silicon().id ?? "This Silicon";
    if (props.request.kind === "initial") return `${id} created its own account and named you as its custodian. Accepting makes you responsible for its account: its details, its id and its STK.`;
    const sender = from()?.id;
    return `${sender ?? "Its custodian"} wants to hand ${id} over to you. Accept and you become its custodian; ${sender ? `${sender} stops` : "they stop"} being one.`;
  };

  return (
    <article
      ref={el => { card = el; useSquircle(el); }}
      class={styles.card}
      role="listitem"
      style={{ "--i": String(props.index) }}
      data-top={top() || undefined}
      aria-hidden={top() ? undefined : "true"}
      inert={!top() || undefined}
      aria-label={`${props.request.kind === "initial" ? "Custodian request from" : "Transfer of"} ${silicon().id ?? silicon().display_name}`}
    >
      <header class={styles.head}>
        <Avatar name={silicon().display_name} src={silicon().pfp_url} size="lg" kind="silicon" />
        <div class={styles.who}>
          <span class={styles.name}>{silicon().display_name}</span>
          <span class={styles.id}>{silicon().id ?? silicon().uuid}</span>
        </div>
        <span class={styles.count}>{props.index + 1} of {props.total}</span>
      </header>
      <Show when={props.request.kind === "transfer" && from()}>
        {sender => (
          <div class={styles.handover} aria-hidden="true">
            <span class={styles.party}><Avatar name={sender().display_name} src={sender().pfp_url} size="xs" /><span class="mono">{sender().id}</span></span>
            <ArrowRight size={14} stroke-width={1.75} />
            <span class={styles.party}><span>you</span></span>
          </div>
        )}
      </Show>
      <p class={styles.sentence}>{sentence()}</p>
      <p class={styles.expiry}>
        {left() > 0 ? `Answer within ${spanText(left())} (by ${formatDate(props.request.expires_at)}). After that the request expires.` : "This request has expired."}
      </p>
      <Show when={error()}><p class={styles.error} role="alert">{error()}</p></Show>
      <div class={styles.actions}>
        <ConfirmMorph
          label="Decline"
          prompt={props.request.kind === "initial" ? "Decline? Its account is released." : "Decline the transfer?"}
          confirmLabel="Decline"
          pendingLabel="Declining"
          doneLabel="Declined"
          onConfirm={decline}
          onError={raw => setError(reportFailure(raw, "The request was not declined"))}
          disabled={accepting()}
        />
        <Button data-deck-primary onClick={() => void accept()} loading={accepting()}>{props.request.kind === "initial" ? "Accept and become custodian" : "Accept the transfer"}</Button>
      </div>
    </article>
  );
}

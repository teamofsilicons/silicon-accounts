"use client";

/**
 * Three visual designs for a custodian request (Anil, 2026-11-12: "we need better design overall"), compared in
 * /__request beside RequestView (the ordered list). Each carries the same facts (requestFacts) in a different shape:
 *
 *   ChoiceDesign  A hero in the Silicon's own colours (its avatar arriving to you), then Accept and Decline as two
 *                 cards side by side, each listing what it does with its button at its foot: you pick a card.
 *   PassDesign    Two columns: a tall pass for the Silicon (its avatar art over its name, si:id and the request's
 *                 facts) beside the question, the check, what accepting means and the buttons.
 *   SheetDesign   A review sheet: the request's facts as a summary on the left, and a sticky "Your answer" panel on
 *                 the right with the time left as a bar, the commitments as a checklist and the buttons.
 *
 * Pure: the caller answers (onAnswer). Declining a Silicon's own request asks first.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, Check, Clock, IdCard, KeyRound, LayoutGrid, LogIn, ShieldAlert, UserX, X } from "lucide-react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { Progress } from "@teamofsilicons/silicon-ui/progress";
import type { CustodianRequest } from "@/lib/api/types";
import { formatDate, formatRelative } from "@/lib/format";
import { siliconAvatarDataUrl, siliconChoiceFromSeed, siliconPalette } from "@/lib/silicon-avatar";
import { msUntil, personLabel, spanText } from "../parts/common";
import type { RequestAnswer } from "./request-view";
import styles from "./request-designs.module.css";

const DAY = 86_400_000;
const ICON = { size: 16, strokeWidth: 1.75 } as const;

export interface DesignProps { request: CustodianRequest; now: number; you: { name: string; photo?: string }; deciding?: RequestAnswer | null; onAnswer: (answer: RequestAnswer) => void }

/** Everything a request page says, worked out once. */
export function requestFacts(request: CustodianRequest, now: number) {
  const transfer = request.kind === "transfer";
  const name = request.silicon.display_name || request.silicon.id || "A Silicon";
  const siliconId = request.silicon.id ?? request.silicon.uuid;
  const from = request.from;
  const fromName = from?.display_name || personLabel(from);
  const left = msUntil(request.expires_at, now);
  const total = msUntil(request.expires_at, Date.parse(request.created_at));
  const to = request.to;
  const email = to && typeof to === "object" && "email" in to ? to.email : null;
  const choice = siliconChoiceFromSeed(request.silicon.uuid);
  return {
    transfer, name, siliconId, from, fromName, left, open: left > 0, soon: left > 0 && left < 2 * DAY,
    elapsed: total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 1,
    ends: formatDate(request.expires_at), asked: formatRelative(request.created_at, now), askedOn: formatDate(request.created_at),
    namedBy: email ? `your email, ${email}` : "your CarbonID",
    question: transfer ? `Take over ${name} from ${fromName}?` : `Look after ${name}?`,
    checkTitle: transfer ? `Accept only if you expected this from ${fromName}.` : "Accept only if you know who set it up.",
    checkBody: transfer ? `${fromName} keeps looking after ${name} until you answer.` : `A Silicon can name anyone. ${name} named you by ${email ? "your email" : "your CarbonID"}.`,
    accept: [
      { icon: <IdCard {...ICON} />, text: `You manage its name, si:id and key.` },
      transfer ? { icon: <KeyRound {...ICON} />, text: "It keeps its si:id, key and sign-ins." } : { icon: <LogIn {...ICON} />, text: "It can sign in to apps as itself." },
      { icon: <LayoutGrid {...ICON} />, text: "It shows in your Silicons." },
      { icon: <UserX {...ICON} />, text: "You can’t delete your account while you look after it." },
    ],
    decline: transfer
      ? [{ icon: <Check {...ICON} />, text: `${fromName} keeps looking after it.` }, { icon: <X {...ICON} />, text: "Nothing else changes." }]
      : [{ icon: <X {...ICON} />, text: "It can’t sign in anywhere." }, { icon: <UserX {...ICON} />, text: `Its account is released and ${siliconId} is freed.` }],
    lapse: left > 0 ? `If you don’t answer by ${formatDate(request.expires_at)}, it runs out, as if you declined.` : `It ran out on ${formatDate(request.expires_at)}.`,
    art: siliconAvatarDataUrl(choice, { crop: true }),
    palette: { "--p1": siliconPalette(choice)[0], "--p2": siliconPalette(choice)[Math.floor(siliconPalette(choice).length / 2)], "--p3": siliconPalette(choice).at(-1) } as CSSProperties,
  };
}
type Facts = ReturnType<typeof requestFacts>;

/** The time left: a badge that warms in the last two days. */
function TimeLeft({ facts }: { facts: Facts }) {
  return facts.open ? <Badge size="sm" tone={facts.soon ? "warning" : "neutral"}>{spanText(facts.left)} left</Badge> : <Badge size="sm" tone="danger">Ran out</Badge>;
}

/** Accept and Decline, Decline asking first for a Silicon's own request. */
function useAnswer({ request, deciding, onAnswer }: DesignProps) {
  const [asking, setAsking] = useState(false);
  const facts = requestFacts(request, 0);
  const decline = () => (facts.transfer ? onAnswer("decline") : setAsking(true));
  const dialog = (
    <Dialog open={asking} onOpenChange={open => { if (!open && !deciding) setAsking(false); }}>
      {asking ? (
        <DialogContent title={`Decline ${facts.name}?`} description={<>It can&rsquo;t sign in anywhere, its account is released, and <strong>{facts.siliconId}</strong> is freed.</>}>
          <div className={styles.dialogActions}>
            <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
            <Button variant="danger" loading={deciding === "decline"} onClick={() => { onAnswer("decline"); setAsking(false); }}>Decline</Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
  return { decline, dialog };
}

/** The Silicon's avatar on a wash of its own palette. */
function Art({ facts, className }: { facts: Facts; className?: string }) {
  return (
    <span data-sq="clip" className={[styles.art, className].filter(Boolean).join(" ")} style={facts.palette} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- a generated SVG data URL. */}
      <img src={facts.art} alt="" />
    </span>
  );
}

function List({ items, tone }: { items: Array<{ icon: ReactNode; text: string }>; tone?: "accept" | "decline" }) {
  return <ul className={styles.list} data-tone={tone}>{items.map(item => <li key={item.text}><span className={styles.listIcon} aria-hidden="true">{item.icon}</span>{item.text}</li>)}</ul>;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A  Choice: a hero in the Silicon's colours, then two cards to pick from                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export function ChoiceDesign(props: DesignProps) {
  const { request, now, you, deciding, onAnswer } = props;
  const facts = requestFacts(request, now);
  const { decline, dialog } = useAnswer(props);
  return (
    <div className={styles.choice}>
      <section data-sq="clip" className={styles.hero} style={facts.palette}>
        <div className={styles.heroFigures} aria-hidden="true">
          {facts.transfer && facts.from ? <><span className={styles.heroPerson}><Avatar name={facts.fromName} src={facts.from.pfp_url} size="lg" /></span><ArrowRight className={styles.heroArrow} {...ICON} /></> : null}
          <Art facts={facts} className={styles.heroArt} />
          <ArrowRight className={styles.heroArrow} {...ICON} />
          <span className={styles.heroPerson}><Avatar name={you.name} src={you.photo} size="lg" /></span>
        </div>
        <h2 className={styles.heroQuestion}>{facts.question}</h2>
        <p className={styles.heroMeta}><span className="mono">{facts.siliconId}</span><span aria-hidden="true">·</span>Asked {facts.asked}<span aria-hidden="true">·</span><TimeLeft facts={facts} /></p>
      </section>
      <p data-sq="surface" className={styles.check}><ShieldAlert {...ICON} aria-hidden="true" /><span><strong>{facts.checkTitle}</strong> {facts.checkBody}</span></p>
      <div className={styles.cards}>
        <section data-sq="surface" className={styles.option} data-yes="" aria-labelledby="choice-accept">
          <h3 id="choice-accept" className={styles.optionTitle}><Check {...ICON} aria-hidden="true" />Accept</h3>
          <List items={facts.accept} tone="accept" />
          <Button size="lg" className={styles.optionButton} loading={deciding === "accept"} disabled={!facts.open || !!deciding} onClick={() => onAnswer("accept")}>Accept</Button>
        </section>
        <section data-sq="surface" className={styles.option} aria-labelledby="choice-decline">
          <h3 id="choice-decline" className={styles.optionTitle}><X {...ICON} aria-hidden="true" />Decline</h3>
          <List items={facts.decline} tone="decline" />
          <Button variant="secondary" size="lg" className={styles.optionButton} disabled={!facts.open || !!deciding} onClick={decline}>Decline</Button>
        </section>
      </div>
      <p className={styles.lapse}><Clock {...ICON} aria-hidden="true" />{facts.lapse}</p>
      {dialog}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* B  Pass: the Silicon's pass beside the decision                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

export function PassDesign(props: DesignProps) {
  const { request, now, deciding, onAnswer } = props;
  const facts = requestFacts(request, now);
  const { decline, dialog } = useAnswer(props);
  return (
    <div className={styles.pass}>
      <aside data-sq="clip" className={styles.ticket} style={facts.palette} aria-label={`${facts.name}, ${facts.siliconId}`}>
        <Art facts={facts} className={styles.ticketArt} />
        <div className={styles.ticketWords}>
          <span className={styles.ticketName}>{facts.name}</span>
          <span className={styles.ticketId}>{facts.siliconId}</span>
        </div>
        <dl className={styles.ticketFacts}>
          {facts.transfer ? <div><dt>From</dt><dd>{facts.fromName}</dd></div> : <div><dt>Named you by</dt><dd>{facts.namedBy.replace(/^your /, "").replace(/^email, /, "")}</dd></div>}
          <div><dt>Asked</dt><dd>{facts.askedOn}</dd></div>
          <div><dt>Answer by</dt><dd>{facts.ends}</dd></div>
        </dl>
      </aside>
      <div className={styles.passMain}>
        <p className={styles.eyebrow}>{facts.transfer ? "A handover" : "A Silicon asks you"} · <TimeLeft facts={facts} /></p>
        <h2 className={styles.passQuestion}>{facts.question}</h2>
        <p data-sq="surface" className={styles.check}><ShieldAlert {...ICON} aria-hidden="true" /><span><strong>{facts.checkTitle}</strong> {facts.checkBody}</span></p>
        <h3 className={styles.smallTitle}>Accepting means</h3>
        <List items={facts.accept} tone="accept" />
        <div className={styles.passButtons}>
          <Button size="lg" loading={deciding === "accept"} disabled={!facts.open || !!deciding} onClick={() => onAnswer("accept")}>Accept</Button>
          <Button variant="secondary" size="lg" disabled={!facts.open || !!deciding} onClick={decline}>Decline</Button>
        </div>
        <p className={styles.lapse}>{facts.transfer ? `Declining: ${facts.fromName} keeps it.` : `Declining: it can’t sign in and ${facts.siliconId} is freed.`} {facts.lapse}</p>
      </div>
      {dialog}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* C  Sheet: a summary of the request, and a sticky answer panel                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

export function SheetDesign(props: DesignProps) {
  const { request, now, deciding, onAnswer } = props;
  const facts = requestFacts(request, now);
  const { decline, dialog } = useAnswer(props);
  return (
    <div className={styles.sheet}>
      <div className={styles.sheetMain}>
        <div className={styles.sheetHead}>
          <Art facts={facts} className={styles.sheetArt} />
          <div>
            <h2 className={styles.passQuestion}>{facts.question}</h2>
            <p className={styles.heroMeta}>Asked {facts.asked}</p>
          </div>
        </div>
        <p data-sq="surface" className={styles.check}><ShieldAlert {...ICON} aria-hidden="true" /><span><strong>{facts.checkTitle}</strong> {facts.checkBody}</span></p>
        <section data-sq="surface" className={styles.summary} aria-label="The request">
          <Row label="Silicon"><span className={styles.rowStrong}>{facts.name}</span> <span className={styles.rowMono}>{facts.siliconId}</span></Row>
          {facts.transfer ? <Row label="From"><span className={styles.rowStrong}>{facts.fromName}</span> {facts.from?.id ? <span className={styles.rowMono}>{facts.from.id}</span> : null}</Row> : <Row label="Named you by">{facts.namedBy}</Row>}
          <Row label="Asked">{facts.askedOn}</Row>
          <Row label="If you decline">{facts.decline.map(item => item.text).join(" ")}</Row>
          <Row label="If you don’t answer">Runs out on {facts.ends}, as if you declined.</Row>
        </section>
      </div>
      <aside data-sq="surface" className={styles.panel} aria-label="Your answer">
        <h3 className={styles.smallTitle}>Your answer</h3>
        <div className={styles.timer}>
          <span className={styles.timerWords}>{facts.open ? <>{spanText(facts.left)} left</> : "Ran out"}<span>until {facts.ends}</span></span>
          <Progress value={Math.round(facts.elapsed * 100)} label="Time used" />
        </div>
        <p className={styles.panelLead}>Accepting means</p>
        <List items={facts.accept} tone="accept" />
        <Button size="lg" className={styles.optionButton} loading={deciding === "accept"} disabled={!facts.open || !!deciding} onClick={() => onAnswer("accept")}>Accept</Button>
        <Button variant="ghost" size="lg" className={styles.optionButton} disabled={!facts.open || !!deciding} onClick={decline}>Decline</Button>
      </aside>
      {dialog}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className={styles.row}><span className={styles.rowLabel}>{label}</span><span className={styles.rowValue}>{children}</span></div>;
}

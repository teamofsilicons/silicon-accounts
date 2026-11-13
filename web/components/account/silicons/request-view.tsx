"use client";

/**
 * A custodian request as a decision (Anil, 2026-11-12: "what information needs to go in, what's important"), in the
 * order a Carbon asks themself, compared in /__request before it replaces request-page.tsx's card:
 *
 *   1. The question and its time: "Look after Research Silicon?", asked when, how long is left.
 *   2. What it is: the Silicon (its pixel avatar, name, si:id); for a handover, who hands it over too.
 *   3. Is it real: a Silicon can name anyone, so accept only if you know who set it up; how it named you (your
 *      CarbonID or your email, from `to`). For a handover, who it comes from.
 *   4. What accepting commits you to (UNDERSTANDING.md, Custodian): you manage its details, si:id and key; it signs in
 *      to apps as itself and shows in your Silicons; you can't delete your account while you look after it.
 *   5. What declining does, and that the request runs out by itself after its 14 days.
 *   6. The answer: Accept and Decline, the days left beside them. Declining a Silicon's own request asks first.
 *
 * Pure: the caller answers (onAnswer). The lab passes samples and answers nothing.
 */
import { useState } from "react";
import { AtSign, Check, IdCard, KeyRound, LayoutGrid, LogIn, Mail, ShieldAlert, UserX } from "lucide-react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import type { CustodianRequest } from "@/lib/api/types";
import { formatDate, formatRelative } from "@/lib/format";
import { msUntil, personLabel, spanText } from "../parts/common";
import { SiliconMark } from "../parts/silicon-mark";
import styles from "./request-view.module.css";

export type RequestAnswer = "accept" | "decline";

const DAY = 86_400_000;

export function RequestView({ request, now, deciding, error, onAnswer }: { request: CustodianRequest; now: number; deciding?: RequestAnswer | null; error?: string | null; onAnswer: (answer: RequestAnswer) => void }) {
  const [asking, setAsking] = useState(false);
  const transfer = request.kind === "transfer";
  const name = request.silicon.display_name || request.silicon.id || "A Silicon";
  const siliconId = request.silicon.id ?? request.silicon.uuid;
  const from = request.from;
  const fromName = from?.display_name || personLabel(from);
  const left = msUntil(request.expires_at, now);
  const soon = left > 0 && left < 2 * DAY;
  const ends = formatDate(request.expires_at);
  const to = request.to;
  const byEmail = !!to && typeof to === "object" && "email" in to;

  return (
    <div className={styles.view}>
      {/* 1. The question and its time. */}
      <header className={styles.head}>
        <h2 className={styles.question}>{transfer ? `Take over ${name} from ${fromName}?` : `Look after ${name}?`}</h2>
        <p className={styles.meta}>
          <span>Asked {formatRelative(request.created_at, now)}</span>
          <span aria-hidden="true">·</span>
          {left > 0 ? <Badge size="sm" tone={soon ? "warning" : "neutral"}>{spanText(left)} left</Badge> : <Badge size="sm" tone="danger">Ran out</Badge>}
        </p>
      </header>

      {/* 2. What it is (and, for a handover, who from). */}
      <section className={styles.parties} aria-label="Who is involved">
        {transfer && from ? (
          <div data-sq="surface" className={styles.party}>
            <Avatar name={fromName} src={from.pfp_url} size="lg" />
            <span className={styles.partyWords}>
              <span className={styles.partyRole}>From</span>
              <span className={styles.partyName}>{fromName}</span>
              {from.id ? <span className={styles.partyId}>{from.id}</span> : null}
            </span>
          </div>
        ) : null}
        <div data-sq="surface" className={styles.party}>
          <SiliconMark seed={request.silicon.uuid} size={56} />
          <span className={styles.partyWords}>
            <span className={styles.partyRole}>{transfer ? "The Silicon" : "A Silicon"}</span>
            <span className={styles.partyName}>{name}</span>
            <span className={styles.partyId}>{siliconId}</span>
          </span>
        </div>
      </section>

      {/* 3. Is it real. */}
      {transfer ? (
        <p className={styles.check}>
          <span className={styles.checkIcon} aria-hidden="true"><ShieldAlert size={16} strokeWidth={2} /></span>
          <span><strong>Accept only if you expected this from {fromName}.</strong> {fromName} keeps looking after {name} until you answer.</span>
        </p>
      ) : (
        <p className={styles.check}>
          <span className={styles.checkIcon} aria-hidden="true"><ShieldAlert size={16} strokeWidth={2} /></span>
          <span>
            <strong>Accept only if you know who set it up.</strong> A Silicon can name anyone. {name} made its own account and named you{" "}
            {byEmail ? <>by your email, <span className={styles.mono}>{(to as { email: string }).email}</span></> : "by your CarbonID"}, {formatDate(request.created_at)}.
          </span>
        </p>
      )}

      {/* 4. What accepting commits you to. */}
      <section className={styles.block} aria-labelledby="if-accept">
        <h3 id="if-accept" className={styles.blockTitle}>If you accept</h3>
        <ul className={styles.list}>
          <Item icon={<IdCard size={16} strokeWidth={2} />}>You look after {name}: its name, its si:id and its key are yours to manage.</Item>
          {transfer
            ? <Item icon={<KeyRound size={16} strokeWidth={2} />}>It keeps working as before: same si:id, same key, same sign-ins.</Item>
            : <Item icon={<LogIn size={16} strokeWidth={2} />}>It can sign in to apps as itself.</Item>}
          <Item icon={<LayoutGrid size={16} strokeWidth={2} />}>It shows in your Silicons.</Item>
          <Item icon={<UserX size={16} strokeWidth={2} />}>You can&rsquo;t delete your account while you look after it; you&rsquo;d hand it to someone else first.</Item>
        </ul>
      </section>

      {/* 5. What declining does, and doing nothing. */}
      <section className={styles.block} aria-labelledby="if-decline">
        <h3 id="if-decline" className={styles.blockTitle}>If you decline</h3>
        <ul className={styles.list}>
          {transfer
            ? <Item icon={<Check size={16} strokeWidth={2} />}>{fromName} keeps looking after {name}. Nothing else changes.</Item>
            : <Item icon={<UserX size={16} strokeWidth={2} />}>{name} can&rsquo;t sign in anywhere, its account is released and <span className={styles.mono}>{siliconId}</span> is freed.</Item>}
          <Item icon={transfer ? <AtSign size={16} strokeWidth={2} /> : <Mail size={16} strokeWidth={2} />}>{transfer ? `${fromName} is told.` : `${name} is told, if it asked to be.`}</Item>
        </ul>
        <p className={styles.note}>{left > 0 ? `If you don’t answer by ${ends}, it runs out, as if you declined.` : `It ran out on ${ends}.`}</p>
      </section>

      {/* 6. The answer. */}
      {error && !asking ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.answer}>
        <Button size="lg" loading={deciding === "accept"} disabled={!!deciding || left <= 0} onClick={() => onAnswer("accept")}>Accept</Button>
        <Button variant="secondary" size="lg" loading={!asking && deciding === "decline"} disabled={!!deciding || left <= 0} onClick={() => (transfer ? onAnswer("decline") : setAsking(true))}>Decline</Button>
        {left > 0 ? <span className={styles.left}>{spanText(left)} left · until {ends}</span> : null}
      </div>

      <Dialog open={asking} onOpenChange={open => { if (!open && !deciding) setAsking(false); }}>
        {asking ? (
          <DialogContent title={`Decline ${name}?`} description={<>It can&rsquo;t sign in anywhere, its account is released, and <strong>{siliconId}</strong> is freed.</>}>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setAsking(false)} disabled={!!deciding}>Cancel</Button>
              <Button variant="danger" loading={deciding === "decline"} onClick={() => { onAnswer("decline"); setAsking(false); }}>Decline</Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

function Item({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <li className={styles.item}><span className={styles.itemIcon} aria-hidden="true">{icon}</span><span>{children}</span></li>;
}

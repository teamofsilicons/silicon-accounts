"use client";

/**
 * Three designs for the consent step, the page where a Carbon decides what an app sees (Anil, 2026-11-13), compared in
 * /__consent inside the real hosted frame. Each carries the same facts:
 *
 *   - who is signing in (with Switch Account), and where the details go (the app's address);
 *   - what the app always gets (name, CarbonID and photo), what it requires, and what is the Carbon's choice;
 *   - which details it hasn't had before ("New"), and a detail the account doesn't have yet (Add);
 *   - that the app sees changes too, and that access can be changed any time in Connected Apps;
 *   - Share and Continue, Cancel.
 *
 *   PreviewConsent    "How Briefcase will see you": a card the app receives, filling in as details are switched on.
 *   HandshakeConsent  The app and you joined by a line; "Briefcase gets" and "You choose" as two groups.
 *   ChecklistConsent  Compact: the always-shared profile in one line, each other detail a row with a switch.
 *
 * Pure and local: switches only change this page; the caller decides what Share does.
 */
import { useState, type ReactNode } from "react";
import { ArrowLeftRight, Eye, Lock, RefreshCw, Settings2 } from "lucide-react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Switch } from "@teamofsilicons/silicon-ui/switch";
import styles from "./consent-designs.module.css";

export interface ConsentField { field: string; label: string; value: string | null; mode: "required" | "optional"; isNew: boolean; shared: boolean }
export interface ConsentProps {
  app: { name: string; logo?: string | null; domain: string | null };
  account: { name: string; id: string; photo?: string | null };
  fields: ConsentField[];
  onShare?: (shared: string[]) => void;
}

function useChoices(fields: ConsentField[]) {
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(fields.map(field => [field.field, field.mode === "required" || field.shared])));
  const set = (field: string, value: boolean) => setOn(current => ({ ...current, [field]: value }));
  const shared = fields.filter(field => on[field.field] && field.value !== null);
  return { on, set, shared };
}

const NEW = <Badge size="sm" tone="info">New</Badge>;

function Footer({ app, children }: { app: ConsentProps["app"]; children?: ReactNode }) {
  return (
    <p className={styles.footer}>
      <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
      <span>{children ?? <>{app.name} also sees these when they change. Change what it sees any time in <strong>Connected Apps</strong>.</>}</span>
    </p>
  );
}

function Actions({ app, onShare, shared }: { app: ConsentProps["app"]; onShare?: ConsentProps["onShare"]; shared: ConsentField[] }) {
  return (
    <div className={styles.actions}>
      <Button size="lg" className={styles.wide} onClick={() => onShare?.(shared.map(field => field.field))}>Share and Continue</Button>
      <Button variant="ghost" size="lg" className={styles.wide}>Cancel</Button>
      {app.domain ? <p className={styles.where}>Your details go to <span className={styles.domain}>{app.domain}</span></p> : null}
    </div>
  );
}

/** One detail with its switch, lock or Add. */
function DetailRow({ field, on, set, compact }: { field: ConsentField; on: boolean; set: (value: boolean) => void; compact?: boolean }) {
  const missing = field.value === null;
  return (
    <li className={styles.detail} data-compact={compact || undefined} data-off={!on || missing || undefined}>
      <span className={styles.detailWords}>
        <span className={styles.detailLabel}>{field.label}{field.isNew ? NEW : null}</span>
        <span className={styles.detailValue}>{missing ? "You haven’t added one" : field.value}</span>
      </span>
      {missing ? <Button variant="secondary" size="xs">Add</Button>
        : field.mode === "required" ? <span className={styles.lock}><Lock size={13} strokeWidth={1.75} aria-hidden="true" />Required</span>
        : <Switch checked={on} onCheckedChange={set} aria-label={`Share ${field.label}`} />}
    </li>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A  Preview: how the app will see you                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export function PreviewConsent({ app, account, fields, onShare }: ConsentProps) {
  const { on, set, shared } = useChoices(fields);
  return (
    <div className={styles.consent}>
      <header className={styles.head}>
        <h1 className={styles.title}>How {app.name} will see you</h1>
        <p className={styles.lead}>Switch on what you&rsquo;re happy to share. The card shows exactly what {app.name} gets.</p>
      </header>
      <section data-sq="surface" className={styles.preview} aria-label={`What ${app.name} gets`}>
        <div className={styles.previewTop}>
          <Avatar name={account.name} src={account.photo ?? undefined} size="lg" />
          <span className={styles.previewWho}>
            <span className={styles.previewName}>{account.name}</span>
            <span className={styles.previewId}>{account.id}</span>
          </span>
          <Eye className={styles.previewEye} size={16} strokeWidth={1.75} aria-hidden="true" />
        </div>
        <ul className={styles.previewFacts}>
          {fields.map(field => {
            const visible = on[field.field] && field.value !== null;
            return (
              <li key={field.field} data-hidden={!visible || undefined}>
                <span>{field.label}</span>
                <span>{visible ? field.value : "Not shared"}</span>
              </li>
            );
          })}
        </ul>
      </section>
      <ul className={styles.details} aria-label="Your choices">
        {fields.map(field => <DetailRow key={field.field} field={field} on={!!on[field.field]} set={value => set(field.field, value)} compact />)}
      </ul>
      <Footer app={app} />
      <div className={styles.signedIn}>Signing in as {account.name} · <Button variant="link" size="xs">Switch Account</Button></div>
      <Actions app={app} onShare={onShare} shared={shared} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* B  Handshake: the app and you, then two groups                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

export function HandshakeConsent({ app, account, fields, onShare }: ConsentProps) {
  const { on, set, shared } = useChoices(fields);
  const required = fields.filter(field => field.mode === "required");
  const optional = fields.filter(field => field.mode === "optional");
  return (
    <div className={styles.consent}>
      <div className={styles.handshake} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element -- app logos are arbitrary URLs, as the hosted frame shows them. */}
        {app.logo ? <img data-sq="clip" src={app.logo} alt="" className={styles.handLogo} /> : <span data-sq="clip" className={styles.handLogo} />}
        <span className={styles.handLine}><ArrowLeftRight size={14} strokeWidth={1.75} /></span>
        <Avatar name={account.name} src={account.photo ?? undefined} size="lg" />
      </div>
      <header className={styles.head} data-center="">
        <h1 className={styles.title}>{app.name} would like to know you</h1>
        <p className={styles.lead}>Signing in as <strong>{account.name}</strong> <span className={styles.mono}>{account.id}</span> · <Button variant="link" size="xs">Switch</Button></p>
      </header>
      <section className={styles.group} aria-labelledby="hs-gets">
        <h2 id="hs-gets" className={styles.groupTitle}>{app.name} gets</h2>
        <ul data-sq="surface" className={styles.box}>
          <li className={styles.detail}>
            <span className={styles.detailWords}>
              <span className={styles.detailLabel}>Name, CarbonID and photo</span>
              <span className={styles.detailValue}>{account.name} · {account.id}</span>
            </span>
            <span className={styles.lock}><Lock size={13} strokeWidth={1.75} aria-hidden="true" />Always</span>
          </li>
          {required.map(field => <DetailRow key={field.field} field={field} on set={() => undefined} />)}
        </ul>
      </section>
      {optional.length ? (
        <section className={styles.group} aria-labelledby="hs-choose">
          <h2 id="hs-choose" className={styles.groupTitle}>You choose</h2>
          <ul data-sq="surface" className={styles.box}>
            {optional.map(field => <DetailRow key={field.field} field={field} on={!!on[field.field]} set={value => set(field.field, value)} />)}
          </ul>
        </section>
      ) : null}
      <Footer app={app} />
      <Actions app={app} onShare={onShare} shared={shared} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* C  Checklist: compact rows                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

export function ChecklistConsent({ app, account, fields, onShare }: ConsentProps) {
  const { on, set, shared } = useChoices(fields);
  const count = shared.length + 1;
  return (
    <div className={styles.consent}>
      <header className={styles.head}>
        <h1 className={styles.title}>Share with {app.name}?</h1>
        <p className={styles.lead}>{app.name} will see {count} {count === 1 ? "thing" : "things"} about you.</p>
      </header>
      <ul data-sq="surface" className={styles.box}>
        <li className={styles.detail} data-compact="">
          <Avatar name={account.name} src={account.photo ?? undefined} size="sm" />
          <span className={styles.detailWords}>
            <span className={styles.detailLabel}>Name, CarbonID and photo</span>
            <span className={styles.detailValue}>{account.name} · {account.id}</span>
          </span>
          <span className={styles.lock}><Lock size={13} strokeWidth={1.75} aria-hidden="true" />Always</span>
        </li>
        {fields.map(field => <DetailRow key={field.field} field={field} on={!!on[field.field]} set={value => set(field.field, value)} compact />)}
      </ul>
      <p className={styles.footer}>
        <Settings2 size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>It sees changes too. Change this any time in <strong>Connected Apps</strong>. Not {account.name}? <Button variant="link" size="xs">Switch Account</Button></span>
      </p>
      <Actions app={app} onShare={onShare} shared={shared} />
    </div>
  );
}

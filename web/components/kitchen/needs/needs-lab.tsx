"use client";

/**
 * /__needs: alternatives for Home's Needs you block (development only, like /__kitchen). Each design shows one thing
 * waiting and three (a Silicon's request, a recovery phone, a device not used lately), built from Silicon UI parts and
 * tokens, with the same sample words. Pick one, or parts of several.
 *
 *   A  Card (today's): the prototype's card, title and count inside, rows under hairlines, a warning edge.
 *   B  Strips: no card; each item its own warning-tinted strip (the prototype's .attn), a small heading above.
 *   C  Quiet list: no box; a heading with a count in words, rows between hairlines, a warning bar at each row's start.
 *   D  Tray: a grey tile holding a white card per item, a warning dot by the title.
 *   E  Alerts: Silicon UI's Alert, warning, one per item, its action inside.
 *   F  Checklist: one card that counts down ("1 of 3 left") with a progress bar, done items ticked off below.
 */
import type { ReactNode } from "react";
import { Check, Laptop, Smartphone } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Progress } from "@teamofsilicons/silicon-ui/progress";
import { SiliconMark } from "@/components/account/parts/silicon-mark";
import styles from "./needs-lab.module.css";

interface Item {
  key: string;
  lead: (tone?: "warning") => ReactNode;
  title: string;
  detail: string;
  actions: ReactNode;
}

const tile = (icon: ReactNode, tone?: "warning") => <span data-sq="surface" className={styles.tile} data-tone={tone}>{icon}</span>;

const PHONE: Item = {
  key: "phone",
  lead: tone => tile(<Smartphone size={16} strokeWidth={1.75} />, tone),
  title: "Add a recovery phone",
  detail: "In case you lose your email",
  actions: <Button variant="secondary" size="sm">Add</Button>,
};
const REQUEST: Item = {
  key: "request",
  lead: () => <SiliconMark seed="research" size={40} pending />,
  title: "Research Silicon wants you to look after it",
  detail: "12 days left",
  actions: <><Button variant="secondary" size="sm">Decline</Button><Button size="sm">Review</Button></>,
};
const DEVICE: Item = {
  key: "device",
  lead: tone => tile(<Laptop size={16} strokeWidth={1.75} />, tone),
  title: "Still using Terminal · silicon-accounts CLI?",
  detail: "Last used 12 days ago",
  actions: <><Button variant="ghost" size="sm">Keep</Button><Button variant="secondary" size="sm">Sign out</Button></>,
};

const ONE = [PHONE];
const THREE = [REQUEST, PHONE, DEVICE];

const DESIGNS: Array<{ id: string; name: string; note: string; render: (items: Item[]) => ReactNode }> = [
  { id: "a", name: "A · Card (today)", note: "The prototype's card: the title and count inside, rows under hairlines, a warning-tinted edge.", render: items => <CardDesign items={items} /> },
  { id: "b", name: "B · Strips", note: "No card. Each item is its own warning-tinted strip, as the prototype's attention strip; a small heading above.", render: items => <StripsDesign items={items} /> },
  { id: "c", name: "C · Quiet list", note: "No box. A heading with the count in words, rows between hairlines, a warning bar at the start of each row.", render: items => <QuietDesign items={items} /> },
  { id: "d", name: "D · Tray", note: "A grey tile holding a white card per item, a warning dot by the title. Reads as a pile of things to do.", render: items => <TrayDesign items={items} /> },
  { id: "e", name: "E · Alerts", note: "Silicon UI's Alert, warning tone, one per item with its action inside. Loudest; uses the component as it is.", render: items => <AlertsDesign items={items} /> },
  { id: "f", name: "F · Checklist", note: "One card that counts down with a progress bar, finished items ticked off below. Frames it as setup you complete.", render: items => <ChecklistDesign items={items} /> },
];

export function NeedsLab() {
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Needs you: alternatives</h1>
        <p className={styles.lede}>Each design with one thing waiting, then three. Sample words; buttons do nothing here.</p>
      </header>
      {DESIGNS.map(design => (
        <section key={design.id} className={styles.design} aria-labelledby={`design-${design.id}`}>
          <div className={styles.designHead}>
            <h2 id={`design-${design.id}`} className={styles.designName}>{design.name}</h2>
            <p className={styles.designNote}>{design.note}</p>
          </div>
          <div className={styles.examples}>
            <div className={styles.example}><span className={styles.exampleLabel}>One</span>{design.render(ONE)}</div>
            <div className={styles.example}><span className={styles.exampleLabel}>Three</span>{design.render(THREE)}</div>
          </div>
        </section>
      ))}
    </main>
  );
}

function Row({ item, tone, className }: { item: Item; tone?: "warning"; className?: string }) {
  return (
    <div className={[styles.row, className].filter(Boolean).join(" ")}>
      {item.lead(tone)}
      <span className={styles.text}>
        <span className={styles.rowTitle}>{item.title}</span>
        <span className={styles.rowDetail}>{item.detail}</span>
      </span>
      <span className={styles.actions}>{item.actions}</span>
    </div>
  );
}

function CardDesign({ items }: { items: Item[] }) {
  return (
    <div data-sq="surface" className={`${styles.card} ${styles.cardWarning}`}>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>Needs you</span>
        <Badge size="sm" tone="warning">{items.length}</Badge>
      </div>
      {items.map(item => <Row key={item.key} item={item} className={styles.ruled} />)}
    </div>
  );
}

function StripsDesign({ items }: { items: Item[] }) {
  return (
    <div className={styles.stack}>
      <span className={styles.smallHead}>Needs you</span>
      {items.map(item => <div key={item.key} data-sq="surface" className={styles.strip}><Row item={item} tone="warning" /></div>)}
    </div>
  );
}

function QuietDesign({ items }: { items: Item[] }) {
  return (
    <div className={styles.quiet}>
      <div className={styles.quietHead}>
        <span className={styles.cardTitle}>Needs you</span>
        <span className={styles.quietCount}>{items.length === 1 ? "1 thing" : `${items.length} things`}</span>
      </div>
      {items.map(item => <Row key={item.key} item={item} className={styles.barred} />)}
    </div>
  );
}

function TrayDesign({ items }: { items: Item[] }) {
  return (
    <div data-sq="surface" className={styles.tray}>
      <div className={styles.trayHead}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.cardTitle}>Needs you</span>
        <span className={styles.quietCount}>{items.length}</span>
      </div>
      {items.map(item => <div key={item.key} data-sq="surface" className={styles.trayItem}><Row item={item} /></div>)}
    </div>
  );
}

function AlertsDesign({ items }: { items: Item[] }) {
  return (
    <div className={styles.stack}>
      {items.map(item => (
        <Alert key={item.key} tone="warning" title={item.title}>
          {item.detail}
          <span className={styles.alertActions}>{item.actions}</span>
        </Alert>
      ))}
    </div>
  );
}

function ChecklistDesign({ items }: { items: Item[] }) {
  const done = [{ key: "email", title: "Verified email" }, { key: "google", title: "Sign in with Google" }];
  const total = items.length + done.length;
  return (
    <div data-sq="surface" className={styles.card}>
      <div className={styles.checkHead}>
        <div className={styles.checkTitleRow}>
          <span className={styles.cardTitle}>Finish setting up</span>
          <span className={styles.quietCount}>{items.length} of {total} left</span>
        </div>
        <Progress value={done.length} max={total} label="Setup progress" />
      </div>
      {items.map(item => <Row key={item.key} item={item} tone="warning" className={styles.ruled} />)}
      {done.map(item => (
        <div key={item.key} className={`${styles.row} ${styles.ruled} ${styles.doneRow}`}>
          {tile(<Check size={16} strokeWidth={2} />)}
          <span className={styles.text}><span className={styles.rowDone}>{item.title}</span></span>
        </div>
      ))}
    </div>
  );
}

"use client";

/**
 * /__needs, compact versions (Anil, 2026-11-11, branch compact): Home's Needs you under the compact philosophy
 * (redesign/decisions.md): two-line rows about 52px instead of 64, small marks, one button per row at most and none filled
 * (the filled one belongs to the review), the urgency said once (the coloured time left, no progress bar). The same
 * items as Home (a handover, a Silicon's request, an unused browser) at Home's column width, three and then one.
 *
 *   1  Boxed: today's box with a clear border, tightened; one outlined button; Keep a quiet text button (Anil's pick).
 *   2  Open, logos: no box and no tiles; the bare Silicon marks and the browser's logo on the page, hairlines between.
 *   3  One line: each item on a single line in a soft grey tray; the densest.
 *   4  Chevron rows: no buttons; the whole row opens its review (Decline and Sign out live there), like Personal info.
 */
import Image from "next/image";
import type { ReactNode } from "react";
import { ChevronRight, X } from "lucide-react";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { SiliconMark } from "@/components/account/parts/silicon-mark";
import styles from "./needs-compact.module.css";

type Tone = "neutral" | "warning" | "danger";
interface Item {
  key: string;
  kind: "silicon" | "device";
  seed?: string;
  pending?: boolean;
  logo?: string;
  title: string;
  /** Who or what, before the time: "From c:saket". */
  context?: string;
  time: string;
  tone: Tone;
  action: string;
}

const HANDOVER: Item = { key: "handover", kind: "silicon", seed: "ledger", title: "c:saket is handing Ledger to you", context: "Handover", time: "2 days left", tone: "danger", action: "Review" };
const REQUEST: Item = { key: "request", kind: "silicon", seed: "researcher", pending: true, title: "Researcher wants you to look after it", context: "From c:saket", time: "5 days left", tone: "warning", action: "Review" };
const DEVICE: Item = { key: "device", kind: "device", logo: "/browsers/chrome.svg", title: "Still using Chrome on macOS?", time: "Last active 7 days ago", tone: "neutral", action: "Sign Out" };
const THREE = [HANDOVER, REQUEST, DEVICE];
const ONE = [DEVICE];

const VERSIONS: { id: string; name: string; note: string; render: (items: Item[]) => ReactNode }[] = [
  { id: "boxed", name: "1 · Boxed", note: "Today's box with a clear border, tightened to about 52px a row (was 64), small marks. One outlined button a row; the device's Keep is a quiet text button beside Sign out. The urgency is the coloured time, no bar.", render: items => <Boxed items={items} /> },
  { id: "open", name: "2 · Open, logos", note: "No box and no tiles: the bare Silicon marks and the browser's own logo sit on the page, hairlines between the rows. The lightest; Needs you reads like part of Home, not a panel.", render: items => <Open items={items} /> },
  { id: "line", name: "3 · One line", note: "Each item on a single line (title, then the time on the right, then one quiet button) in a soft grey tray. The densest: three things in about 110px.", render: items => <OneLine items={items} /> },
  { id: "chevron", name: "4 · Chevron rows", note: "No buttons at all: the whole row opens its review, where Review, Decline, Keep and Sign out live. Like Personal info's rows; the calmest list, one more click to act.", render: items => <Chevron items={items} /> },
];

export function CompactNeeds() {
  return (
    <>
      {VERSIONS.map(version => (
        <section key={version.id} className={styles.version} aria-labelledby={`compact-${version.id}`}>
          <div className={styles.versionHead}>
            <h2 id={`compact-${version.id}`} className={styles.versionName}>{version.name}</h2>
            <p className={styles.versionNote}>{version.note}</p>
          </div>
          <div className={styles.stage}>
            <div className={styles.column}>
              <span className={styles.caption}>Three</span>
              {version.render(THREE)}
              <span className={styles.caption}>One</span>
              {version.render(ONE)}
            </div>
          </div>
        </section>
      ))}
    </>
  );
}

/* Shared --------------------------------------------------------------------------------------------------------- */

function Head({ count, plain }: { count: number; plain?: boolean }) {
  return (
    <div className={styles.head}>
      <h3 className={styles.title}>Needs you</h3>
      {plain ? <span className={styles.count}>{count}</span> : <Badge size="sm" tone="neutral">{count}</Badge>}
    </div>
  );
}

/** The item's mark: a Silicon's mark, or the browser's logo; on a tile unless bare. */
function Mark({ item, bare }: { item: Item; bare?: boolean }) {
  if (item.kind === "silicon") return <SiliconMark seed={item.seed!} size={bare ? 24 : 28} pending={item.pending} />;
  return (
    <span data-sq={bare ? undefined : "surface"} className={bare ? styles.logoBare : styles.logoTile} aria-hidden="true">
      <Image src={item.logo!} alt="" width={bare ? 22 : 18} height={bare ? 22 : 18} unoptimized />
    </span>
  );
}

function Detail({ item }: { item: Item }) {
  return (
    <span className={styles.detail}>
      {item.context ? <>{item.context} · </> : null}
      <span className={styles.time} data-tone={item.tone}>{item.time}</span>
    </span>
  );
}

const Keep = () => <Button variant="ghost" size="sm" aria-label="Keep signed in"><X size={14} strokeWidth={2} aria-hidden="true" /></Button>;

/* 1 · Boxed ------------------------------------------------------------------------------------------------------ */

function Boxed({ items }: { items: Item[] }) {
  return (
    <section className={styles.block}>
      <Head count={items.length} />
      <ul data-sq="surface" className={styles.box}>
        {items.map(item => (
          <li key={item.key} className={styles.row}>
            <Mark item={item} />
            <span className={styles.text}>
              <span className={styles.rowTitle}>{item.title}</span>
              <Detail item={item} />
            </span>
            <span className={styles.actions}>
              {item.kind === "device" ? <Button variant="ghost" size="sm">Keep</Button> : null}
              <Button variant="secondary" size="sm">{item.action}</Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* 2 · Open, logos ------------------------------------------------------------------------------------------------ */

function Open({ items }: { items: Item[] }) {
  return (
    <section className={styles.block}>
      <Head count={items.length} plain />
      <ul className={styles.open}>
        {items.map(item => (
          <li key={item.key} className={styles.row}>
            <Mark item={item} bare />
            <span className={styles.text}>
              <span className={styles.rowTitle}>{item.title}</span>
              <Detail item={item} />
            </span>
            <span className={styles.actions}>
              {item.kind === "device" ? <Keep /> : null}
              <Button variant="secondary" size="sm">{item.action}</Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* 3 · One line --------------------------------------------------------------------------------------------------- */

function OneLine({ items }: { items: Item[] }) {
  return (
    <section className={styles.block}>
      <Head count={items.length} />
      <ul data-sq="surface" className={styles.tray}>
        {items.map(item => (
          <li key={item.key} className={styles.line}>
            <Mark item={item} bare />
            <span className={styles.lineTitle}>{item.title}</span>
            <span className={styles.lineTime} data-tone={item.tone}>{item.time}</span>
            <Button variant={item.kind === "device" ? "ghost" : "secondary"} size="xs">{item.action}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* 4 · Chevron rows ----------------------------------------------------------------------------------------------- */

function Chevron({ items }: { items: Item[] }) {
  return (
    <section className={styles.block}>
      <Head count={items.length} />
      <ul data-sq="surface" className={styles.box}>
        {items.map(item => (
          <li key={item.key}>
            <a href="#needs" className={styles.linkRow} aria-label={`${item.title}: ${item.kind === "device" ? "keep or sign out" : "review"}`}>
              <Mark item={item} />
              <span className={styles.text}>
                <span className={styles.rowTitle}>{item.title}</span>
                <Detail item={item} />
              </span>
              <ChevronRight className={styles.chevron} size={16} strokeWidth={2} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

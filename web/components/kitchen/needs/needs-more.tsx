"use client";

/**
 * /__needs, seeing everything waiting (Anil, 2026-11-21): Home's Needs you shows only the newest item, with the total in
 * its badge ("5"), and nothing else of the other four. Three ways to reach them, each on today's boxed rows
 * (home-needs.module.css) with the same five items: a handover, two Silicons asking, two browsers not used lately.
 *
 *   1  Show all: the newest item, then a row at the box's foot, "Show all 5", that opens the rest in place (Show less).
 *   2  Arrows: one item at a time; "1 of 5" and previous and next buttons beside the heading; each new item slides in
 *      from its side. Anil's pick (2026-11-21), now on Home; the slide is home-needs.module.css's own.
 *   3  Carousel: Silicon UI's Carousel, one item a slide; swipe, the arrow keys or its controls.
 */
import Image from "next/image";
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Carousel } from "@teamofsilicons/silicon-ui/carousel";
import { SiliconMark } from "@/components/account/parts/silicon-mark";
import home from "@/components/account/home-needs.module.css";
import styles from "./needs-more.module.css";

type Tone = "neutral" | "warning" | "danger";
interface Item {
  key: string;
  title: string;
  seed?: string;
  pending?: boolean;
  logo?: string;
  /** A request's time left, in its colour. */
  when?: { text: string; tone: Tone };
  /** A device's last use. */
  detail?: string;
}

const ITEMS: Item[] = [
  { key: "handover", seed: "ledger", title: "c:saket is handing Ledger to you", when: { text: "2 days left", tone: "danger" } },
  { key: "researcher", seed: "researcher", pending: true, title: "Researcher wants you to look after it", when: { text: "5 days left", tone: "warning" } },
  { key: "chrome", logo: "/browsers/chrome.svg", title: "Still using Chrome on macOS?", detail: "Last active 7 days ago" },
  { key: "scout", seed: "scout", pending: true, title: "Scout wants you to look after it", when: { text: "12 days left", tone: "neutral" } },
  { key: "safari", logo: "/browsers/safari.svg", title: "Still using Safari on iPhone?", detail: "Last active 9 days ago" },
];

const VERSIONS: { id: string; name: string; note: string; render: () => ReactNode }[] = [
  { id: "all", name: "1 · Show all", note: "The newest item as today, then a quiet row at the box's foot, \"Show all 5\", that opens the other four in place under it; \"Show less\" folds them back. Everything stays on Home, in one list, in order.", render: () => <ShowAll /> },
  { id: "arrows", name: "2 · Arrows", note: "One item at a time, as today. Beside the heading, \"1 of 5\" and previous and next buttons step through them; the new item slides in a little from the side it comes from and fades up, the box keeps still. The smallest change to Home. Picked for Home (2026-11-21).", render: () => <Arrows /> },
  { id: "carousel", name: "3 · Carousel", note: "Silicon UI's Carousel with one item a slide: swipe, drag, the arrow keys, or the dots and arrows below it, with the items sliding across. The most motion, and a row of controls under the box.", render: () => <Slides /> },
];

export function NeedsMore() {
  return (
    <>
      <div className={styles.intro}>
        <h2 className={styles.introTitle}>Seeing everything waiting (2026-11-21)</h2>
        <p className={styles.introNote}>Home shows the newest item and the total. Three ways to reach the rest, with five things waiting.</p>
      </div>
      {VERSIONS.map(version => (
        <section key={version.id} className={styles.version} aria-labelledby={`more-${version.id}`}>
          <div className={styles.versionHead}>
            <h3 id={`more-${version.id}`} className={styles.versionName}>{version.name}</h3>
            <p className={styles.versionNote}>{version.note}</p>
          </div>
          <div className={styles.stage}>
            <div className={styles.column}>{version.render()}</div>
          </div>
        </section>
      ))}
    </>
  );
}

/* Shared: Home's heading and row --------------------------------------------------------------------------------- */

function Head({ end }: { end?: ReactNode }) {
  return (
    <div className={`${home.head} ${styles.head}`}>
      <h4 className={home.title}>Needs you</h4>
      <Badge size="sm" tone="neutral">{ITEMS.length}</Badge>
      {end ? <span className={styles.headEnd}>{end}</span> : null}
    </div>
  );
}

function Lead({ item }: { item: Item }) {
  if (item.seed) return <SiliconMark seed={item.seed} size={28} pending={item.pending} />;
  return (
    <span data-sq="surface" className={`${home.icon} ${home.iconLogo}`} aria-hidden="true">
      <Image className={home.logo} src={item.logo!} alt="" width={24} height={24} unoptimized />
    </span>
  );
}

function Row({ item, as: Tag = "li", enter }: { item: Item; as?: "li" | "div"; enter?: "next" | "previous" | null }) {
  return (
    <Tag className={home.row} data-enter={enter ?? undefined}>
      <Lead item={item} />
      <span className={home.text}>
        <span className={home.rowTitle}>{item.title}</span>
        {item.when ? <span className={home.when} data-tone={item.when.tone}>{item.when.text}</span> : <span className={home.rowDetail}>{item.detail}</span>}
      </span>
      <span className={home.actions}>
        {item.logo ? <><Button variant="soft" size="sm">Keep</Button><Button variant="secondary" size="sm">Sign Out</Button></> : <Button variant="secondary" size="sm">Review</Button>}
      </span>
    </Tag>
  );
}

/* 1 · Show all --------------------------------------------------------------------------------------------------- */

function ShowAll() {
  const [open, setOpen] = useState(false);
  const shown = open ? ITEMS : ITEMS.slice(0, 1);
  return (
    <section className={home.section}>
      <Head />
      <ul data-sq="surface" className={home.rows}>
        {shown.map(item => <Row key={item.key} item={item} />)}
        <li className={styles.foot}>
          <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>
            {open ? "Show less" : `Show all ${ITEMS.length}`}
            {open ? <ChevronUp size={16} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />}
          </Button>
        </li>
      </ul>
    </section>
  );
}

/* 2 · Arrows ----------------------------------------------------------------------------------------------------- */

function Arrows() {
  const [{ index, step }, setPage] = useState<{ index: number; step: "next" | "previous" | null }>({ index: 0, step: null });
  const last = ITEMS.length - 1;
  const go = (to: "next" | "previous") => setPage({ index: index + (to === "next" ? 1 : -1), step: to });
  return (
    <section className={home.section}>
      <Head end={(
        <>
          <span className={styles.position} aria-live="polite">{index + 1} of {ITEMS.length}</span>
          <Button variant="ghost" size="sm" aria-label="Previous" disabled={index === 0} onClick={() => go("previous")}><ChevronLeft size={16} strokeWidth={2} aria-hidden="true" /></Button>
          <Button variant="ghost" size="sm" aria-label="Next" disabled={index === last} onClick={() => go("next")}><ChevronRight size={16} strokeWidth={2} aria-hidden="true" /></Button>
        </>
      )} />
      <ul data-sq="surface" className={home.rows}>
        <Row key={ITEMS[index]!.key} item={ITEMS[index]!} enter={step} />
      </ul>
    </section>
  );
}

/* 3 · Carousel --------------------------------------------------------------------------------------------------- */

function Slides() {
  return (
    <section className={home.section}>
      <Head />
      <Carousel label="Needs you" slideSize="100cqw" slideLabel={(index, count) => `${index + 1} of ${count}`}>
        {ITEMS.map(item => (
          <div key={item.key} data-sq="surface" className={`${home.rows} ${styles.slide}`}>
            <Row item={item} as="div" />
          </div>
        ))}
      </Carousel>
    </section>
  );
}

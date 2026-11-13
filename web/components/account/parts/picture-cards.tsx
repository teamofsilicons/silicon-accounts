"use client";

/**
 * Picture cards (Anil, 2026-11-11, picked in /__banner): Home's introduction (home-cards.tsx). No background or box of
 * its own: an h3 title with a quiet dismiss, then three cards of one design in the page's column: a picture on top
 * (16:9, a Super Visuals picture from public/banner, nothing on it), the item's title and one line under it.
 *
 * A card can go somewhere (`href`: the whole card is the link, and rises a little on hover like Home's Silicon cards)
 * or do something small in place (`onSelect`: a flourish such as the You card lighting Home's ring; not a control, so
 * nothing else depends on it). Anil, 2026-11-13.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import styles from "./picture-cards.module.css";

export interface PictureCard {
  id: string;
  /** The picture: a /banner/*.webp and where its focus is (CSS background-position). */
  picture: { src: string; focus?: string };
  title: string;
  line: ReactNode;
  /** Where the card goes: the whole card is the link. */
  href?: string;
  /** A flourish on click, in place of a link. */
  onSelect?: () => void;
}

/**
 * `ratio`: the picture's shape, width / height (16 / 9, Anil 2026-11-11). `layout`: "grid" shares the width between
 * the cards; "scroll" gives each a fixed, wider width in a row that scrolls sideways, the next card peeking in.
 */
export function PictureCards({ title, cards, ratio = "16 / 9", layout = "grid", onDismiss, className }: { title: string; cards: PictureCard[]; ratio?: string; layout?: "grid" | "scroll"; onDismiss?: () => void; className?: string }) {
  return (
    <section className={className ? `${styles.banner} ${className}` : styles.banner} aria-label={title}>
      <div className={styles.head}>
        <h3 className={styles.title}>{title}</h3>
        <Button variant="ghost" size="xs" aria-label="Dismiss" onClick={onDismiss}><X size={14} strokeWidth={2} aria-hidden="true" /></Button>
      </div>
      <ul className={styles.cards} data-layout={layout}>
        {cards.map(card => (
          <li key={card.id} data-sq="clip" className={styles.card} data-active={card.href || card.onSelect ? "" : undefined} onClick={card.href ? undefined : card.onSelect}>
            {card.href ? <Link href={card.href} className={styles.link}><Face card={card} ratio={ratio} /></Link> : <Face card={card} ratio={ratio} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A card's picture and words, inside its link or on its own. */
function Face({ card, ratio }: { card: PictureCard; ratio: string }) {
  return (
    <>
      <span className={styles.picture} style={{ backgroundImage: `url("${card.picture.src}")`, backgroundPosition: card.picture.focus ?? "center", aspectRatio: ratio }} aria-hidden="true" />
      <span className={styles.words}>
        <span className={styles.cardTitle}>{card.title}</span>
        <span className={styles.cardLine}>{card.line}</span>
      </span>
    </>
  );
}

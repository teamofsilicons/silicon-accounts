"use client";

/**
 * Picture cards (Anil, 2026-11-11, picked in /__banner): Home's introduction (home-cards.tsx). No background or box of
 * its own: an h3 title with a quiet dismiss, then three cards of one design in the page's column: a picture on top
 * (16:9, a Super Visuals picture from public/banner, nothing on it), the item's title and one line under it.
 */
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import styles from "./picture-cards.module.css";

export interface PictureCard {
  id: string;
  /** The picture: a /banner/*.webp and where its focus is (CSS background-position). */
  picture: { src: string; focus?: string };
  title: string;
  line: ReactNode;
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
          <li key={card.id} data-sq="clip" className={styles.card}>
            <span className={styles.picture} style={{ backgroundImage: `url("${card.picture.src}")`, backgroundPosition: card.picture.focus ?? "center", aspectRatio: ratio }} aria-hidden="true" />
            <span className={styles.words}>
              <span className={styles.cardTitle}>{card.title}</span>
              <span className={styles.cardLine}>{card.line}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

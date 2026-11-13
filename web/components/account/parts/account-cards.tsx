/**
 * Home's "Your account" cards (Anil, 2026-11-12: "like the introduction banner", each card clickable): Connected apps,
 * Security and Personal info, each a link to its page with one live fact. Four designs, compared in /__account:
 *
 *   picture  The introduction's anatomy: a 16:9 Super Visuals picture on top, the page's icon and name, the fact.
 *   cover    The picture fills the card; the icon, name and fact sit on a white panel at its foot.
 *   band     A short band of the picture, the page's icon in a white tile straddling its lower edge, then the words.
 *   gradient The earlier introduction's gradient cards: a gradient of the page's colours, a large icon at the right.
 *
 * The pictures are the three of public/banner the introduction doesn't use: the birds over water (Connected apps), the
 * soft green (Security) and the starry figure (Personal info).
 */
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import styles from "./account-cards.module.css";

export type AccountCardsDesign = "picture" | "cover" | "band" | "gradient";

export interface AccountCard {
  key: "apps" | "security" | "personal";
  href: string;
  title: string;
  icon: LucideIcon;
  /** The live fact; undefined while it loads (the line keeps its height). */
  fact?: string;
}

/** Each page's picture (public/banner) and where its focus is. */
export const ACCOUNT_PICTURES: Record<AccountCard["key"], { src: string; focus: string }> = {
  apps: { src: "/banner/bg-139.webp", focus: "center 40%" },
  security: { src: "/banner/bg-126.webp", focus: "right bottom" },
  personal: { src: "/banner/bg-024.webp", focus: "center 30%" },
};

export function AccountCards({ cards, design = "picture" }: { cards: AccountCard[]; design?: AccountCardsDesign }) {
  return (
    <ul className={styles.cards} data-design={design}>
      {cards.map(({ key, href, title, icon: Icon, fact }) => {
        const picture = ACCOUNT_PICTURES[key];
        return (
          <li key={key}>
            <Link href={href} data-sq="clip" className={styles.card} data-page={key}>
              {design === "gradient" ? (
                <Icon className={styles.bigIcon} strokeWidth={1.25} aria-hidden="true" />
              ) : (
                <span className={styles.picture} style={{ backgroundImage: `url("${picture.src}")`, backgroundPosition: picture.focus }} aria-hidden="true" />
              )}
              <span className={styles.body} data-sq={design === "cover" ? "surface" : undefined}>
                {design === "gradient" ? null : <span data-sq="surface" className={styles.icon} aria-hidden="true"><Icon size={16} strokeWidth={1.75} /></span>}
                <span className={styles.words}>
                  <span className={styles.title}>{title}</span>
                  <span className={styles.fact}>{fact ?? " "}</span>
                </span>
                {design === "band" ? <ChevronRight className={styles.chevron} size={16} strokeWidth={2} aria-hidden="true" /> : null}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

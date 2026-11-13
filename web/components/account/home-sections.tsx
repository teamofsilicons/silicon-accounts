"use client";

/**
 * Home's sections under the introduction (Anil, 2026-10-31, direction B: Silicons first):
 *
 * - Your Silicons, the core of the account. With some, the first three as Silicon cards (parts/silicon-card.tsx: the
 *   Silicon's moving pixel avatar over its name and si:id), with "See all" in the heading. No New Silicon card (Anil,
 *   2026-11-13): creating one is on the Silicons page. With none, no section (the introduction presents Silicons).
 *
 * No apps section and no account cards for now (Anil, 2026-11-12): Your apps left Home (Connected apps lists them); the
 * account cards that replaced it are parked in /__account (parts/account-cards.tsx) until Home wants them.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { paths } from "@/lib/navigation";
import { useEverySilicon } from "./parts/queries";
import { SiliconCard, type SiliconCardBlend } from "./parts/silicon-card";
import { siliconHref } from "./silicons/silicons";
import styles from "./home-sections.module.css";

/** Three cards fill Home's row (New Silicon left Home, Anil 2026-11-13; it is on the Silicons page). */
const SILICON_TILES = 3;
/** How a Silicon card blends its avatar with its words (/__silicon-cards; A Wash until Anil picks, 2026-11-12). */
const SILICON_CARD_BLEND: SiliconCardBlend = "wash";

function Section({ id, title, href, children }: { id: string; title: string; href?: string; children: ReactNode }) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.head}>
        <h2 id={id} className={styles.title}>{title}</h2>
        {/* A quiet link (a soft button was too loud): label weight with a chevron (Anil, 2026-11-10). */}
        {href ? <Link href={href} className={styles.seeAll}>See All<ChevronRight size={14} strokeWidth={2} aria-hidden="true" /></Link> : null}
      </div>
      {children}
    </section>
  );
}

export function HomeSilicons() {
  const silicons = useEverySilicon();
  if (!silicons.data) return null;
  const list = silicons.data.items;

  // No Silicons yet: no section for now (Anil, 2026-11-11); the introduction above presents Silicons. The first-Silicon
  // banner it showed (parts/first-silicon.tsx) is kept for when Home wants it back.
  if (!list.length) return null;

  return (
    <Section id="home-silicons" title="Your Silicons" href={paths.silicons}>
      <ul className={styles.tiles}>
        {list.slice(0, SILICON_TILES).map(silicon => (
          <li key={silicon.uuid}>
            <SiliconCard uuid={silicon.uuid} photo={silicon.pfp_url} name={silicon.display_name || silicon.id || "A Silicon"} id={silicon.id} href={siliconHref(silicon)} blend={SILICON_CARD_BLEND} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

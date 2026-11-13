"use client";

/**
 * /__silicon-motion: the Silicon card (components/account/parts/silicon-card.tsx) with each motion style
 * (silicon-avatar.tsx, SiliconMotion), three sample Silicons a row as on Home, so the styles can be compared side by
 * side. None moves up or down (Anil, 2026-11-13). Reduced motion keeps every one still.
 */
import { useState } from "react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { SiliconCard } from "@/components/account/parts/silicon-card";
import type { SiliconMotion } from "@/components/account/parts/silicon-avatar";
import styles from "./silicon-motion-lab.module.css";

const STYLES: { motion: SiliconMotion | "hover"; name: string; note: string }[] = [
  { motion: "alive", name: "1  Alive (today)", note: "The mosaic shimmers, it glances to one side now and then, blinks, and its halo twinkles." },
  { motion: "wave", name: "2  Colour wave", note: "Its palette flows slowly through the body along the avatar's own slant, and back; it blinks." },
  { motion: "sparkle", name: "3  Sparkle", note: "A few pixels glint white for a moment, a different few each time; it blinks." },
  { motion: "watch", name: "4  Watcher", note: "Its eyes follow your pointer across the page, left or right of it; it blinks. Move the mouse around." },
  { motion: "glow", name: "5  Glow", note: "Its halo swells to a ring of light pixels and settles again, slowly; it blinks now and then." },
  { motion: "hover", name: "6  On hover", note: "Still until you point at the card (or tab to it), then alive. The calmest page." },
];

const NAMES = ["zap", "Atlas", "Juniper"];

export function SiliconMotionLab() {
  const [round, setRound] = useState(0);
  const silicons = NAMES.map((name, index) => ({ uuid: `motion-${round}-${index}`, name, id: `si:${name.toLowerCase()}` }));
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Silicon motion</h1>
        <p className={styles.lede}>The same Silicons on Home&rsquo;s cards, in each way of moving. Nothing moves up or down. With reduced motion on, every one is still.</p>
        <Button variant="secondary" size="sm" onClick={() => setRound(value => value + 1)}>New Silicons</Button>
      </header>
      {STYLES.map(({ motion, name, note }) => (
        <section key={motion} className={styles.style} aria-label={name}>
          <div>
            <h2 className={styles.name}>{name}</h2>
            <p className={styles.note}>{note}</p>
          </div>
          <div className={styles.stage}>
            <ul className={styles.grid}>
              {silicons.map(silicon => <li key={silicon.uuid}><SiliconCard uuid={silicon.uuid} name={silicon.name} id={silicon.id} href="/silicons" motion={motion} /></li>)}
            </ul>
          </div>
        </section>
      ))}
    </main>
  );
}

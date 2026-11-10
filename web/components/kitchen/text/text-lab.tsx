"use client";

/**
 * /__text: the text greys (Anil, 2026-11-10). Ours jump from the text (#0D0D0D, lightness 4) to the secondary text
 * (#5D5D5D, 40); Refactoring UI's palette steps down 15, 24, 34 before its muted grey at 59. Anil wants a step between
 * the two. Each ladder sets four greys, darkest first:
 *
 *   text       names, titles, headings
 *   step       the new one: lines under a name (an app's description, an address)
 *   secondary  facts and quiet links ("Signed in 2 weeks ago", "Member since", "See all")
 *   muted      ids (c:anil, si:zap)
 *
 * The same Home column is drawn with "Now" beside the chosen ladder. Lightness is CIELAB L* (0 black, 100 white).
 */
import type { CSSProperties } from "react";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { AppMark } from "@/components/account/parts/app-mark";
import { withAppIcon } from "@/components/account/parts/app-icons";
import { SiliconMark } from "@/components/account/parts/silicon-mark";
import { LADDERS, NOW, type Ladder } from "@/lib/text-ladders";
import styles from "./text-lab.module.css";

const ROLES = ["Text", "Step", "Secondary", "Muted"];

function ladderStyle(ladder: Ladder): CSSProperties {
  const [text, step, secondary, muted] = ladder.greys;
  return { "--lab-text": text, "--lab-step": step, "--lab-secondary": secondary, "--lab-muted": muted } as CSSProperties;
}

export function TextLab() {
  const [chosen, setChosen] = useState(LADDERS[0]!.id);
  const ladder = LADDERS.find(item => item.id === chosen) ?? LADDERS[0]!;
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Text greys</h1>
        <p className={styles.lede}>A step between the text and the secondary text. The same Home column in the greys before (OpenAI&rsquo;s) and in the ladder you pick. Sample words; nothing here acts.</p>
        <SegmentedControl size="sm" label="Ladder" options={LADDERS.map(item => ({ value: item.id, label: item.name.split(" · ")[0]! }))} value={chosen} onValueChange={setChosen} />
      </header>
      <div className={styles.pair}>
        <Column ladder={NOW} />
        <Column ladder={ladder} />
      </div>
      <section className={styles.all} aria-labelledby="all-ladders">
        <h2 id="all-ladders" className={styles.allTitle}>Every ladder</h2>
        {[NOW, ...LADDERS].map(item => <Strip key={item.id} ladder={item} />)}
      </section>
    </main>
  );
}

function Strip({ ladder }: { ladder: Ladder }) {
  return (
    <div className={styles.strip}>
      <div className={styles.stripHead}>
        <span className={styles.stripName}>{ladder.name}</span>
        <span className={styles.stripNote}>{ladder.note}</span>
      </div>
      <ul className={styles.swatches}>
        {ladder.greys.map((grey, index) => (
          <li key={ROLES[index]} className={styles.swatchItem}>
            <span className={styles.swatch} style={{ background: grey }} />
            <span className={styles.swatchWords}>{ROLES[index]} · {grey} · L {ladder.lightness[index]}{index ? ` (+${ladder.lightness[index]! - ladder.lightness[index - 1]!})` : ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const APPS = [
  { id: "write", name: "Silicon Write", line: "write.teamofsilicons.com", fact: "Signed in 2 weeks ago", joined: true },
  { id: "dm", name: "Silicon DM", line: "Message people and Silicons directly.", fact: "Signed in 3 weeks ago", joined: true },
  { id: "briefcase", name: "Silicon Briefcase", line: "Keep and share files with your Silicons.", fact: "Not signed in yet", joined: false },
  { id: "ting", name: "Silicon Ting", line: "Get notified when your Silicons need you.", fact: "Not signed in yet", joined: false },
];

function Column({ ladder }: { ladder: Ladder }) {
  return (
    <div className={styles.column} style={ladderStyle(ladder)}>
      <p className={styles.columnName}>{ladder.name}</p>
      <div className={styles.page}>
        <div className={styles.welcome}>
          <span data-sq="surface" className={styles.photo} aria-hidden="true" />
          <div className={styles.welcomeWords}>
            <h2 className={styles.h1}>Welcome, Anil</h2>
            <span className={styles.id}>c:anil</span>
            <span className={styles.fact}>Member since Oct 2026</span>
          </div>
        </div>

        <section className={styles.section}>
          <div className={styles.head}><h3 className={styles.h2}>Your Silicons</h3><span className={styles.fact}>See all</span></div>
          <ul className={styles.grid}>
            {[{ seed: "lab-zap", name: "zap", id: "si:zap" }, { seed: "lab-anil", name: "anil", id: "si:anil" }].map(item => (
              <li key={item.seed} data-sq="surface" className={styles.tile}>
                <SiliconMark seed={item.seed} size={28} />
                <span className={styles.words}><span className={styles.name}>{item.name}</span><span className={styles.id}>{item.id}</span></span>
              </li>
            ))}
            <li data-sq="surface" className={`${styles.tile} ${styles.newTile}`}>
              <span data-sq="surface" className={styles.plus} aria-hidden="true"><Plus size={16} strokeWidth={1.75} /></span>
              <span className={styles.name}>New Silicon</span>
            </li>
          </ul>
        </section>

        <section className={styles.section}>
          <div className={styles.head}><h3 className={styles.h2}>Your apps</h3><span className={styles.fact}>See all</span></div>
          <ul className={styles.grid}>
            {APPS.map(app => (
              <li key={app.id} data-sq="surface" className={styles.card}>
                <div className={styles.cardTop}>
                  <AppMark app={withAppIcon({ app_id: app.id, name: app.name, logo_url: null })} size={32} className={styles.mark} decorative />
                  <span className={styles.words}><span className={styles.name}>{app.name}</span><span className={styles.line}>{app.line}</span></span>
                </div>
                <div className={styles.cardFooter}>
                  <span className={styles.fact}>{app.fact}</span>
                  <Button variant={app.joined ? "secondary" : "soft"} size="xs">{app.joined ? "Open" : "Try"}</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

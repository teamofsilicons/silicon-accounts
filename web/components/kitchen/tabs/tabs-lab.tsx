"use client";

/**
 * /__tabs: Silicon UI's Tabs as the Silicon page uses them (Access, Settings), before and with a thinner frame: the
 * strip's padding around the tabs drops from 4px to 2px (Anil, 2026-11-13: "i mean reducing padding of outer"). With
 * the thinner frame the keyboard ring is drawn inside the tab (Silicon UI's --focus-outline-offset, as its own scroll
 * buttons do), and the tab's and selection's corners shrink with the frame so they stay concentric. Anil chose A; it is
 * in Silicon UI's Tabs through the local patch, so "Before" redraws the released 4px here. Each is in
 * the page's context (the Silicon's header above, the first section below). The versions are this lab's own CSS over
 * the component, to choose the values; the chosen one is then made in Silicon UI (as #30 and #31 were), never as a
 * restyle in the product.
 */
import { Tabs, TabsList, TabsTrigger } from "@teamofsilicons/silicon-ui/tabs";
import styles from "./tabs-lab.module.css";

const VERSIONS = [
  { key: "before", name: "Before", note: "Silicon UI 0.4.0 as released: 4px around and between the tabs; each tab at least 88px wide and 32px high, 12px each side of the label. Strip 42px high." },
  { key: "thin", name: "A  Thin frame (chosen, now in Silicon UI's Tabs)", note: "2px around the tabs, everything else as before. The strip is 38px high; the selection sits 2px from the strip's edge, its corners 2px rounder to stay concentric." },
  { key: "thin-fit", name: "B  Thin, fit the label", note: "2px around, 4px between; each tab its label and 12px each side, 32px high. The strip only as wide as its words." },
  { key: "thin-short", name: "C  Thin and short", note: "2px around, 4px between, fit the label and 28px high: a 34px strip, close to a small button's height." },
] as const;

export function TabsLab() {
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Tabs</h1>
        <p className={styles.lede}>Silicon UI&rsquo;s Tabs on a Silicon&rsquo;s page, before and with a thinner frame around the tabs. Click a tab, then press the arrow keys to see the keyboard ring inside the tab. Click the tabs to see the selection glide.</p>
      </header>
      {VERSIONS.map(version => (
        <section key={version.key} className={styles.version} aria-label={version.name}>
          <div>
            <h2 className={styles.name}>{version.name}</h2>
            <p className={styles.note}>{version.note}</p>
          </div>
          <div className={styles.stage} data-version={version.key}>
            <p className={styles.header}><span className={styles.mono}>si:zap</span> · In your care since Nov 7, 2026</p>
            <Tabs defaultValue="access">
              <TabsList aria-label={`${version.name}: zap's settings`}>
                <TabsTrigger value="access">Access</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
            </Tabs>
            <h3 className={styles.section}>Secret key</h3>
          </div>
        </section>
      ))}
    </main>
  );
}

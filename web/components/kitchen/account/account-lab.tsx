"use client";

/**
 * /__account: Home's "Your account" cards in each design (components/account/parts/account-cards.tsx), at Home's
 * column, with Home's section heading above, plus the plain tiles Home shows today for comparison. The facts are
 * samples; the switch puts every design in one state (facts shown, or still loading). Links go to the real pages.
 */
import { useState } from "react";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { AccountCards, type AccountCard, type AccountCardsDesign } from "@/components/account/parts/account-cards";
import { SECTIONS } from "@/lib/navigation";
import styles from "./account-lab.module.css";

const DESIGNS: { design: AccountCardsDesign; name: string; note: string }[] = [
  { design: "picture", name: "A  Picture", note: "The introduction's card: a 16:9 picture on top, then the page's icon, name and fact. On a phone the picture sits beside the words." },
  { design: "band", name: "B  Band", note: "A short band of the picture; the page's icon in a white tile straddles its edge; a chevron that nudges on hover. Shorter than A." },
  { design: "cover", name: "C  Cover", note: "The picture fills the card; the words sit on a frosted white panel at its foot. The most pictorial." },
  { design: "gradient", name: "D  Gradient", note: "The earlier introduction's gradient cards: each page's own colours, light words, a large icon that tilts on hover. No photos." },
];

const FACTS = { apps: "Signed in to 3 apps", security: "Signed in on 5 devices", personal: "1 email · 1 phone" } as const;

export function AccountLab() {
  const [state, setState] = useState<"facts" | "loading">("facts");
  const cards: AccountCard[] = (["apps", "security", "personal"] as const).map(key => {
    const section = SECTIONS.find(entry => entry.key === key)!;
    return { key, href: section.href, title: section.label, icon: section.icon, fact: state === "facts" ? FACTS[key] : undefined };
  });
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Your account</h1>
        <p className={styles.lede}>Designs for Home&rsquo;s cards to Connected apps, Security and Personal info. Sample facts; each card links to its page.</p>
        <SegmentedControl size="sm" label="State" options={[{ value: "facts", label: "Facts" }, { value: "loading", label: "Loading" }]} value={state} onValueChange={value => setState(value as typeof state)} />
      </header>
      {DESIGNS.map(({ design, name, note }) => (
        <section key={design} className={styles.design} aria-label={name}>
          <div>
            <h2 className={styles.name}>{name}</h2>
            <p className={styles.note}>{note}</p>
          </div>
          <div className={styles.stage}>
            <div className={styles.column}>
              <h3 className={styles.sectionTitle}>Your account</h3>
              <AccountCards cards={cards} design={design} />
            </div>
          </div>
        </section>
      ))}
    </main>
  );
}

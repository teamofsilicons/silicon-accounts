"use client";

/**
 * /__delete-entry: Data & privacy's Delete account row, drawn five ways under the page's real What apps see (Anil,
 * 2026-11-12: "better design for this; we don't need to mention handing over Silicons here, this is about deleting the
 * account"). Each one goes to the real /privacy/delete, where the Silicons are dealt with.
 *
 *   Now        the live row: red outline, trash tile, a line, a chevron
 *   A · Quiet  the page's own list look; only the title and the bin are red
 *   B · Words  no box: a heading, one sentence, and a Delete Account button under it
 *   C · Foot   at the very end of the page, under a line: one red link and a grey sentence
 *   D · Button a white row like the others, with Delete… at its end instead of a chevron
 */
import type { ReactNode } from "react";
import { ArrowRight, Trash2 } from "lucide-react";
import { ButtonLink } from "@/components/foundation/button-link";
import { AppMark } from "@/components/account/parts/app-mark";
import { withAppIcon } from "@/components/account/parts/app-icons";
import { appHref } from "@/components/account/apps/apps";
import { useEveryApp } from "@/components/account/parts/queries";
import { LinkItem, Section, Tile } from "@/components/account/parts/rows";
import { paths } from "@/lib/navigation";
import Link from "next/link";
import styles from "./delete-entry-lab.module.css";

const LINE = "Your account, its sign-ins and its apps’ access, for good";

export function DeleteEntryLab() {
  const apps = useEveryApp();
  const items = (apps.data?.items ?? []).filter(item => item.status !== "access_removed");
  const whatAppsSee = (key: string) => (
    <Section id={`apps-${key}`} title="What apps see" description="Change what each app can see from its page.">
      {items.map(item => (
        <LinkItem key={item.membership_id} href={appHref(item.app.app_id)} lead={<AppMark app={withAppIcon(item.app)} size={28} className={styles.mark} decorative />} title={item.app.name} detail="Name, photo, CarbonID and more" />
      ))}
    </Section>
  );
  const ways: Array<{ key: string; name: string; note: string; node: ReactNode }> = [
    {
      key: "now", name: "Now", note: "The live row.",
      node: (
        <Section id="now-delete" label="Delete account" tone="danger">
          <LinkItem href={paths.privacyDelete} lead={<Tile><Trash2 size={16} strokeWidth={2} /></Tile>} title="Delete account" detail={LINE} />
        </Section>
      ),
    },
    {
      key: "a", name: "A · Quiet", note: "The page's own list look. Only the bin and the title are red, so it doesn't shout above the apps.",
      node: (
        <Section id="a-delete" label="Delete account">
          <LinkItem href={paths.privacyDelete} lead={<span className={styles.redTile}><Trash2 size={16} strokeWidth={2} /></span>} title={<span className={styles.red}>Delete account</span>} detail="Remove your account and everything in it" />
        </Section>
      ),
    },
    {
      key: "b", name: "B · Words", note: "No box: a heading like What apps see, one sentence, and the button. Reads as a decision, not a list item.",
      node: (
        <section className={styles.words} aria-labelledby="b-title">
          <h2 id="b-title" className={styles.h2}>Delete account</h2>
          <p className={styles.sentence}>Your account ends, every app you use is told, and you&rsquo;re signed out everywhere. You&rsquo;ll see what&rsquo;s left to do first.</p>
          <div><ButtonLink href={paths.privacyDelete} variant="secondary" size="sm" className={styles.redButton}>Delete Account</ButtonLink></div>
        </section>
      ),
    },
    {
      key: "c", name: "C · Foot", note: "At the very end, under a line, like a footer. Easy to find when you look for it, out of the way when you don't.",
      node: (
        <div className={styles.foot}>
          <Link href={paths.privacyDelete} className={styles.footLink}>Delete your account<ArrowRight size={14} strokeWidth={2} aria-hidden="true" /></Link>
          <span className={styles.footLine}>You&rsquo;ll see what goes with it before anything is deleted.</span>
        </div>
      ),
    },
    {
      key: "d", name: "D · Button", note: "A white row like the others, with a Delete… button at its end instead of a chevron, so it reads as an action.",
      node: (
        <Section id="d-delete" label="Delete account">
          <li className={styles.buttonRow}>
            <Tile><Trash2 size={16} strokeWidth={2} /></Tile>
            <span className={styles.text}>
              <span className={styles.title}>Delete account</span>
              <span className={styles.detail}>{LINE}</span>
            </span>
            <ButtonLink href={paths.privacyDelete} variant="secondary" size="sm" className={styles.redButton}>Delete&hellip;</ButtonLink>
          </li>
        </Section>
      ),
    },
  ];

  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.titleH1}>Delete account row</h1>
        <p className={styles.lede}>Data &amp; privacy&rsquo;s way to delete, five ways, each under the page&rsquo;s real What apps see. Each one opens the real Delete your account page; nothing here deletes.</p>
      </header>
      {ways.map(way => (
        <article key={way.key} className={styles.way} aria-label={way.name}>
          <div className={styles.wayHead}>
            <h2 className={styles.wayName}>{way.name}</h2>
            <p className={styles.wayNote}>{way.note}</p>
          </div>
          <div data-sq="surface" className={styles.frame}>
            <p className={styles.frameTitle}>Data &amp; privacy</p>
            {whatAppsSee(way.key)}
            {way.node}
          </div>
        </article>
      ))}
    </main>
  );
}

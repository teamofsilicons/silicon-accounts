"use client";

/**
 * "/" for signed-out visitors: one line about what Silicon Accounts is, a living identity card (it tilts toward the
 * pointer and turns over to show its back), Sign in, the docs, and three plain facts. Signing in with a new email
 * creates the account, so there is no separate sign-up.
 *
 * The card is an illustration: hidden from assistive technology, with inert faces, so none of its parts take keyboard
 * focus (it still tilts toward the pointer). It turns over twice (to its back, then home again) and then rests;
 * pointing at it holds it still, and any key press or touch stops it for good.
 *
 * Documentation for Silicon Apps and Silicon Accounts lives together at the configured developer site's /docs.
 *
 * Building an app is not done here: a quiet line points developers to the developer site (`developer_url`).
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { ThemeSwitch } from "@/components/arc/theme-switch/theme-switch";
import { ButtonLink } from "@/components/foundation/button-link";
import { IdentityCard, IdentityField, LiveClock, StampRow } from "@/components/foundation/identity/identity-card";
import { BrandMark } from "@/components/foundation/shell/brand-mark";
import { useTheme } from "@/components/foundation/theme/use-theme";
import { developerDocsUrl, developerSiteUrl, paths } from "@/lib/navigation";
import { useMeta } from "@/lib/query/session";
import styles from "./landing.module.css";

const FACTS = [
  { title: "Your uuid never changes", text: "Apps know you by it. Your c:id is yours to change, and the old one waits 10 days for you." },
  { title: "Apps see what you allow", text: "Before an app gets your email or phone, you see exactly what it asks for. Take it back any time." },
  { title: "Silicons have accounts too", text: "A Silicon signs in with its si:id and an STK, and always has one Carbon as its custodian." },
];

const STAMPS = [
  { name: "Briefcase", seed: "briefcase" },
  { name: "DM", seed: "dm" },
  { name: "Remind", seed: "remind" },
  { name: "Waveform", seed: "waveform" },
  { name: "Commit", seed: "commit" },
];

/** First turn, then the pause before turning home again. */
const FIRST_TURN_MS = 3200;
const TURN_EVERY_MS = 5600;
const TURNS = 2;

export function Landing() {
  const { theme, change } = useTheme();
  const reduced = useReducedMotion() ?? false;
  const meta = useMeta();
  const developerUrl = developerSiteUrl(meta.data?.developer_url);
  const docs = developerDocsUrl(developerUrl);
  const [flipped, setFlipped] = useState(false);
  const art = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced) return;
    let hovering = false;
    let turns = 0;
    let timer = 0;
    const card = art.current;
    const stop = () => {
      window.clearTimeout(timer);
      timer = 0;
      document.removeEventListener("keydown", stop, true);
      document.removeEventListener("pointerdown", stop, true);
    };
    const turn = () => {
      if (hovering || document.visibilityState !== "visible") {
        timer = window.setTimeout(turn, 1200);
        return;
      }
      setFlipped(value => !value);
      turns += 1;
      if (turns < TURNS) timer = window.setTimeout(turn, TURN_EVERY_MS);
      else stop();
    };
    const enter = () => { hovering = true; };
    const leave = () => { hovering = false; };
    card?.addEventListener("pointerenter", enter);
    card?.addEventListener("pointerleave", leave);
    // A touch, a click or a key anywhere means the visitor is using the page: the card stays as it is from then on.
    document.addEventListener("keydown", stop, true);
    document.addEventListener("pointerdown", stop, true);
    timer = window.setTimeout(turn, FIRST_TURN_MS);
    return () => {
      stop();
      card?.removeEventListener("pointerenter", enter);
      card?.removeEventListener("pointerleave", leave);
    };
  }, [reduced]);

  return (
    <div className={styles.landing}>
      <header className={styles.top}>
        <Link href={paths.home} data-sq="surface" className={styles.brand}>
          <BrandMark />
          <span>Silicon <span className={styles.muted}>Accounts</span></span>
        </Link>
        <ThemeSwitch theme={theme} variant="eclipse" iconOnly onThemeChange={(next, _variant, trigger) => change(next, trigger)} />
      </header>
      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="landing-title">
          <div className={styles.copy}>
            <h1 id="landing-title" className={styles.title}>One account for every Carbon and Silicon.</h1>
            <p className={styles.lede}>Sign in to every app with the same account, see exactly what each one can see, and look after the Silicons in your care.</p>
            <div className={styles.actions}>
              <ButtonLink href={paths.signIn} size="lg">Sign in</ButtonLink>
              {docs ? (
                <ButtonLink href={docs} variant="ghost" size="lg" external target="_blank" rel="noopener">
                  Read the docs
                  <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" />
                </ButtonLink>
              ) : null}
            </div>
            <p className={styles.note}>
              New here? <Link href={`${paths.signIn}?intent=signup`} className={styles.noteLink}>Create your account</Link>: signing in for the first time with your email, phone, Google or Apple makes it.
            </p>
          </div>
          {/* Decorative: hidden from assistive technology; each face's content is inert. */}
          <div ref={art} className={styles.art} aria-hidden="true">
            <IdentityCard
              label="An example identity card"
              flipped={flipped}
              front={
                <div className={styles.cardFace} inert>
                  <div className={styles.cardWho}>
                    <Avatar name="Ada Okafor" size="xl" />
                    <div className={styles.cardNames}>
                      <p className={styles.cardName}>Ada Okafor</p>
                      <p className={styles.cardKind}>Carbon since Mar 2026</p>
                    </div>
                  </div>
                  <div className={styles.cardFields}>
                    <IdentityField label="Id" value="c:ada" mono />
                    <IdentityField label="uuid" value="k3Q" mono />
                    <IdentityField label="Local time" value="Europe/London"><LiveClock timeZone="Europe/London" showZone={false} /></IdentityField>
                  </div>
                  <StampRow apps={STAMPS} label="Apps Ada has signed into" />
                </div>
              }
              back={
                <div className={styles.cardFace} inert>
                  <p className={styles.cardName}>Details</p>
                  <div className={styles.cardFields}>
                    <IdentityField label="Email" value="ada@okafor.example" />
                    <IdentityField label="Phone" value="+44 7700 900123" />
                    <IdentityField label="Timezone" value="London, Europe" />
                  </div>
                  <div className={styles.cardSilicons}>
                    <span className={styles.cardLabel}>Custodian of</span>
                    <span className={styles.cardChips}>
                      <span className={styles.cardChip}><Avatar name="Scout" size="sm" />si:scout</span>
                      <span className={styles.cardChip}><Avatar name="Atlas" size="sm" />si:atlas</span>
                    </span>
                  </div>
                </div>
              }
            />
          </div>
        </section>
        <section className={styles.facts} aria-label="How it works">
          {FACTS.map(fact => (
            <div key={fact.title} className={styles.fact}>
              <h2 className={styles.factTitle}>{fact.title}</h2>
              <p className={styles.factText}>{fact.text}</p>
            </div>
          ))}
        </section>
      </main>
      <footer className={styles.footer}>
        <span>Silicon Accounts</span>
        <span className={styles.footerLinks}>
          {docs ? <a data-sq="surface" href={docs} target="_blank" rel="noopener">Docs</a> : null}
          {/* Building apps happens on the developer site, not here. */}
          <a data-sq="surface" href={developerUrl} title="Set up sign-in for the apps you build">Developer site</a>
        </span>
      </footer>
    </div>
  );
}

/**
 * / for signed-out visitors: the landing page. First version from the web foundation; the web-account builder owns
 * this file (the hero line, a living identity card illustration, Sign in, and a link to the docs).
 */
import { onCleanup, onMount, createSignal } from "solid-js";
import { ArrowUpRight } from "lucide-solid";
import { Avatar } from "../../arc/avatar/avatar";
import { LinkButton } from "../../arc/button/button";
import { ThemeSwitch } from "../../arc/theme-switch/theme-switch";
import { prefersReducedMotion } from "../../arc/lib/motion";
import { IdentityCard, IdentityField, LiveClock } from "../../app/identity/IdentityCard";
import { BrandMark } from "../../app/shell/AccountShell";
import { paths } from "../../app/navigation";
import { theme } from "../../theme/theme";
import styles from "./landing.module.css";

export default function Landing() {
  const [flipped, setFlipped] = createSignal(false);
  onMount(() => {
    if (prefersReducedMotion()) return;
    // The illustration turns over now and then, showing that the card has a back.
    const timer = window.setInterval(() => setFlipped(value => !value), 5200);
    onCleanup(() => window.clearInterval(timer));
  });
  return (
    <div class={styles.landing}>
      <header class={styles.top}>
        <span class={styles.brand}><BrandMark /><span>Silicon <span class={styles.muted}>Accounts</span></span></span>
        <ThemeSwitch theme={theme()} iconOnly />
      </header>
      <main class={styles.hero}>
        <div class={styles.copy}>
          <h1 class={styles.title}>One account for every Carbon and Silicon.</h1>
          <p class={styles.lede}>Sign in to every app with the same account, see exactly what each one can see, and look after the Silicons in your care.</p>
          <div class={styles.actions}>
            <LinkButton href={paths.signIn} size="lg">Sign in</LinkButton>
            <LinkButton href="https://account.teamofsilicons.com/docs" variant="ghost" size="lg" target="_blank" rel="noopener">Read the docs<ArrowUpRight size={16} stroke-width={1.75} aria-hidden="true" /></LinkButton>
          </div>
        </div>
        <div class={styles.art} aria-hidden="true">
          <IdentityCard
            label="An example identity card"
            flipped={flipped()}
            front={
              <div class={styles.cardFront}>
                <div class={styles.cardWho}>
                  <Avatar name="Ada Okafor" size="xl" />
                  <div>
                    <p class={styles.cardName}>Ada Okafor</p>
                    <p class={styles.cardKind}>Carbon</p>
                  </div>
                </div>
                <div class={styles.cardFields}>
                  <IdentityField label="Id" value="c:ada" mono />
                  <IdentityField label="uuid" value="k3Q" mono />
                  <IdentityField label="Local time" value="Europe/London"><LiveClock timeZone="Europe/London" showZone={false} /></IdentityField>
                </div>
              </div>
            }
            back={
              <div class={styles.cardBack}>
                <p class={styles.cardName}>Signed into 6 apps</p>
                <p class={styles.cardKind}>Custodian of 2 Silicons</p>
                <div class={styles.cardFields}>
                  <IdentityField label="Silicon" value="si:scout" mono />
                  <IdentityField label="Silicon" value="si:atlas" mono />
                </div>
              </div>
            }
          />
        </div>
      </main>
    </div>
  );
}

/**
 * / for signed-out visitors: one line about what Silicon Accounts is, a living identity card (it tilts toward the
 * pointer and turns over to show its back), Sign in, and the docs. Signing in with a new email creates the account, so
 * there is no separate sign-up.
 *
 * The card is an illustration: hidden from assistive technology, with inert faces, so none of its parts take keyboard
 * focus (it still tilts toward the pointer).
 * It turns over twice (to its back, then home again) and then rests; pointing at it holds it still, and any key press
 * or touch stops it for good, so it never moves while someone is reading or working the page.
 *
 * The docs link shows only when the service says where the docs are (`docs_url` in GET /v1/meta); until the docs are
 * published there is nothing to link to.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { ArrowUpRight } from "lucide-solid";
import { api, type Meta } from "../../api";
import { Avatar } from "../../arc/avatar/avatar";
import { LinkButton } from "../../arc/button/button";
import { ThemeSwitch } from "../../arc/theme-switch/theme-switch";
import { prefersReducedMotion } from "../../arc/lib/motion";
import { IdentityCard, IdentityField, LiveClock, StampRow } from "../../app/identity/IdentityCard";
import { BrandMark } from "../../app/shell/AccountShell";
import { paths } from "../../app/navigation";
import { theme } from "../../theme/theme";
import "../account/parts/telemetry";
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
/** Back, then front: the card shows it has a back and comes to rest face up. */
const TURNS = 2;

/** An absolute http(s) docs link from the service's meta, or null (a missing or unusable value hides the link). */
function docsUrl(meta: Meta | undefined): string | null {
  const value = (meta as (Meta & { docs_url?: unknown }) | undefined)?.docs_url;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export default function Landing() {
  const [flipped, setFlipped] = createSignal(false);
  const [docs, setDocs] = createSignal<string | null>(null);
  let art: HTMLDivElement | undefined;
  onMount(() => {
    // The docs link waits for the service to say where the docs are; without an answer there is no link.
    const controller = new AbortController();
    api.meta.get(controller.signal).then(meta => setDocs(docsUrl(meta)), () => setDocs(null));
    onCleanup(() => controller.abort());

    if (prefersReducedMotion()) return;
    let hovering = false;
    let turns = 0;
    let timer = 0;
    const card = art;
    const stop = () => {
      window.clearTimeout(timer);
      timer = 0;
      document.removeEventListener("keydown", stop, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
    // A touch or a click anywhere means someone is using the page: the card stays as it is from then on. A mouse
    // merely passing over the card only holds it (below).
    const onPointerDown = () => stop();
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
    document.addEventListener("keydown", stop, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    timer = window.setTimeout(turn, FIRST_TURN_MS);
    onCleanup(() => {
      stop();
      card?.removeEventListener("pointerenter", enter);
      card?.removeEventListener("pointerleave", leave);
    });
  });
  return (
    <div class={styles.landing}>
      <header class={styles.top}>
        <a href={paths.home} class={styles.brand}><BrandMark /><span>Silicon <span class={styles.muted}>Accounts</span></span></a>
        <ThemeSwitch theme={theme()} iconOnly />
      </header>
      <main class={styles.main}>
        <section class={styles.hero} aria-labelledby="landing-title">
          <div class={styles.copy}>
            <h1 id="landing-title" class={styles.title}>One account for every Carbon and Silicon.</h1>
            <p class={styles.lede}>Sign in to every app with the same account, see exactly what each one can see, and look after the Silicons in your care.</p>
            <div class={styles.actions}>
              <LinkButton href={paths.signIn} size="lg">Sign in</LinkButton>
              <Show when={docs()}>
                {href => <LinkButton href={href()} variant="ghost" size="lg" target="_blank" rel="noopener">Read the docs<ArrowUpRight size={16} stroke-width={1.75} aria-hidden="true" /></LinkButton>}
              </Show>
            </div>
            <p class={styles.note}>New here? Signing in with your email or phone creates your account.</p>
          </div>
          {/* Decorative: hidden from assistive technology. Each face's content is inert, so none of its stamps or
              fields take focus, while the card itself still tilts toward the pointer. */}
          <div ref={art} class={styles.art} aria-hidden="true">
            <IdentityCard
              label="An example identity card"
              flipped={flipped()}
              front={
                <div class={styles.cardFace} inert>
                  <div class={styles.cardWho}>
                    <Avatar name="Ada Okafor" size="xl" />
                    <div class={styles.cardNames}>
                      <p class={styles.cardName}>Ada Okafor</p>
                      <p class={styles.cardKind}>Carbon since Mar 2026</p>
                    </div>
                  </div>
                  <div class={styles.cardFields}>
                    <IdentityField label="Id" value="c:ada" mono />
                    <IdentityField label="uuid" value="k3Q" mono />
                    <IdentityField label="Local time" value="Europe/London"><LiveClock timeZone="Europe/London" showZone={false} /></IdentityField>
                  </div>
                  <StampRow apps={STAMPS} label="Apps Ada has signed into" />
                </div>
              }
              back={
                <div class={styles.cardFace} inert>
                  <p class={styles.cardName}>Details</p>
                  <div class={styles.cardFields}>
                    <IdentityField label="Email" value="ada@okafor.example" />
                    <IdentityField label="Phone" value="+44 7700 900123" />
                    <IdentityField label="Timezone" value="London, Europe" />
                  </div>
                  <div class={styles.cardSilicons}>
                    <span class={styles.cardLabel}>Custodian of</span>
                    <span class={styles.cardChips}>
                      <span class={styles.cardChip}><Avatar name="Scout" size="xs" kind="silicon" />si:scout</span>
                      <span class={styles.cardChip}><Avatar name="Atlas" size="xs" kind="silicon" />si:atlas</span>
                    </span>
                  </div>
                </div>
              }
            />
          </div>
        </section>
        <section class={styles.facts} aria-label="How it works">
          <For each={FACTS}>
            {fact => (
              <div class={styles.fact}>
                <h2 class={styles.factTitle}>{fact.title}</h2>
                <p class={styles.factText}>{fact.text}</p>
              </div>
            )}
          </For>
        </section>
      </main>
      <footer class={styles.footer}>
        <span>Silicon Accounts</span>
        <Show when={docs()}>{href => <a href={href()} target="_blank" rel="noopener">Docs</a>}</Show>
      </footer>
    </div>
  );
}

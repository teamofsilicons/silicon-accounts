/**
 * /__kitchen — the style guide (development builds and screenshot runs only). Every ported Arc component, the
 * account shell's building blocks and the branding runtime, in the Silicon Accounts brand. Review it in both themes
 * (the switch, or `pnpm screens --only kitchen`); add `?squircle=fallback` to see the Safari/Firefox squircle path.
 */
import { For, onMount, type JSX } from "solid-js";
import { ThemeSwitch } from "../../arc/theme-switch/theme-switch";
import { LinkButton } from "../../arc/button/button";
import { useSquircle } from "../../arc/lib/squircle";
import { BrandMark } from "../../app/shell/AccountShell";
import { theme } from "../../theme/theme";
import { Brandings } from "./branding-specimens";
import { Embeds } from "./embed-specimens";
import { Actions, Blocks, Choices, Data, Feedback, Fields, Foundations, Identity, Overlays, Structure } from "./specimens";
import styles from "./kitchen.module.css";

const SECTIONS: Array<{ id: string; title: string; lede: string; render: () => JSX.Element }> = [
  { id: "foundations", title: "Foundations", lede: "Brand tokens mapped onto Arc's semantic roles; one accent, warm paper, warm charcoal.", render: () => <Foundations /> },
  { id: "actions", title: "Actions", lede: "Buttons do things, links go places. Destructive actions ask in place or need a hold.", render: () => <Actions /> },
  { id: "feedback", title: "Feedback", lede: "Numbers count, status carries a label, results confirm in place; toasts are for background work.", render: () => <Feedback /> },
  { id: "identity", title: "Identity", lede: "Squircle portraits and the identity card shell.", render: () => <Identity /> },
  { id: "fields", title: "Fields", lede: "Labelled fields with focus shown by the border, never a ring.", render: () => <Fields /> },
  { id: "choices", title: "Choices", lede: "Switches apply now; checkboxes belong to forms that submit.", render: () => <Choices /> },
  { id: "structure", title: "Structure", lede: "Tabs swap panels, steppers walk a flow, timelines group by day.", render: () => <Structure /> },
  { id: "data", title: "Data", lede: "Records to compare, snippets to copy, payloads to read.", render: () => <Data /> },
  { id: "overlays", title: "Overlays", lede: "Dialogs interrupt, drawers sit beside, sheets serve phones.", render: () => <Overlays /> },
  { id: "blocks", title: "Sign-in block", lede: "The parts the hosted sign-in is built from, as one sample flow.", render: () => <Blocks /> },
  { id: "branding", title: "Branding", lede: "applyBranding paints an app's variables onto one subtree; Powered by stays outside it.", render: () => <Brandings /> },
  { id: "embed", title: "Embed and SDK", lede: "The iframe page and the script tag render an app's buttons on its own pages; choosing one goes to the hosted sign-in.", render: () => <Embeds /> },
];

export default function Kitchen() {
  let page: HTMLDivElement | undefined;
  onMount(() => requestAnimationFrame(() => page?.setAttribute("data-kitchen-ready", "")));
  return (
    <div ref={page} class={styles.page}>
      <header class={styles.top}>
        <span class={styles.brand}><BrandMark /><span>Silicon <span class={styles.muted}>Accounts</span></span></span>
        <span class={styles.tools}>
          <LinkButton href={location.search.includes("squircle=fallback") ? "/__kitchen" : "/__kitchen?squircle=fallback"} variant="ghost" size="sm" rel="external">
            {location.search.includes("squircle=fallback") ? "Native squircles" : "Squircle fallback"}
          </LinkButton>
          <ThemeSwitch theme={theme()} iconOnly />
        </span>
      </header>
      <header class={styles.header}>
        <h1 class={styles.title}>Style guide</h1>
        <p class={styles.lede}>Every Arc component the web app uses, ported to Solid and set in the Silicon Accounts brand. Sample data only.</p>
        <nav class={styles.toc} aria-label="Sections">
          <For each={SECTIONS}>{section => <a ref={el => useSquircle(el)} class={styles.tocLink} href={`#${section.id}`}>{section.title}</a>}</For>
        </nav>
      </header>
      <For each={SECTIONS}>
        {section => (
          <section id={section.id} class={styles.section} aria-labelledby={`${section.id}-title`}>
            <h2 id={`${section.id}-title`} class={styles.sectionTitle}>{section.title}</h2>
            <p class={styles.sectionLede}>{section.lede}</p>
            {section.render()}
          </section>
        )}
      </For>
    </div>
  );
}

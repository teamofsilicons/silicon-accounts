"use client";

/**
 * /__kitchen: the style guide (development builds and screenshot runs only). Every installed Arc component in the
 * Silicon Accounts brand with squircles, the account shell's building blocks, the branding runtime and the embed.
 *
 *   /__kitchen                     in the page theme (the switch top right; screenshots run both themes)
 *   /__kitchen?compare=1           every specimen in a light and a dark pane side by side
 *   /__kitchen?squircle=fallback   the SVG-path squircles Firefox gets, in a browser with corner-shape
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { ThemeSwitch } from "@/components/arc/theme-switch/theme-switch";
import { BrandMark } from "@/components/foundation/shell/brand-mark";
import { useTheme } from "@/components/foundation/theme/use-theme";
import { Actions } from "./sections/actions";
import { Blocks } from "./sections/blocks";
import { Brandings } from "./sections/branding";
import { Choices } from "./sections/choices";
import { Data } from "./sections/data";
import { Embeds } from "./sections/embed";
import { Feedback } from "./sections/feedback";
import { Fields } from "./sections/fields";
import { Foundations } from "./sections/foundations";
import { Identity } from "./sections/identity";
import { Overlays } from "./sections/overlays";
import { Structure } from "./sections/structure";
import { CompareContext } from "./specimen";
import styles from "./kitchen.module.css";

const SECTIONS: Array<{ id: string; title: string; lede: string; render: () => ReactNode }> = [
  { id: "foundations", title: "Foundations", lede: "Brand tokens mapped onto Arc's semantic roles; one accent, warm paper, warm charcoal, squircles everywhere.", render: () => <Foundations /> },
  { id: "actions", title: "Actions", lede: "Buttons do things, links go places. Destructive actions ask in place or need a hold.", render: () => <Actions /> },
  { id: "feedback", title: "Feedback", lede: "Numbers count, status carries a label, results confirm in place; toasts are for background work.", render: () => <Feedback /> },
  { id: "identity", title: "Identity", lede: "Squircle portraits, the identity card shell, cards and the account menu.", render: () => <Identity /> },
  { id: "fields", title: "Fields", lede: "Labelled fields with focus shown by the border, never a ring.", render: () => <Fields /> },
  { id: "choices", title: "Choices", lede: "Switches apply now; checkboxes belong to forms that submit.", render: () => <Choices /> },
  { id: "structure", title: "Structure", lede: "Tabs swap panels, steppers walk a flow, timelines group by day.", render: () => <Structure /> },
  { id: "data", title: "Data", lede: "Records to compare, snippets to copy, payloads to read.", render: () => <Data /> },
  { id: "overlays", title: "Overlays", lede: "Dialogs interrupt, drawers sit beside, sheets serve phones.", render: () => <Overlays /> },
  { id: "blocks", title: "Blocks", lede: "Arc's composed blocks: a sample sign-in flow and the empty states.", render: () => <Blocks /> },
  { id: "branding", title: "Branding", lede: "The branding runtime paints an app's variables onto one subtree; Powered by stays outside it.", render: () => <Brandings /> },
  { id: "embed", title: "Embed and SDK", lede: "The iframe page and the script tag render an app's buttons on its own pages; choosing one goes to the hosted sign-in.", render: () => <Embeds /> },
];

const subscribeNothing = () => () => undefined;
const readSearch = () => window.location.search;

function withParam(search: string, key: string, value: string | null): string {
  const params = new URLSearchParams(search);
  if (value === null) params.delete(key);
  else params.set(key, value);
  const query = params.toString();
  return `/__kitchen${query ? `?${query}` : ""}`;
}

export function Kitchen() {
  const { theme, change } = useTheme();
  const page = useRef<HTMLDivElement>(null);
  // The query only matters after hydration (the server renders the default view).
  const search = useSyncExternalStore(subscribeNothing, readSearch, () => "");
  const params = new URLSearchParams(search);
  const compare = params.has("compare");
  const fallback = params.get("squircle") === "fallback";

  // Ready for screenshots once mounted and the fonts are in.
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => requestAnimationFrame(() => {
      if (live) page.current?.setAttribute("data-kitchen-ready", "");
    }));
    return () => {
      live = false;
    };
  }, []);

  return (
    <CompareContext.Provider value={compare}>
      <div ref={page} className={styles.page} data-compare={compare || undefined}>
        <header className={styles.top}>
          <span className={styles.brand}><BrandMark /><span>Silicon <span className={styles.muted}>Accounts</span></span></span>
          <ThemeSwitch theme={theme} variant="eclipse" iconOnly onThemeChange={(next, _variant, trigger) => change(next, trigger)} />
        </header>
        <header className={styles.header}>
          <h1 className={styles.title}>Style guide</h1>
          <p className={styles.lede}>Every Arc component the web app uses, installed with the shadcn CLI and set in the Silicon Accounts brand. Sample data only; nothing here talks to an account.</p>
          <nav className={styles.toc} aria-label="Sections">
            {SECTIONS.map(section => <a key={section.id} data-sq="surface" className={styles.tocLink} href={`#${section.id}`}>{section.title}</a>)}
          </nav>
          {/* Full loads on purpose: the squircle path is chosen once per page. */}
          <nav className={styles.views} aria-label="Views">
            <a data-sq="surface" className={styles.toggle} aria-current={compare || undefined} href={withParam(search, "compare", compare ? null : "1")}>{compare ? "Back to the page theme" : "Light and dark side by side"}</a>
            <a data-sq="surface" className={styles.toggle} aria-current={fallback || undefined} href={withParam(search, "squircle", fallback ? null : "fallback")}>{fallback ? "Back to native squircles" : "Squircle fallback (Firefox)"}</a>
          </nav>
        </header>
        {SECTIONS.map(section => (
          <section key={section.id} id={section.id} className={styles.section} aria-labelledby={`${section.id}-title`}>
            <h2 id={`${section.id}-title`} className={styles.sectionTitle}>{section.title}</h2>
            <p className={styles.sectionLede}>{section.lede}</p>
            {section.render()}
          </section>
        ))}
      </div>
    </CompareContext.Provider>
  );
}

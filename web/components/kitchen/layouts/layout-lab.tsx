"use client";

/**
 * /__layouts: the layout lab (development builds only, like /__kitchen). The account site's frame drawn in its loading
 * state, so only the arrangement shows: no words, no data. Four choices, kept in the address (choices.ts):
 *
 *   shell     panel: top bar and sidebar on the canvas, the page on a panel (today's shell)
 *             open: no panel; the top bar, sidebar and page share one background, and only the content is surfaces
 *             inset: no top bar; the sidebar carries the brand, search and account; the panel is inset on every side
 *             flat: one surface, the regions parted by hairlines
 *   sidebar   list (icon and label), rail (icons only), grouped (labelled groups, a leading marker)
 *   elements  cards (an edge), tiles (a fill, no edge), rows (no container, hairlines)
 *   content   column (one centred column), aside (a column and a side column), split (a list beside its detail)
 *
 *   /__layouts?shell=inset&sidebar=rail&elements=tiles&content=split&ui=0   (ui=0 hides the controls; H toggles them)
 */
import { useEffect, useState } from "react";
import { EyeOff, PanelsTopLeft } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { AXES, CHOICES, type Axis, type Layout } from "./choices";
import styles from "./layout-lab.module.css";

/** Label widths, so rows of bones read as different words. */
const WIDTHS = ["56%", "42%", "68%", "48%", "62%", "38%", "52%"];
const width = (index: number) => WIDTHS[index % WIDTHS.length];

const LINE = "var(--radius-full)";
const CONTROL = "var(--radius-control)";

export function LayoutLab({ initial, controls: initialControls }: { initial: Layout; controls: boolean }) {
  const [layout, setLayout] = useState(initial);
  const [controls, setControls] = useState(initialControls);

  const choose = (axis: Axis, value: string) => {
    const next = { ...layout, [axis]: value } as Layout;
    setLayout(next);
    const params = new URLSearchParams(next);
    if (!controls) params.set("ui", "0");
    window.history.replaceState(null, "", `?${params}`);
  };

  // H shows and hides the controls, for a clean look or a screenshot.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "h" || event.metaKey || event.ctrlKey || event.altKey) return;
      setControls(shown => !shown);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={styles.lab} data-shell={layout.shell} data-sidebar={layout.sidebar} data-elements={layout.elements} data-content={layout.content}>
      <div className={styles.frame} aria-busy="true" aria-label="Loading">
        <TopBar />
        <div className={styles.body}>
          <Sidebar />
          <main data-sq-native="" className={styles.main}>
            {layout.content === "column" ? <Column /> : layout.content === "aside" ? <WithAside /> : <Split />}
          </main>
        </div>
      </div>

      {controls ? (
        <div data-sq="surface" className={styles.controls} role="group" aria-label="Layout">
          {AXES.map(({ axis, label }) => (
            <div key={axis} className={styles.control}>
              <span className={styles.controlLabel}>{label}</span>
              <SegmentedControl
                label={label}
                options={CHOICES[axis].map(choice => ({ value: choice.value, label: choice.label }))}
                value={layout[axis]}
                onValueChange={value => choose(axis, value)}
              />
            </div>
          ))}
          <Button variant="ghost" size="sm" aria-label="Hide the controls (H)" aria-keyshortcuts="H" onClick={() => setControls(false)}>
            <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <span className={styles.reveal}>
          <Button variant="secondary" size="sm" aria-keyshortcuts="H" onClick={() => setControls(true)}>
            <PanelsTopLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            Layout
          </Button>
        </span>
      )}
    </div>
  );
}

/** A round bone for an avatar or mark: profile pictures are circles, so the squircled bone is clipped to one. */
function Circle({ size, index = 0 }: { size: string; index?: number }) {
  return <span className={styles.circle}><SkeletonBlock width={size} height={size} radius={LINE} index={index} /></span>;
}

/* --------------------------------------------------------- shell -------------------------------------------------------- */

/** The top bar: brand, search, the account. Hidden by the inset shell from 900px (its sidebar carries them). */
function TopBar() {
  return (
    <header className={styles.top}>
      <span className={styles.brand}>
        <SkeletonBlock width="22px" height="22px" radius={CONTROL} />
        <span className={styles.brandName}><SkeletonBlock width="100%" height="14px" radius={LINE} /></span>
      </span>
      <span className={styles.search}><SkeletonBlock width="100%" height="36px" radius={CONTROL} index={1} /></span>
      <span className={styles.topEnd}>
        <Circle size="32px" index={2} />
        <span className={styles.menu}><SkeletonBlock width="32px" height="32px" radius={CONTROL} index={3} /></span>
      </span>
    </header>
  );
}

function NavRow({ index, active, trailing }: { index: number; active?: boolean; trailing?: boolean }) {
  return (
    <span data-sq="surface" className={styles.navRow} data-active={active ? "" : undefined}>
      <SkeletonBlock width="16px" height="16px" radius="var(--radius-detail)" index={index} />
      <span className={styles.navLabel}><SkeletonBlock width={width(index)} height="10px" radius={LINE} index={index} /></span>
      {trailing ? <span className={styles.navTrail}><SkeletonBlock width="20px" height="16px" radius={LINE} index={index} /></span> : null}
    </span>
  );
}

/** The section list. Every variant draws the same two groups; CSS shows labels, icons only, or group headings. */
function Sidebar() {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.sideHead}>
        <span className={styles.brand}>
          <SkeletonBlock width="22px" height="22px" radius={CONTROL} />
          <span className={styles.brandName}><SkeletonBlock width="100%" height="14px" radius={LINE} /></span>
        </span>
        <span className={styles.sideSearch}><SkeletonBlock width="100%" height="36px" radius={CONTROL} index={1} /></span>
      </div>
      <nav className={styles.nav} aria-hidden="true">
        <div className={styles.navGroup}>
          <span className={styles.groupLabel}><SkeletonBlock width="36%" height="8px" radius={LINE} /></span>
          <NavRow index={0} active />
          <NavRow index={1} trailing />
          <NavRow index={2} />
          <NavRow index={3} />
        </div>
        <div className={styles.navGroup}>
          <span className={styles.groupLabel}><SkeletonBlock width="28%" height="8px" radius={LINE} index={4} /></span>
          <NavRow index={4} />
          <NavRow index={5} />
        </div>
      </nav>
      <div className={styles.sideFoot}>
        <NavRow index={6} />
        <span className={styles.account}>
          <Circle size="28px" index={7} />
          <span className={styles.navLabel}><SkeletonBlock width="60%" height="10px" radius={LINE} index={7} /></span>
        </span>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------- elements ------------------------------------------------------ */

function PageHead({ action }: { action?: boolean }) {
  return (
    <header className={styles.pageHead}>
      <span className={styles.pageTitle}>
        <SkeletonBlock width="min(280px, 70%)" height="28px" radius={CONTROL} />
        <SkeletonBlock width="min(440px, 90%)" height="12px" radius={LINE} index={1} />
      </span>
      {action ? <SkeletonBlock width="104px" height="36px" radius={CONTROL} index={2} /> : null}
    </header>
  );
}

function BlockHead({ index }: { index: number }) {
  return (
    <span className={styles.blockHead}>
      <SkeletonBlock width="120px" height="12px" radius={LINE} index={index} />
      <SkeletonBlock width="48px" height="10px" radius={LINE} index={index} />
    </span>
  );
}

function Row({ index, action = true }: { index: number; action?: boolean }) {
  return (
    <li className={styles.row}>
      <Circle size="36px" index={index} />
      <span className={styles.rowText}>
        <SkeletonBlock width={width(index)} height="12px" radius={LINE} index={index} />
        <SkeletonBlock width={width(index + 3)} height="10px" radius={LINE} index={index} />
      </span>
      {action ? <SkeletonBlock width="72px" height="28px" radius={CONTROL} index={index} /> : null}
    </li>
  );
}

/** A group of rows in the chosen element style: a card, a filled tile, or bare rows between hairlines. */
function Rows({ count, from = 0, head = true }: { count: number; from?: number; head?: boolean }) {
  return (
    <section className={styles.block}>
      {head ? <BlockHead index={from} /> : null}
      <ul data-sq="surface" className={styles.group}>
        {Array.from({ length: count }, (_, offset) => <Row key={offset} index={from + offset} />)}
      </ul>
    </section>
  );
}

function Tiles({ count, from = 0 }: { count: number; from?: number }) {
  return (
    <section className={styles.block}>
      <BlockHead index={from} />
      <div className={styles.tiles} data-count={count}>
        {Array.from({ length: count }, (_, offset) => (
          <span key={offset} data-sq="surface" className={styles.tile}>
            <Circle size="36px" index={from + offset} />
            <span className={styles.rowText}>
              <SkeletonBlock width={width(from + offset)} height="12px" radius={LINE} index={from + offset} />
              <SkeletonBlock width={width(from + offset + 2)} height="10px" radius={LINE} index={from + offset} />
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}

/** A summary: one large figure over a line, the kind of block a side column holds. */
function Summary({ index }: { index: number }) {
  return (
    <section className={styles.block}>
      <BlockHead index={index} />
      <div data-sq="surface" className={styles.tile}>
        <SkeletonBlock width="96px" height="32px" radius={CONTROL} index={index} />
        <span className={styles.rowText}>
          <SkeletonBlock width="80%" height="10px" radius={LINE} index={index} />
          <SkeletonBlock width="56%" height="10px" radius={LINE} index={index} />
        </span>
      </div>
    </section>
  );
}

/* --------------------------------------------------------- content ------------------------------------------------------ */

/** One centred column, blocks stacked: Home today. */
function Column() {
  return (
    <div className={styles.column}>
      <PageHead />
      <Rows count={2} from={1} />
      <Tiles count={3} from={3} />
      <Rows count={3} from={5} />
    </div>
  );
}

/** A main column with a side column of summaries that stays in view. */
function WithAside() {
  return (
    <div className={styles.wide}>
      <PageHead action />
      <div className={styles.twoCol}>
        <div className={styles.stack}>
          <Rows count={4} from={1} />
          <Tiles count={2} from={5} />
        </div>
        <div className={styles.aside}>
          <Summary index={3} />
          <Rows count={2} from={6} head />
        </div>
      </div>
    </div>
  );
}

/** A list of things beside the chosen one's detail: Silicons and apps. */
function Split() {
  return (
    <div className={styles.split}>
      <div className={styles.listPane}>
        <span className={styles.listHead}>
          <SkeletonBlock width="96px" height="16px" radius={LINE} />
          <SkeletonBlock width="28px" height="28px" radius={CONTROL} />
        </span>
        <SkeletonBlock width="100%" height="36px" radius={CONTROL} index={1} />
        <ul className={styles.listRows}>
          {Array.from({ length: 7 }, (_, index) => (
            <li key={index} data-sq="surface" className={styles.listRow} data-active={index === 1 ? "" : undefined}>
              <Circle size="32px" index={index + 2} />
              <span className={styles.rowText}>
                <SkeletonBlock width={width(index)} height="11px" radius={LINE} index={index + 2} />
                <SkeletonBlock width={width(index + 4)} height="9px" radius={LINE} index={index + 2} />
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.detailPane}>
        <header className={styles.detailHead}>
          <Circle size="56px" />
          <span className={styles.pageTitle}>
            <SkeletonBlock width="min(240px, 70%)" height="24px" radius={CONTROL} index={1} />
            <SkeletonBlock width="min(160px, 50%)" height="11px" radius={LINE} index={1} />
          </span>
          <SkeletonBlock width="88px" height="36px" radius={CONTROL} index={2} />
        </header>
        <Tabs />
        <Rows count={3} from={2} />
        <Rows count={2} from={5} />
      </div>
    </div>
  );
}

function Tabs() {
  return (
    <span className={styles.tabs}>
      {["64px", "52px", "72px"].map((size, index) => (
        <span key={size} className={styles.tab} data-active={index === 0 ? "" : undefined}>
          <SkeletonBlock width={size} height="10px" radius={LINE} index={index + 2} />
        </span>
      ))}
    </span>
  );
}

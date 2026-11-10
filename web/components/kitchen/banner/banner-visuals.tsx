"use client";

/**
 * /__banner, visual directions (Anil, 2026-11-10): the introduction banner with character, built in layers: a picture
 * from the Super Visuals library (public/banner, on its own layer, .art, because the squircle fallback paints with the
 * surface's ::before and drops its background images; Anil's picks: BG 126, 127, 110, 102, 024, 139), a fade or scrim so
 * the words sit on a calm part, the content, and pieces floating over the picture (the next step, the Carbon's avatar,
 * a Silicon mark) with soft shadows. The same three steps as the structures in banner-lab.tsx.
 *
 *   Meadow  BG 126, the dithered green: the picture gathers at the lower right; a checklist on the white; the next step
 *           floats over the green. The dots echo the pixel avatar.
 *   Hills   BG 127, ivory hills: a picture band on top with the greeting in its sky; the three steps as cards straddling
 *           its lower edge.
 *   Golden  BG 110, watercolour: the whole banner warm; a frosted panel holds the steps; the avatar hangs over its edge.
 *   Peach   BG 102, the soft gradient: words on the left; the steps as a stack of cards in the colour, the next in front.
 *   Forest  BG 139, the birds: full bleed under a dark scrim on the left; light words; the steps as glass rows. The birds
 *           flying out read as Silicons going out to apps.
 *   Stage   BG 024, the figure of light: dark; the figure fades in from the right; one glowing Silicon mark.
 */
import type { ReactNode } from "react";
import { Camera, Check, LayoutGrid, Sparkle, X } from "lucide-react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Progress } from "@teamofsilicons/silicon-ui/progress";
import { SiliconMark } from "@/components/account/parts/silicon-mark";
import styles from "./banner-visuals.module.css";

interface Step { key: string; icon: ReactNode; title: string; line: string; action: string }

const STEPS: Step[] = [
  { key: "photo", icon: <Camera size={16} strokeWidth={1.75} />, title: "Add your photo", line: "Apps and Silicons show it beside your name.", action: "Add Photo" },
  { key: "silicon", icon: <Sparkle size={16} strokeWidth={1.75} />, title: "Create your first Silicon", line: "It gets its own id and key, and signs in to apps by itself.", action: "Create a Silicon" },
  { key: "app", icon: <LayoutGrid size={16} strokeWidth={1.75} />, title: "Try an app", line: "Sign in to Briefcase, DM or Ting with your account.", action: "Browse Apps" },
];
const NAME = "Anil";
const count = (done: number) => `${Math.min(done, STEPS.length)} of ${STEPS.length} done`;

export const VISUALS: { id: string; name: string; note: string; render: (done: number) => ReactNode }[] = [
  { id: "meadow", name: "Meadow · BG 126", note: "The dithered green gathers at the lower right of a white banner; a checklist sits on the white, and the next step floats over the green. The dots echo the pixel avatar.", render: done => <Meadow done={done} /> },
  { id: "hills", name: "Hills · BG 127", note: "A band of ivory hills with the greeting in its sky; the steps are cards straddling the band's lower edge, so the picture and the page overlap.", render: done => <Hills done={done} /> },
  { id: "golden", name: "Golden · BG 110", note: "Warm watercolour fills the banner; a frosted panel holds the steps, and your avatar hangs over the panel's edge.", render: done => <Golden done={done} /> },
  { id: "peach", name: "Peach · BG 102", note: "The soft gradient on the right; the steps as a small stack of cards in the colour, the next one in front. Finishing one would slide it away.", render: done => <Peach done={done} /> },
  { id: "forest", name: "Forest · BG 139", note: "The forest full bleed under a dark scrim on the left; light words and glass rows. The birds flying out read as Silicons going out to apps.", render: done => <Forest done={done} /> },
  { id: "stage", name: "Stage · BG 024", note: "Dark. The figure of light fades in from the right; one glowing Silicon mark; the next step as a light button. The boldest.", render: done => <Stage done={done} /> },
];

/* Shared ----------------------------------------------------------------------------------------------------------- */

const Dismiss = ({ onDark }: { onDark?: boolean }) => (
  <span className={onDark ? styles.dismissOnDark : styles.dismiss}>
    <Button variant="ghost" size="xs" aria-label="Dismiss"><X size={14} strokeWidth={2} aria-hidden="true" /></Button>
  </span>
);

function Mark({ step, done, glass }: { step: Step; done: boolean; glass?: boolean }) {
  return (
    <span data-sq="surface" className={glass ? styles.markGlass : styles.mark} data-done={done ? "" : undefined} aria-hidden="true">
      {done ? <Check size={14} strokeWidth={2.25} /> : step.icon}
    </span>
  );
}

function Rows({ done, glass }: { done: number; glass?: boolean }) {
  return (
    <ul className={glass ? styles.rowsGlass : styles.rows}>
      {STEPS.map((step, index) => {
        const isDone = index < done;
        return (
          <li key={step.key} className={styles.row} data-done={isDone ? "" : undefined}>
            <Mark step={step} done={isDone} glass={glass} />
            <span className={styles.rowTitle}>{step.title}</span>
            {isDone ? <span className={styles.rowMeta}>Done</span> : index === done ? <Button variant={glass ? "secondary" : "primary"} size="sm">{step.action}</Button> : null}
          </li>
        );
      })}
    </ul>
  );
}

function AllSet({ onDark }: { onDark?: boolean }) {
  return <p className={onDark ? styles.allSetOnDark : styles.allSet}><Check size={16} strokeWidth={2.25} aria-hidden="true" /> You&rsquo;re set up, {NAME}.</p>;
}

/* Meadow ------------------------------------------------------------------------------------------------------------ */

function Meadow({ done }: { done: number }) {
  const next = STEPS[done];
  return (
    <section data-sq="surface" className={`${styles.banner} ${styles.meadow}`} aria-label="Set up your account">
      <span className={styles.art} aria-hidden="true" />
      <div className={styles.meadowWords}>
        <div className={styles.headLine}>
          <h3 className={styles.title}>Welcome, {NAME}</h3>
          <Dismiss />
        </div>
        <p className={styles.lede}>{done >= STEPS.length ? "You're set up." : `Three things to make it yours · ${count(done)}`}</p>
        {done >= STEPS.length ? <AllSet /> : (
          <ul className={styles.list}>
            {STEPS.map((step, index) => (
              <li key={step.key} className={styles.listItem} data-done={index < done ? "" : undefined} data-next={index === done ? "" : undefined}>
                <Mark step={step} done={index < done} />
                <span>{step.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {next ? (
        <div data-sq="surface" className={styles.floatCard}>
          <span className={styles.floatEyebrow}>Next</span>
          <span className={styles.floatTitle}>{next.title}</span>
          <span className={styles.floatLine}>{next.line}</span>
          <div><Button size="sm">{next.action}</Button></div>
        </div>
      ) : null}
    </section>
  );
}

/* Hills ------------------------------------------------------------------------------------------------------------- */

function Hills({ done }: { done: number }) {
  return (
    <section className={styles.hills} aria-label="Set up your account">
      <div data-sq="surface" className={styles.hillsBand}>
        <span className={styles.art} aria-hidden="true" />
        <div className={styles.headLine}>
          <div>
            <h3 className={styles.titleLarge}>Welcome, {NAME}</h3>
            <p className={styles.lede}>One account for you, your Silicons and your apps.</p>
          </div>
          <Dismiss />
        </div>
      </div>
      {done >= STEPS.length ? <div className={styles.hillsAllSet}><AllSet /></div> : (
        <ul className={styles.hillsCards}>
          {STEPS.map((step, index) => {
            const isDone = index < done;
            return (
              <li key={step.key} data-sq="surface" className={styles.hillsCard} data-done={isDone ? "" : undefined}>
                <Mark step={step} done={isDone} />
                <span className={styles.cardTitle}>{step.title}</span>
                <span className={styles.cardLine}>{isDone ? "Done." : step.line}</span>
                {isDone ? null : <div><Button variant={index === done ? "primary" : "secondary"} size="sm">{step.action}</Button></div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* Golden ------------------------------------------------------------------------------------------------------------ */

function Golden({ done }: { done: number }) {
  return (
    <section data-sq="surface" className={`${styles.banner} ${styles.golden}`} aria-label="Set up your account">
      <span className={styles.art} aria-hidden="true" />
      <div data-sq="surface" className={styles.goldenPanel}>
        <span className={styles.goldenAvatar}><Avatar name={NAME} size="lg" /></span>
        <div className={styles.headLine}>
          <div>
            <h3 className={styles.title}>Welcome, {NAME}</h3>
            <p className={styles.lede}>{done >= STEPS.length ? "You're set up." : count(done)}</p>
          </div>
          <Dismiss />
        </div>
        {done >= STEPS.length ? null : <><Progress className={styles.progress} value={Math.round((done / STEPS.length) * 100)} max={100} aria-label={count(done)} /><Rows done={done} /></>}
      </div>
    </section>
  );
}

/* Peach ------------------------------------------------------------------------------------------------------------- */

function Peach({ done }: { done: number }) {
  const left = STEPS.slice(done);
  return (
    <section data-sq="surface" className={`${styles.banner} ${styles.peach}`} aria-label="Set up your account">
      <span className={styles.art} aria-hidden="true" />
      <div className={styles.peachWords}>
        <h3 className={styles.titleLarge}>Make it yours, {NAME}</h3>
        <p className={styles.lede}>{left.length ? `${left.length} ${left.length === 1 ? "thing" : "things"} left to try.` : "You're set up."}</p>
        <Badge size="sm" tone="neutral">{count(done)}</Badge>
      </div>
      <div className={styles.peachStack}>
        {left.length ? left.slice(0, 3).reverse().map((step, back) => {
          const depth = Math.min(left.length, 3) - 1 - back;
          return (
            <div key={step.key} data-sq="surface" className={styles.peachCard} data-depth={depth} aria-hidden={depth > 0 ? true : undefined}>
              <Mark step={step} done={false} />
              <span className={styles.cardTitle}>{step.title}</span>
              <span className={styles.cardLine}>{step.line}</span>
              {depth === 0 ? <div><Button size="sm">{step.action}</Button></div> : null}
            </div>
          );
        }) : <div data-sq="surface" className={styles.peachCard} data-depth={0}><AllSet /></div>}
      </div>
      <Dismiss />
    </section>
  );
}

/* Forest ------------------------------------------------------------------------------------------------------------ */

function Forest({ done }: { done: number }) {
  return (
    <section data-sq="surface" className={`${styles.banner} ${styles.forest}`} aria-label="Set up your account">
      <span className={styles.art} aria-hidden="true" />
      <div className={styles.forestWords}>
        <div className={styles.headLine}>
          <div>
            <h3 className={styles.titleOnDark}>Welcome, {NAME}</h3>
            <p className={styles.ledeOnDark}>{done >= STEPS.length ? "You're set up." : `Three things to start with · ${count(done)}`}</p>
          </div>
          <Dismiss onDark />
        </div>
        {done >= STEPS.length ? <AllSet onDark /> : <Rows done={done} glass />}
      </div>
    </section>
  );
}

/* Stage ------------------------------------------------------------------------------------------------------------- */

function Stage({ done }: { done: number }) {
  const next = STEPS[done];
  return (
    <section data-sq="surface" className={`${styles.banner} ${styles.stage}`} aria-label="Set up your account">
      <span className={styles.art} aria-hidden="true" />
      <div className={styles.stageWords}>
        <span className={styles.stageMark}><SiliconMark seed="stage" size={40} /></span>
        <h3 className={styles.titleOnDark}>{next ? next.title : `You're set up, ${NAME}`}</h3>
        <p className={styles.ledeOnDark}>{next ? next.line : "Everything else is in the sidebar."}</p>
        <div className={styles.stageActions}>
          {next ? <Button variant="secondary" size="sm">{next.action}</Button> : null}
          <span className={styles.stageCount}>{count(done)}</span>
        </div>
      </div>
      <Dismiss onDark />
    </section>
  );
}

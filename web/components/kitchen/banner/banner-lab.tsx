"use client";

/**
 * /__banner: Home's introduction banner (Anil, 2026-11-10), development only, like /__needs. Three views: the templates
 * (intro-banner.tsx, IntroBanner, proposed to Silicon UI: a template and any picture), the earlier visual explorations
 * (banner-visuals.tsx) and the first structures below. Each
 * design shows the same three things a new Carbon can do, at the Home column's width, and the switch at the top puts
 * them all in one state: just joined, one done, or all done. Built from Silicon UI parts and tokens. Drawn from how
 * others introduce themselves (OpenAI's platform, Shopify's setup guide, GitHub and Figma's cards, Apple's welcome
 * sheet); the research is in redesign/log.md, 2026-11-10.
 *
 *   A  Checklist: a title, "1 of 3 done" with a bar, a row per step with its action; done steps tick and fade.
 *   B  Guided: Silicon UI's Accordion, the next step open with its line, action and picture; the others one line each.
 *   C  Cards: a card per step, each with its own action; a done card says so.
 *   D  Strip: one line with the next step and its action, and how many are left. The most compact.
 *   E  Stepper: Silicon UI's Stepper down the side, the current step's action beside it, in a Card.
 *   F  Welcome sheet: shown once, in a dialog: the three things, each a line, and one button to start.
 */
import { useState, type ReactNode } from "react";
import { Camera, Check, LayoutGrid, Sparkle, X } from "lucide-react";
import { Accordion } from "@teamofsilicons/silicon-ui/accordion";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Card } from "@teamofsilicons/silicon-ui/card";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { Progress } from "@teamofsilicons/silicon-ui/progress";
import { Select } from "@teamofsilicons/silicon-ui/select";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { Stepper } from "@teamofsilicons/silicon-ui/stepper";
import { VISUALS } from "./banner-visuals";
import { HomeCardsView } from "@/components/account/home-cards";
import { PictureCards, type PictureCard } from "@/components/account/parts/picture-cards";
import { IntroBanner, type IntroBannerArt, type IntroBannerStep, type IntroBannerTemplate } from "./intro-banner";
import styles from "./banner-lab.module.css";

interface Step {
  key: string;
  icon: ReactNode;
  title: string;
  line: string;
  action: string;
}

const STEPS: Step[] = [
  { key: "photo", icon: <Camera size={16} strokeWidth={1.75} />, title: "Add your photo", line: "Apps and Silicons show it beside your name.", action: "Add Photo" },
  { key: "silicon", icon: <Sparkle size={16} strokeWidth={1.75} />, title: "Create your first Silicon", line: "It gets its own id and key, and signs in to apps by itself.", action: "Create a Silicon" },
  { key: "app", icon: <LayoutGrid size={16} strokeWidth={1.75} />, title: "Try an app", line: "Sign in to Briefcase, DM or Ting with your account.", action: "Browse Apps" },
];

const STATES = [{ value: "0", label: "Just joined" }, { value: "1", label: "One done" }, { value: "3", label: "All done" }];

const DESIGNS: { id: string; name: string; note: string; render: (done: number) => ReactNode }[] = [
  { id: "a", name: "A · Checklist", note: "OpenAI's platform and Shopify's setup guide: a title, progress, a row per step with its own action. Done steps tick themselves and fade; when all are done it says so once, then goes.", render: done => <Checklist done={done} /> },
  { id: "b", name: "B · Guided", note: "Shopify's expanding steps: only the next step is open, with its line, action and a small picture; the rest are one line each. Click a step to open it.", render: done => <Guided done={done} /> },
  { id: "c", name: "C · Cards", note: "GitHub and Figma's home cards, like today's three cards, but each does something. A done card turns into a quiet confirmation.", render: done => <Cards done={done} /> },
  { id: "d", name: "D · Strip", note: "The compact one: a single line with the next step and its button, and how many are left. Nothing to read twice.", render: done => <Strip done={done} /> },
  { id: "e", name: "E · Stepper", note: "Silicon UI as it ships: its Stepper down the side in a Card, the current step's action beside it. Card has no place for a dismiss button in its header (its action sits in the footer), so this one can't be closed without asking Silicon UI.", render: done => <StepperCard done={done} /> },
  { id: "f", name: "F · Welcome sheet", note: "Apple's first-launch sheet: shown once in a dialog, the three things in a line each, one button to start. Home then needs nothing else.", render: () => <Sheet /> },
];

const ART = [
  { value: "none", label: "No picture" },
  { value: "126", label: "BG 126 · Pale green meadow (light)", tone: "light", focus: "right bottom" },
  { value: "127", label: "BG 127 · Ivory hills (light)", tone: "light", focus: "center 70%" },
  { value: "110", label: "BG 110 · Golden watercolour (light)", tone: "light", focus: "center" },
  { value: "102", label: "BG 102 · Peach and blue (light)", tone: "light", focus: "right center" },
  { value: "139", label: "BG 139 · Forest and birds (dark)", tone: "dark", focus: "center 40%" },
  { value: "024", label: "BG 024 · Figure of light (dark)", tone: "dark", focus: "70% 30%" },
] as const;

const TEMPLATES: { id: IntroBannerTemplate; name: string; note: string; art: string }[] = [
  { id: "checklist", name: "Checklist", note: "The steps as rows on the surface; the picture fades in from the end side. The quietest: most of the banner is plain.", art: "126" },
  { id: "cards", name: "Cards", note: "A picture band with the title; a card per step overlaps its lower edge, each with one line on what it gives you.", art: "127" },
  { id: "panel", name: "Panel", note: "The picture fills the banner; a frosted panel holds the title and the rows. Works on any picture, light or dark.", art: "110" },
  { id: "spotlight", name: "Spotlight", note: "Only the next step, large, on the picture, with dots for how far along you are. The boldest; one thing at a time.", art: "024" },
];

/** Picture sets for the picture cards: You, Silicons, Apps. */
const PICTURE_SETS = [
  { value: "warm", label: "Warm: BG 110, 102, 127", pictures: [["110", "center"], ["102", "right center"], ["127", "center 70%"]] },
  { value: "mixed", label: "Mixed: BG 110, 024, 139", pictures: [["110", "center"], ["024", "60% 30%"], ["139", "center 40%"]] },
  { value: "textures", label: "Dithered: BG 126, 127, 126", pictures: [["126", "right bottom"], ["127", "center 70%"], ["126", "left top"]] },
] as const;
const SAMPLE_CARBON = { uuid: "lab-sample-carbon", id: "c:anil" };

/** Ways to make the cards wider at 16:9, the shape Anil picked (2026-11-11; 3:1, 5:2, 2:1 and 16:10 were tried). */
const WIDTHS: { id: string; name: string; note: string; layout: "grid" | "scroll"; wide?: boolean }[] = [
  { id: "column", name: "In the column", note: "Home's 720px column shared by three: about 230px a card.", layout: "grid" },
  { id: "wide", name: "Wider than the column", note: "The banner steps out of Home's column to about 816px: about 260px a card. The only part of Home that does.", layout: "grid", wide: true },
  { id: "scroll", name: "Scroll row", note: "280px cards in one row that scrolls sideways, the third peeking in at the column's edge; a swipe or a trackpad shows it.", layout: "scroll" },
];

/** Home's introduction as it is today, and the new picture cards in a few picture shapes, with sample words. */
function Collection() {
  const [set, setSet] = useState<string>("warm");
  const pictures = (PICTURE_SETS.find(item => item.value === set) ?? PICTURE_SETS[0]).pictures;
  const cards: PictureCard[] = [
    { id: "you", picture: { src: `/banner/bg-${pictures[0][0]}.webp`, focus: pictures[0][1] }, title: "You", line: `Your id across apps: ${SAMPLE_CARBON.id}` },
    { id: "silicons", picture: { src: `/banner/bg-${pictures[1][0]}.webp`, focus: pictures[1][1] }, title: "Silicons", line: "Give an AI agent its own account." },
    { id: "apps", picture: { src: `/banner/bg-${pictures[2][0]}.webp`, focus: pictures[2][1] }, title: "Apps", line: "Apps for delightful agent creation and interaction." },
  ];
  return (
    <>
      <section className={styles.design} aria-labelledby="collection-current">
        <div className={styles.designHead}>
          <h2 id="collection-current" className={styles.designName}>Current <code className={styles.code}>home-cards.tsx</code></h2>
          <p className={styles.designNote}>Home&rsquo;s introduction today: a grey banner with its title, and three cards (You, Silicons, Apps), each a gradient with its picture standing at the lower right. Shown here with a sample avatar.</p>
        </div>
        <div className={styles.stage}><div className={styles.column}><HomeCardsView account={SAMPLE_CARBON} /></div></div>
      </section>
      <section className={styles.design} aria-labelledby="collection-pictures">
        <div className={styles.designHead}>
          <h2 id="collection-pictures" className={styles.designName}>Picture cards <code className={styles.code}>new</code></h2>
          <p className={styles.designNote}>No background or box: an h3 and three cards of one design, a 16:9 picture on top (nothing on it) and the title and its line under it. The same words as today, at three widths.</p>
          <div className={styles.picker}><Select label="Pictures" options={PICTURE_SETS.map(({ value, label }) => ({ value, label }))} value={set} onValueChange={setSet} /></div>
        </div>
        {WIDTHS.map(item => (
          <div key={item.id} className={styles.ratio}>
            <p className={styles.ratioName}>{item.name} <span className={styles.ratioNote}>{item.note}</span></p>
            <div className={styles.stage}><div className={item.wide ? styles.columnWide : styles.column}><PictureCards title="One Account for Your Silicons & Apps" cards={cards} layout={item.layout} /></div></div>
          </div>
        ))}
      </section>
    </>
  );
}

const VIEWS = [{ value: "templates", label: "Templates" }, { value: "earlier", label: "Earlier explorations" }, { value: "structures", label: "Structures" }];

function labSteps(done: number): IntroBannerStep[] {
  return STEPS.map((step, index) => ({ id: step.key, icon: step.icon, title: step.title, description: step.line, action: step.action, done: index < done }));
}

export function BannerLab() {
  const [done, setDone] = useState("0");
  const [view, setView] = useState("templates");
  const [art, setArt] = useState("each");
  const artFor = (fallback: string): IntroBannerArt | undefined => {
    const choice = ART.find(item => item.value === (art === "each" ? fallback : art));
    return choice && "tone" in choice ? { src: `/banner/bg-${choice.value}.webp`, tone: choice.tone, focus: choice.focus } : undefined;
  };
  const shown = view === "earlier" ? VISUALS : DESIGNS;
  return (
    <main className={styles.lab}>
      <div className={styles.intro}>
        <h1 className={styles.title}>Introduction banner</h1>
        <p className={styles.lede}>A banner any TOS app can show a new person: a template (how it&rsquo;s laid out) and a picture (any of them), with the same few steps. Proposed to Silicon UI as IntroBanner; each sits at Home&rsquo;s column width.</p>
        <div className={styles.switches}>
          <SegmentedControl size="sm" label="View" options={VIEWS} value={view} onValueChange={setView} />
          <SegmentedControl size="sm" label="State" options={STATES} value={done} onValueChange={setDone} />
        </div>
        {view === "templates" ? (
          <div className={styles.picker}>
            <Select label="Picture" options={[{ value: "each", label: "Each template's own" }, ...ART.map(({ value, label }) => ({ value, label }))]} value={art} onValueChange={setArt} />
          </div>
        ) : null}
      </div>
      {view === "templates" ? <Collection /> : null}
      {view === "templates" ? TEMPLATES.map(template => (
        <section key={template.id} className={styles.design} aria-labelledby={`template-${template.id}`}>
          <div className={styles.designHead}>
            <h2 id={`template-${template.id}`} className={styles.designName}>{template.name} <code className={styles.code}>template=&quot;{template.id}&quot;</code></h2>
            <p className={styles.designNote}>{template.note}</p>
          </div>
          <div className={styles.stage}>
            <div className={styles.column}>
              <IntroBanner template={template.id} title="Welcome, Anil" description="Three things to make it yours" steps={labSteps(Number(done))} art={artFor(template.art)} />
            </div>
          </div>
        </section>
      )) : shown.map(design => (
        <section key={design.id} className={styles.design} aria-labelledby={`design-${design.id}`}>
          <div className={styles.designHead}>
            <h2 id={`design-${design.id}`} className={styles.designName}>{design.name}</h2>
            <p className={styles.designNote}>{design.note}</p>
          </div>
          <div className={styles.stage}>
            <div className={styles.column}>{design.render(Number(done))}</div>
          </div>
        </section>
      ))}
    </main>
  );
}

/* Shared parts ---------------------------------------------------------------------------------------------------- */

const Dismiss = () => (
  <Button variant="ghost" size="xs" aria-label="Dismiss"><X size={14} strokeWidth={2} aria-hidden="true" /></Button>
);

function Mark({ step, done }: { step: Step; done: boolean }) {
  return <span data-sq="surface" className={styles.mark} data-done={done ? "" : undefined} aria-hidden="true">{done ? <Check size={14} strokeWidth={2.25} /> : step.icon}</span>;
}

const count = (done: number) => `${Math.min(done, STEPS.length)} of ${STEPS.length} done`;

function AllSet({ children }: { children?: ReactNode }) {
  return (
    <div data-sq="surface" className={styles.allSet}>
      <span data-sq="surface" className={styles.mark} data-done="" aria-hidden="true"><Check size={14} strokeWidth={2.25} /></span>
      <span className={styles.allSetText}><strong>You&rsquo;re set up.</strong> Everything else is in the sidebar.</span>
      {children ?? <Dismiss />}
    </div>
  );
}

/* A · Checklist ---------------------------------------------------------------------------------------------------- */

function Checklist({ done }: { done: number }) {
  if (done >= STEPS.length) return <AllSet />;
  return (
    <section data-sq="surface" className={styles.box} aria-label="Set up your account">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h3 className={styles.boxTitle}>Set up your account</h3>
          <span className={styles.meta}>{count(done)}</span>
        </div>
        <Dismiss />
      </div>
      <Progress className={styles.progress} value={Math.round((done / STEPS.length) * 100)} max={100} aria-label={count(done)} />
      <ul className={styles.rows}>
        {STEPS.map((step, index) => {
          const isDone = index < done;
          return (
            <li key={step.key} className={styles.row} data-done={isDone ? "" : undefined}>
              <Mark step={step} done={isDone} />
              <span className={styles.text}>
                <span className={styles.rowTitle}>{step.title}</span>
                {isDone ? null : <span className={styles.rowLine}>{step.line}</span>}
              </span>
              {isDone ? <span className={styles.meta}>Done</span> : <Button variant={index === done ? "primary" : "secondary"} size="sm">{step.action}</Button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* B · Guided ------------------------------------------------------------------------------------------------------- */

function Guided({ done }: { done: number }) {
  if (done >= STEPS.length) return <AllSet />;
  return (
    <section data-sq="surface" className={styles.box} aria-label="Get started">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h3 className={styles.boxTitle}>Get started</h3>
          <span className={styles.meta}>{count(done)}</span>
        </div>
        <Dismiss />
      </div>
      {/* Silicon UI's Accordion: the next step open; its titles are text only, so a done step says so in words. */}
      <div className={styles.guided}>
        <Accordion key={done} defaultOpen={done} items={STEPS.map((step, index) => ({
          title: index < done ? `${step.title} · Done` : step.title,
          content: (
            <div className={styles.guidedBody}>
              <div className={styles.guidedText}>
                <p className={styles.rowLine}>{step.line}</p>
                {index < done ? null : <div><Button size="sm">{step.action}</Button></div>}
              </div>
              <span data-sq="surface" className={styles.picture} aria-hidden="true">{step.icon}</span>
            </div>
          ),
        }))} />
      </div>
    </section>
  );
}

/* C · Cards -------------------------------------------------------------------------------------------------------- */

function Cards({ done }: { done: number }) {
  if (done >= STEPS.length) return <AllSet />;
  return (
    <section className={styles.cardsBlock} aria-label="Start here">
      <div className={styles.head}>
        <div className={styles.headText}>
          <h3 className={styles.sectionTitle}>Start here</h3>
          <span className={styles.meta}>{count(done)}</span>
        </div>
        <Dismiss />
      </div>
      <ul className={styles.cards}>
        {STEPS.map((step, index) => {
          const isDone = index < done;
          return (
            <li key={step.key} data-sq="surface" className={styles.card} data-done={isDone ? "" : undefined}>
              <Mark step={step} done={isDone} />
              <span className={styles.cardTitle}>{step.title}</span>
              <span className={styles.rowLine}>{isDone ? "Done." : step.line}</span>
              {isDone ? null : <div className={styles.cardAction}><Button variant={index === done ? "primary" : "secondary"} size="sm">{step.action}</Button></div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* D · Strip -------------------------------------------------------------------------------------------------------- */

function Strip({ done }: { done: number }) {
  if (done >= STEPS.length) return <AllSet />;
  const next = STEPS[done]!;
  return (
    <section data-sq="surface" className={styles.strip} aria-label="Next step">
      <Mark step={next} done={false} />
      <span className={styles.text}>
        <span className={styles.rowTitle}>{next.title}</span>
        <span className={styles.rowLine}>{next.line}</span>
      </span>
      <Badge size="sm" tone="neutral">{STEPS.length - done} left</Badge>
      <Button size="sm">{next.action}</Button>
      <Dismiss />
    </section>
  );
}

/* E · Stepper ------------------------------------------------------------------------------------------------------ */

function StepperCard({ done }: { done: number }) {
  const next = STEPS[done];
  return (
    <Card title="Set up your account" description={done >= STEPS.length ? "You're set up." : count(done)}>
      <div className={styles.stepperBody}>
        <Stepper orientation="vertical" current={done} details="current" label="Set up your account" completeLabel="All done"
          steps={STEPS.map(step => ({ id: step.key, label: step.title, description: step.line }))} />
        {next ? <div className={styles.stepperAction}><Button size="sm">{next.action}</Button></div> : null}
      </div>
    </Card>
  );
}

/* F · Welcome sheet ------------------------------------------------------------------------------------------------ */

function Sheet() {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.sheetStage}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Open the Welcome Sheet</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Welcome to Silicon Accounts" description="One account for you, your Silicons and your apps.">
          <ul className={styles.sheetList}>
            {STEPS.map(step => (
              <li key={step.key} className={styles.sheetItem}>
                <span data-sq="surface" className={styles.mark} aria-hidden="true">{step.icon}</span>
                <span className={styles.text}>
                  <span className={styles.rowTitle}>{step.title}</span>
                  <span className={styles.rowLine}>{step.line}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className={styles.sheetActions}>
            <Button onClick={() => setOpen(false)}>Get Started</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

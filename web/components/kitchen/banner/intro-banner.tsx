"use client";

/**
 * IntroBanner (Anil, 2026-11-10), a prototype for Silicon UI: the banner a TOS app shows a new person, with the few
 * things to do first. Identified by its template (how it's laid out), not by its picture; any picture fits any template.
 * Proposed to Silicon UI in redesign/requests/silicon-ui-intro-banner.md; until then it lives in the kitchen
 * (/__banner) and nowhere on the site.
 *
 * Templates:
 *   checklist  The steps as rows on the surface; the picture fades in from the end side. The quietest.
 *   cards      A picture band with the title; a card per step overlapping the band's lower edge.
 *   panel      The picture fills the banner; a frosted panel holds the title and the rows.
 *   spotlight  Only the next step, large, on the picture, with how far along you are. The boldest.
 *
 * Every template has the same parts and rules, kept simple on purpose:
 *   - a title, an optional line, and a dismiss button;
 *   - steps, each a mark (its icon, a tick once done), a title and, for cards and spotlight, one line;
 *   - one action only: the next step's (primary); done steps are struck through in their own colour; later steps
 *     wait, without buttons;
 *   - when every step is done, one line ("You're set up") until dismissed.
 * The picture is a layer under the content (its own element, not the surface's background, so the squircle fallback
 * keeps it); `art.tone` says whether it's light or dark, which sets the scrim and the words' colour.
 */
import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import styles from "./intro-banner.module.css";

export type IntroBannerTemplate = "checklist" | "cards" | "panel" | "spotlight";

export interface IntroBannerStep {
  id: string;
  icon: ReactNode;
  title: string;
  /** One line on what it gives you; shown by cards and spotlight. */
  description?: string;
  /** The next step's button. */
  action: string;
  done?: boolean;
}

export interface IntroBannerArt {
  src: string;
  /** Light pictures take dark words; dark pictures take light words and a dark scrim. */
  tone: "light" | "dark";
  /** CSS background-position for the picture's focus, e.g. "right bottom". */
  focus?: string;
}

export interface IntroBannerProps {
  template: IntroBannerTemplate;
  title: string;
  description?: string;
  steps: IntroBannerStep[];
  art?: IntroBannerArt;
  /** Shown once every step is done. */
  doneTitle?: string;
  onDismiss?: () => void;
}

export function IntroBanner({ template, title, description, steps, art, doneTitle = "You're set up.", onDismiss }: IntroBannerProps) {
  const doneCount = steps.filter(step => step.done).length;
  const next = steps.find(step => !step.done);
  const progress = `${doneCount} of ${steps.length} done`;
  const tone = art?.tone ?? "light";
  const artLayer = art ? <span className={styles.art} style={{ backgroundImage: `url("${art.src}")`, backgroundPosition: art.focus ?? "center" }} aria-hidden="true" /> : null;
  const dismiss = (
    <span className={styles.dismiss}>
      <Button variant="ghost" size="xs" aria-label="Dismiss" onClick={onDismiss}><X size={14} strokeWidth={2} aria-hidden="true" /></Button>
    </span>
  );

  return (
    <section data-sq="surface" className={styles.banner} data-template={template} data-tone={tone} aria-label={title}>
      {template === "cards" ? (
        <>
          <div data-sq="surface" className={styles.band}>
            {artLayer}
            <Head title={title} description={next ? description : doneTitle} dismiss={dismiss} />
          </div>
          {next ? (
            <ul className={styles.cards}>
              {steps.map(step => (
                <li key={step.id} data-sq="surface" className={styles.card} data-done={step.done ? "" : undefined}>
                  <Mark step={step} />
                  <span className={styles.stepTitle}>{step.title}</span>
                  {step.description ? <span className={styles.stepLine}>{step.description}</span> : null}
                  {step === next ? <div className={styles.cardAction}><Button size="sm">{step.action}</Button></div> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : template === "spotlight" ? (
        <>
          {artLayer}
          <div className={styles.spotlight}>
            <span className={styles.meta}>{next ? `${title} · ${progress}` : title}</span>
            <h3 className={styles.spotTitle}>{next ? next.title : doneTitle}</h3>
            {next?.description ? <p className={styles.stepLine}>{next.description}</p> : null}
            {next ? <div className={styles.spotAction}><Button variant={tone === "dark" ? "secondary" : "primary"} size="sm">{next.action}</Button></div> : null}
            <span className={styles.dots} aria-hidden="true">{steps.map(step => <span key={step.id} data-on={step.done ? "" : undefined} data-next={step === next ? "" : undefined} />)}</span>
          </div>
          {dismiss}
        </>
      ) : (
        <>
          {artLayer}
          <div data-sq={template === "panel" ? "surface" : undefined} className={styles.body}>
            <Head title={title} description={next ? `${description ? `${description} · ` : ""}${progress}` : doneTitle} dismiss={dismiss} />
            {next ? (
              <ul className={styles.rows}>
                {steps.map(step => (
                  <li key={step.id} className={styles.row} data-done={step.done ? "" : undefined} data-next={step === next ? "" : undefined}>
                    <Mark step={step} />
                    <span className={styles.stepTitle}>{step.title}</span>
                    {step === next ? <span className={styles.rowAction}><Button size="sm">{step.action}</Button></span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function Head({ title, description, dismiss }: { title: string; description?: string; dismiss: ReactNode }) {
  return (
    <div className={styles.head}>
      <div className={styles.headText}>
        <h3 className={styles.title}>{title}</h3>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {dismiss}
    </div>
  );
}

function Mark({ step }: { step: IntroBannerStep }) {
  return <span data-sq="surface" className={styles.mark} data-done={step.done ? "" : undefined} aria-hidden="true">{step.done ? <Check size={14} strokeWidth={2.25} /> : step.icon}</span>;
}

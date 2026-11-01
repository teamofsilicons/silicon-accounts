"use client";

/**
 * The Silicons page on a first visit, as stories (Anil, 2026-11-01): one idea at a time instead of everything at once.
 * Six beats (the content: redesign/decisions.md, "Silicons, first visit"), each a headline in Geist Serif, one line,
 * its own colour and, for the first five, a small animated product shot (stories/shots.tsx):
 *
 * 1. Meet Silicons: an AI agent with an identity of its own.
 * 2. It gets an id, like yours (the Carbon's own c:id beside a Silicon's si:…).
 * 3. It signs in with its own key (an STK, shown once).
 * 4. It signs in to apps by itself.
 * 5. Every Silicon has one Carbon looking after it.
 * 6. Three ways to start: make one here, start from a Starter, let one ask you.
 *
 * Segmented bars on top; each beat plays for five seconds (longer with a shot), then the next (the last one stays). Tap or click the
 * right of the card (or →) for the next beat, the left (or ←) for the one before; holding the pointer down pauses.
 * Back and Next buttons do the same for the keyboard and screen readers. With reduced motion nothing plays on its
 * own. This is the site's own component: Silicon UI's Carousel keeps neighbours in view and CardStack is for triage.
 */
import { useEffect, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { ButtonLink } from "@/components/foundation/button-link";
import { CopyChip } from "../home-identity";
import { AppsShot, CareShot, IdShot, KeyShot, MeetShot } from "./stories/shots";
import styles from "./silicons-intro.module.css";

/** Silicon Starter: the registry of ready-made Silicons (starters), genes, ISIs and functions. */
export const STARTER_URL = "https://starter.teamofsilicons.com";

/** How long one beat plays before the next. */
const BEAT_MS = 5000;

interface Beat {
  key: string;
  /** The beat's colours: one of the Silicon colour pairs, or the forest of the first-Silicon banner. */
  tone: "forest" | "1" | "2" | "3" | "4";
  headline: string;
  line: ReactNode;
  /** A small animated product shot in the card's top-right corner (stageshow; stories/shots.tsx). */
  shot?: ReactNode;
  /** How long it plays, when not BEAT_MS (a shot needs time for its payoff to hold). */
  ms?: number;
}

export function SiliconsIntro({ carbonId, onCreate }: { carbonId: string | null; onCreate: () => void }) {
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const id = carbonId ?? "c:you";
  const beats: Beat[] = [
    {
      key: "meet",
      tone: "forest",
      headline: "An AI agent with an identity of its own.",
      line: "A Silicon isn't you, and it doesn't use your logins. It signs in as itself.",
      shot: <MeetShot />,
    },
    {
      key: "id",
      tone: "1",
      headline: "It gets an id, like yours.",
      line: <>You&apos;re <span className={styles.mono}>{id}</span>; a Silicon is <span className={styles.mono}>si:something</span>. That&apos;s how people and apps find it.</>,
      shot: <IdShot />,
      ms: 5500,
    },
    {
      key: "key",
      tone: "2",
      headline: "It signs in with its own key.",
      line: "Its STK is a password made for it. You see it once; you can change it any time.",
      shot: <KeyShot />,
      ms: 6500,
    },
    {
      key: "apps",
      tone: "3",
      headline: "It signs in to apps by itself.",
      line: "Briefcase, DM and the rest see it as itself, not as you.",
      shot: <AppsShot />,
      ms: 7500,
    },
    {
      key: "you",
      tone: "4",
      headline: "Every Silicon has one Carbon looking after it.",
      line: "That's you. You can change its key, hand it to someone else, or end it.",
      shot: <CareShot />,
      ms: 6000,
    },
    {
      key: "start",
      tone: "forest",
      headline: "Three ways to start.",
      line: null,
    },
  ];
  const last = beats.length - 1;
  const beat = beats[index];
  const go = (next: number) => setIndex(Math.max(0, Math.min(last, next)));
  const playing = !reduced && !held && index < last;

  // A tap on the left third goes back; anywhere else on the card goes on. Taps on the beat's own controls don't.
  const onTap = (event: PointerEvent<HTMLDivElement>) => {
    setHeld(false);
    if ((event.target as HTMLElement).closest("a, button")) return;
    const box = event.currentTarget.getBoundingClientRect();
    go(event.clientX - box.left < box.width / 3 ? index - 1 : index + 1);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") go(index + 1);
    else if (event.key === "ArrowLeft") go(index - 1);
    else return;
    event.preventDefault();
  };

  return (
    <section className={styles.stories} aria-labelledby="silicon-story-title" aria-roledescription="stories">
      <div
        data-sq="clip"
        className={styles.card}
        data-tone={beat.tone}
        tabIndex={0}
        aria-label={`Beat ${index + 1} of ${beats.length}. Arrow keys move between beats.`}
        onKeyDown={onKey}
        onPointerDown={() => setHeld(true)}
        onPointerUp={onTap}
        onPointerLeave={() => setHeld(false)}
        onPointerCancel={() => setHeld(false)}
      >
        <div className={styles.bars} aria-hidden="true">
          {beats.map((item, at) => (
            <span key={item.key} className={styles.bar}>
              <span
                key={at === index ? `${item.key}-${index}` : item.key}
                className={styles.fill}
                data-state={at < index || (at === index && index === last) ? "done" : at === index ? "now" : "next"}
                style={{ "--beat": `${item.ms ?? BEAT_MS}ms`, animationPlayState: playing ? "running" : "paused" } as CSSProperties}
                onAnimationEnd={at === index ? () => go(index + 1) : undefined}
              />
            </span>
          ))}
        </div>

        {beat.shot ? <div key={`${beat.key}-shot`} className={styles.shot} aria-hidden="true">{beat.shot}</div> : null}

        <div key={beat.key} className={styles.beat}>
          <h2 id="silicon-story-title" className={styles.headline}>{beat.headline}</h2>
          {beat.line ? <p className={styles.line}>{beat.line}</p> : null}
          {beat.key === "start" ? (
            <ul className={styles.ways}>
              <li className={styles.way}>
                <span className={styles.wayWords}>
                  <span className={styles.wayTitle}>Make one here</span>
                  <span className={styles.wayLine}>Give it a name and an id; its key is shown to you once.</span>
                </span>
                <Button data-create-silicon="" variant="secondary" size="sm" onClick={onCreate}>Create a Silicon</Button>
              </li>
              <li className={styles.way}>
                <span className={styles.wayWords}>
                  <span className={styles.wayTitle}>Start from a Starter</span>
                  <span className={styles.wayLine}>Pick a ready-made Silicon on Silicon Starter and run it with Silicon.</span>
                </span>
                <ButtonLink href={STARTER_URL} external variant="secondary" size="sm">Browse Starters</ButtonLink>
              </li>
              <li className={styles.way}>
                <span className={styles.wayWords}>
                  <span className={styles.wayTitle}>Let one ask you</span>
                  <span className={styles.wayLine}>A Silicon can make its own account and name you; its request shows up here.</span>
                </span>
                {carbonId ? <CopyChip value={carbonId} what="your id" /> : null}
              </li>
            </ul>
          ) : null}
        </div>

        <div className={styles.controls}>
          <Button variant="soft" size="xs" className={styles.control} aria-label="Previous" disabled={index === 0} onClick={() => go(index - 1)}>
            <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          </Button>
          {index === last ? (
            <Button variant="soft" size="xs" className={styles.control} aria-label="Watch again" onClick={() => go(0)}>
              <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          ) : (
            <Button variant="soft" size="xs" className={styles.control} aria-label="Next" onClick={() => go(index + 1)}>
              <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

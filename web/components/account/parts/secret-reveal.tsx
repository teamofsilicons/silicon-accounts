"use client";

/**
 * A secret shown exactly once (a Silicon's STK, a webhook signing secret). The characters decode into place, the value
 * can be copied or hidden while someone looks over your shoulder, and the card stays until "I've stored it". Silicon
 * Accounts keeps only a hash (STK) or an encrypted copy the page can never read again, so closing this card is final.
 * The card reads the values from the reveal store by its id (parts/reveals.ts), so only the card itself ever holds them.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { SlotText } from "@/components/arc/slot-text/slot-text";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import { bringIntoView } from "./focus";
import { revealValue, type SecretSlot } from "./reveals";
import styles from "./parts.module.css";

export interface SecretRevealProps {
  /** The reveal in the store (parts/reveals.ts) whose values this card shows. */
  revealId: string;
  title: string;
  description: ReactNode;
  secrets: SecretSlot[];
  onDone: () => void;
  doneLabel?: string;
  /** Moves focus to the card's heading when it appears, so it is announced and the keyboard lands on it. */
  focusOnMount?: boolean;
  className?: string;
}

const mask = (value: string) => value.replace(/[^-_]/g, "•");

function SecretValue({ secret: slot, value }: { secret: SecretSlot; value: string }) {
  const secret = { ...slot, value };
  const reduced = useReducedMotion() ?? false;
  const [hidden, setHidden] = useState(false);
  // The reels decode the value once (from the mask, on the next frame); then plain text takes over, so a long secret
  // can wrap on a narrow screen.
  const [decoded, setDecoded] = useState(false);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDecoded(true));
    const timer = window.setTimeout(() => setSettled(true), reduced ? 0 : 1500);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [reduced]);
  const shown = hidden || (!decoded && !reduced) ? mask(secret.value) : secret.value;
  return (
    <div className={styles.secret}>
      <span className={styles.secretLabel}>{secret.label}</span>
      <div data-sq="surface" className={styles.secretWell}>
        <span className={styles.secretText}>
          <span className="sr-only">{hidden ? `${secret.label} hidden` : secret.value}</span>
          <span aria-hidden="true">
            {settled || reduced ? <span className={styles.secretPlain}>{shown}</span> : <SlotText value={shown} duration={0.55} stagger={0.016} spins={1} align="start" />}
          </span>
        </span>
        <span className={styles.secretActions}>
          <button data-sq="surface" type="button" className={styles.iconButton} onClick={() => setHidden(value => !value)} aria-label={hidden ? `Show the ${secret.label}` : `Hide the ${secret.label}`} aria-pressed={hidden}>
            {hidden ? <Eye size={16} strokeWidth={1.75} aria-hidden="true" /> : <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          <CopyButton value={secret.value} label={`Copy the ${secret.label}`} iconOnly variant="plain" />
        </span>
      </div>
      {secret.note ? <span className={styles.secretNote}>{secret.note}</span> : null}
      {secret.command ? (
        <span className={styles.command}>
          <code className={styles.commandText}>{secret.command}</code>
          <CopyButton value={secret.command} label="Copy the command" iconOnly variant="plain" />
        </span>
      ) : null}
    </div>
  );
}

export function SecretReveal({ revealId, title, description, secrets, onDone, doneLabel = "I've stored it", focusOnMount, className }: SecretRevealProps) {
  const reduced = useReducedMotion() ?? false;
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const node = card.current;
    if (!focusOnMount || !node) return;
    heading.current?.focus({ preventScroll: true });
    // Scroll only the card's own scroller (a drawer's body, or the page): a plain focus() would also scroll the drawer
    // panel, which clips its overflow, and push its header out of sight.
    bringIntoView(node, "start");
  }, [focusOnMount]);
  return (
    <motion.section
      ref={card}
      data-sq="surface"
      className={[styles.reveal, className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      role="region"
      data-reveal=""
      initial={reduced ? false : { opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard } }}
    >
      <div className={styles.revealHead}>
        <span className={styles.revealIcon} aria-hidden="true"><KeyRound size={20} strokeWidth={1.75} /></span>
        <div className={styles.revealText}>
          <h2 ref={heading} id={titleId} className={styles.revealTitle} tabIndex={-1}>{title}</h2>
          <p className={styles.revealDescription}>{description}</p>
        </div>
      </div>
      <div className={styles.secrets}>
        {secrets.map((secret, index) => <SecretValue key={secret.label} secret={secret} value={revealValue(revealId, index) ?? ""} />)}
      </div>
      <div className={styles.revealFoot}>
        <span className={styles.revealWarning}>Shown only this once. Silicon Accounts cannot show it again.</span>
        <Button onClick={onDone}>{doneLabel}</Button>
      </div>
    </motion.section>
  );
}

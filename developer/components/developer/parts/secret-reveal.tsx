"use client";

/**
 * A secret shown exactly once (a webhook signing secret, a proof token): masked until revealed, copyable, and gone once
 * the reader confirms they stored it. Silicon Accounts keeps only a hash or an encrypted copy and never shows it again.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { Button } from "@/components/silicon-ui/button/button";
import { CopyButton } from "@/components/silicon-ui/copy-button/copy-button";
import { motionTokens } from "@/components/silicon-ui/lib/motion-tokens";
import styles from "./parts.module.css";

export interface SecretItem {
  label: string;
  value: string;
  /** One line under the value (expiry, where it goes). */
  note?: ReactNode;
}

export interface SecretRevealProps {
  title: string;
  description: ReactNode;
  secrets: SecretItem[];
  onDone: () => void;
  doneLabel?: string;
  children?: ReactNode;
}

/** `whsec_` plus dots: the prefix says what it is, the rest stays hidden. */
function mask(value: string): string {
  const prefix = /^[a-z_]+?_/.exec(value)?.[0] ?? "";
  return `${prefix}${"•".repeat(Math.min(28, Math.max(12, value.length - prefix.length)))}`;
}

export function SecretReveal({ title, description, secrets, onDone, doneLabel = "I've stored it", children }: SecretRevealProps) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<Record<number, boolean>>({});
  const card = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  // Shown once, so it takes focus when it appears (a screen reader announces it) and gives focus back when it goes.
  useEffect(() => {
    opener.current = document.activeElement;
    const node = card.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, []);
  const done = () => {
    const back = opener.current;
    onDone();
    requestAnimationFrame(() => {
      if (back instanceof HTMLElement && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
    });
  };
  return (
    <motion.div
      ref={card}
      tabIndex={-1}
      data-sq="surface"
      className={styles.secretCard}
      role="group"
      aria-label={title}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={reduced ? { duration: motionTokens.duration.instant } : { y: motionTokens.spring.smooth, scale: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] } }}
    >
      <div className={styles.secretHead}>
        <span className={styles.secretIcon} aria-hidden="true"><KeyRound size={18} strokeWidth={1.75} /></span>
        <div className={styles.secretText}>
          <strong>{title}</strong>
          <p>{description}</p>
        </div>
      </div>
      {secrets.map((secret, index) => {
        const visible = !!shown[index];
        return (
          <div key={secret.label} className={styles.secretRow}>
            <span className={styles.secretLabel}>{secret.label}</span>
            <div data-sq="surface" className={styles.secretShell}>
              <code className={styles.secretValue} data-shown={visible || undefined} tabIndex={0} aria-label={visible ? `${secret.label}: ${secret.value}` : `${secret.label}, hidden`}>{visible ? secret.value : mask(secret.value)}</code>
              <button
                type="button"
                data-sq="surface"
                className={styles.secretToggle}
                aria-pressed={visible}
                aria-label={visible ? `Hide the ${secret.label.toLowerCase()}` : `Show the ${secret.label.toLowerCase()}`}
                onClick={() => setShown(current => ({ ...current, [index]: !current[index] }))}
              >
                {visible ? <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.75} aria-hidden="true" />}
              </button>
              <CopyButton value={secret.value} label="Copy" />
            </div>
            {secret.note ? <span className={styles.secretNote}>{secret.note}</span> : null}
          </div>
        );
      })}
      {children ? <div className={styles.secretExtra}>{children}</div> : null}
      <div className={styles.secretFooter}>
        <span className={styles.secretWarning}>This is the only time {secrets.length === 1 ? "it is" : "they are"} shown.</span>
        <Button variant="secondary" size="sm" onClick={done}>{doneLabel}</Button>
      </div>
    </motion.div>
  );
}

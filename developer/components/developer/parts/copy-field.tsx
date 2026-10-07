"use client";

/** A value to copy somewhere else: a callback URL, an app id, a URL to paste into a provider's console. */
import type { ReactNode } from "react";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import styles from "./parts.module.css";

export interface CopyFieldProps {
  label: string;
  value: string;
  description?: ReactNode;
  copyLabel?: string;
  className?: string;
}

export function CopyField({ label, value, description, copyLabel = "Copy", className }: CopyFieldProps) {
  return (
    <div className={[styles.copyField, className].filter(Boolean).join(" ")}>
      <span className={styles.copyLabel}>{label}</span>
      <div data-sq="surface" className={styles.copyShell}>
        <code className={styles.copyValue} tabIndex={0} aria-label={`${label}: ${value}`}>{value}</code>
        <CopyButton value={value} label={copyLabel} />
      </div>
      {description ? <span className={styles.copyDescription}>{description}</span> : null}
    </div>
  );
}

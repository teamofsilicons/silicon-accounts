"use client";

/**
 * The c:id field of the sign-up page: Arc's input look with the "c:" prefix outside the editable text (it is not
 * part of the handle) and a live status mark (checking, free, taken), the hint or error under it, and free ids to
 * pick when the one typed is taken.
 */
import { useId, type ReactNode } from "react";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import type { IdStatus } from "./id-check";
import { FieldNote } from "./parts";
import styles from "./flow.module.css";

export interface IdFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  status: IdStatus;
  description?: string | null;
  error?: string | null;
  /** Free handles (without c:) to offer. */
  suggestions?: string[];
  onPick?: (handle: string) => void;
}

function statusMark(status: IdStatus): ReactNode {
  switch (status) {
    case "checking":
      return <LoaderCircle className={styles.spin} size={16} strokeWidth={1.75} aria-hidden="true" />;
    case "available":
    case "own":
      return <Check className={styles.ok} size={16} strokeWidth={2} aria-hidden="true" />;
    case "unavailable":
    case "invalid":
      return <CircleAlert className={styles.bad} size={16} strokeWidth={1.75} aria-hidden="true" />;
    default:
      return null;
  }
}

export function IdField({ label, value, onChange, status, description, error, suggestions = [], onPick }: IdFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const mark = statusMark(status);
  return (
    <div className={styles.idField}>
      <label className={styles.fieldLabel} htmlFor={id}>{label}</label>
      <div className={styles.idControl} data-sq="surface" data-invalid={error ? "" : undefined}>
        <span className={styles.idPrefix} aria-hidden="true">c:</span>
        <input
          id={id}
          className={styles.idInput}
          value={value}
          autoCapitalize="off"
          autoComplete="username"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || description ? noteId : undefined}
          onChange={event => onChange(event.currentTarget.value)}
        />
        <span className={styles.idStatus}>{mark}</span>
      </div>
      <FieldNote id={noteId} text={error ?? description} tone={error ? "error" : "hint"} alert={!!error} />
      {suggestions.length && onPick ? (
        <div className={styles.suggestions} role="group" aria-label="Free ids">
          <span className={styles.muted}>Free:</span>
          {suggestions.map(suggestion => (
            <button key={suggestion} type="button" data-sq="surface" className={styles.suggestion} onClick={() => onPick(suggestion)}>
              c:{suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

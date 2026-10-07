"use client";

/**
 * A labelled slider: a native range input (arrow keys, Page Up/Down, Home/End, and assistive tech for free) in Arc's
 * control tokens. The track fills with --control-on up to the thumb; the value reads in tabular numerals.
 */
import { useId, type CSSProperties } from "react";
import styles from "./parts.module.css";

export interface RangeFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** The shown value, for example "24 px". */
  format?: (value: number) => string;
  description?: string;
  error?: string;
  disabled?: boolean;
  className?: string;
}

export function RangeField({ label, value, min, max, step = 1, onChange, format, description, error, disabled, className }: RangeFieldProps) {
  const id = useId();
  const text = format ? format(value) : String(value);
  const fill = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  return (
    <div className={[styles.slider, className].filter(Boolean).join(" ")}>
      <div className={styles.sliderHead}>
        <label className={styles.sliderLabel} htmlFor={id}>{label}</label>
        <output className={styles.sliderValue} htmlFor={id}>{text}</output>
      </div>
      <input
        id={id}
        type="range"
        className={styles.range}
        style={{ "--fill": `${fill}%` } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={text}
        aria-describedby={description || error ? `${id}-note` : undefined}
        aria-invalid={error ? true : undefined}
        onChange={event => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next) && next !== value) onChange(next);
        }}
      />
      {error ? <p id={`${id}-note`} className={styles.fieldError} role="alert">{error}</p> : description ? <p id={`${id}-note`} className={styles.sliderDescription}>{description}</p> : null}
    </div>
  );
}

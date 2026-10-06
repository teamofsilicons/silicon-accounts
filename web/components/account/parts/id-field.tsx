"use client";

/**
 * Choosing a c:id or si:id: the field checks the handle as it is typed (the rules first, then GET /v1/ids/available
 * once typing pauses), says exactly why an id is not free, offers the free ids the server suggests, and recognises an
 * id that is still reserved for this account (it can be taken back within 10 days of a change). A custodian checking
 * one of its Silicons' ids passes the Silicon's uuid (`for`), so the Silicon's own reservation counts as its own.
 *
 *   const check = useIdCheck("c:", handle, me.id);
 *   <IdField prefix="c:" value={handle} onValueChange={setHandle} check={check} />
 */
import { useEffect, useId, useState, type CSSProperties, type Ref } from "react";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { Input } from "@/components/arc/input/input";
import { describeError, readableTimes } from "./common";
import { useIdCheckQuery } from "./queries";
import styles from "./parts.module.css";

export type IdPrefix = "c:" | "si:";

export type IdCheck =
  | { status: "empty" }
  | { status: "invalid"; message: string }
  | { status: "current"; message: string }
  | { status: "checking" }
  | { status: "available"; id: string; message: string; reclaimable: boolean }
  | { status: "unavailable"; id: string; reason: string; message: string; suggestions: string[] }
  | { status: "error"; message: string };

const OTHER: Record<IdPrefix, { prefix: IdPrefix; noun: string; own: string }> = {
  "c:": { prefix: "si:", noun: "Silicons", own: "Carbons" },
  "si:": { prefix: "c:", noun: "Carbons", own: "Silicons" },
};

/**
 * Normalizes what was typed: lowercase (ids are case-insensitive), and a typed or pasted prefix of the right kind is
 * dropped. Spaces stay, so the rules can say exactly what is wrong instead of silently eating characters.
 */
export function normalizeHandle(raw: string, prefix: IdPrefix): string {
  const value = raw.toLowerCase();
  const lead = value.trimStart();
  return lead.startsWith(prefix) ? lead.slice(prefix.length) : value;
}

/** The rule a handle breaks (3 to 30 of a-z, 0-9, - and _), said precisely; null when it follows them. */
export function handleProblem(handle: string, prefix: IdPrefix): string | null {
  const other = OTHER[prefix];
  if (handle.startsWith(other.prefix)) return `${other.prefix} ids belong to ${other.noun}. ${other.own}' ids start with ${prefix}, so type only the part after it.`;
  const bad = Array.from(handle).find(char => !/[a-z0-9_-]/.test(char));
  if (bad !== undefined) {
    const shown = bad === " " ? "a space" : `“${bad}”`;
    return `An id can use only a to z, 0 to 9, - and _; ${shown} is not allowed.`;
  }
  if (handle.length < 3) return `An id needs at least 3 characters after ${prefix} (this one has ${handle.length}).`;
  if (handle.length > 30) return `An id can have at most 30 characters after ${prefix} (this one has ${handle.length}).`;
  return null;
}

function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Checks `prefix + handle` as it changes: local rules at once, then the server once typing pauses (320 ms; answers
 * are cached per id). `current` is the id the account has now, reported as such instead of "taken". `forUuid` is the
 * Silicon whose id a custodian is changing.
 */
export function useIdCheck(prefix: IdPrefix, handle: string, current: string | null | undefined, forUuid?: string | null): IdCheck {
  const value = handle.toLowerCase();
  const full = `${prefix}${value}`;
  const blank = !value.trim();
  const problem = blank ? null : handleProblem(value, prefix);
  const isCurrent = !!current && full === current.toLowerCase();
  const wanted = !blank && !problem && !isCurrent ? full : null;
  const settled = useDebouncedValue(wanted, 320);
  const query = useIdCheckQuery(wanted && settled === wanted ? wanted : null, forUuid);
  if (blank) return { status: "empty" };
  if (problem) return { status: "invalid", message: problem };
  if (isCurrent) return { status: "current", message: `${full} is the id now. Type the new one.` };
  if (settled !== wanted) return { status: "checking" };
  if (query.error) return { status: "error", message: `Could not check ${full}: ${describeError(query.error)}` };
  const result = query.data;
  if (!result) return { status: "checking" };
  const message = readableTimes(result.message || "");
  if (result.available) return { status: "available", id: full, message: message || `${full} is free.`, reclaimable: !!result.reclaimable };
  return {
    status: "unavailable",
    id: full,
    reason: result.reason ?? "taken",
    message: message || `${full} is not available.`,
    suggestions: (result.suggestions ?? []).filter(item => typeof item === "string").slice(0, 3),
  };
}

export interface IdFieldProps {
  prefix: IdPrefix;
  /** The handle without its prefix. */
  value: string;
  onValueChange: (handle: string) => void;
  check: IdCheck;
  label?: string;
  description?: string;
  /** A failure from submitting (overrides the live status). */
  error?: string | null;
  /** Free ids to offer (the live check's, or a 409's `details.suggestions`). */
  suggestions?: string[];
  autoFocus?: boolean;
  disabled?: boolean;
  /** While a change is being saved: the field keeps focus but takes no input. */
  readOnly?: boolean;
  /** Shown for an id still reserved for this account. */
  reclaimText?: (id: string) => string;
  inputRef?: Ref<HTMLInputElement>;
}

/** The id input with its live status line and suggestions. */
export function IdField({ prefix, value, onValueChange, check, label = "New id", description, error, suggestions: given, autoFocus, disabled, readOnly, reclaimText, inputRef }: IdFieldProps) {
  const tone = error ? "danger"
    : check.status === "available" ? "success"
      : check.status === "unavailable" || check.status === "invalid" || check.status === "error" ? "danger"
        : "neutral";
  const status = (() => {
    if (error) return error;
    switch (check.status) {
      case "invalid":
      case "current":
      case "unavailable":
      case "error":
        return check.message;
      case "available":
        return check.reclaimable ? (reclaimText?.(check.id) ?? `${check.id} was yours and is still reserved for you, so you can take it back.`) : check.message;
      case "checking":
        return "Checking…";
      default:
        return "";
    }
  })();
  const suggestions = given?.length ? given : check.status === "unavailable" ? check.suggestions : [];
  const pick = (id: string) => onValueChange(normalizeHandle(id, prefix));
  const uid = useId();
  const statusId = `${uid}-status`;
  const descriptionId = `${uid}-description`;
  return (
    <div className={styles.idField}>
      <div className={styles.idControl} style={{ "--prefix-width": `${prefix.length}ch` } as CSSProperties}>
        <Input
          ref={inputRef}
          label={label}
          value={value}
          onChange={event => onValueChange(normalizeHandle(event.target.value, prefix))}
          className={styles.idInput}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          disabled={disabled}
          readOnly={readOnly}
          autoFocus={autoFocus}
          aria-invalid={tone === "danger" ? true : undefined}
          aria-describedby={[description ? descriptionId : null, statusId].filter(Boolean).join(" ")}
        />
        <span className={styles.idPrefix} aria-hidden="true">{prefix}</span>
        <span className={styles.idSuffix} data-tone={tone} aria-hidden="true">
          {check.status === "checking" && !error ? <LoaderCircle className={styles.spin} size={16} strokeWidth={1.75} />
            : tone === "success" ? <Check size={16} strokeWidth={2} />
              : tone === "danger" ? <CircleAlert size={16} strokeWidth={1.75} /> : null}
        </span>
      </div>
      {description ? <p id={descriptionId} className={styles.idDescription}>{description}</p> : null}
      <p id={statusId} className={styles.idStatus} data-tone={tone} role="status" aria-live="polite">{status}</p>
      {suggestions.length ? (
        <div className={styles.suggestions}>
          <span className={styles.suggestionsLabel}>Free ids close to it</span>
          <div className={styles.suggestionList}>
            {suggestions.map(id => <button key={id} data-sq="surface" type="button" className={styles.suggestion} onClick={() => pick(id)}>{id}</button>)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

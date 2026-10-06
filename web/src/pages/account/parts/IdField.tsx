/**
 * Choosing a c:id or si:id: the field checks the handle as it is typed (rules first, then GET /v1/ids/available),
 * says exactly why an id is not free, offers the free ids the server suggests, and recognises an id that is still
 * reserved for this account (it can be taken back within 10 days of a change).
 *
 *   const check = createIdCheck(() => "c:", handle, () => me.id);
 *   <IdField prefix="c:" value={handle()} onValueChange={setHandle} check={check()} />
 */
import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import { Check, CircleAlert, LoaderCircle } from "lucide-solid";
import { ApiError, request, type IdAvailability } from "../../../api";
import { Input } from "../../../arc/input/input";
import { useSquircle } from "../../../arc/lib/squircle";
import { describeError, readableTimes } from "./common";
import styles from "./parts.module.css";

export type IdPrefix = "c:" | "si:";

export type IdCheck =
  | { status: "empty" }
  | { status: "invalid"; message: string }
  | { status: "current"; message: string }
  | { status: "checking" }
  /** `until`: when the reservation on a reclaimable id ends (RFC 3339), if the service said. */
  | { status: "available"; id: string; message: string; reclaimable: boolean; until?: string | null }
  /** `until`: when the reservation on a "reserved" id ends (RFC 3339), if the service said. */
  | { status: "unavailable"; id: string; reason: string; message: string; suggestions: string[]; until?: string | null }
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

/** The end of a reservation named in a message from the service, if it names one. */
export function reservedUntil(message: string): string | null {
  const found = /until (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(message);
  return found?.[1] ?? null;
}

export interface IdCheckOptions {
  /**
   * The uuid of the account whose id is being changed when it is not the signed-in one (a custodian changing a
   * Silicon's id). Sent as `for`, so a service that supports it can answer `reclaimable: true` for that account's own
   * reservation; one that does not ignores the parameter.
   */
  forUuid?: Accessor<string | undefined>;
}

/**
 * Checks `prefix + handle` as it changes: local rules at once, then the server after a short pause (the previous
 * request is cancelled). `current` is the id the account has now, which is reported as such instead of "taken".
 */
export function createIdCheck(prefix: Accessor<IdPrefix>, handle: Accessor<string>, current: Accessor<string | null | undefined>, options: IdCheckOptions = {}): Accessor<IdCheck> {
  const [check, setCheck] = createSignal<IdCheck>({ status: "empty" });
  let timer = 0;
  let controller: AbortController | undefined;
  const stop = () => {
    window.clearTimeout(timer);
    controller?.abort();
    controller = undefined;
  };
  const subject = () => options.forUuid?.();
  createEffect(on([prefix, handle, current, subject], ([p, raw, now, forUuid]) => {
    stop();
    const value = raw.toLowerCase();
    if (!value.trim()) return setCheck({ status: "empty" });
    const problem = handleProblem(value, p);
    if (problem) return setCheck({ status: "invalid", message: problem });
    const full = `${p}${value}`;
    if (now && full === now.toLowerCase()) return setCheck({ status: "current", message: `${full} is the id now. Type the new one.` });
    setCheck({ status: "checking" });
    timer = window.setTimeout(() => {
      const ctl = new AbortController();
      controller = ctl;
      request<IdAvailability & { suggestions?: string[] }>("/v1/ids/available", { query: { id: full, for: forUuid }, signal: ctl.signal })
        .then(result => {
          if (ctl.signal.aborted) return;
          const message = result.message || "";
          const until = reservedUntil(message);
          if (result.available) setCheck({ status: "available", id: full, message: readableTimes(message || `${full} is free.`), reclaimable: !!result.reclaimable, until });
          else setCheck({ status: "unavailable", id: full, reason: result.reason ?? "taken", message: readableTimes(message || `${full} is not available.`), suggestions: (result.suggestions ?? []).filter(item => typeof item === "string").slice(0, 3), until });
        })
        .catch(error => {
          if (ctl.signal.aborted || ApiError.is(error, "aborted")) return;
          setCheck({ status: "error", message: `Could not check ${full}: ${describeError(error)}` });
        });
    }, 320);
  }));
  onCleanup(stop);
  return check;
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
  autofocus?: boolean;
  disabled?: boolean;
  /** Shown for an id still reserved for this account. */
  reclaimText?: (id: string) => string;
  /** Replaces the live status line (and its tone) while set, unless a submit failure (`error`) is showing. */
  notice?: { tone: "neutral" | "success" | "danger"; text: string } | null;
  inputRef?: (el: HTMLInputElement) => void;
}

/** The id input with its live status line and suggestions. */
export function IdField(props: IdFieldProps) {
  const statusTone = () => {
    if (props.error) return "danger";
    if (props.notice) return props.notice.tone;
    const check = props.check;
    if (check.status === "available") return "success";
    if (check.status === "unavailable" || check.status === "invalid" || check.status === "error") return "danger";
    return "neutral";
  };
  const statusText = () => {
    if (props.error) return props.error;
    if (props.notice) return props.notice.text;
    const check = props.check;
    switch (check.status) {
      case "invalid":
      case "current":
      case "unavailable":
      case "error":
        return check.message;
      case "available":
        return check.reclaimable ? (props.reclaimText?.(check.id) ?? `${check.id} was yours and is still reserved for you, so you can take it back.`) : check.message;
      case "checking":
        return "Checking…";
      default:
        return "";
    }
  };
  const suggestions = () => {
    if (props.suggestions?.length) return props.suggestions;
    return props.check.status === "unavailable" ? props.check.suggestions : [];
  };
  const pick = (id: string) => props.onValueChange(normalizeHandle(id, props.prefix));
  return (
    <div class={styles.idField}>
      <Input
        label={props.label ?? "New id"}
        description={props.description}
        value={props.value}
        ref={el => props.inputRef?.(el)}
        onInput={event => {
          const next = normalizeHandle(event.currentTarget.value, props.prefix);
          if (next !== event.currentTarget.value) event.currentTarget.value = next;
          props.onValueChange(next);
        }}
        prefix={<span class={styles.idPrefix} aria-hidden="true">{props.prefix}</span>}
        suffix={
          <span class={styles.idSuffix} data-tone={statusTone()} aria-hidden="true">
            <Switch>
              <Match when={props.check.status === "checking" && !props.error}><LoaderCircle class={styles.spin} size={16} stroke-width={1.75} /></Match>
              <Match when={statusTone() === "success"}><Check size={16} stroke-width={2} /></Match>
              <Match when={statusTone() === "danger"}><CircleAlert size={16} stroke-width={1.75} /></Match>
            </Switch>
          </span>
        }
        mono
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        maxLength={64}
        disabled={props.disabled}
        autofocus={props.autofocus}
        aria-invalid={statusTone() === "danger" ? true : undefined}
      />
      <p class={styles.idStatus} data-tone={statusTone()} role="status" aria-live="polite">{statusText()}</p>
      <Show when={suggestions().length}>
        <div class={styles.suggestions}>
          <span class={styles.suggestionsLabel}>Free ids close to it</span>
          <div class={styles.suggestionList}>
            <For each={suggestions()}>
              {id => <button ref={el => useSquircle(el)} type="button" class={styles.suggestion} onClick={() => pick(id)}>{id}</button>}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

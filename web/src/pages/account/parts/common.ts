/**
 * Small helpers shared by the account pages: a ticking clock, a signal-based loader (no Suspense, so a reload never
 * blanks a page), the signed-in account's Me view without Suspense, labels for the many shapes a person can take in an
 * API answer, photo checks, and error text for components that show a rejection's message.
 */
import { batch, createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { ApiError, type CarbonMe, type Me, type SiliconMe } from "../../../api";
import { notifyError } from "../../../app/notify";
import { me as meResource } from "../../../app/session";
import { formatDate } from "../../../lib/format";

/** A clock that ticks every `ms` while the calling component lives (relative times, countdowns, expiry rings). */
export function createNow(ms = 1000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    onCleanup(() => window.clearInterval(timer));
  });
  return now;
}

export interface Loader<T> {
  data: Accessor<T | undefined>;
  /** True while the first load runs (reloads keep the old data on screen). */
  loading: Accessor<boolean>;
  error: Accessor<ApiError | undefined>;
  reload: () => Promise<void>;
  /** Replaces the data (an optimistic edit, or a fresh value a mutation returned). */
  set: (next: T | ((previous: T | undefined) => T)) => void;
}

/**
 * Loads on creation (unless `immediate` is false) and on `reload()`. Failures land in `error()` as ApiError; earlier
 * data stays on screen.
 */
export function createLoader<T>(fetcher: () => Promise<T>, options: { immediate?: boolean } = {}): Loader<T> {
  const [data, setData] = createSignal<T>();
  const [loading, setLoading] = createSignal(options.immediate !== false);
  const [error, setError] = createSignal<ApiError>();
  let generation = 0;
  const reload = async () => {
    const token = ++generation;
    setError(undefined);
    if (data() === undefined) setLoading(true);
    try {
      const value = await fetcher();
      if (token !== generation) return;
      batch(() => {
        setData(() => value);
        setLoading(false);
      });
    } catch (raw) {
      if (token !== generation) return;
      batch(() => {
        setError(ApiError.from(raw));
        setLoading(false);
      });
    }
  };
  if (options.immediate !== false) void reload();
  return {
    data,
    loading: () => loading() && data() === undefined,
    error,
    reload,
    set: next => setData(previous => (typeof next === "function" ? (next as (p: T | undefined) => T)(previous) : next)),
  };
}

/**
 * The signed-in account's Me view without suspending: undefined until the first answer, then the latest value (a
 * refresh keeps the old one on screen). Use `meError()` to show a load failure.
 */
export function currentMe(): Me | undefined {
  const state = meResource.state;
  return state === "ready" || state === "refreshing" ? meResource.latest : undefined;
}

export function meError(): ApiError | undefined {
  return meResource.state === "errored" ? ApiError.from(meResource.error) : undefined;
}

export const asCarbon = (value: Me | undefined): CarbonMe | undefined => (value?.kind === "carbon" ? value : undefined);
export const asSilicon = (value: Me | undefined): SiliconMe | undefined => (value?.kind === "silicon" ? value : undefined);

/**
 * Who a transfer or request names. The API sends an AccountSummary, `{email}` when a Carbon was named by email,
 * `{uuid}` for an account it could not load, or (older shapes) a plain string.
 */
export function personLabel(value: unknown, fallback = "another Carbon"): string {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && record.id) return record.id;
    if (typeof record.email === "string" && record.email) return record.email;
    if (typeof record.display_name === "string" && record.display_name) return record.display_name;
    if (typeof record.uuid === "string" && record.uuid) return `the account ${record.uuid}`;
  }
  return fallback;
}

/** An Error whose message is the API's message and hint, for components that print a rejection's reason. */
export function reasonError(error: unknown): Error {
  const failure = ApiError.from(error);
  return new Error([failure.message, failure.hint].filter(Boolean).join(" "));
}

/**
 * Reports a failed action: a toast with the server's message and hint (titled with what did not happen), and the same
 * words back for an inline message next to the control that failed.
 */
export function reportFailure(error: unknown, title: string): string {
  notifyError(error, title);
  return describeError(error);
}

/** The message and hint of a failure as one line (inline alerts and field errors). */
export function describeError(error: unknown): string {
  const failure = ApiError.from(error);
  const wait = failure.retryAfter && !failure.hint ? ` Try again in ${failure.retryAfter} s.` : "";
  return [failure.message, failure.hint].filter(Boolean).join(" ") + wait;
}

const TIMESTAMP = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/g;

/**
 * The service writes times into some sentences as RFC 3339 ("reserved … until 2026-10-16T11:01:06.201Z", "renewable
 * until 2029-03-24T13:58:09.982Z"); people read dates.
 */
export function readableTimes(message: string): string {
  return message.replace(TIMESTAMP, value => formatDate(value));
}

/* ------------------------------------------------- photos ------------------------------------------------- */

/** What POST /v1/me/photo accepts. */
export const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const PHOTO_ACCEPT = PHOTO_TYPES.join(",");
/** 2 MB, the API's limit (2 097 152 bytes). */
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Why a file cannot be a profile photo, before uploading it; null when it can. */
export function photoProblem(file: File): string | null {
  const type = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (!(PHOTO_TYPES as readonly string[]).includes(type)) {
    return `${file.name || "That file"} is ${file.type ? `a ${file.type} file` : "not an image we can read"}. Choose a PNG, JPEG, WebP or GIF image.`;
  }
  if (file.size === 0) return `${file.name || "That file"} is empty. Choose another image.`;
  if (file.size > PHOTO_MAX_BYTES) return `${file.name || "That image"} is ${sizeText(file.size)}; a profile photo can be at most 2 MB. Choose a smaller image or resize it first.`;
  return null;
}

/** True for the default photo Silicon Accounts gives every account (Iris), which cannot be removed. */
export function isDefaultPhoto(url: string | null | undefined): boolean {
  return !url || /\/pfp\/(carbon|silicon)(\?|$)/.test(url);
}

/* -------------------------------------------------- dates -------------------------------------------------- */

/** Milliseconds until a timestamp (negative once passed). */
export function msUntil(value: string | null | undefined, now: number): number {
  if (!value) return Number.NaN;
  const at = Date.parse(value);
  return Number.isNaN(at) ? Number.NaN : at - now;
}

/** "13 days", "5 hours", "12 minutes", "40 seconds" for a duration in milliseconds. */
export function spanText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const units: Array<[string, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1]];
  for (const [unit, size] of units) {
    if (seconds >= size || unit === "second") {
      const value = Math.floor(seconds / size);
      return `${value} ${unit}${value === 1 ? "" : "s"}`;
    }
  }
  return "0 seconds";
}

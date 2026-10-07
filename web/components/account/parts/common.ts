"use client";

/**
 * Small helpers shared by the account pages: error text in the server's words, readable times inside the service's
 * sentences, photo checks, durations, the names accounts take in API answers, the Carbon/Silicon views of Me, and a
 * ticking clock for relative times, countdowns and expiry rings.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api/errors";
import type { AppSummary, CarbonMe, Me, SiliconMe } from "@/lib/api/types";
import { durationText, readableTimes } from "@/lib/format";
import { notifyError } from "@/lib/notify";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Errors                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The message and hint of a failure as one line (inline alerts and field errors). */
export function describeError(error: unknown): string {
  const failure = ApiError.from(error);
  const wait = failure.retryAfter && !failure.hint ? ` Try again in ${durationText(failure.retryAfter)}.` : "";
  return readableTimes([failure.message, failure.hint].filter(Boolean).join(" ") + wait);
}

/**
 * Reports a failed action: a toast with the server's message and hint (titled with what did not happen), and the same
 * words back for an inline message next to the control that failed.
 */
export function reportFailure(error: unknown, title: string): string {
  notifyError(error, title);
  return describeError(error);
}

/** An Error whose message is the API's message and hint, for components that print a rejection's reason. */
export function reasonError(error: unknown): Error {
  return new Error(describeError(error));
}

// Readable times in the service's sentences and waits in words live in lib/format.ts (the shared toasts use them too).
export { durationText, readableTimes } from "@/lib/format";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Accounts                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export const asCarbon = (value: Me | undefined | null): CarbonMe | undefined => (value?.kind === "carbon" ? value : undefined);
export const asSilicon = (value: Me | undefined | null): SiliconMe | undefined => (value?.kind === "silicon" ? value : undefined);

/**
 * Who a transfer or request names. The API sends an AccountSummary, `{email}` when a Carbon was named by email,
 * `{uuid}` for an account it could not load, or null.
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

/** The logo to show for an app in the current theme (its dark logo on dark surfaces when it has one). */
export function appLogo(app: Pick<AppSummary, "logo_url" | "logo_dark_url">, theme: "light" | "dark"): string | null {
  return theme === "dark" && app.logo_dark_url ? app.logo_dark_url : app.logo_url;
}

/**
 * When a Silicon's STK was last rotated, or null when it never was. The service stamps `stk_rotated_at` when the first
 * STK is set too, in the same statement that creates the account, so that stamp equals `created_at` exactly; any other
 * stamp is a rotation, however soon after creation it came.
 */
export function stkRotatedAt(silicon: { stk_rotated_at: string | null; created_at: string }): string | null {
  if (!silicon.stk_rotated_at) return null;
  if (silicon.stk_rotated_at === silicon.created_at) return null;
  const rotated = Date.parse(silicon.stk_rotated_at);
  return Number.isFinite(rotated) && rotated === Date.parse(silicon.created_at) ? null : silicon.stk_rotated_at;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Photos                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What POST /v1/me/photo (and a Silicon's photo upload) accepts. */
export const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const PHOTO_ACCEPT = PHOTO_TYPES.join(",");
/** 2 MB, the API's limit (2 097 152 bytes). */
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

export const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

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

/* ------------------------------------------------------------------------------------------------------------------ */
/* Time                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Milliseconds until a timestamp (negative once passed; NaN without one). */
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

/**
 * A clock that ticks every `ms` while the calling component lives (relative times, countdowns, expiry rings). The
 * account pages render in the browser only (the shell waits for the session), so the first value is the real time.
 * Every component that calls it re-renders on each tick: keep it for the small parts that change (useSecondTick for
 * many of them at once).
 */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/* One shared one-second clock: a page full of countdowns re-renders them together, once a second, from one timer. */
const secondListeners = new Set<() => void>();
let secondTimer: number | null = null;
let secondNow = 0;

function subscribeSecond(listener: () => void): () => void {
  secondListeners.add(listener);
  if (secondTimer === null) {
    secondNow = Date.now();
    secondTimer = window.setInterval(() => {
      secondNow = Date.now();
      for (const notify of secondListeners) notify();
    }, 1000);
  }
  return () => {
    secondListeners.delete(listener);
    if (!secondListeners.size && secondTimer !== null) {
      window.clearInterval(secondTimer);
      secondTimer = null;
    }
  };
}

/** While the clock runs, its last tick; before it starts, the current second (stable within one render). */
const secondSnapshot = () => (secondTimer === null ? Math.floor(Date.now() / 1000) * 1000 : secondNow);

/** The time, once a second, from the shared clock (countdowns and expiry rings in long lists). */
export function useSecondTick(): number {
  return useSyncExternalStore(subscribeSecond, secondSnapshot, secondSnapshot);
}

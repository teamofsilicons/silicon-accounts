/**
 * Formatting helpers shared by every page: dates, relative times, counts, ids and scope labels. Fixed locale (en-US)
 * so every visitor reads the same digits; time zones are explicit.
 */
import type { AccountKind, ContactField, Scope } from "./api/types";

const LOCALE = "en-US";

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d, 12));
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Oct 6, 2026" (date-only strings are treated as calendar dates, never shifted by the time zone). */
export function formatDate(value: string | number | Date | null | undefined, timeZone?: string): string {
  const date = toDate(value);
  if (!date) return "–";
  const dateOnly = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", year: "numeric", timeZone: dateOnly ? "UTC" : timeZone }).format(date);
}

/** "Oct 6, 2026, 14:05" in the given time zone (the visitor's by default). */
export function formatDateTime(value: string | number | Date | null | undefined, timeZone?: string): string {
  const date = toDate(value);
  if (!date) return "–";
  return new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
}

/** "14:05" in a time zone. */
export function formatTime(value: string | number | Date | null | undefined, timeZone?: string, seconds = false): string {
  const date = toDate(value);
  if (!date) return "–";
  return new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined, hourCycle: "h23", timeZone }).format(date);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];
const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

/** "2 hours ago", "in 5 minutes", "just now". */
export function formatRelative(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return "–";
  const seconds = Math.round((date.getTime() - now) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === "second") return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(seconds, "second");
}

/** "in 9 days" style countdown for expiries; "expired" once passed. */
export function formatExpiry(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return "–";
  return date.getTime() <= now ? "expired" : formatRelative(date, now);
}

/** Seconds as "1:05" (resend timers, cooldowns). */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 12480 → "12,480". */
export function formatCount(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

/** "1 Silicon", "3 Silicons". */
export function plural(count: number, one: string, other = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : other}`;
}

/** The noun for an account kind, capitalized: "Carbon" / "Silicon". */
export function kindNoun(kind: AccountKind): string {
  return kind === "carbon" ? "Carbon" : "Silicon";
}

/** Splits `c:saket` into prefix and handle for typography. */
export function splitId(id: string | null | undefined): { prefix: string; handle: string } {
  if (!id) return { prefix: "", handle: "" };
  const at = id.indexOf(":");
  return at < 0 ? { prefix: "", handle: id } : { prefix: id.slice(0, at + 1), handle: id.slice(at + 1) };
}

/** Labels for the what's-shared screen and lists (same words as the server's consent rows). */
export const SCOPE_LABELS: Record<Scope, string> = {
  profile: "Name, id and profile photo",
  email: "Email address",
  phone: "Phone number",
  dob: "Date of birth",
  timezone: "Timezone",
  openid: "Sign-in identity (OpenID Connect)",
  offline_access: "Stay signed in",
};

export const FIELD_LABELS: Record<ContactField, string> = {
  email: "Email address",
  phone: "Phone number",
  dob: "Date of birth",
  timezone: "Timezone",
};

/** Short labels for chips: "Email", "Phone", "Date of birth", "Timezone", "Profile". */
export const SCOPE_SHORT: Record<Scope, string> = {
  profile: "Profile",
  email: "Email",
  phone: "Phone",
  dob: "Date of birth",
  timezone: "Timezone",
  openid: "OpenID",
  offline_access: "Offline",
};

/** "+91 98765 43210"-ish grouping for display only (the value stays E.164). */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/[^\d+]/g, "");
  if (digits.startsWith("+1") && digits.length === 12) return `+1 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  if (digits.startsWith("+91") && digits.length === 13) return `+91 ${digits.slice(3, 8)} ${digits.slice(8)}`;
  if (digits.startsWith("+44") && digits.length === 13) return `+44 ${digits.slice(3, 7)} ${digits.slice(7)}`;
  return digits.replace(/^(\+\d{1,3})(\d{3,4})(\d{3,4})(\d*)$/, (_, cc, a, b, c) => [cc, a, b, c].filter(Boolean).join(" "));
}

/** The browser's IANA time zone, or UTC. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

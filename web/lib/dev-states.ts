/**
 * Dev states (Anil, 2026-10-31): while developing, put the account site in any state without changing the account.
 * Each variable picks how one API read is answered: "real" leaves it to the API; anything else answers it here with
 * made-up data (or changes the real answer), so every page that reads it shows that state. The choices are kept in
 * this browser (`accounts.dev.states`); the panel (components/foundation/dev/dev-states.tsx) sets them and reloads.
 *
 * Development only: lib/api/http.ts asks `devAnswer` only when NODE_ENV is "development". Writes always go to the
 * API, so acting on made-up rows (declining a made-up request, say) fails with the API's own error.
 */
import type { AccountSummary, CustodianRequest, ManagedSilicon, Me, MyApp, Page, SessionInfo } from "./api/types";

export interface DevVariable {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

/** The variables, in the panel's order. The first option of each is the default. */
export const DEV_VARIABLES: DevVariable[] = [
  { key: "account", label: "Account", options: [{ value: "real", label: "Real" }, { value: "new", label: "New today" }, { value: "no-id", label: "No id" }] },
  { key: "requests", label: "Silicon requests", options: [{ value: "real", label: "Real" }, { value: "none", label: "None" }, { value: "request", label: "Request" }, { value: "handover", label: "Handover" }, { value: "both", label: "Both" }] },
  { key: "devices", label: "Devices", options: [{ value: "real", label: "Real" }, { value: "recent", label: "All recent" }, { value: "unused", label: "One unused" }] },
  { key: "silicons", label: "Silicons", options: [{ value: "real", label: "Real" }, { value: "none", label: "0" }, { value: "one", label: "1" }, { value: "three", label: "3" }] },
  { key: "apps", label: "Apps", options: [{ value: "real", label: "Real" }, { value: "none", label: "0" }, { value: "two", label: "2" }, { value: "six", label: "6" }] },
  { key: "network", label: "Network", options: [{ value: "real", label: "Normal" }, { value: "slow", label: "Slow" }, { value: "failing", label: "Lists fail" }] },
];

/** Whole scenarios in one click: each sets every variable it names (the rest go back to Real). */
export const DEV_PRESETS: { key: string; label: string; states: DevStates; showIntro?: boolean }[] = [
  { key: "joined", label: "Just joined", states: { account: "new", requests: "none", devices: "recent", silicons: "none", apps: "none" }, showIntro: true },
];

const KEY = "accounts.dev.states";

export type DevStates = Record<string, string>;

export function readDevStates(): DevStates {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as DevStates) : {};
  } catch {
    return {};
  }
}

export function writeDevStates(states: DevStates) {
  try {
    const kept = Object.fromEntries(Object.entries(states).filter(([, value]) => value && value !== "real"));
    window.localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Storage blocked: the states can't be kept.
  }
}

/** How many variables are set away from "real" (the panel's button shows it). */
export function devStatesInUse(states: DevStates): number {
  return Object.values(states).filter(value => value && value !== "real").length;
}

/* Made-up data ------------------------------------------------------------------------------------------------------ */

const DAY = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const page = <T>(items: T[]): Page<T> => ({ items, next_cursor: null }) as Page<T>;

function logo(hue: number, glyph: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="hsl(${hue} 52% 42%)"/><text x="32" y="42" font-family="system-ui,sans-serif" font-size="28" font-weight="600" text-anchor="middle" fill="#fff">${glyph}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const summary = (uuid: string, kind: "carbon" | "silicon", id: string, name: string): AccountSummary => ({ uuid, kind, id: id as AccountSummary["id"], display_name: name, pfp_url: "", status: "active" } as AccountSummary);

const SILICONS = [
  { uuid: "dvS1", id: "si:scout", name: "Scout" },
  { uuid: "dvS2", id: "si:atlas", name: "Atlas" },
  { uuid: "dvS3", id: "si:head_of_growth", name: "Head of growth" },
];

function silicons(count: number): ManagedSilicon[] {
  return SILICONS.slice(0, count).map((item, index) => ({
    uuid: item.uuid, kind: "silicon", id: item.id, display_name: item.name, pfp_url: "", dob: iso(-(index + 3) * 7 * DAY).slice(0, 10),
    timezone: "Asia/Kolkata", status: "active", created_at: iso(-(index + 3) * 7 * DAY), updated_at: iso(-DAY), version: 1,
    custodian: null, webhook_url: null, stk_rotated_at: null, pending_transfer: null,
  }) as unknown as ManagedSilicon);
}

const APPS = [
  { app_id: "briefcase", name: "Briefcase", hue: 214 },
  { app_id: "dm", name: "DM", hue: 160 },
  { app_id: "commit", name: "Commit", hue: 256 },
  { app_id: "remind", name: "Remind", hue: 36 },
  { app_id: "waveform", name: "Waveform", hue: 12 },
  { app_id: "interface", name: "Silicon Interface", hue: 220 },
];

function apps(count: number): MyApp[] {
  return APPS.slice(0, count).map((item, index) => ({
    app: { app_id: item.app_id, name: item.name, logo_url: logo(item.hue, item.name[0] ?? "A"), homepage_url: null },
    membership_id: `${item.app_id}:dev`, status: "active", source: "signin", granted_scopes: [],
    first_signed_in_at: iso(-(index + 2) * 9 * DAY), last_signed_in_at: iso(-(index + 1) * DAY), active_sessions: 1, access_removed_at: null,
  }) as unknown as MyApp);
}

function requests(kind: "request" | "handover" | "both"): CustodianRequest[] {
  const out: CustodianRequest[] = [];
  if (kind !== "handover") out.push({ id: "dvR1", kind: "initial", status: "pending", silicon: summary("dvR1s", "silicon", "si:researcher", "Researcher"), from: null, to: null, created_at: iso(-2 * DAY), expires_at: iso(12 * DAY), decided_at: null } as unknown as CustodianRequest);
  if (kind !== "request") out.push({ id: "dvR2", kind: "transfer", status: "pending", silicon: summary("dvR2s", "silicon", "si:ledger", "Ledger"), from: summary("dvC1", "carbon", "c:saket", "Saket"), to: null, created_at: iso(-DAY), expires_at: iso(13 * DAY), decided_at: null } as unknown as CustodianRequest);
  return out;
}

const UNUSED_DEVICE: SessionInfo = { id: "dvD1", kind: "browser", origin: "browser", label: "Edge on Windows", ip: null, user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0", created_at: iso(-60 * DAY), last_seen_at: iso(-20 * DAY), expires_at: null, current: false };

/* Answering reads ---------------------------------------------------------------------------------------------------- */

/** What the dev states do to one GET: answer it outright, change the real answer, or leave it alone. */
export interface DevAnswer {
  /** Wait this long first (Network: Slow). */
  delay?: number;
  /** Fail it as the API would (Network: Lists fail). */
  fail?: boolean;
  /** Answer with this instead of asking the API. */
  replace?: unknown;
  /** Ask the API, then change its answer. */
  patch?: (real: unknown) => unknown;
}

const LISTS = ["/v1/me/silicons", "/v1/me/apps", "/v1/me/sessions", "/v1/me/custodian-requests"];

export function devAnswer(method: string, path: string): DevAnswer | null {
  if (method !== "GET" || typeof window === "undefined") return null;
  const states = readDevStates();
  if (!devStatesInUse(states)) return null;
  const answer: DevAnswer = {};
  if (states.network === "slow") answer.delay = 1500;
  if (states.network === "failing" && LISTS.includes(path)) return { ...answer, fail: true };

  if (path === "/v1/me" && states.account === "new") answer.patch = real => ({ ...(real as Me), created_at: iso(-5 * 60_000) });
  if (path === "/v1/me" && states.account === "no-id") answer.patch = real => ({ ...(real as Me), id: null });
  if (path === "/v1/me/custodian-requests" && states.requests && states.requests !== "real") answer.replace = page(states.requests === "none" ? [] : requests(states.requests as "request" | "handover" | "both"));
  if (path === "/v1/me/sessions" && states.devices === "recent") answer.patch = real => ({ ...(real as Page<SessionInfo>), items: (real as Page<SessionInfo>).items.map(item => ({ ...item, last_seen_at: iso(-60_000) })) });
  if (path === "/v1/me/sessions" && states.devices === "unused") answer.patch = real => ({ ...(real as Page<SessionInfo>), items: [...(real as Page<SessionInfo>).items.map(item => ({ ...item, last_seen_at: item.current ? item.last_seen_at : iso(-60_000) })), UNUSED_DEVICE] });
  if (path === "/v1/me/silicons" && states.silicons && states.silicons !== "real") answer.replace = page(silicons({ none: 0, one: 1, three: 3 }[states.silicons] ?? 0));
  if (path === "/v1/me/apps" && states.apps && states.apps !== "real") answer.replace = page(apps({ none: 0, two: 2, six: 6 }[states.apps] ?? 0));
  return Object.keys(answer).length ? answer : null;
}

/** The made-up failure, shaped like the API's errors. */
export function devFailure(): Response {
  return new Response(JSON.stringify({ error: { code: "dev_state", message: "This list failed on purpose (dev states: Network, Lists fail).", hint: "Set Network back to Normal in the States panel." } }), { status: 503, headers: { "content-type": "application/json" } });
}

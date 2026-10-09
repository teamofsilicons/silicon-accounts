/**
 * Whether our three services are up right now, for /status and its JSON twin /status.json:
 *
 *   Silicon Accounts   GET /readyz (the API and its database) and GET /v1/meta (the API, with its version)
 *   Silicon Apps       GET /health (the API, with its version)
 *   Silicon Developer  GET /openapi.json on this site's public address (DEVELOPER_PUBLIC_URL), so the check goes the
 *                      way a visitor's request does; its version is this build's own (package.json)
 *
 * Every check is a GET from this server with a 3 second limit, all at once. A service is up when every one of its
 * checks answered 2xx in time (and, where the body says how it is, says it is fine). One round of checks is kept for
 * 30 seconds and shared by every request in that time, so the page and the JSON never cost the services more than one
 * round every 30 seconds. Nothing here is stored: there is no history yet, only what the checks see now.
 */
import packageJson from "@/package.json";
import { developerPublicUrl } from "@/lib/server/config";
import { LINKS } from "@/lib/site";

export const STATUS_TIMEOUT_MS = 3_000;
export const STATUS_CACHE_SECONDS = 30;
const USER_AGENT = "silicon-developer-status";

/** What we do not publish yet, in plain words: the page and the JSON both say it. */
export const NOT_PUBLISHED_YET = [
  "No SLA yet: we don't promise an uptime figure.",
  "No incident history yet: this shows what our checks see right now, not what happened before.",
  "No status alerts yet: open this page or read /status.json when you want to know.",
] as const;

export type ServiceId = "accounts" | "apps" | "developer";
export type ServiceState = "up" | "down";
export type OverallState = "up" | "partial" | "down";

export interface StatusError {
  code: "timeout" | "unreachable" | "http_status" | "not_ready";
  message: string;
}

interface Endpoint {
  url: string;
  /** What this request tells us, in a few words. */
  purpose: string;
  /** Whether the body says the service is fine. Left out: any 2xx answer is fine. */
  healthy?: (body: unknown) => boolean;
  /** The version the body reports, if this request reports one. */
  version?: (body: unknown) => string | null;
}

export interface ServiceTarget {
  id: ServiceId;
  name: string;
  /** Where the service lives. */
  url: string;
  about: string;
  /** The first is the health check: its time is the service's response time. */
  endpoints: Endpoint[];
  /** A version known without asking (this site's own build). */
  version?: string | null;
}

export interface CheckResult {
  url: string;
  purpose: string;
  ok: boolean;
  http_status: number | null;
  /** Milliseconds until the whole answer arrived, or null when none did. */
  response_ms: number | null;
  error: StatusError | null;
}

export interface ServiceStatus {
  id: ServiceId;
  name: string;
  url: string;
  about: string;
  status: ServiceState;
  response_ms: number | null;
  version: string | null;
  checked_at: string;
  error: StatusError | null;
  checks: CheckResult[];
}

export interface StatusReport {
  status: OverallState;
  summary: string;
  checked_at: string;
  cache_seconds: number;
  timeout_ms: number;
  services: ServiceStatus[];
  not_published_yet: string[];
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface CheckOptions {
  fetch?: Fetcher;
  targets?: ServiceTarget[];
  timeoutMs?: number;
  /** The time the round starts (tests pass a fixed one). */
  now?: () => Date;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringField = (body: unknown, key: string): string | null => (isObject(body) && typeof body[key] === "string" && body[key] ? (body[key] as string).slice(0, 64) : null);
const trimSlash = (value: string) => value.replace(/\/+$/, "");

/** The three services and how each one is checked. */
export function statusTargets(self: string = developerPublicUrl()): ServiceTarget[] {
  const accounts = trimSlash(LINKS.accounts);
  const apps = trimSlash(LINKS.apps);
  const developer = trimSlash(self);
  return [
    {
      id: "accounts",
      name: "Silicon Accounts",
      url: accounts,
      about: "Sign-in for Carbons, Silicons and apps: the API and the hosted sign-in pages.",
      endpoints: [
        { url: `${accounts}/readyz`, purpose: "The API and its database are ready", healthy: body => !isObject(body) || !("database" in body) || body.database === "ok" },
        { url: `${accounts}/v1/meta`, purpose: "The API answers, with its version", version: body => stringField(body, "version") },
      ],
    },
    {
      id: "apps",
      name: "Silicon Apps",
      url: apps,
      about: "The store and the API that publishes, finds and installs apps.",
      endpoints: [
        { url: `${apps}/health`, purpose: "The API answers, with its version", healthy: body => !isObject(body) || !("status" in body) || body.status === "ok", version: body => stringField(body, "version") },
      ],
    },
    {
      id: "developer",
      name: "Silicon Developer",
      url: developer,
      about: "This site: the docs, the developer portal, the docs API and the MCP server.",
      endpoints: [
        { url: `${developer}/openapi.json`, purpose: "This site answers at its public address", healthy: body => isObject(body) && typeof body.openapi === "string" },
      ],
      version: packageJson.version,
    },
  ];
}

const seconds = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`);

async function check(endpoint: Endpoint, fetcher: Fetcher, timeoutMs: number): Promise<{ result: CheckResult; body: unknown }> {
  const started = performance.now();
  const base = { url: endpoint.url, purpose: endpoint.purpose };
  try {
    const response = await fetcher(endpoint.url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The time limit covers the body too: the same signal ends a body that stops arriving.
    const text = await response.text();
    const ms = Math.round(performance.now() - started);
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      return { body, result: { ...base, ok: false, http_status: response.status, response_ms: ms, error: { code: "http_status", message: `Answered ${response.status} instead of 200.` } } };
    }
    if (endpoint.healthy && !endpoint.healthy(body)) {
      return { body, result: { ...base, ok: false, http_status: response.status, response_ms: ms, error: { code: "not_ready", message: "Answered, but said it is not ready." } } };
    }
    return { body, result: { ...base, ok: true, http_status: response.status, response_ms: ms, error: null } };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    const message = timedOut ? `Did not answer within ${seconds(timeoutMs)}.` : "Could not be reached.";
    return { body: null, result: { ...base, ok: false, http_status: null, response_ms: null, error: { code: timedOut ? "timeout" : "unreachable", message } } };
  }
}

const listNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** One sentence that answers "is everything up?". */
export function summarize(services: Array<Pick<ServiceStatus, "name" | "status">>): { status: OverallState; summary: string } {
  const down = services.filter(service => service.status === "down").map(service => service.name);
  if (down.length === 0) return { status: "up", summary: services.length === 3 ? "All three services are up." : "Every service is up." };
  if (down.length === services.length) return { status: "down", summary: "Every service is down right now." };
  return { status: "partial", summary: `${listNames(down)} ${down.length === 1 ? "is" : "are"} down right now. Everything else is up.` };
}

/** Run one round of checks: every service at once, every endpoint of a service at once. */
export async function runChecks({ fetch: fetcher = (url, init) => fetch(url, init), targets = statusTargets(), timeoutMs = STATUS_TIMEOUT_MS, now = () => new Date() }: CheckOptions = {}): Promise<StatusReport> {
  const checkedAt = now().toISOString();
  const services = await Promise.all(targets.map(async (target): Promise<ServiceStatus> => {
    const answers = await Promise.all(target.endpoints.map(endpoint => check(endpoint, fetcher, timeoutMs)));
    const failed = answers.find(answer => !answer.result.ok);
    // A version from any answer that carried one (no answer means no body, so nothing to read).
    const reported = target.endpoints.map((endpoint, index) => endpoint.version?.(answers[index]!.body) ?? null).find(Boolean) ?? null;
    return {
      id: target.id,
      name: target.name,
      url: target.url,
      about: target.about,
      status: failed ? "down" : "up",
      response_ms: answers[0]?.result.response_ms ?? null,
      version: reported ?? target.version ?? null,
      checked_at: checkedAt,
      error: failed?.result.error ?? null,
      checks: answers.map(answer => answer.result),
    };
  }));
  return {
    ...summarize(services),
    checked_at: checkedAt,
    cache_seconds: STATUS_CACHE_SECONDS,
    timeout_ms: timeoutMs,
    services,
    not_published_yet: [...NOT_PUBLISHED_YET],
  };
}

/*
 * The 30 second cache. It lives on globalThis so the page and the JSON route (separate bundles in one process) share
 * one round, and a round still running is shared too: requests that arrive while it runs wait for the same answer.
 */
interface StatusCache {
  started: number;
  report: Promise<StatusReport>;
}

const CACHE_KEY = Symbol.for("silicon-developer.status-cache");
const store = globalThis as typeof globalThis & { [CACHE_KEY]?: StatusCache | null };

/** The latest round of checks, run again when the kept one is 30 seconds old. */
export function statusReport(options: CheckOptions & { clock?: () => number } = {}): Promise<StatusReport> {
  const clock = options.clock ?? Date.now;
  const kept = store[CACHE_KEY];
  if (kept && clock() - kept.started < STATUS_CACHE_SECONDS * 1000) return kept.report;
  const started = clock();
  const report = runChecks({ ...options, now: options.now ?? (() => new Date(started)) });
  store[CACHE_KEY] = { started, report };
  // A round that fails as a whole (a bug, never a down service) is not kept, so the next request tries again.
  report.catch(() => {
    if (store[CACHE_KEY]?.report === report) store[CACHE_KEY] = null;
  });
  return report;
}

/** Forget the kept round (tests). */
export function resetStatusCache(): void {
  store[CACHE_KEY] = null;
}

/** Seconds until a report is checked again: what /status.json lets caches keep it for. */
export function secondsLeft(report: Pick<StatusReport, "checked_at" | "cache_seconds">, now = Date.now()): number {
  const age = Math.floor((now - Date.parse(report.checked_at)) / 1000);
  return Math.min(report.cache_seconds, Math.max(0, report.cache_seconds - age));
}

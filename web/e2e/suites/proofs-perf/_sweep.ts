/**
 * The hourly proof sweep (crates/proofs store::sweep), shared by its two journeys: 0-sweep-setup.ts (first in the suite:
 * the proofs the sweep must store, delete or keep, made before the stack's first sweep) and z-sweep.ts (last in the
 * suite: waits for that sweep, then checks what it did).
 *
 * accounts-api runs its first sweep 120 s after it starts (crates/proofs/src/lib.rs SWEEP_FIRST_DELAY; its background
 * tasks start just before it logs "Silicon Accounts is listening"), then every hour. So the setup has to be done before
 * that first sweep. A setup that comes too late (a stack walked again with --keep, or a site build that waited minutes
 * for a build slot) is handed over as such, and the check reports "not measured" as a failure rather than a pass.
 *
 * Both journeys run only when asked for, with E2E_PROOFS_SWEEP=1 (`E2E_PROOFS_SWEEP=1 scripts/e2e.sh proofs-perf-sweep`):
 * the check has to wait for that first sweep, 120 s after accounts-api started, which is a minute or more of doing
 * nothing at the end of an otherwise ~40 s suite. Otherwise they are reported as skipped. The sweep's own logic
 * (store::sweep: what it stores, deletes and keeps) is covered without waiting by crates/proofs/tests (api/listings.rs,
 * api/sign_in.rs), which call it directly; these journeys add its schedule on a real stack.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Journey } from "../../context";
import type { AppSignIn, IssuedProof } from "./_helpers";
import { E2E_DIR, type Env } from "../../lib";

const ROOT = resolve(E2E_DIR, "../..");

/** E2E_PROOFS_SWEEP=1 runs the sweep journeys (they wait for the stack's first sweep); otherwise they are skipped. */
export const SWEEP_ENABLED = process.env.E2E_PROOFS_SWEEP === "1";

/**
 * What the sweep journeys spread into themselves: nothing when enabled; otherwise no engine (run.ts reports a journey
 * whose `engines` leave out the run's engine as skipped) and a title that says how to run them.
 */
export function sweepOptIn(title: string): Pick<Journey, "title" | "engines"> {
  return SWEEP_ENABLED ? { title } : { title: `[skipped unless E2E_PROOFS_SWEEP=1: it waits for the stack's first sweep, 120 s after accounts-api starts] ${title}`, engines: [] };
}

/** crates/proofs/src/lib.rs SWEEP_FIRST_DELAY. */
export const FIRST_SWEEP_AFTER_MS = 120_000;
/** The setup must be done at least this long before the first sweep is due. */
export const SETUP_MARGIN_MS = 10_000;
/** How long after the first sweep was due the check waits for its log line before giving up. */
export const SWEEP_WAIT_MS = 90_000;
/** The hand-over from the setup to the check. */
export const SWEEP_KEY = "proofs-perf.sweep";

/** The stack's accounts-api log (scripts/dev.sh writes .dev/logs/<base>/accounts-api.log). */
export const apiLogFile = (env: Env) => join(ROOT, ".dev", "logs", String(env.base), "accounts-api.log");

/** A log line's time (its leading RFC 3339 UTC timestamp), ms since the epoch. */
export function logTime(line: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z/.exec(line);
  if (!match) return null;
  return Date.parse(`${match[1]}.${(match[2] ?? "0").slice(0, 3).padEnd(3, "0")}Z`);
}

/** When accounts-api last started listening, in the text of its log (null when it never did). */
export function listeningAt(log: string): number | null {
  let at: number | null = null;
  for (const line of log.split("\n")) {
    if (line.includes("Silicon Accounts is listening")) at = logTime(line) ?? at;
  }
  return at;
}

const readLog = (env: Env) => (existsSync(apiLogFile(env)) ? readFileSync(apiLogFile(env), "utf8") : "");

/** When the stack's accounts-api last started listening, from its log (null when the log or the line is missing). */
export const apiListeningAt = (env: Env) => listeningAt(readLog(env));

export interface SweepLine {
  at: number;
  signInRevocationsRecorded: number;
  expiredAccessTokens: number;
  deadFamilyTokens: number;
  line: string;
}

/** Every "proof sweep" line in the text of an accounts-api log (a sweep logs one when it stored or deleted anything). */
export function parseSweepLines(log: string): SweepLine[] {
  const field = (line: string, name: string) => Number(new RegExp(`\\b${name}=(\\d+)`).exec(line)?.[1] ?? Number.NaN);
  return log
    .split("\n")
    .filter(line => / proof sweep\b/.test(line) && line.includes("sign_in_revocations_recorded="))
    .map(line => ({
      at: logTime(line) ?? Number.NaN,
      signInRevocationsRecorded: field(line, "sign_in_revocations_recorded"),
      expiredAccessTokens: field(line, "expired_access_tokens"),
      deadFamilyTokens: field(line, "dead_family_tokens"),
      line,
    }));
}

/** Every "proof sweep" line of the stack's accounts-api log. */
export const sweepLines = (env: Env) => parseSweepLines(readLog(env));

/** What the setup made, for the check. */
export type SweepSetup =
  | { measurable: false; why: string }
  | {
      measurable: true;
      listeningAt: number;
      doneAt: number;
      /** Carbon A, signed into dm: the proofs whose tokens the sweep deletes or keeps. */
      a: AppSignIn;
      /** Carbon B, whose dm sign-in dm ended: the proof whose end only the sweep stores. */
      b: AppSignIn;
      /** dm's sign-in (token family) of B that dm ended, and why it ended (token_families.revoke_reason). */
      bSignIn: { family: string; reason: string };
      /** A live proof refreshed once: its first proof token (live), its used refresh token, and the current pair. */
      live: IssuedProof;
      liveCurrent: IssuedProof;
      /** Its proof token expired 25 h ago (more than the 1 day the sweep keeps expired proof tokens). */
      staleToken: IssuedProof;
      /** Its proof token expired 23 h ago (kept). */
      recentToken: IssuedProof;
      /** Revoked by dm, 31 days ago (every token deleted) and 29 days ago (kept). */
      endedLongAgo: IssuedProof;
      endedRecently: IssuedProof;
      /** An app verification proof (commit → remind) whose 900-day lifetime ended 31 days ago (every token deleted). */
      ataExpiredLongAgo: IssuedProof;
      /** B's User verification proof on the sign-in dm ended: invalid at once, its end stored by nobody but the sweep. */
      signInEnded: IssuedProof;
      /** proof_tokens rows per proof right after the setup. */
      tokensBefore: Record<string, number>;
    };

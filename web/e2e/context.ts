/**
 * What every journey gets, and what journeys hand to each other (the Carbons they created, signed in).
 *
 * A journey file (e2e/journeys/*.ts for the "core" suite, e2e/suites/<suite>/*.ts for the others) exports `journey`
 * (one) or `journeys` (several). run.ts finds them by itself: adding a suite never means editing run.ts.
 */
import type { Browser, Cookie } from "@playwright/test";
import type { Engine, Env, Results } from "./lib";

export interface SignedIn {
  email: string;
  id: string;
  uuid: string;
  /** The browser's cookies once signed in to the account site (the session). */
  cookies: Cookie[];
}

/**
 * Hand-overs between journeys, by key. The core suite's are typed here; a suite hands over its own under keys of its
 * own (prefix them with the suite's name, e.g. "silicons.custodian"), read back with a cast.
 */
export interface Shared {
  /** Signed up on the account site (core journey a-signup). */
  ada?: SignedIn;
  /** Signed up through briefcase, then dm with a phone (core journey b-apps). */
  brook?: SignedIn & { phone: string };
  [key: string]: unknown;
}

export interface Ctx {
  env: Env;
  results: Results;
  browser: Browser;
  shared: Shared;
  /** The suite this journey belongs to ("core" for e2e/journeys). */
  suite: string;
  /** This journey's own client address for direct API calls (lib.ts api()); browser contexts get their own. */
  ip: string;
}

export interface Journey {
  /** Unique across every suite; positional arguments of run.ts select journeys by its prefix. */
  name: string;
  /** One line: what it walks through. */
  title: string;
  /** Keys of Shared this journey reads; the journeys that provide them run first, whatever the selection. */
  needs?: string[];
  /** Keys of Shared this journey hands over (when it passes). */
  provides?: string[];
  /** Only in these browsers (default: both). */
  engines?: Engine[];
  /** Give up after this long (default 10 minutes, or E2E_JOURNEY_TIMEOUT_MS). */
  timeoutMs?: number;
  run: (ctx: Ctx) => Promise<void>;
}

/**
 * The ux-audit suite's helpers (a helper file: its name starts with "_", so run.ts never takes it for journeys).
 *
 * Every audited page is looked at in four variants (light and dark at 1440 and 390 px) and checked for: the theme it
 * paints, no sideways scrolling, axe-core (no serious or critical violation), every painted rounded surface a squircle,
 * no console errors, no broken images, no content left invisible, the vocabulary (Carbons and Silicons, never org or
 * team), and a screenshot per variant. What is worth reading but not a failure (truncated text, moderate axe findings,
 * text spilling out of its box) goes to the journey's findings file: e2e/.artifacts/<base>/ux-audit/<journey>.json.
 *
 * UNDERSTANDING.md v2: two sites. The account site (accounts.teamofsilicons.com, env.site) holds a Carbon's own account,
 * the hosted sign-in pages, the device page and the docs; the developer site (developers.teamofsilicons.com, env.developer,
 * base + 5) holds everything about building apps, signed in through its BFF (lib.ts signInOnDeveloper). Both are audited
 * with the same checks; "Powered by Silicon Accounts" links to https://accounts.teamofsilicons.com (POWERED_HREF).
 *
 * axe-core comes from the site's own node_modules (eslint-config-next's jsx-a11y depends on it), so the suite needs no
 * package of its own. It and the kit (_kit.ts) are installed with context.addInitScript, which no page CSP refuses.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { Ctx } from "../../context";
import { DEVELOPER_SIGNED_OUT, E2E_DIR, codeFor, developerApi, lastSeq, newContext, shot, signInOnDeveloper, signInOnSite, sleep, sql, tag, type ContextOptions, type Env } from "../../lib";
import { KIT_SOURCE } from "./_kit";

/** Where every "Powered by Silicon Accounts" links (UNDERSTANDING.md "Making the pages your own"; v2: the plural host). */
export const POWERED_HREF = /^https:\/\/accounts\.teamofsilicons\.com\/?$/;

export type Theme = "light" | "dark";

export interface Variant {
  theme: Theme;
  width: number;
  height: number;
  /** "light-1440", "dark-390"… (check names and screenshot names). */
  key: string;
}

const variant = (theme: Theme, width: number, height: number): Variant => ({ theme, width, height, key: `${theme}-${width}` });
export const VARIANTS: Variant[] = [variant("light", 1440, 900), variant("dark", 1440, 900), variant("light", 390, 844), variant("dark", 390, 844)];
/** For pages whose app forces one theme: both widths in that theme only. */
export const forcedVariants = (theme: Theme): Variant[] => VARIANTS.filter(entry => entry.theme === theme);

/* ------------------------------------------------------------------------------------------------------------------ */
/* Browser contexts with the kit and axe                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

let axeSource: string | null = null;

/** axe-core's browser build from the site's node_modules (the newest version there). */
export function axeScript(): string {
  if (axeSource) return axeSource;
  const store = resolve(E2E_DIR, "../node_modules/.pnpm");
  const versions = existsSync(store) ? readdirSync(store).filter(name => /^axe-core@\d/.test(name)) : [];
  const parse = (name: string) => (name.split("@")[1] ?? "0").split(".").map(part => Number.parseInt(part, 10) || 0);
  versions.sort((a, b) => {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  });
  for (const name of versions) {
    const file = join(store, name, "node_modules", "axe-core", "axe.min.js");
    if (existsSync(file)) {
      axeSource = readFileSync(file, "utf8");
      return axeSource;
    }
  }
  throw new Error(`axe-core is not in ${store} (eslint-config-next brings it): run pnpm -C web install`);
}

/** A browser context from lib.ts's newContext, with the kit and axe in every document it opens. */
export async function auditContext(browser: Browser, options: ContextOptions = {}): Promise<BrowserContext> {
  const context = await newContext(browser, options);
  await context.addInitScript({ content: `${KIT_SOURCE}\n;${axeScript()}` });
  return context;
}

/** The kit in a page that was opened before addInitScript (idempotent). */
export async function ensureKit(page: Page): Promise<void> {
  const present = await page.evaluate("!!window.__uxa").catch(() => false);
  if (!present) await page.evaluate(KIT_SOURCE);
}

export async function kit<T>(page: Page, call: string): Promise<T> {
  await ensureKit(page);
  return (await page.evaluate(`window.__uxa.${call}`)) as T;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Console errors per page                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

const consoleLogs = new WeakMap<Page, string[]>();
const awayHosts = new WeakMap<Page, Set<string>>();
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Collects this page's console errors, page errors, CSP refusals and failed requests (as results.watch does for the
 * journey) so each audit can say which page and variant they came from. `expected` filters out what a journey asks for.
 */
export function collectConsole(page: Page, expected: RegExp[] = []): void {
  const log: string[] = [];
  consoleLogs.set(page, log);
  const away = new Set<string>();
  awayHosts.set(page, away);
  page.on("request", request => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return;
    try {
      const host = new URL(url).host;
      if (!LOCAL.test(host)) away.add(`${host} (${url.slice(0, 90)})`);
    } catch {
      // Not a URL with a host.
    }
  });
  const allowed = (text: string) => expected.some(pattern => pattern.test(text)) || BENIGN.some(pattern => pattern.test(text));
  /** Loads from other machines are the "nothing leaves this machine" check's (a timeout there is not the page's error). */
  const remote = (url: string) => {
    try {
      return !LOCAL.test(new URL(url).host);
    } catch {
      return false;
    }
  };
  page.on("console", message => {
    const text = `console.${message.type()}: ${message.text()} @ ${message.location().url}`;
    if (/^Failed to load resource/.test(message.text()) && remote(message.location().url)) return;
    if ((message.type() === "error" || /Content Security Policy|Refused to/i.test(message.text())) && !allowed(text)) log.push(text);
  });
  page.on("pageerror", failure => {
    const text = `pageerror: ${failure.message}`;
    if (!allowed(text)) log.push(text);
  });
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText ?? "";
    if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure) || remote(request.url())) return;
    const text = `requestfailed: ${request.method()} ${request.url()} ${failure}`;
    if (!allowed(text)) log.push(text);
  });
}

/** The same browser noise lib.ts ignores (see BENIGN there). */
const BENIGN = [/_rsc=.* due to access control checks/, /Frame load interrupted/, /ResizeObserver loop completed with undelivered notifications/];

/** This page's console problems and loads from other machines collected since the last audit (and forgets them). */
export function drainProblems(page: Page): { console: string[]; away: string[] } {
  return { console: takeConsole(page), away: takeAway(page) };
}

function takeAway(page: Page): string[] {
  const away = awayHosts.get(page);
  if (!away) return [];
  const list = [...away];
  away.clear();
  return list;
}

function takeConsole(page: Page): string[] {
  const log = consoleLogs.get(page);
  if (!log) return [];
  return log.splice(0, log.length);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Findings (the journey's JSON file next to the report)                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Findings {
  journey: string;
  pages: Record<string, unknown>;
  notes: string[];
}

export function findingsFor(ctx: Ctx): Findings {
  return { journey: ctx.results.journey, pages: {}, notes: [] };
}

export function saveFindings(ctx: Ctx, findings: Findings): string {
  const dir = join(ctx.env.artifacts, "ux-audit");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${findings.journey}.json`);
  writeFileSync(file, `${JSON.stringify(findings, null, 2)}\n`);
  return file;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Settling and variants                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Polls `expression` in the page until it is truthy (true) or `timeoutMs` passes (false). Not page.waitForFunction:
 * Playwright runs that predicate through the page's eval, which the site's CSP (no 'unsafe-eval') refuses, with a
 * page error to show for it; page.evaluate goes through the browser's protocol, which no CSP restricts.
 */
export async function waitUntil(page: Page, expression: string, timeoutMs = 10_000, everyMs = 100): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await page.evaluate(expression).catch(() => false);
    if (value) return true;
    if (Date.now() >= end) return false;
    await sleep(everyMs);
  }
}

/** Network quiet, fonts loaded, no finite animation running (at most a few seconds), then a short pause. */
export async function settle(page: Page, pause = 300): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true").catch(() => undefined);
  await ensureKit(page).catch(() => undefined);
  await waitUntil(page, "!window.__uxa || window.__uxa.calm()", 3_000);
  await sleep(pause);
}

/** Sets the variant's size and theme; scrolls to the top unless `keepScroll` (an open popover stays where it is). */
export async function applyVariant(page: Page, entry: Variant, keepScroll = false): Promise<void> {
  // The pointer stays where the last click was; parked in the corner it hovers nothing in the screenshots.
  await page.mouse.move(0, 0).catch(() => undefined);
  const size = page.viewportSize();
  if (!size || size.width !== entry.width || size.height !== entry.height) await page.setViewportSize({ width: entry.width, height: entry.height });
  await page.emulateMedia({ colorScheme: entry.theme });
  if (!keepScroll) await page.evaluate("window.scrollTo({ left: 0, top: 0, behavior: 'instant' })").catch(() => undefined);
  await settle(page);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The audit of one page in one variant                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  count: number;
  nodes: Array<{ target: string; html: string; summary: string }>;
}
interface Overflow {
  scrollWidth: number;
  clientWidth: number;
  scrolledX: number;
  offenders: Array<{ el: string; left: number; right: number; width: number }>;
}
interface Squircles {
  native: boolean;
  checked: number;
  marked: number;
  exempt: number;
  violations: Array<{ el: string; w: number; h: number; radius: string; pill: boolean; primary: boolean }>;
  nativeMismatch: Array<{ el: string; shape: string }>;
}
interface Truncated {
  el: string;
  kind: "ellipsis" | "clipped" | "line-clamp" | "spills";
  text: string;
  titled: boolean;
  box: number;
  content: number;
  fixed: boolean;
}

export interface AuditOptions {
  /** Names the page in check names and screenshots ("landing", "hosted-acme-signup"…). */
  name: string;
  variant: Variant;
  /** The page's theme is forced (an app's branding): html[data-theme] is not checked against the variant. */
  forcedTheme?: Theme;
  /** A page of the account site's own look (html[data-theme] follows the visitor). Default true. */
  siteTheme?: boolean;
  /** Also a full-page screenshot. */
  fullPage?: boolean;
  /** axe rules to leave out (say why at the call). */
  axeDisable?: string[];
  /** Console problems the page is expected to log (a 404 it asks for…). */
  expectedConsole?: RegExp[];
  /** Skip the vocabulary check (pages that show an app's own words). */
  skipWords?: boolean;
  /** Leave the scroll position as it is (an open popover in view), instead of starting from the top. */
  keepScroll?: boolean;
}

/** axe's rule for WCAG 2.5.3 Label in Name, reported as a check of its own. */
const LABEL_IN_NAME = "label-content-name-mismatch";

/** Words that never name accounts or groups of them on the site (UNDERSTANDING.md: Carbons and Silicons, no Teams). */
const BANNED = /\b(org|orgs|organi[sz]ations?|teams?|workspaces?|tenants?|humans?|AI agents?|robots?|bots?|frontend|backend)\b/gi;
/** Vendor words the site has to use as the vendors spell them (Apple's Team ID, Google Workspace). */
const VENDOR = /\b(Apple Team ID|Team ID|Google Workspace domain|Workspace domain|Google Workspace)\b/gi;
/** Words worth a look (not failures): generic names for accounts where Carbon or Silicon may be meant. */
const SOFT = /\b(people|person|users?|customers?|members?|accounts holders?)\b/gi;

export interface AuditSummary {
  axe: AxeViolation[];
  overflow: Overflow;
  squircles: Squircles;
  truncated: Truncated[];
  overlaps: unknown[];
  hidden: unknown[];
  broken: unknown[];
  console: string[];
  banned: string[];
  soft: string[];
  theme: string | null;
}

/**
 * Audits the page as it is now in `options.variant` (applied first): records checks on ctx.results, saves a screenshot
 * (`uxa-<name>-<variant>.png`) and returns the details (also stored in `findings`).
 */
export async function auditPage(ctx: Ctx, page: Page, findings: Findings, options: AuditOptions): Promise<AuditSummary> {
  const { results, env } = ctx;
  const v = options.variant;
  await applyVariant(page, v, !!options.keepScroll);
  const label = `${options.name} ${v.key}`;
  const shotName = `uxa-${options.name}-${v.key}`;
  await shot(env, page, shotName, !!options.fullPage);

  const theme = await page.evaluate("document.documentElement.getAttribute('data-theme')").catch(() => null) as string | null;
  if (options.siteTheme !== false && !options.forcedTheme) results.check(`${label}: the page paints the visitor's ${v.theme} theme`, theme === v.theme, `html[data-theme]=${theme}`);

  const overflow = await kit<Overflow>(page, "overflow()");
  results.check(
    `${label}: no horizontal scroll`,
    overflow.scrolledX === 0 && overflow.scrollWidth <= overflow.clientWidth,
    `scrollWidth ${overflow.scrollWidth} vs ${overflow.clientWidth}, scrolled ${overflow.scrolledX}px${overflow.offenders.length ? `; sticking out: ${overflow.offenders.map(o => `${o.el} [${o.left}..${o.right}]`).join("; ")}` : ""}`,
  );

  const axe = await kit<{ violations?: AxeViolation[]; error?: string }>(page, `axe(${JSON.stringify({ disable: options.axeDisable ?? [] })})`);
  const violations = axe.violations ?? [];
  const severe = violations.filter(entry => (entry.impact === "serious" || entry.impact === "critical") && entry.id !== LABEL_IN_NAME);
  const describeAxe = (list: AxeViolation[]) => list.map(entry => `${entry.impact} ${entry.id} ×${entry.count} (${entry.help}): ${entry.nodes.slice(0, 3).map(node => `${node.target} ${node.html}`).join(" | ")}`).join(" || ");
  results.check(
    `${label}: axe finds no serious or critical violations`,
    !axe.error && severe.length === 0,
    axe.error ?? (describeAxe(severe) || `${violations.length} lesser or listed apart: ${violations.map(entry => `${entry.impact} ${entry.id}×${entry.count}`).join(", ") || "none"}`),
  );
  // WCAG 2.5.3 (axe label-content-name-mismatch, serious) on its own line, so the other findings stay readable.
  const labelInName = violations.filter(entry => entry.id === LABEL_IN_NAME);
  results.check(`${label}: every control's visible words are part of its accessible name (WCAG 2.5.3)`, !axe.error && labelInName.length === 0, describeAxe(labelInName));

  const squircles = await kit<Squircles>(page, "squircles()");
  const primary = squircles.violations.filter(entry => entry.primary);
  results.check(
    `${label}: every primary rounded surface is a squircle`,
    primary.length === 0 && squircles.nativeMismatch.length === 0,
    `${squircles.checked} rounded surfaces, ${squircles.marked} squircles${squircles.native ? " (native corner-shape)" : " (fallback)"}${primary.length ? `; not squircles: ${primary.slice(0, 8).map(entry => `${entry.el} ${entry.w}×${entry.h} r=${entry.radius}`).join("; ")}` : ""}${squircles.nativeMismatch.length ? `; marked but drawn round: ${squircles.nativeMismatch.slice(0, 5).map(entry => `${entry.el} (${entry.shape})`).join("; ")}` : ""}`,
  );

  const broken = await kit<Array<{ el: string; src: string }>>(page, "brokenImages()");
  results.check(`${label}: no broken images`, broken.length === 0, broken.map(entry => `${entry.el} ${entry.src}`).join("; "));

  const hidden = await kit<Array<{ el: string; opacity: number }>>(page, "hiddenContent()");
  results.check(`${label}: no heading, control or text left faded out`, hidden.length === 0, hidden.map(entry => `${entry.el} (opacity ${entry.opacity})`).join("; "));

  const consoleProblems = takeConsole(page).filter(text => !(options.expectedConsole ?? []).some(pattern => pattern.test(text)));
  results.check(`${label}: no console errors`, consoleProblems.length === 0, consoleProblems.slice(0, 5).join(" | "));
  const away = takeAway(page);
  results.check(`${label}: nothing the page loads leaves this machine`, away.length === 0, away.slice(0, 5).join(" | "));

  const text = await kit<string>(page, "words()");
  // Google Workspace keeps its name even a few words after "Google" or its hosted_domain setting ("another Workspace").
  const cleaned = text.replace(VENDOR, " ").replace(/teamofsilicons/gi, " ").replace(/(Google|hosted_domain)([^\n]{0,60}?)\bWorkspaces?\b/gi, "$1$2 ");
  const banned = [...new Set([...cleaned.matchAll(BANNED)].map(match => match[0]))];
  const soft = [...new Set([...cleaned.matchAll(SOFT)].map(match => contextOf(cleaned, match.index ?? 0)))].slice(0, 12);
  if (!options.skipWords) results.check(`${label}: vocabulary: no org, team, workspace or human words`, banned.length === 0, banned.map(word => contextOf(cleaned, cleaned.indexOf(word))).join(" | "));

  const truncated = await kit<Truncated[]>(page, "truncation()");
  const overlaps = await kit<unknown[]>(page, "textOverlaps()");

  const summary: AuditSummary = { axe: violations, overflow, squircles, truncated, overlaps, hidden, broken, console: consoleProblems, banned, soft, theme };
  findings.pages[label] = { shot: `shots/${shotName}.png`, ...summary, squircles: { ...squircles, violations: squircles.violations.slice(0, 30) } };
  return summary;
}

/** The sentence around a word, for reports. */
function contextOf(text: string, index: number): string {
  const start = Math.max(0, index - 40);
  return text.slice(start, index + 50).replace(/\s+/g, " ").trim();
}

/** Audits the page in each variant. */
export async function auditVariants(ctx: Ctx, page: Page, findings: Findings, name: string, variants: Variant[], options: Omit<AuditOptions, "name" | "variant"> = {}): Promise<AuditSummary[]> {
  const out: AuditSummary[] = [];
  for (const entry of variants) out.push(await auditPage(ctx, page, findings, { ...options, name, variant: entry }));
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* "Powered by" and the dock                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface PoweredBy {
  found: boolean;
  href?: string;
  text?: string;
  rect?: { x: number; y: number; w: number; h: number };
  inView?: boolean;
  covered?: string | null;
  overlaps?: string[];
  visible?: boolean;
  scrollHeight?: number;
  viewport?: number;
}

export async function poweredBy(page: Page): Promise<PoweredBy> {
  return kit<PoweredBy>(page, "poweredBy()");
}

export interface DockClearance {
  dock: { x: number; y: number; w: number; h: number } | null;
  dockEl?: string;
  lowestContent?: number | null;
  lowestEl?: string | null;
  gap?: number | null;
  overlapping?: Array<{ el: string; rect: { x: number; y: number; w: number; h: number } }>;
  scrolledTo: number;
  viewport?: number;
  scrollHeight?: number;
}

/** Scrolls to the bottom and measures the room between the last content and the floating dock. */
export async function dockClearance(page: Page): Promise<DockClearance> {
  const answer = await kit<DockClearance>(page, "dockClearance()");
  await sleep(150);
  return answer;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Keyboard                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface FocusStop {
  /** The same number every time the same element is focused (in this document). */
  uid?: number;
  none: boolean;
  el?: string;
  tag?: string;
  type?: string;
  role?: string;
  name?: string;
  rect?: { x: number; y: number; w: number; h: number };
  /** Its first line box (a wrapped link's own start; the same as rect otherwise). */
  line?: { x: number; y: number; w: number; h: number };
  inView?: boolean;
  fully?: boolean;
  obscuredBy?: string | null;
  changed?: string[] | null;
  inert?: boolean;
  ariaHidden?: boolean;
  visible?: boolean;
  focusVisible?: boolean;
  scrollY?: number;
  /**
   * Whether its pixels (and 16 px around) differ focused and unfocused: "unstable" when they change on their own
   * meanwhile (a countdown), "unmeasured" when they could not be taken.
   */
  pixels?: "differs" | "same" | "unstable" | "unmeasured";
  /** For a stop next to the previous one: whether moving focus from it to here changes anything around here. */
  moves?: "differs" | "same" | "unstable" | "unmeasured";
}

/** Tab in Chromium, Option+Tab in WebKit (like Safari, whose plain Tab skips buttons and links). */
export const tabKey = (env: Env, back = false) => (env.engine === "webkit" ? (back ? "Alt+Shift+Tab" : "Alt+Tab") : back ? "Shift+Tab" : "Tab");

/** Remembers every focusable element's unfocused look (blurs the focused one first). */
export async function snapshotLooks(page: Page): Promise<number> {
  return kit<number>(page, "snapshotLooks()");
}

export async function activeFocus(page: Page): Promise<FocusStop> {
  return kit<FocusStop>(page, "activeFocus()");
}

/** Starts sequential focus navigation from the top of the document (the next Tab reaches the first focusable). */
export async function focusFromTop(page: Page): Promise<void> {
  await page.evaluate("(() => { const b = document.body; const had = b.hasAttribute('tabindex'); if (!had) b.setAttribute('tabindex', '-1'); b.focus({ preventScroll: true }); if (!had) b.removeAttribute('tabindex'); window.scrollTo({ left: 0, top: 0, behavior: 'instant' }); })()");
}

type Clip = { x: number; y: number; width: number; height: number };

/** The focused element and 16 px around it (a field's border is often drawn by its shell, outside the input). */
function clipFor(page: Page, stop: FocusStop): Clip | null {
  const viewport = page.viewportSize();
  if (!viewport || !stop.rect) return null;
  const x = Math.max(0, stop.rect.x - 16);
  const y = Math.max(0, stop.rect.y - 16);
  const width = Math.min(viewport.width, stop.rect.x + stop.rect.w + 16) - x;
  const height = Math.min(viewport.height, stop.rect.y + stop.rect.h + 16) - y;
  return width < 2 || height < 2 ? null : { x, y, width, height };
}

/** Screenshots of `clip` until two in a row match (a script-driven ring or fade has come to rest), or null. */
async function settledShot(page: Page, clip: Clip): Promise<Buffer | null> {
  const shoot = () => page.screenshot({ clip, animations: "disabled" }).catch(() => null);
  let last = await shoot();
  // Up to about 2 s: a spring that glides a focus ring between cells takes a moment to come to rest.
  for (let i = 0; i < 16 && last; i++) {
    await sleep(120);
    const next = await shoot();
    if (!next) return null;
    if (next.equals(last)) return next;
    last = next;
  }
  return null;
}

/**
 * Whether focus shows on the focused element in pixels: a screenshot of it (and 16 px around) focused, then blurred,
 * then focused again as keyboard focus (:focus-visible on, checked). The two focused shots must match (else something changes on its own, like a
 * countdown, and the answer is "unstable"); the focused and unfocused ones must differ. This sees indicators drawn by
 * other elements (a ring that slides between code cells, an inline editor's frame) and never takes a computed change
 * that paints nothing (a transparent outline) for a visible one.
 */
export async function focusPixels(env: Env, page: Page, stop: FocusStop): Promise<"differs" | "same" | "unstable" | "unmeasured"> {
  const clip = clipFor(page, stop);
  if (!clip) return "unmeasured";
  const focused = await settledShot(page, clip);
  if (!focused) return "unstable";
  if (!(await page.evaluate("window.__uxa.blurActive()").catch(() => false))) return "unmeasured";
  const rest = await settledShot(page, clip);
  // Back to it as keyboard focus: Chromium keeps the Tab starting point after blur(), so Shift+Tab, Tab returns to it;
  // WebKit restarts from the top after blur(), and its script focus() keeps :focus-visible after keyboard use.
  if (env.engine === "chromium") {
    await page.keyboard.press(tabKey(env, true));
    await sleep(150);
    await page.keyboard.press(tabKey(env));
    await sleep(200);
  }
  if ((await activeFocus(page)).uid !== stop.uid) {
    await page.evaluate("window.__uxa.refocus()").catch(() => undefined);
    await sleep(200);
  }
  const back = await activeFocus(page);
  if (back.uid !== stop.uid || !back.focusVisible) return "unmeasured";
  const again = await settledShot(page, clip);
  if (!rest || !again || !focused.equals(again)) return "unstable";
  return focused.equals(rest) ? "same" : "differs";
}

/**
 * Whether moving focus here from the previous stop changes anything around this stop: the same clip with focus on
 * the previous stop (Shift+Tab) and back here (Tab). A control inside another one's shell (a combobox's clear button)
 * can borrow the shell's :focus-within ring, which shows for both: then a Carbon cannot see focus move.
 */
export async function focusMoves(env: Env, page: Page, stop: FocusStop): Promise<"differs" | "same" | "unstable" | "unmeasured"> {
  const clip = clipFor(page, stop);
  if (!clip) return "unmeasured";
  const here = await settledShot(page, clip);
  await page.keyboard.press(tabKey(env, true));
  await sleep(200);
  const before = await settledShot(page, clip);
  await page.keyboard.press(tabKey(env));
  await sleep(200);
  const back = await activeFocus(page);
  const again = await settledShot(page, clip);
  if (back.uid !== stop.uid || !here || !before || !again) return "unmeasured";
  if (!here.equals(again)) return "unstable";
  return here.equals(before) ? "same" : "differs";
}

/** Presses Tab up to `max` times from the top and returns every stop (stops when focus cycles or leaves the page). */
export async function tabWalk(env: Env, page: Page, max = 40): Promise<FocusStop[]> {
  // The pointer parked in the corner: a hovered control would look the same focused and unfocused.
  await page.mouse.move(0, 0).catch(() => undefined);
  await sleep(150);
  await snapshotLooks(page);
  await focusFromTop(page);
  const stops: FocusStop[] = [];
  const seen = new Set<number>();
  let empty = 0;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(tabKey(env));
    await sleep(180);
    const stop = await activeFocus(page);
    if (stop.none) {
      if (++empty >= 2) break;
      continue;
    }
    if (stop.uid !== undefined) {
      if (seen.has(stop.uid)) break;
      seen.add(stop.uid);
    }
    if (stop.visible) stop.pixels = await focusPixels(env, page, stop);
    // A neighbour close enough to share this stop's surroundings: does focus visibly move from it to here?
    const previous = stops[stops.length - 1];
    if (stop.visible && stop.pixels === "differs" && previous?.rect && stop.rect && near(previous.rect, stop.rect)) stop.moves = await focusMoves(env, page, stop);
    stops.push(stop);
  }
  return stops;
}

/** Two boxes within 16 px of each other. */
function near(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x - 16 < b.x + b.w && b.x - 16 < a.x + a.w && a.y - 16 < b.y + b.h && b.y - 16 < a.y + a.h;
}

/**
 * Whether a stop shows where focus is. "none": its pixels are the same focused and unfocused, or focus visibly does
 * not move to it from the neighbour before it. "shows": its pixels change with focus (or, when the pixels cannot
 * tell, its computed look, its wrapper's or its neighbour's changes). "inconclusive": the pixels change on their own
 * (a countdown, a ring still gliding) and nothing in the computed look changed: listed, not failed.
 */
export function focusVerdict(stop: FocusStop): "shows" | "none" | "inconclusive" {
  if (stop.moves === "same") return "none";
  if (stop.pixels === "differs") return "shows";
  // A field you type in shows focus with its caret (WCAG 2.4.7 counts it), which screenshots leave out.
  if (TEXT_ENTRY(stop)) return "shows";
  if (stop.pixels === "same") return "none";
  return stop.changed && stop.changed.length > 0 ? "shows" : "inconclusive";
}

/** A field that takes typed text (its caret shows where focus is). */
const TEXT_ENTRY = (stop: FocusStop) => stop.tag === "textarea" || (stop.tag === "input" && /^(|text|search|email|tel|url|password|number)$/.test(stop.type ?? ""));

/** Whether a stop shows where focus is (not "none"). */
export const showsFocus = (stop: FocusStop) => focusVerdict(stop) !== "none";

/** Presses Tab until the focused element matches, up to `max` presses; returns the stop or null. */
export async function tabTo(env: Env, page: Page, match: (stop: FocusStop) => boolean, max = 30): Promise<FocusStop | null> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(tabKey(env));
    await sleep(120);
    const stop = await activeFocus(page);
    if (!stop.none && match(stop)) return stop;
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Motion                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface MotionSummary {
  frames: number;
  ms: number;
  motionAnimations: Array<{ name: string; target: string; pseudo: string | null; props: string[]; duration: number; infinite: boolean; frames: number }>;
  fadeAnimations: number;
  infinite: Array<{ name: string; target: string; pseudo: string | null; duration: number }>;
  viewTransitions: number;
  moving: Array<{ el: string; frames: number; px: number }>;
  movingCount: number;
  fading: number;
}

/** Samples every frame while `action` runs and for `windowMs` after it starts. */
export async function probeMotion(page: Page, action: () => Promise<unknown>, windowMs = 1_400, selector = "body *"): Promise<MotionSummary> {
  await kit(page, `motionStart(${JSON.stringify({ selector })})`);
  const started = Date.now();
  await action();
  const left = windowMs - (Date.now() - started);
  if (left > 0) await sleep(left);
  return (await page.evaluate("window.__uxa.motionStop()")) as MotionSummary;
}

export const describeMotion = (m: MotionSummary) =>
  `${m.frames} frames/${m.ms} ms; ${m.motionAnimations.length} moving animations${m.motionAnimations.length ? ` (${m.motionAnimations.slice(0, 4).map(a => `${a.name}${a.pseudo ?? ""} on ${a.target.slice(0, 50)} [${a.props.join(",")}] ${a.duration}ms`).join("; ")})` : ""}; ${m.movingCount} elements moved over 3+ frames${m.moving.length ? ` (${m.moving.slice(0, 4).map(e => `${e.el.slice(0, 60)} ${e.px}px/${e.frames}f`).join("; ")})` : ""}; ${m.viewTransitions} view-transition animations; ${m.fading} fading elements; ${m.infinite.length} infinite`;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Flows                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export const freshEmail = (who: string) => `${who}.${tag()}${tag()}@example.test`;

/** The hosted sign-in link of a fake app (its "Sign in with Silicon Accounts" link). */
export async function hostedLink(env: Env, page: Page, app: string): Promise<string> {
  await page.goto(`${env.apps}/${app}/`);
  const href = (await page.locator("#signin-hosted").getAttribute("href", { timeout: 20_000 })) ?? "";
  if (!href.startsWith(env.site)) throw new Error(`${app}'s hosted link does not point at the site: ${href}`);
  return href;
}

/**
 * On a hosted choose_method step: types the email and asks for the code; returns the code once it arrives. An app whose
 * methods page opens on the phone (dm lists phone first) shows "Phone | Email": the Email segment is chosen first.
 */
export async function sendEmailCode(env: Env, page: Page, email: string): Promise<string> {
  const field = page.getByRole("textbox", { name: "Email" });
  const segment = page.getByRole("button", { name: "Email", exact: true });
  await field.or(segment).first().waitFor({ timeout: 30_000 });
  if (!(await field.isVisible().catch(() => false))) await segment.click();
  await field.waitFor({ timeout: 30_000 });
  const after = await lastSeq(env);
  await field.fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const code = await codeFor(env, email, after);
  await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 20_000 });
  return code;
}

/** Waits for a hosted step to be on screen (its fonts ready, the morph finished). */
export async function stepReady(page: Page): Promise<void> {
  await page.locator('main[data-fonts="ready"]').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  await settle(page, 400);
}

/** A signed-in Carbon on the account site, in an audited context. */
export async function signedInCarbon(ctx: Ctx, who: string, options: ContextOptions = {}): Promise<{ context: BrowserContext; page: Page; email: string; id: string; uuid: string }> {
  const { env, browser } = ctx;
  const context = await auditContext(browser, options);
  const page = await context.newPage();
  const email = freshEmail(who);
  await page.goto(`${env.site}/sign-in`);
  const field = page.getByRole("textbox", { name: "Email" });
  await field.waitFor({ timeout: 30_000 });
  const after = await lastSeq(env);
  await field.fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const code = await codeFor(env, email, after);
  await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 20_000 });
  await page.keyboard.type(code, { delay: 25 });
  await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
  await page.waitForURL(`${env.site}/`, { timeout: 30_000 });
  const me = (await (await page.request.get(`${env.site}/v1/me`)).json()) as { id?: string; uuid?: string };
  return { context, page, email, id: me.id ?? "", uuid: me.uuid ?? "" };
}

/** Where production keeps the default photos (ACCOUNTS_IRIS_BASE_URL's default in crates/core/src/config.rs). */
const PRODUCTION_IRIS = "https://iris.teamofsilicons.com";

/**
 * Test data, not the site: the harness seeds the fake apps' owners (c:saket, c:shubham, c:acme-dev, …) with photos on
 * the production Iris, because scripts/dev.sh runs accounts-seed with base_env(), which exports no
 * ACCOUNTS_IRIS_BASE_URL (Settings then falls back to https://iris.teamofsilicons.com), while accounts-api and the site
 * get this stack's mock Iris. A page showing a seeded owner would load a photo from the internet, which says nothing
 * about the site and breaks the README's "no page loads a photo from the internet". This points those photos at this
 * stack's mock Iris (same path and id), in this stack's own database, before a journey shows them, and records how
 * many it moved (the harness defect stays in the findings and the metrics). Idempotent.
 */
export async function localSeedPhotos(ctx: Ctx, findings?: Findings): Promise<number> {
  const rows = await sql(ctx.env, `with moved as (update accounts set pfp_url = '${ctx.env.iris}' || substr(pfp_url, ${PRODUCTION_IRIS.length + 1}) where pfp_url like '${PRODUCTION_IRIS}/%' returning handle) select handle from moved order by handle`);
  const handles = rows.map(row => row[0] ?? "").filter(Boolean);
  ctx.results.metric("seeded accounts whose photo pointed at the production Iris (harness: scripts/dev.sh seeds without ACCOUNTS_IRIS_BASE_URL)", handles.length, "count");
  if (handles.length) findings?.notes.push(`harness: ${handles.length} seeded accounts had photos on ${PRODUCTION_IRIS} (${handles.join(", ")}); moved to this stack's mock Iris ${ctx.env.iris} before the walk. Cause: scripts/dev.sh base_env() exports no ACCOUNTS_IRIS_BASE_URL for accounts-seed.`);
  return handles.length;
}

/** briefcase's seeded owner (c:saket), whose apps the developer pages need populated. */
export const SEEDED_OWNER_EMAIL = "saketdev12@example.test";
/** ledgerly's seeded owner (c:ledgerly-dev): the app with a two-page flow and a review page. */
export const LEDGERLY_OWNER_EMAIL = "dev@ledgerly.test";

/**
 * Every sign-in sends a code to the owner's address, and the suite signs in as a seeded owner in several journeys (more
 * on a stack walked again with --keep), so the per-address limit (10 codes in 10 minutes) would refuse the suite's own
 * later sign-ins: the window of the codes already sent there is moved past (README "Time travel"), and the seeded
 * photos are made local (localSeedPhotos).
 */
async function prepareSeededOwner(ctx: Ctx, email: string, findings?: Findings): Promise<void> {
  await sql(ctx.env, `update otp_challenges set created_at = created_at - interval '11 minutes' where destination = '${email.replace(/'/g, "")}' and created_at > now() - interval '11 minutes'`);
  await localSeedPhotos(ctx, findings);
}

/** Signs `page` in to the account site as a seeded owner (default briefcase's, c:saket). */
export async function signInAsSeededOwner(ctx: Ctx, page: Page, findings?: Findings, email = SEEDED_OWNER_EMAIL): Promise<void> {
  await prepareSeededOwner(ctx, email, findings);
  await signInOnSite(ctx.env, page, email);
}

/** Signs `page` in to the developer site (through its BFF) as a seeded owner (default briefcase's, c:saket). */
export async function signInAsSeededOwnerOnDeveloper(ctx: Ctx, page: Page, findings?: Findings, email = SEEDED_OWNER_EMAIL, returnTo = "/"): Promise<void> {
  await prepareSeededOwner(ctx, email, findings);
  await signInOnDeveloper(ctx.env, page, email, { returnTo });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The developer site                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The tabs of an app on the developer site (developer/lib/app-tabs.ts), and the address of each. */
export const TABS = ["overview", "sign-in", "details", "flows", "pages", "users", "import", "webhooks", "ata", "embed"] as const;
export const tabPath = (appId: string, tab: (typeof TABS)[number]) => `/apps/${appId}${tab === "overview" ? "" : `/${tab}`}`;

/** What the developer site's pages log on purpose: the session probe's 401 before signing in. */
export const DEVELOPER_EXPECTED = [DEVELOPER_SIGNED_OUT];

/** A new Carbon signed in to the developer site (signed up on the account site through the hosted pages on the way). */
export async function developerCarbon(ctx: Ctx, who: string, options: ContextOptions = {}): Promise<{ context: BrowserContext; page: Page; email: string; id: string; uuid: string }> {
  const context = await auditContext(ctx.browser, options);
  const page = await context.newPage();
  const email = freshEmail(who);
  await signInOnDeveloper(ctx.env, page, email);
  const me = await developerApi<{ id?: string; uuid?: string }>(ctx.env, page, "/me");
  return { context, page, email, id: me.body?.id ?? "", uuid: me.body?.uuid ?? "" };
}

/**
 * Makes an app owned by `ownerUuid` in the stack's database, as Silicon Apps would deliver one (UNDERSTANDING.md "Until
 * Silicon Apps exists": apps are not created on our sites), with `from`'s sign-in setup, logo and secret.
 */
export async function ownedApp(ctx: Ctx, ownerUuid: string, appId: string, name: string, from = "briefcase"): Promise<void> {
  const quote = (value: string) => value.replace(/'/g, "''");
  await sql(ctx.env, `insert into apps (app_id, name, description, logo_url, logo_dark_url, homepage_url, owner_uuid, secret_hash, status, source)
    select '${quote(appId)}', '${quote(name)}', 'An app the ux-audit suite made for its owner', logo_url, logo_dark_url, homepage_url, '${quote(ownerUuid)}', secret_hash, 'active', 'fake' from apps where app_id = '${quote(from)}'`);
  await sql(ctx.env, `insert into app_signin_configs (app_id, version, config, updated_by) select '${quote(appId)}', 1, config, 'system' from app_signin_configs where app_id = '${quote(from)}' order by version desc limit 1`);
}

/** Opens a developer-site page and waits until its content (not the shell's or the tab's loading state) has settled. */
export async function openDeveloperPage(ctx: Ctx, page: Page, path: string): Promise<string> {
  await page.goto(`${ctx.env.developer}${path}`);
  await page.locator("main").first().waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  await waitUntil(page, "!document.querySelector('[aria-busy=\"true\"]')", 20_000);
  await settle(page, 900);
  return (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
}

/** A same-origin fetch from the page itself (the browser sends Origin, which cookie mutations need). */
export async function pageFetch<T = unknown>(page: Page, path: string, init: { method?: string; body?: unknown; idempotent?: boolean } = {}): Promise<{ status: number; body: T }> {
  const script = `(async () => {
    const headers = { "content-type": "application/json" };
    ${init.idempotent === false ? "" : 'headers["idempotency-key"] = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));'}
    const response = await fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(init.method ?? "GET")}, headers, credentials: "same-origin"${init.body === undefined ? "" : `, body: ${JSON.stringify(JSON.stringify(init.body))}`} });
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    return { status: response.status, body };
  })()`;
  return (await page.evaluate(script)) as { status: number; body: T };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Account pages                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Opens an account page and waits until its content (not the shell's loading state) is on screen. */
export async function openAccountPage(ctx: Ctx, page: Page, path: string, ready: RegExp): Promise<string> {
  await page.goto(`${ctx.env.site}${path}`);
  await page.locator("main").first().waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  await waitUntil(page, `new RegExp(${JSON.stringify(ready.source)}).test((document.querySelector("main") || {}).textContent || "")`, 20_000);
  await settle(page, 700);
  return (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
}

/** The floating dock (1440) or the compact bar (390) never covers the last content once scrolled to the bottom. */
export async function checkDock(ctx: Ctx, page: Page, findings: Findings, name: string): Promise<void> {
  for (const [width, height, theme] of [[1440, 900, "light"], [390, 844, "dark"]] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await settle(page, 300);
    const clearance = await dockClearance(page);
    findings.pages[`${name} dock ${width}`] = clearance;
    await page.screenshot({ path: `${ctx.env.shots}/uxa-${name}-bottom-${width}.png` }).catch(() => undefined);
    ctx.results.check(
      `${name} ${width}: at the bottom of the page no content sits under the ${width < 640 ? "compact navigation bar" : "dock"} (gap ≥ 8 px)`,
      !!clearance.dock && (clearance.overlapping?.length ?? 0) === 0 && (clearance.gap ?? -1) >= 8,
      clearance.dock ? `dock ${JSON.stringify(clearance.dock)}; lowest content ${clearance.lowestEl} at ${clearance.lowestContent} (gap ${clearance.gap}px); under the dock: ${clearance.overlapping?.map(entry => entry.el).join("; ") || "nothing"}` : "no dock found",
    );
    await page.evaluate("window.scrollTo({ left: 0, top: 0, behavior: 'instant' })");
  }
}

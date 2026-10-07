/**
 * Live checks of the account pages, in a real browser against a running site and accounts-api: a stack started by
 * scripts/dev.sh, or one kept by scripts/e2e.sh --keep (any port base). The checks sign up Carbons of their own through
 * the site's /sign-in (codes from the dev outbox, so the API runs with ACCOUNTS_EXPOSE_DEV_OUTBOX=true, as scripts/dev.sh
 * starts it), each browser context with its own forwarded address, so they run again and again on the same stack.
 *
 *   pnpm -C web checks:account --live http://localhost:8590
 *   … --only silicon,words      checks whose name contains one of these
 *   … --webkit                  in WebKit instead of Chromium
 *   CHECKS_SHOTS=<dir>          screenshots of the page of a check that failed
 *
 * They guard what the e2e walk and the UX audit found on these pages:
 *
 *   settings-delete   deleting the account on Settings lands on the signed-out landing page without calling
 *                     POST /v1/session/signout (the deletion already ended every session, so it could only answer 401,
 *                     which browsers log as a failed request) or any other /v1 call that fails
 *   silicon-tiles     every word a Silicon tile's button shows is part of its accessible name (WCAG 2.5.3, axe
 *                     label-content-name-mismatch), the name still starts "Manage <si:id>", a click anywhere on the tile
 *                     opens the Silicon, and keyboard focus on the button shows on the whole tile
 *   request-deck      a custodian request is a list item named for its Silicon that axe accepts (aria-allowed-role: an
 *                     <article> may not be a listitem)
 *   heading-order     /apps, /proofs and /activity go h1, h2, h3 in their empty and filled views (axe heading-order)
 *   words             the account pages and their dialogs never call Carbons and Silicons "people"
 *
 * Every check also fails on a page error or a console error.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, webkit, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

interface Env {
  base: string;
  browser: Browser;
  /** axe-core's browser build, installed in every document of every context. */
  axe: string;
  /** A tag unique to this run (ids and emails). */
  run: string;
  /** The Carbon the checks that change nothing irreversible share (made on first use). */
  keeper?: Carbon;
}

interface Carbon {
  context: BrowserContext;
  page: Page;
  email: string;
  id: string;
  uuid: string;
}

interface Check {
  name: string;
  run: (env: Env) => Promise<void>;
}

interface Violation {
  id: string;
  impact: string | null;
  nodes: string[];
}

const problems: string[] = [];
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const byte = () => 1 + Math.floor(Math.random() * 254);

function expect(condition: boolean, message: string): void {
  if (!condition) problems.push(message);
}

/** axe-core's browser build from the site's node_modules (eslint-config-next brings it; the newest one there). */
function axeSource(): string {
  const store = resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/.pnpm");
  const versions = existsSync(store) ? readdirSync(store).filter(name => /^axe-core@\d/.test(name)).sort((a, b) => a.localeCompare(b, "en", { numeric: true })) : [];
  const newest = versions[versions.length - 1];
  const file = newest ? join(store, newest, "node_modules", "axe-core", "axe.min.js") : "";
  if (!file || !existsSync(file)) throw new Error(`axe-core is not in ${store}: run pnpm -C web install.`);
  return readFileSync(file, "utf8");
}

/** Runs the named axe rules over the page; the violations, each with up to five of its elements. */
async function axe(page: Page, rules: string[]): Promise<Violation[]> {
  const script = `(async () => {
    const result = await window.axe.run(document, { runOnly: { type: "rule", values: ${JSON.stringify(rules)} }, resultTypes: ["violations"] });
    return result.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map(n => n.html.slice(0, 200)) }));
  })()`;
  return (await page.evaluate(script)) as Violation[];
}

const describeViolations = (violations: Violation[]) => violations.map(item => `${item.id} (${item.impact}) ${item.nodes.join(" | ")}`).join("; ");

/** A call to the API from the page (its cookie, its forwarded address, the site's origin). */
async function call<T>(page: Page, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ path, method, body }) => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method && method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
    const response = await fetch(path, { method: method ?? "GET", headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "include" });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed as T };
  }, { path, method: init.method, body: init.body });
}

/**
 * Browser noise that is not a fault of the site (the e2e walk's list, e2e/lib.ts): WebKit reports Next's route
 * prefetches cut short by a full navigation (every page.goto here) as an aborted fetch "due to access control checks".
 */
const BENIGN = [/_rsc=.* due to access control checks/];

function watch(page: Page, label: string): void {
  const noise = (text: string) => BENIGN.some(pattern => pattern.test(text));
  page.on("console", message => {
    if (message.type() === "error" && !noise(message.text())) problems.push(`${label}: console error: ${message.text().slice(0, 300)}`);
  });
  page.on("pageerror", failure => {
    if (!noise(failure.message)) problems.push(`${label}: page error: ${failure.message.slice(0, 300)}`);
  });
}

/** The newest code sent to `email` after `after` (ms since the epoch), from the dev outbox. */
async function outboxCode(base: string, email: string, after: number): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await fetch(`${base}/v1/dev/outbox?to=${encodeURIComponent(email)}&limit=5`);
    if (!response.ok) throw new Error(`GET /v1/dev/outbox answered ${response.status}: start the API with ACCOUNTS_EXPOSE_DEV_OUTBOX=true.`);
    const body = (await response.json()) as { items: Array<{ code: string | null; created_at: string }> };
    const code = body.items.find(item => item.code && Date.parse(item.created_at) > after)?.code;
    if (code) return code;
    await sleep(250);
  }
  throw new Error(`no code reached the dev outbox for ${email}`);
}

/** Signs a new Carbon up on the site's own /sign-in, in a context of its own; lands on the identity home. */
async function newCarbon(env: Env, label: string, viewport = { width: 1440, height: 900 }): Promise<Carbon> {
  const context = await env.browser.newContext({ viewport, locale: "en-US", timezoneId: "Asia/Kolkata" });
  await context.addInitScript({ content: env.axe });
  // Its own forwarded address on the site's /v1 (the stacks trust it), so the per-network limits are its own.
  const ip = `10.${byte()}.${byte()}.${byte()}`;
  await context.route(`${env.base}/v1/**`, route => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": ip } }));
  const page = await context.newPage();
  watch(page, label);
  const email = `chk.${label}.${env.run}.${Math.random().toString(36).slice(2, 7)}@example.test`;
  await page.goto(`${env.base}/sign-in`);
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  const sentAfter = Date.now() - 2_000;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const code = await outboxCode(env.base, email, sentAfter);
  await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
  await page.keyboard.type(code, { delay: 25 });
  await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
  await page.waitForURL(`${env.base}/`, { timeout: 30_000 });
  const me = await call<{ uuid: string; id: string }>(page, "/v1/me");
  if (me.status !== 200) throw new Error(`GET /v1/me answered ${me.status} after signing up ${email}`);
  return { context, page, email, id: me.body.id, uuid: me.body.uuid };
}

async function keeper(env: Env): Promise<Carbon> {
  env.keeper ??= await newCarbon(env, "keeper");
  return env.keeper;
}

/**
 * Polls an expression in the page until it is truthy (page.waitForFunction would compile it in the page, which the
 * site's CSP refuses: no 'unsafe-eval').
 */
async function waitUntil(page: Page, expression: string, timeoutMs = 10_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await page.evaluate(expression).catch(() => false)) return true;
    if (Date.now() >= end) return false;
    await sleep(100);
  }
}

/** Waits until no finite animation is running (cards rising, the empty state settling). */
async function settle(page: Page, extra = 250): Promise<void> {
  await waitUntil(page, "document.getAnimations().every(a => a.playState !== 'running' || (a.effect && a.effect.getComputedTiming().iterations === Infinity))", 5_000);
  await sleep(extra);
}

async function visit(page: Page, url: string, heading: string | RegExp): Promise<void> {
  await page.goto(url);
  await page.getByRole("heading", { level: 1, name: heading }).waitFor({ timeout: 30_000 });
  await waitUntil(page, "!document.querySelector('main [aria-busy=true]')", 20_000);
  await settle(page);
}

/** Every word a page shows on screen or to a screen reader: its text, labels, titles, placeholders and alt texts. */
const pageWords = (page: Page) => page.evaluate(`(() => {
  const parts = [document.title, document.body.innerText];
  for (const el of document.querySelectorAll("[aria-label],[title],[placeholder],img[alt],[aria-description]")) {
    for (const name of ["aria-label", "title", "placeholder", "alt", "aria-description"]) { const v = el.getAttribute(name); if (v) parts.push(v); }
  }
  for (const el of document.querySelectorAll(".sr-only")) parts.push(el.textContent || "");
  return parts.join("\\n");
})()`) as Promise<string>;

/** Presses and holds a button for `ms` with the mouse. */
async function hold(page: Page, button: Locator, ms: number): Promise<void> {
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (!box) throw new Error("the hold button has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(ms);
  await page.mouse.up();
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Checks                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

const checks: Check[] = [
  {
    name: "settings-delete: deleting the account lands on the signed-out landing page with no sign-out call and no failing request",
    run: async env => {
      const leaver = await newCarbon(env, "leaver");
      const { page } = leaver;
      try {
        await visit(page, `${env.base}/settings`, "Settings");
        const section = page.getByRole("region", { name: "Delete your account" });
        await section.getByText(/Your account ends for good/).waitFor({ timeout: 20_000 });
        const signouts: string[] = [];
        const failing: string[] = [];
        page.on("request", request => {
          if (new URL(request.url()).pathname === "/v1/session/signout") signouts.push(`${request.method()} ${request.url()}`);
        });
        page.on("response", response => {
          if (response.url().startsWith(`${env.base}/v1/`) && response.status() >= 400) failing.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`);
        });
        const deleted = page.waitForResponse(response => new URL(response.url()).pathname === "/v1/me" && response.request().method() === "DELETE", { timeout: 20_000 });
        await hold(page, page.getByRole("button", { name: "Hold to delete your account" }), 2_600);
        const answer = await deleted;
        expect(answer.status() === 204, `DELETE /v1/me answered ${answer.status()}, not 204`);
        await page.waitForURL(`${env.base}/`, { timeout: 20_000 });
        const landing = await page.getByRole("link", { name: /sign in/i }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
        expect(landing, "after the deletion the browser did not land on the signed-out landing page");
        // Anything the old page or the landing page still asks for would show up by now.
        await sleep(1_500);
        expect(signouts.length === 0, `the site signed out a session the deletion had already ended: ${signouts.join(", ")}`);
        expect(failing.length === 0, `requests failed after the deletion: ${failing.join(", ")}`);
        const session = await leaver.context.request.get(`${env.base}/v1/session`);
        expect(session.status() === 401, `GET /v1/session answered ${session.status()} after the deletion, not 401`);
      } finally {
        await leaver.context.close();
      }
    },
  },
  {
    name: "silicon-tiles: a tile's button shows only words of its name, the name starts Manage <si:id>, the whole tile opens it, focus shows on the tile",
    run: async env => {
      const { page } = await keeper(env);
      const made: Array<{ id: string; name: string }> = [
        { id: `si:chk-scout-${env.run}`, name: `Scout ${env.run}` },
        { id: `si:chk-a-very-long-silicon-${env.run}`, name: `A Silicon With A Rather Long Display Name ${env.run}` },
      ];
      for (const silicon of made) {
        const created = await call(page, "/v1/me/silicons", { method: "POST", body: { id: silicon.id, display_name: silicon.name } });
        expect(created.status === 201, `POST /v1/me/silicons ${silicon.id} answered ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`);
      }
      await visit(page, `${env.base}/silicons`, "Silicons in your care");
      const stored = page.getByRole("button", { name: "I've stored it" });
      for (const silicon of made) await page.getByRole("button", { name: new RegExp(`^Manage ${escapeRegExp(silicon.id)}, ${escapeRegExp(silicon.name)}$`) }).waitFor({ timeout: 20_000 });
      await settle(page, 400);
      const violations = await axe(page, ["label-content-name-mismatch"]);
      expect(violations.length === 0, `axe: ${describeViolations(violations)}`);

      // The button holds the id and the name only: the status and the facts are the tile's own text, outside it.
      const inside = (await page.evaluate(`[...document.querySelectorAll("[data-silicon]")].map(b => ({ name: b.getAttribute("aria-label"), text: b.textContent }))`)) as Array<{ name: string | null; text: string }>;
      for (const silicon of made) {
        const tile = inside.find(item => item.name?.startsWith(`Manage ${silicon.id},`));
        expect(!!tile && tile.text.includes(silicon.id) && tile.text.includes(silicon.name), `the ${silicon.id} tile's button does not hold its id and name: ${JSON.stringify(tile)}`);
        expect(!!tile && !/STK|Webhook|Active|Waiting|Transfer/.test(tile.text), `the ${silicon.id} tile's button holds more than its id and name: ${JSON.stringify(tile?.text)}`);
      }

      // A click on the tile's facts (outside the button's own words) opens the Silicon.
      const scout = made[0]!;
      const button = page.getByRole("button", { name: new RegExp(`^Manage ${escapeRegExp(scout.id)},`) });
      const tile = page.locator("[data-sq]").filter({ has: button }).last();
      const box = await tile.boundingBox();
      if (!box) throw new Error("the Scout tile has no box");
      await tile.click({ position: { x: box.width - 24, y: box.height - 14 } });
      const drawer = page.getByRole("dialog").filter({ hasText: scout.id }).first();
      const opened = await drawer.waitFor({ timeout: 10_000 }).then(() => true, () => false);
      expect(opened, "a click on the tile's facts did not open the Silicon");
      if (opened) {
        await sleep(400);
        await page.keyboard.press("Escape");
        await drawer.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
        await page.mouse.move(0, 0);
        await settle(page, 300);
        // Focus came back to the tile's button from the keyboard: the tile shows it (its border takes the accent).
        const focus = (await page.evaluate(`(() => {
          const active = document.activeElement;
          const tile = active && active.closest("[data-sq]");
          const other = [...document.querySelectorAll("[data-silicon]")].find(b => b !== active);
          const otherTile = other && other.closest("[data-sq]");
          return {
            active: active ? active.tagName.toLowerCase() + (active.getAttribute("role") ? "[role=" + active.getAttribute("role") + "]" : "") : null,
            silicon: active ? active.getAttribute("data-silicon") : null,
            visible: active ? active.matches(":focus-visible") : false,
            border: tile ? getComputedStyle(tile).borderTopColor : null,
            otherBorder: otherTile ? getComputedStyle(otherTile).borderTopColor : null,
          };
        })()`)) as { active: string | null; silicon: string | null; visible: boolean; border: string | null; otherBorder: string | null };
        expect(!!focus.silicon && focus.visible, `after Escape, focus is not back on the tile's button as keyboard focus (${JSON.stringify(focus)})`);
        expect(!!focus.border && focus.border !== focus.otherBorder, `keyboard focus on the tile's button does not show on the tile: its border ${focus.border}, another tile's ${focus.otherBorder}`);
      }
      // A Silicon made here shows its STK once; store it so the next checks start from a quiet page.
      while (await stored.first().isVisible().catch(() => false)) {
        await stored.first().click();
        await sleep(500);
      }
    },
  },
  {
    name: "request-deck: a custodian request is a list item named for its Silicon, and axe accepts its role",
    run: async env => {
      const carbon = await keeper(env);
      const { page } = carbon;
      const asking = `si:chk-asks-${env.run}`;
      const created = await call(page, "/v1/silicons", { method: "POST", body: { id: asking, display_name: `Asks ${env.run}`, custodian: carbon.id } });
      expect(created.status === 201 || created.status === 202, `POST /v1/silicons answered ${created.status}: ${JSON.stringify(created.body).slice(0, 200)}`);
      await visit(page, `${env.base}/silicons`, "Silicons in your care");
      const card = page.getByRole("listitem", { name: `Custodian request from ${asking}` });
      const shown = await card.waitFor({ timeout: 20_000 }).then(() => true, () => false);
      expect(shown, `no list item named "Custodian request from ${asking}"`);
      await settle(page, 400);
      const violations = await axe(page, ["aria-allowed-role", "list", "listitem"]);
      expect(violations.length === 0, `axe: ${describeViolations(violations)}`);
    },
  },
  {
    name: "heading-order: /apps, /proofs and /activity go h1, h2, h3 in their empty and filled views",
    run: async env => {
      const { page } = await keeper(env);
      const views: Array<{ url: string; title: string; switchTo?: { group: string; option: RegExp } }> = [
        { url: "/apps", title: "Apps you have signed into" },
        { url: "/apps", title: "Apps you have signed into", switchTo: { group: "Which apps", option: /^Access removed/ } },
        { url: "/proofs", title: "Proofs about you" },
        { url: "/proofs", title: "Proofs about you", switchTo: { group: "Which proofs", option: /^Ended/ } },
        { url: "/activity", title: "Activity" },
        { url: "/activity", title: "Activity", switchTo: { group: "Show", option: /^Proofs$/ } },
      ];
      for (const view of views) {
        await visit(page, `${env.base}${view.url}`, view.title);
        if (view.switchTo) {
          await page.getByRole("group", { name: view.switchTo.group }).getByRole("button", { name: view.switchTo.option }).click();
          await settle(page, 600);
        }
        const where = `${view.url}${view.switchTo ? ` (${view.switchTo.option.source})` : ""}`;
        const violations = await axe(page, ["heading-order", "page-has-heading-one", "empty-heading"]);
        expect(violations.length === 0, `${where}: axe: ${describeViolations(violations)}`);
        const outline = (await page.evaluate(`[...document.querySelectorAll("main h1, main h2, main h3, main h4, main [role=heading]")].map(h => (h.getAttribute("aria-level") || h.tagName.slice(1)) + " " + h.textContent.trim().slice(0, 40))`)) as string[];
        expect(outline.length >= 2 && outline[0]!.startsWith("1 ") && outline[1]!.startsWith("2 "), `${where}: the page's headings go ${outline.join(" → ")}`);
      }
    },
  },
  {
    name: "words: the account pages and their dialogs never call Carbons and Silicons people",
    run: async env => {
      const { page } = await keeper(env);
      const people = /\bpeople\b|\bperson\b|\bhumans?\b/i;
      const found: string[] = [];
      const look = async (where: string) => {
        const words = await pageWords(page);
        const hits = words.split("\n").filter(line => people.test(line));
        if (hits.length) found.push(`${where}: ${hits.map(line => JSON.stringify(line.trim().slice(0, 120))).join(", ")}`);
      };
      for (const [url, title] of [["/", "Your identity"], ["/sign-in-methods", "Sign-in methods"], ["/apps", "Apps you have signed into"], ["/proofs", "Proofs about you"], ["/silicons", "Silicons in your care"], ["/activity", "Activity"], ["/settings", "Settings"]] as const) {
        await visit(page, `${env.base}${url}`, title);
        await look(url);
      }
      await visit(page, `${env.base}/silicons`, "Silicons in your care");
      await page.getByRole("button", { name: "Create a Silicon" }).first().click();
      const create = page.getByRole("dialog", { name: "Create a Silicon" });
      await create.waitFor({ timeout: 10_000 });
      await settle(page, 300);
      const createText = (await create.innerText()).replace(/\s+/g, " ");
      expect(createText.includes("What Carbons, Silicons and apps type to find it."), `the Create a Silicon id field says: ${createText.slice(0, 400)}`);
      await look("/silicons, Create a Silicon");
      await page.keyboard.press("Escape");
      await visit(page, `${env.base}/`, "Your identity");
      await page.getByRole("button", { name: "Change id" }).first().click();
      const change = page.getByRole("dialog", { name: "Change your id" });
      await change.waitFor({ timeout: 10_000 });
      await settle(page, 300);
      await look("/, Change your id");
      await page.keyboard.press("Escape");
      expect(found.length === 0, `"people" words: ${found.join("; ")}`);
    },
  },
];

/* ------------------------------------------------------------------------------------------------------------------ */
/* Runner                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

async function main(argv: string[]): Promise<void> {
  const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const base = value("--live")?.replace(/\/$/, "");
  if (!base) throw new Error("Usage: tsx components/account/checks.ts --live http://localhost:8590 [--only name,name] [--webkit]");
  const only = (value("--only") ?? "").split(",").map(item => item.trim()).filter(Boolean);
  const selected = checks.filter(check => !only.length || only.some(name => check.name.includes(name)));
  if (!selected.length) throw new Error(`No check matches --only ${only.join(",")}.`);
  const shots = process.env.CHECKS_SHOTS ? resolve(process.env.CHECKS_SHOTS) : null;
  if (shots) mkdirSync(shots, { recursive: true });
  const engine = argv.includes("--webkit") ? webkit : chromium;

  console.log(`Live checks of the account pages against ${base} (${argv.includes("--webkit") ? "WebKit" : "Chromium"})`);
  const browser = await engine.launch();
  const env: Env = { base, browser, axe: axeSource(), run: Date.now().toString(36).slice(-5) };
  let failures = 0;
  try {
    for (const check of selected) {
      const started = Date.now();
      problems.length = 0;
      try {
        await check.run(env);
      } catch (failure) {
        problems.push(`failed: ${failure instanceof Error ? failure.message.split("\n").slice(0, 8).join(" | ") : String(failure)}`);
      }
      if (problems.length) {
        failures++;
        if (shots && env.keeper) await env.keeper.page.screenshot({ path: join(shots, `${check.name.split(":")[0]}.png`), fullPage: true }).catch(() => undefined);
        console.log(`✗ ${check.name}\n${problems.map(problem => `    ${problem}`).join("\n")}`);
        await env.keeper?.page.keyboard.press("Escape").catch(() => undefined);
      } else console.log(`✓ ${check.name} (${Date.now() - started} ms)`);
    }
  } finally {
    await browser.close();
  }
  if (failures) {
    console.error(`\n${failures} of ${selected.length} check(s) failed.`);
    process.exitCode = 1;
  } else console.log(`\nAll ${selected.length} checks passed.`);
}

// Run directly (not when imported).
const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).catch(failure => {
    console.error(`checks: ${failure instanceof Error ? failure.message : String(failure)}`);
    process.exitCode = 1;
  });
}

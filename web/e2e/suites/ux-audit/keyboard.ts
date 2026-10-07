/**
 * ux-audit: the sign-in flows with the keyboard alone (Tab in Chromium, Option+Tab in WebKit), no mouse at all:
 *
 *   hosted        briefcase's hosted pages at 1440 light: every Tab stop of each step shows where focus is, is in view,
 *                 uncovered, never inside the leaving (inert) step, in reading order; then the whole sign-up is done
 *                 from the keyboard (email + Enter, the code, the timezone combobox and the date of birth by keys,
 *                 Create account, Share and continue) and the app receives the account
 *   first-party   the account site's own /sign-in at 390 dark: the same, Email ⇄ Phone by arrow keys, and the shell's
 *                 skip link on the home page it lands on
 *   developer     briefcase's owner on the Users and Import tabs at 1440 light: every Tab stop shows focus, in view,
 *                 never under the dock
 *
 * "Shows focus" is judged in pixels (_audit.ts focusPixels: the stop and 16 px around it, focused, unfocused, focused
 * again from the keyboard; and, next to the previous stop, whether focus visibly moves from it). A stop whose pixels
 * change on their own (a countdown, a ring still gliding) and whose computed look did not change is listed as
 * inconclusive, never failed; the Resend countdown gets a targeted check of what it paints instead.
 */
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { appAccount, codeFor, lastSeq, signInOnSite, sleep } from "../../lib";
import { activeFocus, auditContext, collectConsole, findingsFor, focusFromTop, focusVerdict, freshEmail, hostedLink, saveFindings, sendEmailCode, settle, stepReady, tabKey, tabTo, tabWalk, waitUntil, type Findings, type FocusStop } from "./_audit";

const label = (stop: FocusStop) => `${stop.name || stop.el} <${stop.tag}${stop.role ? ` role=${stop.role}` : ""}>`;
const evidence = (stop: FocusStop) => `pixels ${stop.pixels ?? "unmeasured"}${stop.moves ? `; from the previous stop ${stop.moves}` : ""}; computed look ${!stop.changed ? "not in the snapshot" : stop.changed.length ? `changed: ${stop.changed.slice(0, 4).join(", ")}` : "unchanged"}`;

/** What an element (and its first children) paints that a focus style could change; `target` is a JS expression. */
const paintScript = (target: string) => `(() => {
  const el = ${target};
  if (!el) return null;
  const pick = node => { const s = getComputedStyle(node); return [s.backgroundColor, s.color, s.borderTopColor, s.borderBottomColor, s.boxShadow, s.outlineStyle === "none" || /transparent|rgba\\(.*,\\s*0\\)$/.test(s.outlineColor) ? "no outline" : s.outlineColor + " " + s.outlineWidth, s.textDecorationLine, s.opacity].join("|"); };
  return [el, ...el.querySelectorAll("*")].slice(0, 8).map(pick).join(" / ");
})()`;

/** Walks every Tab stop of the step (or page) on screen and checks each one; returns the stops. */
async function walkStep(ctx: Ctx, page: Page, findings: Findings, name: string, expected: RegExp[], hosted = true): Promise<FocusStop[]> {
  const { env, results } = ctx;
  if (hosted) await stepReady(page);
  else await settle(page, 600);
  const stops = await tabWalk(env, page, 45);
  findings.pages[`${name} tab stops`] = stops;
  results.check(`${name}: Tab reaches the step's controls (${stops.length} stops)`, stops.length >= expected.length, stops.map(label).join(" → "));
  for (const pattern of expected) results.check(`${name}: Tab reaches ${pattern.source}`, stops.some(stop => pattern.test(stop.name ?? "") || pattern.test(stop.el ?? "")), stops.map(stop => stop.name).join(" | "));
  const unseen = stops.filter(stop => focusVerdict(stop) === "none");
  const unsure = stops.filter(stop => focusVerdict(stop) === "inconclusive");
  results.check(`${name}: every stop shows keyboard focus (WCAG 2.4.7)`, unseen.length === 0, [...unseen.map(stop => `${label(stop)} (${evidence(stop)})`), ...unsure.map(stop => `inconclusive, not counted: ${label(stop)} (${evidence(stop)})`)].join("; "));
  const hidden = stops.filter(stop => !stop.visible || !stop.inView);
  results.check(`${name}: every stop is visible and scrolled into view`, hidden.length === 0, hidden.map(stop => `${label(stop)} ${JSON.stringify(stop.rect)}`).join("; "));
  const covered = stops.filter(stop => stop.obscuredBy);
  results.check(`${name}: no focused control is covered by something else (WCAG 2.4.11)`, covered.length === 0, covered.map(stop => `${label(stop)} under ${stop.obscuredBy}`).join("; "));
  const inert = stops.filter(stop => stop.inert || stop.ariaHidden);
  results.check(`${name}: focus never enters an inert or aria-hidden part (the leaving step)`, inert.length === 0, inert.map(label).join("; "));
  // Reading order: in page coordinates (scroll included), each stop is below or on the row of the previous one.
  const backwards: string[] = [];
  for (let i = 1; i < stops.length; i++) {
    const [a, b] = [stops[i - 1]!, stops[i]!];
    const ya = (a.rect?.y ?? 0) + (a.scrollY ?? 0);
    const yb = (b.rect?.y ?? 0) + (b.scrollY ?? 0);
    const sameRow = Math.abs(yb - ya) < Math.max(12, Math.min(a.rect?.h ?? 0, b.rect?.h ?? 0) / 2);
    // Up and to the right is the next column of a two-column row (a header's actions beside its title): in order.
    const nextColumn = (b.rect?.x ?? 0) > (a.rect?.x ?? 0) + (a.rect?.w ?? 0) - 4;
    if (sameRow ? (b.rect?.x ?? 0) + 4 < (a.rect?.x ?? 0) : yb < ya - 4 && !nextColumn) backwards.push(`${label(a)} → ${label(b)}`);
  }
  results.check(`${name}: Tab follows the reading order (top to bottom, left to right)`, backwards.length === 0, backwards.join("; "));
  return stops;
}

/** Presses Tab until `match`, then `key`. */
async function tabAndPress(ctx: Ctx, page: Page, what: string, match: (stop: FocusStop) => boolean, key = "Enter"): Promise<boolean> {
  await focusFromTop(page);
  const stop = await tabTo(ctx.env, page, match, 45);
  ctx.results.check(`keyboard: Tab reaches ${what}`, !!stop, stop ? label(stop) : "never reached");
  if (!stop) return false;
  await page.keyboard.press(key);
  return true;
}

/** Where focus is after a step changed: never lost to the page itself. */
async function focusAfterStep(ctx: Ctx, page: Page, step: string): Promise<FocusStop> {
  await stepReady(page);
  const stop = await activeFocus(page);
  const inMain = stop.none ? false : await page.evaluate("!!document.activeElement && !!document.activeElement.closest('main')");
  ctx.results.check(`keyboard: after moving to ${step}, focus is inside the step (not lost to the page)`, !stop.none && inMain === true, stop.none ? "focus is on <body>" : label(stop));
  return stop;
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-keyboard-hosted",
    title: "briefcase's hosted sign-up with the keyboard alone at 1440 light: every Tab stop of every step shows focus, in view, uncovered, in order; the whole flow from keys to the app",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      const context = await auditContext(browser, { width: 1440, height: 900 });
      const page = await context.newPage();
      results.watch(page, "keyboard-hosted");
      collectConsole(page);
      await page.goto(await hostedLink(env, page, "briefcase"));
      await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
      await walkStep(ctx, page, findings, "keyboard-hosted methods", [/Continue with Google/, /Continue with Apple/, /^Email$/, /Continue/, /Silicon Accounts/]);

      // Email by keys: Tab to the field, type, Enter.
      const email = freshEmail("uxa.keys");
      await tabAndPress(ctx, page, "the email field", stop => stop.tag === "input" && /email/i.test(`${stop.name} ${stop.type}`), "Home");
      const after = await lastSeq(env);
      await page.keyboard.type(email, { delay: 15 });
      await page.keyboard.press("Enter");
      const code = await codeFor(env, email, after);
      await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 20_000 });
      const atCode = await focusAfterStep(ctx, page, "the code step");
      results.check("keyboard: the code step puts focus in its first cell", /digit 1 of 6/.test(atCode.name ?? ""), label(atCode));
      await walkStep(ctx, page, findings, "keyboard-hosted code", [/digit 1 of 6/, /Verify/, /Change/, /Resend/]);
      // The Resend button while it counts down: its words change every second, so its pixels cannot tell; what it
      // paints (fill, ink, edges, a visible outline) must change with focus.
      await focusFromTop(page);
      if (await tabTo(env, page, stop => /^Resend code/.test(stop.name ?? ""), 30)) {
        await sleep(250);
        const focusedPaint = (await page.evaluate(paintScript("document.activeElement"))) as string | null;
        await page.evaluate("document.activeElement && document.activeElement.blur()");
        await sleep(250);
        const restPaint = (await page.evaluate(paintScript("document.querySelector('button[aria-label^=Resend]')"))) as string | null;
        results.check("keyboard-hosted code: the Resend button shows keyboard focus while it counts down (WCAG 2.4.7)", !!focusedPaint && focusedPaint !== restPaint, `focused: ${focusedPaint} || unfocused: ${restPaint}`);
      }
      await tabAndPress(ctx, page, "the first code cell", stop => /digit 1 of 6/.test(stop.name ?? ""), "Home");
      await page.keyboard.type(code, { delay: 40 });

      // Setting up by keys: the timezone combobox and the date of birth, then Create account.
      await page.getByRole("button", { name: "Create account" }).waitFor({ timeout: 30_000 });
      await focusAfterStep(ctx, page, "setting up");
      await walkStep(ctx, page, findings, "keyboard-hosted signup", [/Not you/, /Display name/, /Your id/, /Timezone/, /Date of birth/, /Create account/, /Silicon Accounts/]);
      if (await tabAndPress(ctx, page, "the timezone combobox", stop => stop.role === "combobox" && /Timezone/i.test(stop.name ?? ""), "ArrowDown")) {
        await sleep(300);
        const combo = page.getByRole("combobox", { name: "Timezone" });
        results.check("keyboard: ArrowDown opens the timezone list", (await combo.getAttribute("aria-expanded")) === "true");
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type("Lisbon", { delay: 30 });
        await sleep(400);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await sleep(400);
        const chosen = await combo.inputValue().catch(() => "");
        results.check("keyboard: typing, ArrowDown and Enter choose a timezone", /Lisbon/.test(chosen) && (await combo.getAttribute("aria-expanded")) === "false", chosen);
      }
      if (await tabAndPress(ctx, page, "the date of birth", stop => /Date of birth/i.test(stop.name ?? ""), "Enter")) {
        await sleep(500);
        const dialog = page.getByRole("dialog").last();
        const open = await dialog.isVisible().catch(() => false);
        const inside = await page.evaluate("!!document.activeElement && !!document.activeElement.closest('[role=dialog]')");
        results.check("keyboard: Enter opens the date picker and moves focus into it", open && inside === true, `open ${open}, focus inside ${inside}`);
        await page.keyboard.press("Escape");
        await sleep(400);
        const back = await activeFocus(page);
        results.check("keyboard: Escape closes the date picker and puts focus back on its trigger", !(await dialog.isVisible().catch(() => false)) && /Date of birth/i.test(back.name ?? ""), label(back));
      }
      await tabAndPress(ctx, page, "Create account", stop => /^Create account$/.test(stop.name ?? ""));

      // What is shared, by keys.
      await page.getByRole("button", { name: "Share and continue" }).waitFor({ timeout: 30_000 });
      await focusAfterStep(ctx, page, "what is shared");
      await walkStep(ctx, page, findings, "keyboard-hosted consent", [/Switch account/, /Timezone/, /Share and continue/, /Cancel/, /Silicon Accounts/]);
      await tabAndPress(ctx, page, "Share and continue", stop => /^Share and continue$/.test(stop.name ?? ""));
      await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/briefcase/`), { timeout: 30_000 });
      const account = await appAccount(page);
      results.check("keyboard: the whole hosted sign-up works without a mouse (briefcase received the account)", typeof account?.uuid === "string", JSON.stringify(account).slice(0, 160));
      results.check("keyboard-hosted: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
  {
    name: "ux-audit-keyboard-first-party",
    title: "the account site's /sign-in with the keyboard alone at 390 dark: Tab stops, Email ⇄ Phone by arrow keys, the code, setting up, and the skip link on the home page",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      const context = await auditContext(browser, { width: 390, height: 844, dark: true });
      const page = await context.newPage();
      results.watch(page, "keyboard-first-party");
      collectConsole(page);
      await page.goto(`${env.site}/sign-in`);
      await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
      const stops = await walkStep(ctx, page, findings, "keyboard-first-party methods", [/Continue with Google/, /Continue with Apple/, /^Email$/, /Continue/, /Silicon Accounts/]);

      // Email ⇄ Phone: the segmented control answers arrow keys.
      const segment = stops.find(stop => /^Email$/.test(stop.name ?? ""));
      if (segment) {
        await tabAndPress(ctx, page, "the Email segment", stop => /^Email$/.test(stop.name ?? ""), "ArrowRight");
        await sleep(500);
        const phoneShown = await page.getByRole("textbox", { name: /Phone number/ }).isVisible().catch(() => false);
        results.check("keyboard: ArrowRight on the Email segment switches to Phone", phoneShown);
        await page.keyboard.press("ArrowLeft");
        await sleep(500);
        results.check("keyboard: ArrowLeft switches back to Email", await page.getByRole("textbox", { name: "Email" }).isVisible().catch(() => false));
      }

      const email = freshEmail("uxa.keys1p");
      await tabAndPress(ctx, page, "the email field", stop => stop.tag === "input" && /email/i.test(`${stop.name} ${stop.type}`), "Home");
      const after = await lastSeq(env);
      await page.keyboard.type(email, { delay: 15 });
      await page.keyboard.press("Enter");
      const code = await codeFor(env, email, after);
      await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 20_000 });
      const atCode = await focusAfterStep(ctx, page, "the code step");
      results.check("keyboard: the code step puts focus in its first cell (390)", /digit 1 of 6/.test(atCode.name ?? ""), label(atCode));
      await tabAndPress(ctx, page, "the first code cell", stop => /digit 1 of 6/.test(stop.name ?? ""), "Home");
      await page.keyboard.type(code, { delay: 40 });
      await page.getByRole("button", { name: "Create account" }).waitFor({ timeout: 30_000 });
      await focusAfterStep(ctx, page, "setting up (390)");
      await walkStep(ctx, page, findings, "keyboard-first-party signup", [/Display name/, /Your id/, /Timezone/, /Date of birth/, /Create account/]);
      await tabAndPress(ctx, page, "Create account", stop => /^Create account$/.test(stop.name ?? ""));
      await page.waitForURL(`${env.site}/`, { timeout: 30_000 });
      await page.locator("main").first().waitFor({ timeout: 30_000 });
      await settle(page, 800);

      // The shell's skip link: the first Tab stop, visible once focused, and Enter moves focus to the page.
      await focusFromTop(page);
      await page.keyboard.press(tabKey(env));
      await sleep(300);
      const first = await activeFocus(page);
      const skipVisible = await page.evaluate("(() => { const a = document.activeElement; if (!a) return false; const r = a.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.width > 0 && getComputedStyle(a).opacity !== '0'; })()");
      results.check("keyboard: the home page's first Tab stop is a skip link, shown once focused", /skip/i.test(`${first.name} ${first.el}`) && skipVisible === true, label(first));
      if (/skip/i.test(`${first.name} ${first.el}`)) {
        await page.keyboard.press("Enter");
        await sleep(400);
        const landed = await page.evaluate("(() => { const a = document.activeElement; return a ? (a.closest('main') ? 'main' : a.tagName.toLowerCase() + (a.id ? '#' + a.id : '')) : 'none'; })()");
        results.check("keyboard: the skip link moves focus to the page's content", landed === "main", String(landed));
      }
      const stopsHome = await tabWalk(env, page, 30);
      findings.pages["home tab stops (390)"] = stopsHome;
      const unseen = stopsHome.filter(stop => focusVerdict(stop) === "none");
      const unsure = stopsHome.filter(stop => focusVerdict(stop) === "inconclusive");
      results.check("keyboard: every Tab stop of the home page (390 dark) shows focus", unseen.length === 0, [...unseen.map(stop => `${label(stop)} (${evidence(stop)})`), ...unsure.map(stop => `inconclusive, not counted: ${label(stop)} (${evidence(stop)})`)].join("; ") || `${stopsHome.length} stops`);
      const covered = stopsHome.filter(stop => stop.obscuredBy);
      results.check("keyboard: no Tab stop of the home page (390) hides under the navigation bar", covered.length === 0, covered.map(stop => `${label(stop)} under ${stop.obscuredBy}`).join("; "));
      results.check("keyboard-first-party: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
  {
    name: "ux-audit-keyboard-developer",
    title: "the developer area with the keyboard alone at 1440 light (briefcase's owner): the Users tab with its table and the Import tab — every Tab stop shows focus, in view, uncovered by the dock, in reading order",
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      // A new Carbon in briefcase's user base, so the Users table has a row.
      {
        const context = await auditContext(browser);
        const page = await context.newPage();
        results.watch(page, "keyboard-developer-user");
        await page.goto(await hostedLink(env, page, "briefcase"));
        const code = await sendEmailCode(env, page, freshEmail("uxa.keysdev"));
        await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
        await page.keyboard.type(code, { delay: 25 });
        await page.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
        await page.getByRole("button", { name: "Share and continue" }).click({ timeout: 30_000 });
        await page.waitForURL(new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/briefcase/`), { timeout: 30_000 });
        await context.close();
      }
      const context = await auditContext(browser, { width: 1440, height: 900 });
      const page = await context.newPage();
      // The seeded owner's photo points at the production Iris (reported by ux-audit-developer-briefcase).
      results.watch(page, "keyboard-developer", [/iris\.teamofsilicons\.com/]);
      await signInOnSite(env, page, "saketdev12@example.test");
      for (const [tab, expected] of [["users", [/^Users$/, /Search users|Id, name/, /Sort by/, /Add filter/]], ["import", [/^Import$/, /Paste instead/]]] as const) {
        await page.goto(`${env.site}/developer/briefcase/${tab}`);
        await page.locator("main").first().waitFor({ timeout: 30_000 });
        await waitUntil(page, "!document.querySelector('main [aria-busy=true]')", 15_000);
        await walkStep(ctx, page, findings, `keyboard-developer ${tab}`, [...expected], false);
      }
      results.check("keyboard-developer: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
];

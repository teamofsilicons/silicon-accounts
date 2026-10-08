/**
 * ux-audit: the sign-in flows with the keyboard alone (Tab in Chromium, Option+Tab in WebKit), no mouse at all:
 *
 *   hosted        briefcase's hosted pages at 1440 light: every Tab stop of each step shows where focus is, is in view,
 *                 uncovered, never inside the leaving (inert) step, in reading order; then the whole sign-up is done
 *                 from the keyboard (email + Enter, the code, the timezone combobox and the date of birth by keys,
 *                 Create account, the optional timezone ticked with Space on the what's-shared page, Share and
 *                 continue) and the app receives the account
 *   flow          ledgerly's two-page flow at 390 dark: the page adding the phone it requires, the second page and the
 *                 review, every Tab stop checked, Back and the review's buttons reached from the keyboard
 *   first-party   the account site's own /sign-in at 390 dark: the same, Email ⇄ Phone by arrow keys, and the shell's
 *                 skip link on the home page it lands on
 *   developer     briefcase's owner on the developer site at 1440 light: the apps home and every tab of briefcase:
 *                 every Tab stop shows focus, in view, uncovered, in reading order; the shell's skip link a squircle
 *   pages         what no other walk covers: the landing page and the developer site's sign-in card (signed out, 1440
 *                 light and 390 dark), a docs page (390 dark) and /device (1440 light)
 *
 * "Shows focus" is judged in pixels (_audit.ts focusPixels: the stop and 16 px around it, focused, unfocused, focused
 * again from the keyboard; and, next to the previous stop, whether focus visibly moves from it). A stop whose pixels
 * change on their own (a countdown, a ring still gliding) and whose computed look did not change is listed as
 * inconclusive, never failed; the Resend countdown gets a targeted check of what it paints instead.
 */
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { appAccount, codeFor, lastSeq, live, sleep, startAtApp } from "../../lib";
import { DEVELOPER_EXPECTED, TABS, activeFocus, auditContext, openAccountPage, pageFetch, signedInCarbon, tabPath, collectConsole, findingsFor, focusFromTop, focusVerdict, freshEmail, hostedLink, openDeveloperPage, saveFindings, sendEmailCode, settle, signInAsSeededOwnerOnDeveloper, stepReady, tabKey, tabTo, tabWalk, type Findings, type FocusStop } from "./_audit";
import { freshPhone } from "./_hosted";

const label = (stop: FocusStop) => `${stop.name || stop.el} <${stop.tag}${stop.role ? ` role=${stop.role}` : ""}>`;
const evidence = (stop: FocusStop) => `pixels ${stop.pixels ?? "unmeasured"}${stop.moves ? `; from the previous stop ${stop.moves}` : ""}; computed look ${!stop.changed ? "not in the snapshot" : stop.changed.length ? `changed: ${stop.changed.slice(0, 4).join(", ")}` : "unchanged"}`;

/**
 * What an element (and its first children) paints that a focus style could change; `target` is a JS expression. The
 * children's opacity and transform are left out: a countdown's rolling digits fade and slide on their own every second.
 */
const paintScript = (target: string) => `(() => {
  const el = ${target};
  if (!el) return null;
  const pick = (node, own) => { const s = getComputedStyle(node); return [s.backgroundColor, own ? s.color : "", s.borderTopColor, s.borderBottomColor, s.boxShadow, s.outlineStyle === "none" || /transparent|rgba\\(.*,\\s*0\\)$/.test(s.outlineColor) ? "no outline" : s.outlineColor + " " + s.outlineWidth, s.textDecorationLine, own ? s.opacity : ""].join("|"); };
  return [el, ...el.querySelectorAll("*")].slice(0, 8).map((node, index) => pick(node, index === 0)).join(" / ");
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
    // A skip link shows only while focused, wherever the shell puts it (over the bar on a phone): not part of the order.
    if (/^Skip to/i.test(a.name ?? "")) continue;
    // Where each starts reading (a wrapped link starts on its first line, not at its box's left edge).
    const [pa, pb] = [a.line ?? a.rect, b.line ?? b.rect];
    const ya = (pa?.y ?? 0) + (a.scrollY ?? 0);
    const yb = (pb?.y ?? 0) + (b.scrollY ?? 0);
    const sameRow = Math.abs(yb - ya) < Math.max(12, Math.min(pa?.h ?? 0, pb?.h ?? 0) / 2);
    // Up and to the right is the next column of a two-column row (a header's actions beside its title): in order.
    const nextColumn = (pb?.x ?? 0) > (pa?.x ?? 0) + (pa?.w ?? 0) - 4;
    if (sameRow ? (pb?.x ?? 0) + 4 < (pa?.x ?? 0) : yb < ya - 4 && !nextColumn) backwards.push(`${label(a)} → ${label(b)}`);
  }
  results.check(`${name}: Tab follows the reading order (top to bottom, left to right)`, backwards.length === 0, backwards.join("; "));
  return stops;
}

/** The focused skip link's look: its words, corner radius and corner shape (a squircle, like every rounded surface). */
const SKIP_SHAPE = `(() => {
  const a = document.activeElement;
  if (!a || !/^Skip to/i.test((a.textContent || "").trim())) return null;
  const s = getComputedStyle(a);
  return { text: (a.textContent || "").trim(), radius: s.borderTopLeftRadius, shape: (s.getPropertyValue("corner-top-left-shape") || s.getPropertyValue("corner-shape") || "").trim(), marked: a.matches("[data-sq],[data-sq-native]") };
})()`;

/** With the skip link focused (shown): it is drawn as a squircle (web/AGENTS.md: data-sq, never border-radius). */
async function checkSkipShape(ctx: Ctx, page: Page, where: string): Promise<void> {
  const shape = (await page.evaluate(SKIP_SHAPE)) as { text: string; radius: string; shape: string; marked: boolean } | null;
  ctx.results.check(`${where}: the skip link, once shown, is a squircle like every rounded surface`, !!shape && (shape.marked || parseFloat(shape.radius) < 2 || /squircle|superellipse\(2\)/.test(shape.shape)), shape ? `${shape.text}: border-radius ${shape.radius}, corner-shape ${shape.shape || "none"}, data-sq ${shape.marked}` : "focus is not on a skip link");
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
      // The Resend button while it counts down (measured first, before the walk uses up its wait): its words change
      // every second, so its pixels cannot tell; what it paints (fill, ink, edges, a visible outline) must change with focus.
      await focusFromTop(page);
      if (await tabTo(env, page, stop => /^Resend code/.test(stop.name ?? ""), 30)) {
        await sleep(250);
        // The very button that has focus, kept for after the blur (it is named by a visually hidden copy of its words,
        // so no attribute finds it).
        const waiting = (await page.evaluate("(() => { window.__uxaResend = document.activeElement; return document.activeElement.getAttribute('aria-disabled') === 'true'; })()")) === true;
        const focusedPaint = (await page.evaluate(paintScript("window.__uxaResend"))) as string | null;
        await page.evaluate("document.activeElement && document.activeElement.blur()");
        await sleep(250);
        const restPaint = (await page.evaluate(paintScript("window.__uxaResend"))) as string | null;
        results.check("keyboard-hosted code: the Resend button shows keyboard focus while it counts down (WCAG 2.4.7)", waiting && !!focusedPaint && !!restPaint && focusedPaint !== restPaint, `${waiting ? "counting down" : "not counting down when measured"}; focused: ${focusedPaint} || unfocused: ${restPaint}`);
      }
      await walkStep(ctx, page, findings, "keyboard-hosted code", [/digit 1 of 6/, /Verify/, /Change/, /Resend/]);
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

      // What is shared (the details page), by keys: the optional timezone ticked with Space.
      await page.getByRole("button", { name: "Share and continue" }).waitFor({ timeout: 30_000 });
      await focusAfterStep(ctx, page, "what is shared");
      await walkStep(ctx, page, findings, "keyboard-hosted details", [/Switch account/, /Timezone/, /Share and continue/, /Cancel/, /Silicon Accounts/]);
      if (await tabAndPress(ctx, page, "the optional timezone's checkbox", stop => stop.role === "checkbox" && /Timezone/.test(stop.name ?? ""), "Space")) {
        await sleep(300);
        const ticked = await live(page, 'ul[aria-label^="Details shared with"] > li[data-field="timezone"] [role="checkbox"]').first().getAttribute("aria-checked");
        results.check("keyboard: Space ticks the optional timezone", ticked === "true", String(ticked));
      }
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
        await checkSkipShape(ctx, page, "keyboard: the account site");
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
    name: "ux-audit-keyboard-account",
    title: "every account page with the keyboard alone (a Carbon with an app, a Silicon and a proof) at 1440 light and 390 dark: every Tab stop shows focus, in view, never under the dock or the phone bar (WCAG 2.4.11), in reading order",
    timeoutMs: 1_500_000,
    async run(ctx) {
      const { env, results } = ctx;
      const findings = findingsFor(ctx);
      const carbon = await signedInCarbon(ctx, "uxa.keys.account");
      const { page } = carbon;
      results.watch(page, "keyboard-account");
      collectConsole(page);
      // Something on every page: briefcase and dm (a user verification proof dm holds), a Silicon.
      for (const app of ["briefcase", "dm"]) {
        await page.goto(await hostedLink(env, page, app));
        await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
        if (app === "dm") {
          const phone = freshPhone();
          const adder = live(page, '[data-adding="phone"]').first();
          await adder.waitFor({ timeout: 30_000 });
          await adder.getByRole("textbox", { name: "Phone number" }).click();
          const after = await lastSeq(env);
          await page.keyboard.type(phone, { delay: 20 });
          await adder.getByRole("button", { name: "Send code" }).click();
          const sms = await codeFor(env, phone, after);
          await page.getByRole("group", { name: /^Code from the text message/ }).first().getByRole("textbox").first().click({ timeout: 15_000 });
          await page.keyboard.type(sms, { delay: 25 });
          await live(page, 'ul[aria-label^="Details shared with"] > li[data-field="phone"]:not([data-missing])').first().waitFor({ timeout: 15_000 });
          await page.getByRole("button", { name: "Start messaging", exact: true }).click();
        } else await page.getByRole("button", { name: "Share and continue", exact: true }).click({ timeout: 30_000 });
        await page.waitForURL(url => url.href.startsWith(`${env.apps}/${app}/`), { timeout: 30_000 });
      }
      const issued = await fetch(`${env.apps}/dm/actions/issue-user_verification`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uuid: carbon.uuid, receiving_app: "briefcase", scopes: ["files.write"] }) });
      results.check("keyboard-account: dm holds a user verification proof on the Carbon's behalf", issued.ok, String(issued.status));
      await page.goto(`${env.site}/`);
      await page.locator("main").first().waitFor({ timeout: 30_000 });
      const created = await pageFetch(page, "/v1/me/silicons", { method: "POST", body: { id: `si:uxa-keys-${Date.now().toString(36)}`, display_name: "Keyboard Scout" } });
      results.check("keyboard-account: a Silicon in the Carbon's care", created.status === 200 || created.status === 201, String(created.status));
      // Every page at 1440 light; at 390 dark (the phone bar instead of the dock) the pages with the most controls.
      const pages = [["/", "identity"], ["/sign-in-methods", "sign-in-methods"], ["/apps", "apps"], ["/silicons", "silicons"], ["/proofs", "proofs"], ["/activity", "activity"], ["/settings", "settings"]] as const;
      for (const [width, height, dark, names] of [[1440, 900, false, null], [390, 844, true, ["identity", "silicons", "settings"]]] as const) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
        for (const [path, name] of pages) {
          if (names && !(names as readonly string[]).includes(name)) continue;
          await openAccountPage(ctx, page, path, /./);
          await walkStep(ctx, page, findings, `keyboard-account ${name} ${width}`, [], false);
        }
      }
      results.check("keyboard-account: findings saved", true, saveFindings(ctx, findings));
      await carbon.context.close();
    },
  },
  {
    name: "ux-audit-keyboard-flow",
    title: "ledgerly's two-page flow with the keyboard alone at 390 dark: the page adding the required phone (form, then code), the second page, the review — every Tab stop shows focus, in view, in order; Back and Share and continue by keys",
    timeoutMs: 600_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      const context = await auditContext(browser, { width: 390, height: 844, dark: true });
      const page = await context.newPage();
      results.watch(page, "keyboard-flow");
      collectConsole(page);
      await startAtApp(env, page, "ledgerly", { intent: "signup" });
      const email = freshEmail("uxa.keysflow");
      const code = await sendEmailCode(env, page, email);
      await tabAndPress(ctx, page, "the first code cell", stop => /digit 1 of 6/.test(stop.name ?? ""), "Home");
      await page.keyboard.type(code, { delay: 40 });
      await page.getByRole("button", { name: "Create account" }).waitFor({ timeout: 30_000 });
      await tabAndPress(ctx, page, "Create account", stop => /^Create account$/.test(stop.name ?? ""));

      // Step 1 of 2: the phone ledgerly requires, added on the page.
      await page.getByText("Step 1 of 2", { exact: true }).first().waitFor({ timeout: 30_000 });
      await focusAfterStep(ctx, page, "step 1 of 2 (adding the required phone)");
      await walkStep(ctx, page, findings, "keyboard-flow step 1", [/Switch account/, /Phone number/, /Send code/, /^Continue$/, /^Cancel$/, /Silicon Accounts/]);
      const phone = freshPhone();
      await tabAndPress(ctx, page, "the phone number field", stop => stop.tag === "input" && /Phone number/.test(stop.name ?? ""), "End");
      const after = await lastSeq(env);
      await page.keyboard.type(phone, { delay: 20 });
      await tabAndPress(ctx, page, "Send code", stop => /^Send code$/.test(stop.name ?? ""));
      const sms = await codeFor(env, phone, after);
      await page.getByRole("group", { name: /^Code from the text message/ }).first().waitFor({ timeout: 20_000 });
      await stepReady(page);
      await walkStep(ctx, page, findings, "keyboard-flow step 1 code", [/digit 1 of 6/, /Change/, /Resend/, /^Continue$/]);
      await tabAndPress(ctx, page, "the first cell of the phone's code", stop => /digit 1 of 6/.test(stop.name ?? ""), "Home");
      await page.keyboard.type(sms, { delay: 40 });
      await live(page, 'ul[aria-label^="Details shared with"] > li[data-field="phone"]:not([data-missing])').first().waitFor({ timeout: 20_000 });
      await tabAndPress(ctx, page, "Continue", stop => /^Continue$/.test(stop.name ?? ""));

      // Step 2 of 2 (its own split layout), then the review.
      await page.getByText("Step 2 of 2", { exact: true }).first().waitFor({ timeout: 30_000 });
      await focusAfterStep(ctx, page, "step 2 of 2");
      await walkStep(ctx, page, findings, "keyboard-flow step 2", [/Timezone/, /^Review$/, /^Back$/, /Cancel signing in/, /Silicon Accounts/]);
      await tabAndPress(ctx, page, "Review", stop => /^Review$/.test(stop.name ?? ""));
      await live(page, 'ul[aria-label^="Shared with"]').first().waitFor({ timeout: 30_000 });
      await focusAfterStep(ctx, page, "the review");
      await walkStep(ctx, page, findings, "keyboard-flow review", [/^Share and continue$/, /^Back$/, /Cancel signing in/, /Silicon Accounts/]);
      await tabAndPress(ctx, page, "Back", stop => /^Back$/.test(stop.name ?? ""));
      await page.getByText("Step 2 of 2", { exact: true }).first().waitFor({ timeout: 30_000 });
      await focusAfterStep(ctx, page, "step 2 of 2 again (Back from the review)");
      await tabAndPress(ctx, page, "Review", stop => /^Review$/.test(stop.name ?? ""));
      await live(page, 'ul[aria-label^="Shared with"]').first().waitFor({ timeout: 30_000 });
      await stepReady(page);
      await tabAndPress(ctx, page, "Share and continue", stop => /^Share and continue$/.test(stop.name ?? ""));
      await page.waitForURL(url => url.href.startsWith(`${env.apps}/ledgerly/`), { timeout: 30_000 });
      const account = await appAccount(page);
      results.check("keyboard: ledgerly's whole flow works without a mouse (ledgerly received the account)", typeof account?.uuid === "string", JSON.stringify(account).slice(0, 160));
      results.check("keyboard-flow: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
  {
    name: "ux-audit-keyboard-developer",
    title: "the developer site with the keyboard alone at 1440 light (briefcase's owner): the apps home and all ten tabs of briefcase — every Tab stop shows focus, in view, uncovered, in reading order",
    timeoutMs: 1_500_000,
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
      results.watch(page, "keyboard-developer", DEVELOPER_EXPECTED);
      collectConsole(page, DEVELOPER_EXPECTED);
      await signInAsSeededOwnerOnDeveloper(ctx, page, findings);
      // The shell's skip link: the first Tab stop, shown once focused.
      await openDeveloperPage(ctx, page, "/");
      await focusFromTop(page);
      await page.keyboard.press(tabKey(env));
      await sleep(400);
      await checkSkipShape(ctx, page, "keyboard: the developer site");
      const tabs: Array<readonly [string, string, readonly RegExp[]]> = [["/", "home", [/Briefcase/, /Search and jump/]]];
      for (const tab of TABS) tabs.push([tabPath("briefcase", tab), tab, [new RegExp(`^${tab === "app_verification" ? "App verification" : tab === "sign-in" ? "Sign-in" : tab[0]!.toUpperCase() + tab.slice(1)}$`)]]);
      for (const [path, name, expected] of tabs) {
        await openDeveloperPage(ctx, page, path);
        await walkStep(ctx, page, findings, `keyboard-developer ${name}`, [...expected], false);
      }
      results.check("keyboard-developer: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
  {
    name: "ux-audit-keyboard-pages",
    title: "the pages no other keyboard walk covers, with the keyboard alone: the landing page and the developer site's sign-in card (signed out, 1440 light and 390 dark), a docs page (390 dark) and /device (1440 light) — every Tab stop shows focus, in view, uncovered, in reading order",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      for (const [width, height, dark] of [[1440, 900, false], [390, 844, true]] as const) {
        const context = await auditContext(browser, { width, height, dark });
        const page = await context.newPage();
        // The developer site's session probe answers 401 while signed out.
        results.watch(page, `keyboard-pages-${width}`, DEVELOPER_EXPECTED);
        collectConsole(page, DEVELOPER_EXPECTED);
        await page.goto(`${env.site}/`);
        await page.locator("main").first().waitFor({ timeout: 30_000 });
        await walkStep(ctx, page, findings, `keyboard-pages landing ${width}`, [/^Sign in$/, /Create your account/], false);
        await page.goto(`${env.developer}/sign-in`);
        await page.getByRole("link", { name: /Continue with Silicon Accounts/ }).waitFor({ timeout: 30_000 });
        await walkStep(ctx, page, findings, `keyboard-pages developer sign-in ${width}`, [/Continue with Silicon Accounts/], false);
        if (width === 390) {
          // On a phone the docs' sidebar is behind the menu button, so the walk is the page itself.
          await page.goto(`${env.site}/docs/start/add-sign-in`);
          await page.locator("main h1").first().waitFor({ timeout: 30_000 });
          await walkStep(ctx, page, findings, "keyboard-pages docs 390", [/Open the docs menu/], false);
        }
        await context.close();
      }
      const carbon = await signedInCarbon(ctx, "uxa.keys.pages", { width: 1440, height: 900 });
      results.watch(carbon.page, "keyboard-pages-device");
      collectConsole(carbon.page);
      await carbon.page.goto(`${env.site}/device`);
      await carbon.page.getByRole("textbox", { name: "Code from your terminal" }).waitFor({ timeout: 30_000 });
      await walkStep(ctx, carbon.page, findings, "keyboard-pages device 1440", [/Code from your terminal/, /^Continue$/], false);
      results.check("keyboard-pages: findings saved", true, saveFindings(ctx, findings));
      await carbon.context.close();
    },
  },
];

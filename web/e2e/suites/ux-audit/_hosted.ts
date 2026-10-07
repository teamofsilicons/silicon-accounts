/**
 * The ux-audit suite's helpers for the hosted sign-in pages (a helper file: run.ts never takes it for journeys).
 *
 * UNDERSTANDING.md v2 "What's shared with the app" and "Flows": after the account is known, the app's details pages
 * (one per step of its flow; the what's-shared page when it has none) and, when its flow says so, a review page. This
 * walks them like a Carbon and audits every page on the way (auditStep: the generic audit, the paint, "Powered by",
 * the split layout's hero copy), including the states in between: a required email or phone being added (its form, its
 * code), Continue pressed while a required detail is missing, Back from the review.
 */
import type { Page } from "@playwright/test";
import type { Ctx } from "../../context";
import { appUrl, codeFor, hostedTitle, lastSeq, live, readFlow, sleep, type DetailField, type FlowSeen } from "../../lib";
import { POWERED_HREF, auditPage, poweredBy, stepReady, type Findings, type Theme, type Variant } from "./_audit";

export const DETAILS_LIST = 'ul[aria-label^="Details shared with"]';
export const REVIEW_LIST = 'ul[aria-label^="Shared with"]';

export interface StepOptions {
  forced?: Theme;
  fullPage?: boolean;
  /** The split layout's hero copy expected beside the form at 1440 (acme-notes). */
  hero?: RegExp;
  /** Console problems the page logs on purpose (a 422 for a wrong code…). */
  expectedConsole?: RegExp[];
  /** Skip the vocabulary check (an app's own words). */
  skipWords?: boolean;
  /** The step's layout differs from its branding's (a flow page's own): the frame must draw this one. */
  layout?: string;
}

/** The generic audit of a hosted step in each variant, plus its paint, "Powered by" and (split layout) the hero copy. */
export async function auditStep(ctx: Ctx, page: Page, findings: Findings, name: string, variants: Variant[], options: StepOptions = {}): Promise<void> {
  const { results } = ctx;
  for (const variant of variants) {
    await auditPage(ctx, page, findings, { name, variant, forcedTheme: options.forced, siteTheme: !options.forced, fullPage: options.fullPage, expectedConsole: options.expectedConsole, skipWords: options.skipWords });
    const paint = await page.locator("[data-paint]").first().getAttribute("data-paint").catch(() => null);
    results.check(`${name} ${variant.key}: the step paints ${options.forced ? `the app's forced ${options.forced}` : `the visitor's ${variant.theme}`} theme`, paint === (options.forced ?? variant.theme), `data-paint=${paint}`);
    if (options.layout) {
      const drawn = await page.locator("[data-paint][data-layout]").first().getAttribute("data-layout").catch(() => null);
      results.check(`${name} ${variant.key}: the page is drawn in its own ${options.layout} layout`, drawn === options.layout, `data-layout=${drawn}`);
    }
    let powered = await poweredBy(page);
    const fits = (powered.scrollHeight ?? 0) <= (powered.viewport ?? 0) + 2;
    if (powered.found && !powered.inView && !fits) {
      await page.locator("[data-powered-by]").first().scrollIntoViewIfNeeded().catch(() => undefined);
      await sleep(250);
      powered = await poweredBy(page);
      await page.evaluate("window.scrollTo({ left: 0, top: 0, behavior: 'instant' })");
    }
    findings.pages[`${name} ${variant.key} powered by`] = powered;
    results.check(
      `${name} ${variant.key}: "Powered by Silicon Accounts" is there, uncovered, overlapping nothing${fits ? ", in view" : " (reachable by scrolling)"}, linking to accounts.teamofsilicons.com`,
      powered.found && !!powered.visible && !!powered.inView && !powered.covered && !powered.overlaps?.length && POWERED_HREF.test(powered.href ?? "") && /Powered by/.test(powered.text ?? ""),
      JSON.stringify(powered),
    );
    if (options.hero && variant.width >= 1000) {
      const hero = (await page.locator(".sa-brand-aside .sa-brand-title").first().innerText().catch(() => "")).trim();
      results.check(`${name} ${variant.key}: the copy beside the form says "${options.hero.source}"`, options.hero.test(hero), hero || "(no hero title)");
    }
  }
}

/** The code step: the first cell, then the digits. */
export async function typeCode(page: Page, code: string): Promise<void> {
  await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
  await page.keyboard.type(code, { delay: 30 });
}

/** A US number unlikely to be on another account of this stack (the mock SMS server takes any; the core suite's shape). */
export const freshPhone = () => `+1${["202", "212", "213", "312", "415", "617", "646", "718"][Math.floor(Math.random() * 8)]}555${String(Math.floor(1000 + Math.random() * 8999))}`;

export interface RowSeen {
  field: string;
  mode: "required" | "optional";
  missing: boolean;
  ticked: boolean | null;
  text: string;
}

/** The rows of the details page on screen. */
export async function detailRows(page: Page): Promise<RowSeen[]> {
  return live(page, `${DETAILS_LIST} > li`).evaluateAll(items =>
    items.map(item => {
      const box = item.querySelector('[role="checkbox"]');
      return {
        field: item.getAttribute("data-field") ?? "",
        mode: (item.hasAttribute("data-optional") ? "optional" : "required") as "required" | "optional",
        missing: item.hasAttribute("data-missing"),
        ticked: box ? box.getAttribute("aria-checked") === "true" : null,
        text: (item as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
      };
    }),
  );
}

type Stop = "details" | "review" | "app";

/** Waits until the hosted sign-in shows a details page other than `lastIndex`, the review page, or is back at the app. */
export async function nextHostedStop(ctx: Ctx, page: Page, app: string, lastIndex: number, timeoutMs = 45_000): Promise<Stop> {
  const pattern = appUrl(ctx.env, app);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(page.url())) return "app";
    if (await live(page, DETAILS_LIST).first().isVisible().catch(() => false)) {
      const flow = await readFlow(page).catch(() => null);
      if (flow?.step === "details" && flow.details && flow.details.index !== lastIndex) return "details";
    } else if (await live(page, REVIEW_LIST).first().isVisible().catch(() => false)) {
      const flow = await readFlow(page).catch(() => null);
      if (flow?.step === "review") return "review";
    }
    await sleep(150);
  }
  const text = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
  throw new Error(`the hosted sign-in did not reach a details page, the review page or ${app} within ${Math.round(timeoutMs / 1000)} s (at ${page.url()}): ${text}`);
}

/** What a details page is expected to say (per page, 0-based). */
export interface PageExpectation {
  title?: RegExp;
  continueLabel?: string;
  /** The page's own layout, drawn by the frame. */
  layout?: string;
  progress?: string;
}

export interface DetailsPlan {
  app: string;
  /** Check and screenshot prefix ("hosted-ledgerly"). */
  prefix: string;
  variants: Variant[];
  forced?: Theme;
  /** Missing emails and phones to add with a code (a required one must be given). */
  add?: { email?: string; phone?: string };
  /** Optional details to tick on their page. */
  tick?: DetailField[];
  /** Before adding a missing required detail, press the page's main button: it must say what is missing. */
  tryContinueFirst?: boolean;
  /** On the review page: Back once, check the choices were kept, then return to the review. */
  reviewBack?: boolean;
  expect?: PageExpectation[];
  /** The split layout's hero copy on the details pages (acme-notes). */
  hero?: RegExp;
  /** Audit the in-between states (adding a detail, Continue blocked) in these variants only (default: all). */
  stateVariants?: Variant[];
}

export interface DetailsWalk {
  pages: Array<{ index: number; count: number; id: string; title: string; continueLabel: string; layout: string | null; drawn: string | null; rows: RowSeen[] }>;
  review: { title: string; shared: string[] } | null;
}

/** The label of a details page's main button, as the page words it (from the FlowView, like the page). */
function continueLabelOf(details: NonNullable<FlowSeen["details"]>): string {
  const own = details.continue_label?.trim();
  if (own) return own;
  if (details.review_next) return "Review";
  return details.index >= details.count - 1 ? "Share and continue" : "Continue";
}

/**
 * Walks the app's details pages and review page (auditing each), until the browser is back at the app. Checks on each
 * page what UNDERSTANDING.md v2 promises a Carbon: required details locked and always shared, optional details unticked
 * until ticked (a first sign-in), a missing required email or phone added right there with a code, "Step n of m" when
 * the flow has several pages, the page's own title, button and layout, and "Powered by" on every page.
 */
export async function walkDetails(ctx: Ctx, page: Page, findings: Findings, plan: DetailsPlan): Promise<DetailsWalk> {
  const { env, results } = ctx;
  const walk: DetailsWalk = { pages: [], review: null };
  const states = plan.stateVariants ?? plan.variants;
  let lastIndex = -1;
  let wentBack = false;
  for (let guard = 0; guard < 12; guard++) {
    const stop = await nextHostedStop(ctx, page, plan.app, lastIndex);
    if (stop === "app") break;
    if (stop === "review") {
      await stepReady(page);
      const title = await hostedTitle(page);
      const shared = await live(page, `${REVIEW_LIST} > li`).evaluateAll(items => items.map(item => item.getAttribute("data-field") ?? ""));
      walk.review = { title, shared };
      results.check(`${plan.prefix}-review: lists the profile first, then what is shared`, shared[0] === "profile" && shared.length >= 1, shared.join(", "));
      const name = wentBack ? `${plan.prefix}-review-again` : `${plan.prefix}-review`;
      await auditStep(ctx, page, findings, name, wentBack ? states.slice(0, 1) : plan.variants, { forced: plan.forced, fullPage: true, hero: plan.hero });
      if (plan.reviewBack && !wentBack) {
        wentBack = true;
        await page.getByRole("button", { name: "Back", exact: true }).click();
        // The last details page comes back with its choices kept.
        lastIndex = -1;
        continue;
      }
      await page.getByRole("button", { name: "Share and continue", exact: true }).click();
      await page.waitForURL(appUrl(env, plan.app), { timeout: 45_000 });
      break;
    }
    const flow = await readFlow(page);
    const details = flow?.details;
    if (!flow || !details) throw new Error(`${plan.prefix}: a details page is on screen but the flow says ${flow?.step ?? "nothing"}`);
    if (details.count > 1) await live(page, "span").filter({ hasText: new RegExp(`^Step ${details.index + 1} of ${details.count}$`) }).first().waitFor({ timeout: 10_000 });
    await stepReady(page);
    lastIndex = details.index;
    const label = `${plan.prefix}-details-${details.index + 1}${wentBack ? "-after-back" : ""}`;
    const rows = await detailRows(page);
    const title = await hostedTitle(page);
    const drawn = await page.locator("[data-paint][data-layout]").first().getAttribute("data-layout").catch(() => null);
    const continueLabel = continueLabelOf(details);
    walk.pages.push({ index: details.index, count: details.count, id: details.id, title, continueLabel, layout: details.layout, drawn, rows });
    findings.pages[`${label} rows`] = { flow: { index: details.index, count: details.count, id: details.id, title: details.title, layout: details.layout }, rows };
    const expectation = plan.expect?.[details.index];
    if (expectation?.title) results.check(`${label}: the page's title is "${expectation.title.source}"`, expectation.title.test(title), title);
    if (expectation?.continueLabel) results.check(`${label}: its main button says "${expectation.continueLabel}"`, continueLabel === expectation.continueLabel && (await page.getByRole("button", { name: expectation.continueLabel, exact: true }).count()) > 0, continueLabel);
    if (details.count > 1) results.check(`${label}: says where the Carbon is ("Step ${details.index + 1} of ${details.count}")`, (await live(page, "span").filter({ hasText: /^Step \d+ of \d+$/ }).count()) > 0);
    const required = rows.filter(row => row.mode === "required" && row.field !== "profile");
    results.check(`${label}: every required detail is locked and says "Required"`, required.every(row => / Required$/.test(row.text) && row.ticked === null), required.map(row => row.text).join(" | ") || "(none on this page)");
    const optional = rows.filter(row => row.mode === "optional");
    if (wentBack) {
      const kept = optional.filter(row => plan.tick?.includes(row.field as DetailField));
      results.check(`${label}: Back from the review keeps the choices made (ticked details still ticked)`, kept.every(row => row.ticked === true), kept.map(row => `${row.field} ${row.ticked}`).join(", ") || "(nothing was ticked)");
    } else {
      results.check(`${label}: optional details start unticked (UNDERSTANDING.md: "It's unticked until they do")`, optional.every(row => row.ticked === false), optional.map(row => `${row.field} ${row.ticked}${row.missing ? " (missing)" : ""}`).join(", ") || "(none on this page)");
    }
    // An optional detail's checkbox is named by its row's label and described by the value it would share. (No named
    // function inside: tsx wraps those in a `__name` helper the page does not have.)
    const boxes = await live(page, `${DETAILS_LIST} > li[data-optional]:not([data-missing]) [role="checkbox"]`).evaluateAll(items =>
      items.map(box => {
        const [named, described] = [box.getAttribute("aria-labelledby"), box.getAttribute("aria-describedby")].map(ids => (ids ?? "").split(/\s+/).filter(Boolean).map(id => (document.getElementById(id)?.textContent ?? "").replace(/\s+/g, " ").trim()).join(" "));
        const row = box.closest("li");
        const value = (row?.querySelector("[id$='-value']")?.textContent ?? "").replace(/\s+/g, " ").trim();
        return { field: row?.getAttribute("data-field") ?? "", name: named || box.getAttribute("aria-label") || "", description: described ?? "", value };
      }),
    );
    if (boxes.length) {
      findings.pages[`${label} checkboxes`] = boxes;
      results.check(`${label}: each optional detail's checkbox is named by its row's label`, boxes.every(box => box.name.toLowerCase().includes(box.field === "dob" ? "date of birth" : box.field === "phone" ? "phone" : box.field)), JSON.stringify(boxes));
      results.check(`${label}: each optional detail's checkbox is described by the value it would share (aria-describedby)`, boxes.every(box => !!box.value && box.description.includes(box.value)), JSON.stringify(boxes));
    }
    await auditStep(ctx, page, findings, label, wentBack ? states.slice(0, 1) : plan.variants, { forced: plan.forced, fullPage: true, hero: plan.hero, layout: expectation?.layout });

    // A missing email or phone: the required one opens its form by itself.
    for (const row of rows) {
      if (!row.missing || (row.field !== "email" && row.field !== "phone")) continue;
      const field = row.field as "email" | "phone";
      const value = plan.add?.[field];
      if (!value) {
        if (row.mode === "required") throw new Error(`${plan.prefix}: page ${details.index + 1} needs a ${field} the account lacks; give plan.add.${field}`);
        continue;
      }
      const adder = live(page, `[data-adding="${field}"]`).first();
      if (!(await adder.isVisible().catch(() => false))) {
        await page.getByRole("button", { name: `Add ${row.mode === "required" ? "your" : "a"} ${field === "email" ? "email address" : "phone number"}` }).click({ timeout: 10_000 });
        await adder.waitFor({ timeout: 10_000 });
      } else results.check(`${label}: a required ${field} the account lacks opens its form right on the page`, row.mode === "required", row.text);
      await stepReady(page);
      if (row.mode === "required" && plan.tryContinueFirst) {
        await page.getByRole("button", { name: continueLabel, exact: true }).click();
        const note = live(page, "main [role=alert]").filter({ hasText: /needs/ }).first();
        const said = await note.waitFor({ timeout: 8_000 }).then(() => note.innerText(), () => "");
        results.check(`${label}: "${continueLabel}" before the ${field} is added says what is missing, in words, and stays on the page`, new RegExp(`needs .*${field === "phone" ? "phone number" : "email address"}`, "i").test(said) && (await readFlow(page))?.details?.index === details.index, said.replace(/\s+/g, " ") || "(nothing said)");
        const focusedInAdder = await page.evaluate(`!!document.activeElement && !!document.activeElement.closest('[data-adding="${field}"]')`);
        results.check(`${label}: …and takes focus to the ${field} field`, focusedInAdder === true);
        await auditStep(ctx, page, findings, `${label}-blocked`, states, { forced: plan.forced, fullPage: true });
      }
      await auditStep(ctx, page, findings, `${label}-add-${field}`, states, { forced: plan.forced, fullPage: true });
      const after = await lastSeq(env);
      if (field === "email") {
        await adder.getByRole("textbox", { name: "Email" }).fill(value);
      } else {
        const input = adder.getByRole("textbox", { name: "Phone number" });
        await input.click();
        await page.keyboard.type(value, { delay: 20 });
      }
      await adder.getByRole("button", { name: "Send code" }).click();
      const code = await codeFor(env, field === "email" ? value.toLowerCase() : value, after);
      await page.getByRole("group", { name: /^Code from the/ }).first().waitFor({ timeout: 15_000 });
      await stepReady(page);
      await auditStep(ctx, page, findings, `${label}-add-${field}-code`, states, { forced: plan.forced, fullPage: true });
      await page.getByRole("group", { name: /^Code from the/ }).first().getByRole("textbox").first().click();
      await page.keyboard.type(code, { delay: 25 });
      await live(page, `${DETAILS_LIST} > li[data-field="${field}"]:not([data-missing])`).first().waitFor({ timeout: 15_000 });
      await stepReady(page);
      const added = (await detailRows(page)).find(entry => entry.field === field);
      results.check(`${label}: the ${field} added with a code is on the page now${row.mode === "optional" ? ", ticked to share" : ""}`, !!added && !added.missing && (row.mode === "required" || added.ticked === true), added?.text ?? "(row gone)");
      await auditStep(ctx, page, findings, `${label}-added-${field}`, states.slice(0, 1), { forced: plan.forced, fullPage: true });
    }
    for (const row of rows) {
      if (row.mode !== "optional" || row.missing || !plan.tick?.includes(row.field as DetailField)) continue;
      const box = live(page, `${DETAILS_LIST} > li[data-field="${row.field}"] [role="checkbox"]`).first();
      if ((await box.getAttribute("aria-checked")) !== "true") await box.click();
    }
    await sleep(250);
    await page.getByRole("button", { name: continueLabel, exact: true }).click();
  }
  await page.waitForLoadState("networkidle").catch(() => undefined);
  return walk;
}

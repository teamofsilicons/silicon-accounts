/**
 * The ux-audit suite's overlay helpers (a helper file: run.ts never takes it for journeys): open a dialog, drawer,
 * popover or list from the keyboard, audit it in every variant, and from the keyboard (light 1440 and dark 390):
 *
 *   modal     focus moves into it, Tab stays inside (it cycles), every Tab stop shows focus, Escape closes it and
 *             focus goes back to what opened it (WCAG 2.4.3, 2.4.7)
 *   popover   a non-modal dialog (the date picker): focus moves into it, every stop inside shows focus (walked with
 *             Shift+Tab: Tab out of it closes it, as it should), Escape closes it and focus goes back to its trigger
 *   listbox   a combobox's list: focus stays on the combobox (aria-activedescendant moves instead), which says it is
 *             expanded and which list it controls, ArrowDown makes an option active, Escape closes the list and
 *             focus stays on the combobox
 *
 * Used by overlays.ts and docs.ts.
 */
import type { Locator, Page } from "@playwright/test";
import type { Ctx } from "../../context";
import { sleep } from "../../lib";
import { VARIANTS, activeFocus, applyVariant, auditPage, focusPixels, focusVerdict, settle, tabKey, type Findings, type FocusStop, type Variant } from "./_audit";

export interface Overlay {
  /** Names checks and screenshots ("overlay-identity-change-id"). */
  name: string;
  /** What opens it (focused, then `key`). */
  trigger: (page: Page) => Locator;
  key?: string;
  /** The overlay once open. */
  panel: (page: Page) => Locator;
  kind: "modal" | "popover" | "listbox";
  /** A grid moved through with the arrow keys (a calendar): the day ArrowRight focuses must show it. */
  gridArrows?: boolean;
  expectedConsole?: RegExp[];
}

const label = (stop: FocusStop) => `${stop.name || stop.el} <${stop.tag}${stop.role ? ` role=${stop.role}` : ""}>`;
const KEYBOARD_VARIANTS = new Set(["light-1440", "dark-390"]);

/** Marks the trigger, focuses it and presses its key; resolves once the panel is visible (false when it never opens). */
export async function openFromKeyboard(page: Page, overlay: Overlay): Promise<boolean> {
  const trigger = overlay.trigger(page);
  await trigger.waitFor({ timeout: 20_000 });
  await trigger.evaluate(element => {
    document.querySelectorAll("[data-uxa-trigger]").forEach(node => node.removeAttribute("data-uxa-trigger"));
    element.setAttribute("data-uxa-trigger", "");
  });
  await trigger.focus();
  await page.keyboard.press(overlay.key ?? "Enter");
  const shown = await overlay.panel(page).waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
  await settle(page, 500);
  if (shown) await overlay.panel(page).evaluate(element => element.setAttribute("data-uxa-panel", "")).catch(() => undefined);
  return shown;
}

/** Inside the panel? (The panel is marked so the page can tell.) */
const insidePanel = (page: Page) => page.evaluate("(() => { const a = document.activeElement; return !!a && !!a.closest('[data-uxa-panel]'); })()") as Promise<boolean>;

/** Walks the stops inside the panel with `key` until focus cycles or leaves; measures each stop's focus in pixels. */
async function walkInside(ctx: Ctx, page: Page, key: string, first: FocusStop | null): Promise<{ stops: FocusStop[]; outside: string[] }> {
  const stops: FocusStop[] = [];
  const seen = new Set<number>();
  const outside: string[] = [];
  if (first && !first.none && first.uid !== undefined) {
    seen.add(first.uid);
    if (first.visible) first.pixels = await focusPixels(ctx.env, page, first);
    stops.push(first);
  }
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press(key);
    await sleep(200);
    const stop = await activeFocus(page);
    if (stop.none) {
      outside.push("<body>");
      break;
    }
    if (!(await insidePanel(page))) {
      outside.push(label(stop));
      break;
    }
    if (stop.uid !== undefined && seen.has(stop.uid)) break;
    if (stop.uid !== undefined) seen.add(stop.uid);
    if (stop.visible) stop.pixels = await focusPixels(ctx.env, page, stop);
    stops.push(stop);
  }
  return { stops, outside };
}

export async function keyboardChecks(ctx: Ctx, page: Page, findings: Findings, overlay: Overlay, variant: Variant): Promise<void> {
  const { env, results } = ctx;
  const name = `${overlay.name} ${variant.key}`;
  await page.mouse.move(0, 0).catch(() => undefined);
  const first = await activeFocus(page);
  if (overlay.kind === "listbox") {
    const state = (await page.evaluate(`(() => {
      const a = document.activeElement;
      const list = document.querySelector("[data-uxa-panel]");
      return { onTrigger: !!a && a.hasAttribute("data-uxa-trigger"), expanded: a ? a.getAttribute("aria-expanded") : null, controls: a ? a.getAttribute("aria-controls") : null, list: list ? list.id : null };
    })()`)) as { onTrigger: boolean; expanded: string | null; controls: string | null; list: string | null };
    results.check(`${name}: focus stays on the combobox, which says it is expanded and which list it controls`, state.onTrigger && state.expanded === "true" && !!state.controls && state.controls === state.list, JSON.stringify(state));
    await page.keyboard.press("ArrowDown");
    await sleep(250);
    const active = (await page.evaluate(`(() => {
      const a = document.activeElement;
      const id = a ? a.getAttribute("aria-activedescendant") : null;
      const option = id ? document.getElementById(id) : null;
      return { id, role: option ? option.getAttribute("role") : null, inList: !!option && !!option.closest("[data-uxa-panel]"), text: option ? option.textContent.trim().slice(0, 60) : null };
    })()`)) as { id: string | null; role: string | null; inList: boolean; text: string | null };
    results.check(`${name}: ArrowDown makes an option of the list active (aria-activedescendant)`, !!active.id && active.role === "option" && active.inList, JSON.stringify(active));
    findings.pages[`${name} keyboard`] = { state, active };
    return;
  }
  results.check(`${name}: opening it moves focus into it`, !first.none && (await insidePanel(page)), first.none ? "focus on <body>" : label(first));
  if (overlay.gridArrows && (await insidePanel(page))) {
    // The arrow keys move focus through the grid; the cell they land on must look focused (not only the selected one).
    await page.keyboard.press("ArrowRight");
    await sleep(500);
    const moved = await activeFocus(page);
    const changed = moved.uid !== first.uid && (await insidePanel(page));
    moved.pixels = changed && moved.visible ? await focusPixels(env, page, moved) : "unmeasured";
    findings.pages[`${name} arrow key`] = moved;
    results.check(`${name}: ArrowRight moves focus to the next cell and that cell shows it (WCAG 2.4.7)`, changed && moved.pixels === "differs", `${changed ? label(moved) : "focus did not move"}; pixels ${moved.pixels}${moved.focusVisible ? " (:focus-visible)" : ""}`);
    await page.keyboard.press("ArrowLeft");
    await sleep(400);
  }
  // A modal: Tab forward, and it must cycle inside. A popover: Shift+Tab back through it (Tab out of it closes it).
  const walk = await walkInside(ctx, page, overlay.kind === "modal" ? tabKey(env) : tabKey(env, true), (await insidePanel(page)) ? first : null);
  findings.pages[`${name} tab stops`] = walk.stops;
  if (overlay.kind === "modal") results.check(`${name}: Tab stays inside while it is open (a modal keeps focus)`, walk.outside.length === 0, walk.outside.length ? `left to ${walk.outside.join(", ")}` : `${walk.stops.length} stops, cycling`);
  const unseen = walk.stops.filter(stop => focusVerdict(stop) === "none");
  const unsure = walk.stops.filter(stop => focusVerdict(stop) === "inconclusive");
  results.check(`${name}: every Tab stop inside shows keyboard focus (WCAG 2.4.7)`, walk.stops.length > 0 && unseen.length === 0, [...unseen.map(stop => `${label(stop)} (pixels ${stop.pixels})`), ...unsure.map(stop => `inconclusive, not counted: ${label(stop)}`)].join("; ") || `${walk.stops.length} stops: ${walk.stops.map(label).join(" → ")}`);
  const covered = walk.stops.filter(stop => stop.obscuredBy || !stop.inView);
  results.check(`${name}: every Tab stop inside is in view and uncovered`, covered.length === 0, covered.map(stop => `${label(stop)} ${stop.obscuredBy ? `under ${stop.obscuredBy}` : "out of view"}`).join("; "));
}

/** Escape closes it and focus goes back to what opened it (a combobox keeps focus itself). */
export async function closeWithEscape(ctx: Ctx, page: Page, overlay: Overlay, variant: Variant, check: boolean): Promise<void> {
  // A popover's inner view (the years grid) takes the first Escape; a second closes it.
  for (let i = 0; i < 2; i++) {
    if (!(await overlay.panel(page).isVisible().catch(() => false))) break;
    await page.keyboard.press("Escape");
    await sleep(500);
  }
  const closed = !(await overlay.panel(page).isVisible().catch(() => false));
  if (!check) return;
  const back = (await page.evaluate("(() => { const a = document.activeElement; return { onTrigger: !!a && a.hasAttribute('data-uxa-trigger'), el: a ? a.tagName.toLowerCase() + (a.getAttribute('aria-label') ? '[' + a.getAttribute('aria-label') + ']' : '') + ' ' + (a.textContent || '').trim().slice(0, 40) : 'none' }; })()")) as { onTrigger: boolean; el: string };
  ctx.results.check(`${overlay.name} ${variant.key}: Escape closes it and focus goes back to what opened it (WCAG 2.4.3)`, closed && back.onTrigger, `${closed ? "closed" : "still open"}; focus on ${back.el}`);
}

/** Each variant (default all four): open from the keyboard, audit, (light 1440 and dark 390) the keyboard checks, then Escape. */
export async function auditOverlay(ctx: Ctx, page: Page, findings: Findings, overlay: Overlay, prepare?: (variant: Variant) => Promise<void>, variants: Variant[] = VARIANTS): Promise<void> {
  for (const variant of variants) {
    if (prepare) await prepare(variant);
    else await applyVariant(page, variant);
    const shown = await openFromKeyboard(page, overlay);
    ctx.results.check(`${overlay.name} ${variant.key}: opens from the keyboard (${overlay.key ?? "Enter"} on its trigger)`, shown);
    if (!shown) continue;
    // The page stays scrolled where opening it left it (a popover below the fold is brought into view first).
    await overlay.panel(page).scrollIntoViewIfNeeded().catch(() => undefined);
    await auditPage(ctx, page, findings, { name: overlay.name, variant, expectedConsole: overlay.expectedConsole, keepScroll: true });
    const keyboard = KEYBOARD_VARIANTS.has(variant.key);
    if (keyboard) {
      await keyboardChecks(ctx, page, findings, overlay, variant);
      // Walking may have closed a popover (or moved within it): open it again from its trigger for the Escape check.
      if (!(await overlay.panel(page).isVisible().catch(() => false)) || overlay.kind !== "modal") {
        if (await overlay.panel(page).isVisible().catch(() => false)) {
          await page.keyboard.press("Escape");
          await sleep(400);
          if (await overlay.panel(page).isVisible().catch(() => false)) await page.keyboard.press("Escape");
          await sleep(400);
        }
        await openFromKeyboard(page, overlay);
      }
    }
    await closeWithEscape(ctx, page, overlay, variant, keyboard);
  }
}

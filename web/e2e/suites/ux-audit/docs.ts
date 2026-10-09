/**
 * ux-audit: the docs at /docs (a route of the account site, written for Silicons), in light and dark at 1440 and
 * 390 px: the landing page, a group page, an instructive page, an informative page, the error and API references and
 * the long CLI reference (light 1440 and dark 390 only), the docs' not-found page; the search dialog and the phone
 * menu drawer opened from the keyboard; and a jump from "On this page" that must not leave its heading under the
 * sticky top bar. Every page: the generic audit (_audit.ts).
 */
import type { Journey } from "../../context";
import { sleep } from "../../lib";
import { VARIANTS, auditContext, auditVariants, collectConsole, findingsFor, saveFindings, settle, waitUntil, type Variant } from "./_audit";
import { auditOverlay } from "./_overlay";

const PAGES: Array<{ path: string; name: string; variants?: Variant[] }> = [
  { path: "/docs", name: "docs-home" },
  { path: "/docs/start", name: "docs-start" },
  { path: "/docs/start/add-sign-in", name: "docs-add-sign-in" },
  { path: "/docs/learn/sign-in-flow", name: "docs-sign-in-flow" },
  { path: "/docs/reference/errors", name: "docs-errors" },
  { path: "/docs/reference/api/sign-in", name: "docs-api-sign-in" },
  // 88 KB of commands: two variants are enough to see its code blocks and tables at both widths.
  { path: "/docs/reference/cli", name: "docs-cli", variants: [VARIANTS[0]!, VARIANTS[3]!] },
];

export const journeys: Journey[] = [
  {
    name: "ux-audit-docs",
    title: "the docs: landing, group, instructive and informative pages, the error, API and CLI references, not-found, the search dialog and the phone menu from the keyboard, and an anchor jump clear of the sticky top bar — light/dark × 1440/390",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      const context = await auditContext(browser);
      const page = await context.newPage();
      // The account site's /docs addresses lead to the developer site's /docs/accounts, so the 404 answers there.
      const missing = [/status of 404 .*\/docs\/(accounts\/)?uxa-no-such-page/];
      results.watch(page, "docs", missing);
      collectConsole(page, missing);

      for (const entry of PAGES) {
        const answer = await page.goto(`${env.site}${entry.path}`);
        await page.locator("main h1").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
        await settle(page, 500);
        const title = (await page.locator("main h1").first().innerText().catch(() => "")).trim();
        results.check(`${entry.name}: ${entry.path} answers 200 with a page title`, answer?.status() === 200 && title.length > 0, `${answer?.status()} "${title}"`);
        await auditVariants(ctx, page, findings, entry.name, entry.variants ?? VARIANTS);
      }

      // Not found.
      const gone = await page.goto(`${env.site}/docs/uxa-no-such-page`);
      await settle(page, 500);
      const goneText = ((await page.locator("main").first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      results.check("docs-not-found: answers 404 and says so, with a way on (search or the docs' home)", gone?.status() === 404 && /not found|no page|doesn't exist|does not exist/i.test(goneText) && (await page.locator("main a[href^='/docs']").count()) > 0, `${gone?.status()}: ${goneText.slice(0, 200)}`);
      await auditVariants(ctx, page, findings, "docs-not-found", VARIANTS, { expectedConsole: missing });

      // Search, from the keyboard, with a query typed.
      await page.goto(`${env.site}/docs/start`);
      await page.locator("main h1").first().waitFor({ timeout: 30_000 });
      await settle(page, 400);
      await auditOverlay(ctx, page, findings, {
        name: "docs-search",
        // By its shortcut, not its name: the trigger is a link to /docs/search (search works without script) that opens
        // the search dialog in place; on a phone it shows only its icon.
        trigger: p => p.locator('[aria-haspopup="dialog"][aria-keyshortcuts]').filter({ visible: true }).first(),
        panel: p => p.getByRole("dialog", { name: "Search the docs" }),
        kind: "modal",
      }, undefined, [VARIANTS[0]!, VARIANTS[3]!]);
      // With results: a query, then the first result opens with Enter.
      await page.locator('[aria-haspopup="dialog"][aria-keyshortcuts]').filter({ visible: true }).first().click();
      const box = page.getByRole("dialog", { name: "Search the docs" }).getByRole("combobox").or(page.getByRole("dialog", { name: "Search the docs" }).getByRole("textbox")).first();
      await box.fill("rate limit");
      const options = page.getByRole("dialog", { name: "Search the docs" }).getByRole("option");
      const found = await options.first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      const optionNames = found ? (await options.allInnerTexts()).slice(0, 5).map(text => text.replace(/\s+/g, " ").slice(0, 80)) : [];
      results.check("docs-search: \"rate limit\" finds pages", found && optionNames.length > 0, optionNames.join(" | "));
      await page.screenshot({ path: `${env.shots}/uxa-docs-search-results-light-1440.png` });
      const before = page.url();
      await page.keyboard.press("Enter");
      const moved = await page.waitForURL(url => url.href !== before && url.pathname.startsWith("/docs"), { timeout: 10_000 }).then(() => true, () => false);
      results.check("docs-search: Enter opens the highlighted result", moved, page.url().replace(env.site, ""));

      // The phone menu (below 900 px): the header's native popover, which holds the docs' navigation on a docs page.
      await page.goto(`${env.site}/docs/learn/sign-in-flow`);
      await page.locator("main h1").first().waitFor({ timeout: 30_000 });
      await settle(page, 400);
      await auditOverlay(ctx, page, findings, {
        name: "docs-menu",
        trigger: p => p.getByRole("button", { name: "Open the menu" }),
        panel: p => p.getByRole("dialog", { name: "Menu" }),
        kind: "popover",
      }, undefined, [VARIANTS[2]!, VARIANTS[3]!]);

      // A jump from "On this page" (1440: the rail) lands its heading below the sticky top bar.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`${env.site}/docs/reference/errors`);
      await page.locator("main h1").first().waitFor({ timeout: 30_000 });
      await settle(page, 400);
      const toc = page.getByRole("navigation", { name: "On this page" }).filter({ visible: true }).first().getByRole("link");
      const count = await toc.count();
      const target = toc.nth(Math.min(4, Math.max(0, count - 1)));
      const href = (await target.getAttribute("href").catch(() => null)) ?? "";
      if (count > 0 && href.startsWith("#")) {
        await target.click();
        await sleep(900);
        await waitUntil(page, "!window.__uxa || window.__uxa.calm()", 3_000);
        const where = (await page.evaluate(`(() => {
          const heading = document.getElementById(${JSON.stringify(decodeURIComponent(href.slice(1)))});
          const header = document.querySelector("header");
          if (!heading || !header) return null;
          const h = heading.getBoundingClientRect(), t = header.getBoundingClientRect();
          return { heading: Math.round(h.top), headerBottom: Math.round(t.bottom), text: heading.textContent.trim().slice(0, 60), position: getComputedStyle(header).position };
        })()`)) as { heading: number; headerBottom: number; text: string; position: string } | null;
        await page.screenshot({ path: `${env.shots}/uxa-docs-anchor-jump-light-1440.png` });
        results.check("docs: a jump from \"On this page\" leaves its heading in view below the sticky top bar", !!where && where.heading >= where.headerBottom - 1 && where.heading < 900, JSON.stringify(where));
      } else results.check("docs: the errors reference has an \"On this page\" list at 1440", false, `${count} links, first href ${href}`);

      results.check("docs: findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
];

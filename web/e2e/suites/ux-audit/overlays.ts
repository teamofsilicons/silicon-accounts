/**
 * ux-audit: what opens on top of a page (dialogs, drawers, the command palette, the sign-up's popovers), opened from
 * the keyboard, in light and dark at 1440 and 390 px: the generic audit with it open (axe, squircles, sideways
 * scroll, console, vocabulary, a screenshot), and from the keyboard (at 1440 light and 390 dark): focus moves into it,
 * a modal keeps Tab inside, every Tab stop in it shows focus (pixels, as _audit.ts focusPixels), and Escape closes it
 * and puts focus back on what opened it.
 *
 *   identity    "CarbonID" (dialog, from Personal info's CarbonID row)
 *   silicons    a Silicon's page: Change its key (dialog), Hand it over (dialog)
 *   palette     "Search and jump" (⌘K), from the shell's search button
 *   sign-up     the date of birth picker and the timezone list (popovers of the hosted sign-up)
 *   developer   the developer site (briefcase's seeded owner): its command palette (⌘K), the apps home's "New app"
 *               dialog, a user's drawer on the Users tab, and the sign-in setup's History drawer
 *
 * Also the state a Carbon reaches through Create a Silicon (/silicons/new): the generated STK, shown once on its page.
 */
import type { Journey } from "../../context";
import { sleep } from "../../lib";
import { DEVELOPER_EXPECTED, VARIANTS, applyVariant, auditContext, auditPage, collectConsole, findingsFor, freshEmail, hostedLink, openAccountPage, openDeveloperPage, pageFetch, saveFindings, sendEmailCode, signInAsSeededOwnerOnDeveloper, signedInCarbon, stepReady, type Variant } from "./_audit";
import { auditOverlay } from "./_overlay";

/** The History drawer at 1440 light and 390 dark (its content is the same list in every theme). */
const VARIANTS_FOR_HISTORY = [VARIANTS[0]!, VARIANTS[3]!];

export const journeys: Journey[] = [
  {
    name: "ux-audit-overlays",
    title: "dialogs, drawers, the command palette and the sign-up's popovers opened from the keyboard: the audit with them open (light/dark × 1440/390), focus moves in, stays in, shows, and goes back on Escape",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);

      // A Carbon with one Silicon (its drawer).
      const carbon = await signedInCarbon(ctx, "uxa.overlays");
      const { page } = carbon;
      results.watch(page, "overlays");
      collectConsole(page);
      const silicon = `Overlay Scout ${Date.now().toString(36).slice(-4)}`;
      const created = await pageFetch<{ silicon?: { id?: string } }>(page, "/v1/me/silicons", { method: "POST", body: { id: `si:uxa-overlay-${Date.now().toString(36)}`, display_name: silicon } });
      results.check("overlays: a Silicon to open", created.status === 200 || created.status === 201, `${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);

      await openAccountPage(ctx, page, "/personal", /./);
      await auditOverlay(ctx, page, findings, {
        name: "overlay-identity-change-id",
        trigger: p => p.getByRole("link", { name: /^CarbonID/ }).first(),
        panel: p => p.getByRole("dialog", { name: "CarbonID" }),
        kind: "modal",
      });
      await openAccountPage(ctx, page, "/", /./);
      await auditOverlay(ctx, page, findings, {
        name: "overlay-palette",
        // The top bar's "Search and jump ⌘K" at 1440; the compact bar's search button on a phone.
        trigger: p => p.locator('button[aria-keyshortcuts], button[aria-label="Search and jump"]').filter({ visible: true }).first(),
        panel: p => p.getByRole("dialog", { name: "Search and jump" }),
        kind: "modal",
      });

      // Created on /silicons/new (three steps): the generated STK is shown exactly once, on its page (UNDERSTANDING.md
      // "Silicon account").
      {
        await applyVariant(page, VARIANTS[0]!);
        await page.goto(`${env.site}/silicons/new`);
        await page.getByRole("textbox", { name: "Name" }).fill(`Reveal Scout ${Date.now().toString(36).slice(-4)}`, { timeout: 30_000 });
        await page.locator("main").getByText(/is available\./).first().waitFor({ timeout: 20_000 });
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByRole("button", { name: "Continue", exact: true }).click({ timeout: 10_000 });
        // Create Silicon ignores a press right after its step opens (ARRIVAL_PAUSE: a double-click never creates one).
        await sleep(900);
        await page.getByRole("button", { name: "Create Silicon", exact: true }).click({ timeout: 10_000 });
        const stk = page.locator("main").getByText(/stk-[0-9a-f]{12}/).first();
        const shown = await stk.waitFor({ timeout: 20_000 }).then(() => true, () => false);
        results.check("silicons-stk-reveal: the generated STK is shown on the page once the Silicon exists", shown, (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300));
        for (const variant of [VARIANTS[0]!, VARIANTS[3]!]) await auditPage(ctx, page, findings, { name: "silicons-stk-reveal", variant, keepScroll: true });
      }
      // A Silicon's page: its dialogs (Change its key on Access, Hand it over on Settings).
      await openAccountPage(ctx, page, "/silicons", /Silicon/);
      await page.getByRole("link", { name: new RegExp(silicon) }).first().click({ timeout: 15_000 });
      await page.getByRole("region", { name: "Secret key", exact: true }).waitFor({ timeout: 20_000 });
      await auditOverlay(ctx, page, findings, {
        name: "overlay-silicon-key",
        trigger: p => p.getByRole("region", { name: "Secret key", exact: true }).getByRole("button", { name: "Change", exact: true }),
        panel: p => p.getByRole("dialog", { name: /key\?$/ }),
        kind: "modal",
      });
      await page.getByRole("tab", { name: "Settings" }).click();
      await page.getByRole("region", { name: "About", exact: true }).waitFor({ timeout: 10_000 });
      await auditOverlay(ctx, page, findings, {
        name: "overlay-silicon-handover",
        trigger: p => p.getByRole("button", { name: "Hand Over" }),
        panel: p => p.getByRole("dialog", { name: /^Hand .* over$/ }),
        kind: "modal",
      });
      await carbon.context.close();

      // The hosted sign-up's popovers: the date of birth picker and the timezone list.
      {
        const context = await auditContext(browser);
        const signup = await context.newPage();
        results.watch(signup, "overlays-signup");
        collectConsole(signup);
        await signup.goto(await hostedLink(env, signup, "briefcase"));
        const code = await sendEmailCode(env, signup, freshEmail("uxa.overlays.signup"));
        await signup.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
        await signup.keyboard.type(code, { delay: 25 });
        await signup.getByRole("button", { name: "Create account" }).waitFor({ timeout: 30_000 });
        await stepReady(signup);
        await auditOverlay(ctx, signup, findings, {
          name: "overlay-signup-date-of-birth",
          trigger: p => p.getByRole("button", { name: /Date of birth/ }).first(),
          panel: p => p.getByRole("dialog", { name: /Date of birth: choose a day/ }),
          kind: "popover",
          gridArrows: true,
        });
        await auditOverlay(ctx, signup, findings, {
          name: "overlay-signup-timezone",
          trigger: p => p.getByRole("combobox", { name: "Timezone" }),
          key: "ArrowDown",
          panel: p => p.getByRole("listbox").first(),
          kind: "listbox",
        });
        await context.close();
      }

      // The developer site, as briefcase's seeded owner: its palette, a user's drawer on the Users tab, the History drawer.
      // First a new Carbon in briefcase's user base, so the Users table has a row to open whatever ran before.
      {
        const context = await auditContext(browser);
        const user = await context.newPage();
        results.watch(user, "overlays-briefcase-user");
        await user.goto(await hostedLink(env, user, "briefcase"));
        const code = await sendEmailCode(env, user, freshEmail("uxa.overlays.user"));
        await user.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
        await user.keyboard.type(code, { delay: 25 });
        await user.getByRole("button", { name: "Create account" }).click({ timeout: 30_000 });
        await user.getByRole("button", { name: "Share and continue" }).click({ timeout: 30_000 });
        await user.waitForURL(url => url.href.startsWith(`${env.apps}/briefcase/`), { timeout: 30_000 });
        await context.close();
      }
      {
        const context = await auditContext(browser);
        const owner = await context.newPage();
        results.watch(owner, "overlays-developer", DEVELOPER_EXPECTED);
        collectConsole(owner, DEVELOPER_EXPECTED);
        await signInAsSeededOwnerOnDeveloper(ctx, owner, findings);
        await openDeveloperPage(ctx, owner, "/apps/briefcase");
        await auditOverlay(ctx, owner, findings, {
          name: "overlay-developer-palette",
          trigger: p => p.locator('button[aria-keyshortcuts], button[aria-label="Search and jump"]').filter({ visible: true }).first(),
          panel: p => p.getByRole("dialog", { name: "Search and jump" }),
          kind: "modal",
          expectedConsole: DEVELOPER_EXPECTED,
        });
        await openDeveloperPage(ctx, owner, "/");
        await auditOverlay(ctx, owner, findings, {
          name: "overlay-developer-new-app",
          trigger: p => p.getByRole("button", { name: "New app", exact: true }).first(),
          panel: p => p.getByRole("dialog", { name: "Create an app" }),
          kind: "modal",
          expectedConsole: DEVELOPER_EXPECTED,
        });
        await openDeveloperPage(ctx, owner, "/apps/briefcase/users");
        const prepare = async (variant: Variant) => {
          await applyVariant(owner, variant);
          await owner.locator("button[data-open-user]").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
        };
        await auditOverlay(ctx, owner, findings, {
          name: "overlay-developer-user",
          trigger: p => p.locator("button[data-open-user]").first(),
          panel: p => p.getByRole("dialog").last(),
          kind: "modal",
          expectedConsole: DEVELOPER_EXPECTED,
        }, prepare);
        await openDeveloperPage(ctx, owner, "/apps/briefcase/sign-in");
        await auditOverlay(ctx, owner, findings, {
          name: "overlay-developer-history",
          trigger: p => p.getByRole("button", { name: /^History/ }).filter({ visible: true }).first(),
          panel: p => p.getByRole("dialog").last(),
          kind: "modal",
          expectedConsole: DEVELOPER_EXPECTED,
        }, undefined, [VARIANTS_FOR_HISTORY[0]!, VARIANTS_FOR_HISTORY[1]!]);
        await context.close();
      }
      results.check("overlays: findings saved", true, saveFindings(ctx, findings));
    },
  },
];

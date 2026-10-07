/**
 * ux-audit: what opens on top of a page (dialogs, drawers, the command palette, the sign-up's popovers), opened from
 * the keyboard, in light and dark at 1440 and 390 px: the generic audit with it open (axe, squircles, sideways
 * scroll, console, vocabulary, a screenshot), and from the keyboard (at 1440 light and 390 dark): focus moves into it,
 * a modal keeps Tab inside, every Tab stop in it shows focus (pixels, as _audit.ts focusPixels), and Escape closes it
 * and puts focus back on what opened it.
 *
 *   identity    "Change your id" (dialog)
 *   silicons    "Create a Silicon" (drawer); a Silicon's own drawer ("Manage si:…")
 *   palette     "Search and jump" (⌘K), from the shell's search button
 *   sign-up     the date of birth picker and the timezone list (popovers of the hosted sign-up)
 *   developer   a user's drawer on briefcase's Users tab (its seeded owner)
 */
import type { Journey } from "../../context";
import { applyVariant, auditContext, collectConsole, findingsFor, freshEmail, hostedLink, openAccountPage, pageFetch, saveFindings, sendEmailCode, signInAsSeededOwner, signedInCarbon, stepReady, type Variant } from "./_audit";
import { auditOverlay } from "./_overlay";

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

      await openAccountPage(ctx, page, "/", /./);
      await auditOverlay(ctx, page, findings, {
        name: "overlay-identity-change-id",
        trigger: p => p.getByRole("button", { name: "Change id", exact: true }).first(),
        panel: p => p.getByRole("dialog", { name: "Change your id" }),
        kind: "modal",
      });
      await auditOverlay(ctx, page, findings, {
        name: "overlay-palette",
        // The top bar's "Search and jump ⌘K" at 1440; the compact bar's search button on a phone.
        trigger: p => p.locator('button[aria-keyshortcuts], button[aria-label="Search and jump"]').filter({ visible: true }).first(),
        panel: p => p.getByRole("dialog", { name: "Search and jump" }),
        kind: "modal",
      });

      await openAccountPage(ctx, page, "/silicons", /Silicon/);
      await auditOverlay(ctx, page, findings, {
        name: "overlay-create-silicon",
        trigger: p => p.getByRole("button", { name: "Create a Silicon" }).first(),
        panel: p => p.getByRole("dialog", { name: "Create a Silicon" }),
        kind: "modal",
      });
      await auditOverlay(ctx, page, findings, {
        name: "overlay-silicon-drawer",
        trigger: p => p.getByRole("button", { name: /^Manage si:uxa-overlay-/ }).first(),
        panel: p => p.getByRole("dialog", { name: silicon }),
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

      // A user's drawer on briefcase's Users tab, as its seeded owner.
      {
        const context = await auditContext(browser);
        const owner = await context.newPage();
        results.watch(owner, "overlays-developer");
        collectConsole(owner);
        await signInAsSeededOwner(ctx, owner, findings);
        await openAccountPage(ctx, owner, "/developer/briefcase/users", /Users|users/);
        const prepare = async (variant: Variant) => {
          await applyVariant(owner, variant);
          await owner.locator("button[data-open-user]").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
        };
        await auditOverlay(ctx, owner, findings, {
          name: "overlay-developer-user",
          trigger: p => p.locator("button[data-open-user]").first(),
          panel: p => p.getByRole("dialog").last(),
          kind: "modal",
        }, prepare);
        await context.close();
      }
      results.check("overlays: findings saved", true, saveFindings(ctx, findings));
    },
  },
];

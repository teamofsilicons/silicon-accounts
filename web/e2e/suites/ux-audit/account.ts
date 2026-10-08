/**
 * ux-audit: the account site's pages for a signed-in Carbon, in light and dark at 1440 and 390 px:
 *
 *   empty   a Carbon who just signed up: every page's empty state
 *   full    a Carbon with two apps (briefcase, dm with a phone), a second email, two Silicons and a Silicon's pending
 *           request to be its custodian, OBO proofs (one revoked) and the activity all of that leaves
 *
 * Every page: the generic audit (_audit.ts), and at the bottom of the page no content under the floating dock (the
 * desktop dock at 1440, the compact bar at 390): the orchestrator's UX note 2.
 */
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { api, codeFor, completeDetails, json, lastSeq, postJson, sleep, tag } from "../../lib";
import { VARIANTS, auditPage, auditVariants, checkDock, collectConsole, findingsFor, hostedLink, openAccountPage, pageFetch, saveFindings, signedInCarbon, type Findings } from "./_audit";

export const ACCOUNT_PAGES: Array<{ path: string; name: string; ready: RegExp }> = [
  { path: "/", name: "identity", ready: /./ },
  { path: "/sign-in-methods", name: "sign-in-methods", ready: /Email|email/ },
  { path: "/apps", name: "apps", ready: /App|app/ },
  { path: "/silicons", name: "silicons", ready: /Silicon/ },
  { path: "/proofs", name: "proofs", ready: /User verification/ },
  { path: "/activity", name: "activity", ready: /./ },
  { path: "/settings", name: "settings", ready: /./ },
];

/** Every account page in every variant, then the dock check. */
async function auditAccountPages(ctx: Ctx, page: Page, findings: Findings, prefix: string, expect: Partial<Record<string, RegExp>> = {}): Promise<void> {
  for (const entry of ACCOUNT_PAGES) {
    const text = await openAccountPage(ctx, page, entry.path, entry.ready);
    const wanted = expect[entry.name];
    if (wanted) ctx.results.check(`${prefix}-${entry.name}: shows ${wanted.source}`, wanted.test(text), text.slice(0, 300));
    await auditVariants(ctx, page, findings, `${prefix}-${entry.name}`, VARIANTS, { fullPage: true });
    await checkDock(ctx, page, findings, `${prefix}-${entry.name}`);
  }
}

/**
 * Signs the browser's Carbon into an app through its hosted link: "Continue as", then the app's details pages (v2: a
 * required phone the account lacks is added on the page with a code; optional details left unticked).
 */
async function signIntoApp(ctx: Ctx, page: Page, app: string, phone?: string): Promise<void> {
  const { env } = ctx;
  await page.goto(await hostedLink(env, page, app));
  await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
  await completeDetails(env, page, app, phone ? { add: { phone } } : {});
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-account-empty",
    title: "a Carbon who just signed up: identity, sign-in methods, apps, Silicons, proofs, activity and settings (empty states), light/dark × 1440/390, and the dock never covers the last content",
    async run(ctx) {
      const { results } = ctx;
      const findings = findingsFor(ctx);
      const carbon = await signedInCarbon(ctx, "uxa.empty");
      results.watch(carbon.page, "account-empty");
      collectConsole(carbon.page);
      results.check("account-empty: signed up as a new Carbon", carbon.id.startsWith("c:"), carbon.id);
      await auditAccountPages(ctx, carbon.page, findings, "account-empty", { identity: new RegExp(carbon.id.slice(2)) });

      // v2: building apps lives on the developer site. The dock's Developer item (1440) and the phone sheet lead there,
      // named as the site they open; the apps page says where apps are set up.
      const meta = await json<{ developer_url?: string }>(`${ctx.env.site}/v1/meta`);
      const developerUrl = (meta.body.developer_url ?? "").replace(/\/+$/, "");
      await openAccountPage(ctx, carbon.page, "/", /./);
      await carbon.page.setViewportSize({ width: 1440, height: 900 });
      const dockLink = await carbon.page.locator("nav[aria-label='Account sections'] a[data-external]").evaluateAll(links => links.map(link => ({ href: (link as HTMLAnchorElement).href, name: link.getAttribute("aria-label") ?? "", text: (link.textContent ?? "").trim() })));
      results.check("account-empty: the dock's Developer item is a link to the developer site (developer_url), named \"Developer site\"", dockLink.length === 1 && dockLink[0]!.href.replace(/\/+$/, "") === developerUrl && /Developer/.test(dockLink[0]!.name) && dockLink[0]!.name.includes(dockLink[0]!.text), JSON.stringify(dockLink));
      await openAccountPage(ctx, carbon.page, "/apps", /App|app/);
      const appsLinks = await carbon.page.locator("main a[href]").evaluateAll((links, developer) => links.filter(link => (link as HTMLAnchorElement).href.replace(/\/+$/, "") === developer).map(link => (link.textContent ?? "").trim()), developerUrl);
      results.check("account-empty: the apps page points app builders to the developer site", appsLinks.length > 0, appsLinks.join(" | ") || "no link to the developer site on /apps");
      results.check("account-empty: findings saved", true, saveFindings(ctx, findings));
      await carbon.context.close();
    },
  },
  {
    name: "ux-audit-account-full",
    title: "a Carbon with apps, a phone and a second email, Silicons and a custodian request, OBO proofs (one revoked) and activity: every account page, light/dark × 1440/390, and the dock never covers the last content",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results } = ctx;
      const findings = findingsFor(ctx);
      const carbon = await signedInCarbon(ctx, "uxa.full");
      const { page } = carbon;
      results.watch(page, "account-full");
      collectConsole(page);
      const t = tag();

      // Two apps: briefcase, then dm with the phone it requires.
      const phone = `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;
      await signIntoApp(ctx, page, "briefcase");
      await signIntoApp(ctx, page, "dm", phone);
      await page.goto(`${env.site}/`);
      await page.locator("main").first().waitFor({ timeout: 30_000 });

      // A second email, verified.
      const second = `uxa.second.${t}@example.test`;
      const after = await lastSeq(env);
      const added = await pageFetch<{ challenge_id?: string }>(page, "/v1/me/emails", { method: "POST", body: { email: second } });
      const code = added.body.challenge_id ? await codeFor(env, second, after) : "";
      const verified = await pageFetch(page, "/v1/me/emails/verify", { method: "POST", body: { challenge_id: added.body.challenge_id, code } });
      results.check("account-full: a second email is on the account", verified.status === 200, `${added.status} → ${verified.status}`);

      // Two Silicons, and a Silicon that names this Carbon as its custodian (pending).
      for (const [handle, name] of [[`uxa-scout-${t}`, `Scout ${t}`], [`uxa-a-very-long-silicon-${t}`, `A Silicon With A Rather Long Display Name ${t}`]] as const) {
        const created = await pageFetch<{ stk?: string }>(page, "/v1/me/silicons", { method: "POST", body: { id: `si:${handle}`, display_name: name } });
        results.check(`account-full: created si:${handle}`, created.status === 200 || created.status === 201, `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
      }
      const asking = await api(ctx, "/v1/silicons", { method: "POST", json: { id: `si:uxa-asks-${t}`, display_name: `Asks ${t}`, custodian: carbon.id }, headers: { "idempotency-key": `uxa-${t}-asks` } });
      results.check("account-full: a Silicon asked this Carbon to be its custodian", asking.status === 200 || asking.status === 201 || asking.status === 202, `${asking.status} ${JSON.stringify(asking.body).slice(0, 200)}`);

      // OBO proofs dm → briefcase on the Carbon's behalf; the Carbon revokes one.
      const proofIds: string[] = [];
      for (let i = 0; i < 2; i++) {
        const issued = await postJson<{ body?: { proof_id?: string } }>(`${env.apps}/dm/actions/issue-obo`, { uuid: carbon.uuid, receiving_app: "briefcase", scopes: ["files.write"] });
        if (issued.body.body?.proof_id) proofIds.push(issued.body.body.proof_id);
      }
      results.check("account-full: dm holds two OBO proofs on the Carbon's behalf", proofIds.length === 2, proofIds.join(", "));
      if (proofIds[0]) {
        const revoked = await pageFetch(page, `/v1/me/proofs/${encodeURIComponent(proofIds[0])}`, { method: "DELETE" });
        results.check("account-full: one proof revoked", revoked.status === 200 || revoked.status === 204, String(revoked.status));
      }
      await sleep(500);

      await auditAccountPages(ctx, page, findings, "account-full", {
        "sign-in-methods": new RegExp(second.replace(/[.]/g, "\\.")),
        apps: /Briefcase[\s\S]*DM|DM[\s\S]*Briefcase/,
        silicons: new RegExp(`uxa-scout-${t}`),
        proofs: /Briefcase/,
      });
      // An app whose access the Carbon removed: the apps page's "Access removed" view.
      const removed = await pageFetch(page, "/v1/me/apps/briefcase", { method: "DELETE" });
      results.check("account-full: briefcase's access removed", removed.status === 200 || removed.status === 204, `${removed.status} ${JSON.stringify(removed.body).slice(0, 160)}`);
      await openAccountPage(ctx, page, "/apps", /App|app/);
      const removedView = page.getByRole("button", { name: /^Access removed/ }).or(page.getByRole("radio", { name: /^Access removed/ })).first();
      await removedView.click({ timeout: 15_000 });
      await sleep(600);
      const removedText = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      results.check("account-full-apps-removed: the removed app is listed under Access removed", /Briefcase/.test(removedText), removedText.slice(0, 300));
      await auditVariants(ctx, page, findings, "account-full-apps-removed", [VARIANTS[0]!, VARIANTS[3]!], { fullPage: true });
      results.check("account-full: findings saved", true, saveFindings(ctx, findings));
      await carbon.context.close();
    },
  },
  {
    name: "ux-audit-account-states",
    title: "the account site's in-between states (light 1440 and dark 390): the identity card's back, photo, timezone and date of birth editors, Change id with a taken id, adding an email up to its code, the remove questions (email, app, proof), the ended proofs, and deleting an account while a Silicon is in its care",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results } = ctx;
      const findings = findingsFor(ctx);
      const carbon = await signedInCarbon(ctx, "uxa.states");
      const { page } = carbon;
      // A taken id is answered "not available"; the browser logs nothing for 200s, but a 409 on a taken id would show.
      results.watch(page, "account-states", [/status of 4\d\d .*\/v1\/ids\/available/]);
      collectConsole(page, [/status of 4\d\d .*\/v1\/ids\/available/]);
      const t = tag();
      // Something to remove and revoke: briefcase and dm (dm holds an OBO proof), a second email, a Silicon.
      await signIntoApp(ctx, page, "briefcase");
      await signIntoApp(ctx, page, "dm", `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`);
      for (let i = 0; i < 2; i++) await postJson(`${env.apps}/dm/actions/issue-obo`, { uuid: carbon.uuid, receiving_app: "briefcase", scopes: ["files.write"] });
      await page.goto(`${env.site}/`);
      await page.locator("main").first().waitFor({ timeout: 30_000 });
      const second = `uxa.states.second.${t}@example.test`;
      const after = await lastSeq(env);
      const added = await pageFetch<{ challenge_id?: string }>(page, "/v1/me/emails", { method: "POST", body: { email: second } });
      if (added.body.challenge_id) await pageFetch(page, "/v1/me/emails/verify", { method: "POST", body: { challenge_id: added.body.challenge_id, code: await codeFor(env, second, after) } });
      await pageFetch(page, "/v1/me/silicons", { method: "POST", body: { id: `si:uxa-states-${t}`, display_name: `States Scout ${t}` } });
      const proofs = await pageFetch<{ items?: Array<{ proof_id: string }> }>(page, "/v1/me/proofs");
      const first = proofs.body.items?.[0]?.proof_id;
      if (first) await pageFetch(page, `/v1/me/proofs/${encodeURIComponent(first)}`, { method: "DELETE" });
      const two = [VARIANTS[0]!, VARIANTS[3]!];

      /** Opens `path`, does `prepare` in each variant, audits; `ready` names what must show. */
      const state = async (name: string, path: string, ready: RegExp, prepare: () => Promise<void>, shows?: RegExp) => {
        for (const variant of two) {
          await openAccountPage(ctx, page, path, ready);
          await page.setViewportSize({ width: variant.width, height: variant.height });
          await page.emulateMedia({ colorScheme: variant.theme });
          await sleep(300);
          let prepared = true;
          await prepare().catch(error => {
            prepared = false;
            results.check(`${name} ${variant.key}: the state opens`, false, String(error).slice(0, 300));
          });
          if (!prepared) continue;
          await sleep(700);
          if (shows) {
            const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
            results.check(`${name} ${variant.key}: shows ${shows.source}`, shows.test(text), text.slice(0, 300));
          }
          await auditPage(ctx, page, findings, { name, variant, keepScroll: true });
        }
      };
      const click = (name: string | RegExp) => page.getByRole("button", { name }).filter({ visible: true }).first().click({ timeout: 15_000 });

      await state("states-identity-back", "/", /./, () => click("Details"));
      await state("states-identity-photo", "/", /./, () => click("Change your photo"));
      await state("states-identity-timezone", "/", /./, () => click("Change your timezone"));
      await state("states-identity-dob", "/", /./, async () => {
        await click("Details");
        await sleep(1_200);
        await click("Change your date of birth");
      });
      await state("states-change-id-taken", "/", /./, async () => {
        await click("Change id");
        await page.getByRole("dialog", { name: "Change your id" }).waitFor({ timeout: 10_000 });
        await page.keyboard.type("saket", { delay: 30 });
        await sleep(1_200);
      }, /not available|taken|in use|reserved/i);
      await page.keyboard.press("Escape").catch(() => undefined);
      await state("states-add-email-code", "/sign-in-methods", /Email|email/, async () => {
        await click("Add an email");
        const field = page.getByLabel("Email address").filter({ visible: true }).first();
        await field.waitFor({ timeout: 10_000 });
        await field.fill(`uxa.states.third.${tag()}@example.test`);
        await click("Send code");
        // The code cells' group is named by its label ("Verification code").
        await page.getByRole("group", { name: /code/i }).first().waitFor({ timeout: 20_000 });
      });
      await state("states-remove-email", "/sign-in-methods", /Email|email/, () => page.getByRole("button", { name: "Remove", exact: true }).filter({ visible: true }).nth(1).click({ timeout: 15_000 }));
      await state("states-remove-app", "/apps", /App|app/, () => click("Remove access"));
      await state("states-revoke-proof", "/proofs", /[Pp]roof/, () => click("Revoke"));
      await state("states-proofs-ended", "/proofs", /[Pp]roof/, () => page.getByRole("button", { name: /^Ended/ }).or(page.getByRole("radio", { name: /^Ended/ })).first().click({ timeout: 15_000 }));
      await state("states-delete-blocked", "/settings", /./, async () => {
        await page.getByRole("button", { name: "Hold to delete your account" }).scrollIntoViewIfNeeded();
      }, /Silicon/);
      const hold = page.getByRole("button", { name: "Hold to delete your account" });
      results.check("states-delete-blocked: deleting is not possible while a Silicon is in the Carbon's care (UNDERSTANDING.md: Custodian)", (await hold.isDisabled().catch(() => false)) || (await hold.getAttribute("aria-disabled")) === "true", `disabled: ${await hold.isDisabled().catch(() => "?")}`);
      results.check("account-states: findings saved", true, saveFindings(ctx, findings));
      await carbon.context.close();
    },
  },
];

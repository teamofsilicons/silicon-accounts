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
import { api, codeFor, lastSeq, postJson, sleep, tag } from "../../lib";
import { VARIANTS, auditVariants, checkDock, collectConsole, findingsFor, hostedLink, openAccountPage, pageFetch, saveFindings, signedInCarbon, stepReady, type Findings } from "./_audit";

export const ACCOUNT_PAGES: Array<{ path: string; name: string; ready: RegExp }> = [
  { path: "/", name: "identity", ready: /./ },
  { path: "/sign-in-methods", name: "sign-in-methods", ready: /Email|email/ },
  { path: "/apps", name: "apps", ready: /App|app/ },
  { path: "/silicons", name: "silicons", ready: /Silicon/ },
  { path: "/proofs", name: "proofs", ready: /[Pp]roof/ },
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

/** Signs the browser's Carbon into an app through its hosted link ("Continue as", the app's requirements, consent). */
async function signIntoApp(ctx: Ctx, page: Page, app: string, phone?: string): Promise<void> {
  const { env } = ctx;
  await page.goto(await hostedLink(env, page, app));
  await page.getByRole("button", { name: /^Continue as/ }).click({ timeout: 30_000 });
  if (phone) {
    const field = page.getByRole("textbox", { name: "Phone number" });
    await field.waitFor({ timeout: 30_000 });
    const after = await lastSeq(env);
    await field.click();
    await page.keyboard.type(phone, { delay: 25 });
    await page.getByRole("button", { name: "Send code" }).click();
    const sms = await codeFor(env, phone, after);
    await page.getByRole("group", { name: /Code/ }).first().waitFor({ timeout: 20_000 });
    await stepReady(page);
    await page.getByRole("textbox", { name: /digit 1 of 6/ }).first().click();
    await page.keyboard.type(sms, { delay: 25 });
  }
  const appUrl = new RegExp(`${env.apps.replace(/[.:/]/g, "\\$&")}/${app}/`);
  const share = page.getByRole("button", { name: "Share and continue" });
  const where = await Promise.race([share.waitFor({ timeout: 30_000 }).then(() => "consent" as const), page.waitForURL(appUrl, { timeout: 30_000 }).then(() => "app" as const)]);
  if (where === "consent") {
    await share.click();
    await page.waitForURL(appUrl, { timeout: 30_000 });
  }
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
      results.check("account-full: findings saved", true, saveFindings(ctx, findings));
      await carbon.context.close();
    },
  },
];

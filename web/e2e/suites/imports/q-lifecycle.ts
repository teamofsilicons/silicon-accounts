/**
 * An import meets an account's whole life. UNDERSTANDING.md: a uuid "never changes and is never reused, even after the
 * account is deleted"; an imported user "is matched to the account that already has their email or phone. If there's
 * none, a new Carbon account is created"; and deleting an account frees its emails and phones while its id stays
 * reserved for 10 days. So when a Carbon an app imported deletes their account and the app imports them again (an
 * app's nightly re-import of its users), the deleted account is never brought back, the person is not matched to it,
 * and the import either makes a new account or says precisely why it doesn't; the app's user base keeps the deleted
 * membership as history.
 *
 * And an import can never hand an app someone's account: a row that bundles a Carbon's email with an address the app
 * controls is matched without attaching that address (signing in with it is a new sign-up), and an unclaimed import
 * carries only its first address, so whoever owns another address in the row signs up on their own (crates/apps
 * imports/engine.rs: "Why a new account carries one address").
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { appAccount, completeDetails, newContext, signInOnSite, signInWithCode, startAtApp, tag } from "../../lib";
import { accountsByUuid, allRows, appCall, describeRow, fakeApp, forgetImportBudgets, lastSeq, lit, messagesAfter, postJson, rowsOf, waitJob, type FakeApp, type RowResult } from "./_helpers";

type Ctx = Parameters<Journey["run"]>[0];

async function importOne(ctx: Ctx, app: FakeApp, row: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<RowResult> {
  const answer = await postJson(ctx, app, { rows: [row], options }, { key: randomUUID() });
  if (!answer.body.job) throw new Error(`the import was refused: ${answer.status} ${JSON.stringify(answer.body)}`);
  const job = await waitJob(ctx, app, answer.body.job.id);
  const [result] = await allRows(ctx, app, job.id);
  if (!result) throw new Error(`job ${job.id} has no row`);
  return result;
}

interface AppUser {
  uuid: string;
  id: string | null;
  status: string;
  display_name: string;
  email?: string | null;
  external_id: string | null;
}

export const journeys: Journey[] = [{
  name: "imports-deleted-account",
  title: "a Carbon legacy-crm imported deletes their account; legacy-crm's user base keeps them as deleted history; re-importing them never revives or matches the deleted account (its uuid is never reused) and either creates a new account or says precisely why not; their old id stays reserved",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const crm = fakeApp("legacy-crm");
    await forgetImportBudgets(env, crm.app_id);
    const t = tag();
    const email = `del.${t}@example.test`;

    // A Carbon with an account of their own, then legacy-crm imports them (matched by email).
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "imports-deleted");
    await signInOnSite(env, page, email);
    const me = (await page.evaluate(async () => (await (await fetch("/v1/me")).json()) as { uuid?: string; id?: string })) ?? {};
    const uuid = me.uuid ?? "";
    const oldId = me.id ?? "";
    const row = { external_id: `del-${t}`, email, display_name: "Del From The CRM", username: oldId.replace(/^c:/, "") };
    const first = await importOne(ctx, crm, row);
    results.check("legacy-crm's import matches the Carbon by email (an imported membership on their account)", first.outcome === "matched" && first.account_uuid === uuid, describeRow(first));

    // The Carbon deletes their account.
    const deleted = await page.evaluate(async confirm => (await fetch("/v1/me", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm }) })).status, oldId);
    const [gone] = await rowsOf<{ status: string; handle: string | null; emails: number; reserved: boolean }>(env, `select a.status, a.handle,
        (select count(*)::int from account_emails where account_uuid = a.uuid) as emails,
        exists (select 1 from handle_reservations r where r.handle = ${lit(oldId)} and r.reserved_until > now()) as reserved
      from accounts a where a.uuid = ${lit(uuid)}`);
    results.check("the Carbon deletes their account: deleted, no id, no email left, the old id reserved", deleted === 204 && gone?.status === "deleted" && gone.handle === null && gone.emails === 0 && gone.reserved === true, `${deleted} ${JSON.stringify(gone)}`);
    await context.close();

    const history = await appCall<AppUser>(ctx, crm, `/v1/apps/legacy-crm/users/${uuid}`);
    results.check("legacy-crm's user base keeps them as history: status deleted, nothing about the person but its own records (external id)", history.status === 200 && history.body.status === "deleted" && !history.body.email && history.body.id === null && history.body.external_id === `del-${t}`, JSON.stringify(history.body).slice(0, 300));

    // legacy-crm imports the same person again, as a nightly re-import of its users would.
    const seq = await lastSeq(env);
    const again = await importOne(ctx, crm, row);
    const [stillDeleted] = await rowsOf<{ status: string; emails: number }>(env, `select status, (select count(*)::int from account_emails where account_uuid = ${lit(uuid)}) as emails from accounts where uuid = ${lit(uuid)}`);
    results.check("the re-import never revives or matches the deleted account (its uuid is never reused; no email lands on it)", again.account_uuid !== uuid && stillDeleted?.status === "deleted" && stillDeleted.emails === 0, `${describeRow(again)}; deleted account ${JSON.stringify(stillDeleted)}`);
    const why = again.messages.map(m => `${m.code}: ${m.message}`).join(" | ");
    const created = again.outcome === "created" && !!again.account_uuid;
    const explained = (again.outcome === "error" || again.outcome === "skipped") && /delet/i.test(why);
    results.check(
      "the person is imported again as a new account (UNDERSTANDING.md: no account has their email, so a new Carbon account is created), or the row says precisely that the account it names was deleted — never that \"another member of this app\" has the external id",
      created || explained,
      `${again.outcome} ${again.account_uuid ?? ""} [${why}]`,
    );
    if (!created) {
      // Without its external id the same row goes through: the external id the deleted membership keeps is what blocks it.
      const withoutExternal = await importOne(ctx, crm, { email, display_name: row.display_name, username: row.username });
      results.check("(diagnosis) the same row without its external_id is created as a new account: the deleted membership's external id is what blocks the re-import", withoutExternal.outcome === "created" && withoutExternal.account_uuid !== uuid, describeRow(withoutExternal));
    }
    const [fresh] = await rowsOf<{ uuid: string; status: string; handle: string }>(env, `select a.uuid, a.status, a.handle from account_emails e join accounts a on a.uuid = e.account_uuid where e.email = ${lit(email)}`);
    if (fresh) {
      results.check("the new account is a different uuid, unclaimed, and does not get the deleted account's id while it is reserved (10 days)", fresh.uuid !== uuid && fresh.status === "unclaimed" && fresh.handle !== oldId, JSON.stringify(fresh));
      const [both] = [...(await accountsByUuid(env, [fresh.uuid])).values()];
      results.check("…with an imported membership of its own; the deleted one stays history", both?.membership?.status === "imported" && (await appCall<AppUser>(ctx, crm, `/v1/apps/legacy-crm/users/${uuid}`)).body.status === "deleted", JSON.stringify(both?.membership).slice(0, 200));
    }
    const sent = await messagesAfter(env, seq);
    results.check("the re-import sent no email or SMS", sent.length === 0, sent.map(item => `${item.channel} to ${item.to}`).join(", ") || "nothing captured");
  },
},
{
  name: "imports-no-takeover",
  title: "a row bundling a Carbon's email with one the app controls never hands the Carbon's account to the app: matched to the Carbon without attaching the other address, so signing in with it is a new sign-up; an unclaimed import carries only its first address, so the owner of another address in the row signs up separately and the claimer never gets it",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const pixel = fakeApp("pixel-studio");
    await forgetImportBudgets(env, pixel.app_id);
    const t = tag();
    const victim = `vic.${t}@example.test`;
    const attacker = `att.${t}@example.test`;

    // A Carbon with an account of their own.
    const victimContext = await newContext(browser);
    const victimPage = await victimContext.newPage();
    results.watch(victimPage, "imports-takeover-victim");
    await signInOnSite(env, victimPage, victim);
    const me = (await victimPage.evaluate(async () => (await (await fetch("/v1/me")).json()) as { uuid?: string })) ?? {};
    const victimUuid = me.uuid ?? "";
    await victimContext.close();

    // pixel-studio's row puts the Carbon's email next to an address pixel-studio controls.
    const bundled = await importOne(ctx, pixel, { external_id: `bundle-${t}`, emails: [attacker, victim], display_name: "Bundled Row" });
    const [victimAfter] = [...(await accountsByUuid(env, [victimUuid], "pixel-studio")).values()];
    const attackerOwner = await rowsOf<{ account_uuid: string }>(env, `select account_uuid from account_emails where email = ${lit(attacker)}`);
    results.check("the row is matched to the Carbon (who owns one of its emails)", bundled.outcome === "matched" && bundled.account_uuid === victimUuid, describeRow(bundled));
    results.check("…without attaching the app's other address to the Carbon's account (it stays in the app's imported data only)", JSON.stringify(victimAfter?.emails.map(e => e.email)) === JSON.stringify([victim]) && attackerOwner.length === 0 && ((victimAfter?.membership?.imported_profile as { emails?: string[] } | null)?.emails ?? []).includes(attacker), `${JSON.stringify(victimAfter?.emails)}; owner of ${attacker}: ${JSON.stringify(attackerOwner)}`);

    // Signing in at pixel-studio with the address it controls: a new Carbon, never the matched one.
    const attackerContext = await newContext(browser);
    const attackerPage = await attackerContext.newPage();
    results.watch(attackerPage, "imports-takeover-attacker");
    await startAtApp(env, attackerPage, "pixel-studio");
    await signInWithCode(env, attackerPage, { email: attacker });
    const setUp = attackerPage.getByRole("button", { name: /^(Create account|Finish setup)$/ });
    await setUp.waitFor({ timeout: 30_000 });
    const label = (await setUp.innerText()).trim();
    await setUp.click();
    await completeDetails(env, attackerPage, "pixel-studio");
    const attackerAccount = await appAccount(attackerPage);
    await attackerContext.close();
    results.check("signing in with the app's own address is an ordinary sign-up (\"Create account\") of a new account, never the Carbon's", label === "Create account" && !!attackerAccount?.uuid && attackerAccount.uuid !== victimUuid, `${label}; ${JSON.stringify(attackerAccount).slice(0, 160)}`);

    // An unclaimed import with two addresses carries only the first: the second one's owner signs up on their own.
    const claimer = `claim.${t}@example.test`;
    const bystander = `by.${t}@example.test`;
    const created = await importOne(ctx, pixel, { external_id: `pair-${t}`, emails: [claimer, bystander], display_name: "Pair Row" });
    const pairUuid = created.account_uuid ?? "";
    const [pair] = [...(await accountsByUuid(env, [pairUuid], "pixel-studio")).values()];
    results.check("a new unclaimed account carries only the row's first email (identifiers_not_attached names the other)", created.outcome === "created" && JSON.stringify(pair?.emails.map(e => e.email)) === JSON.stringify([claimer]) && created.messages.some(m => m.code === "identifiers_not_attached" && m.message.includes(bystander)), `${describeRow(created)}; ${JSON.stringify(pair?.emails)}`);
    const bystanderContext = await newContext(browser);
    const bystanderPage = await bystanderContext.newPage();
    results.watch(bystanderPage, "imports-takeover-bystander");
    await startAtApp(env, bystanderPage, "briefcase");
    await signInWithCode(env, bystanderPage, { email: bystander });
    const bystanderButton = bystanderPage.getByRole("button", { name: /^(Create account|Finish setup)$/ });
    await bystanderButton.waitFor({ timeout: 30_000 });
    const bystanderLabel = (await bystanderButton.innerText()).trim();
    await bystanderButton.click();
    await completeDetails(env, bystanderPage, "briefcase");
    const bystanderAccount = await appAccount(bystanderPage);
    await bystanderContext.close();
    results.check("the owner of the second address signs up as a new Carbon (\"Create account\"), never into the account the import created", bystanderLabel === "Create account" && !!bystanderAccount?.uuid && bystanderAccount.uuid !== pairUuid, `${bystanderLabel}; ${JSON.stringify(bystanderAccount).slice(0, 160)}`);
    const claimerContext = await newContext(browser);
    const claimerPage = await claimerContext.newPage();
    results.watch(claimerPage, "imports-takeover-claimer");
    await startAtApp(env, claimerPage, "pixel-studio");
    await signInWithCode(env, claimerPage, { email: claimer });
    await claimerPage.getByRole("button", { name: "Finish setup" }).click({ timeout: 30_000 });
    await completeDetails(env, claimerPage, "pixel-studio");
    const claimed = await appAccount(claimerPage);
    await claimerContext.close();
    const [pairAfter] = [...(await accountsByUuid(env, [pairUuid], "pixel-studio")).values()];
    results.check("the first address's owner finishes the imported account, which never gets the second address", claimed?.uuid === pairUuid && pairAfter?.status === "active" && JSON.stringify(pairAfter.emails.map(e => e.email)) === JSON.stringify([claimer]), `${JSON.stringify(claimed).slice(0, 120)}; ${JSON.stringify(pairAfter?.emails)}`);
  },
}];

/**
 * An import that matches an existing, active Carbon: the app gets a membership (imported) without the Carbon signing
 * in, so the Carbon must be able to see it and undo it. The Carbon finds the app on /apps as "Imported you", with what
 * that means; their own details are untouched; removing its access works like any app's: the app's user base then
 * shows nothing of the account's own data ("Access removed", the default photo, no contact data), whatever the Carbon
 * changes afterwards, and finds them by its own records only, never by name; the next import (even update_existing)
 * doesn't bring them back. Signing in to the app again is what gives it access again: active, and it sees what the
 * Carbon shares.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { afterConsent, appAccount, newContext, shot, signInOnSite, sleep, tag } from "../../lib";
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
  display_name: string;
  pfp_url?: string;
  status: string;
  email?: string | null;
  phone?: string | null;
  dob?: string | null;
  timezone?: string | null;
  external_id: string | null;
}

export const journey: Journey = {
  name: "imports-matched-visible",
  title: "an import matching an active Carbon: the app's membership is imported (the Carbon's details untouched), the Carbon sees \"Imported you\" on /apps and removes its access; the app then sees none of their data, even after changes, and imports skip them; signing in again gives it access again",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const pixel = fakeApp("pixel-studio");
    await forgetImportBudgets(env, pixel.app_id);
    const t = tag();
    const email = `mira.${t}@example.test`;
    const context = await newContext(browser);
    const page = await context.newPage();
    // The 409 is asked for (an address parked on an unclaimed import can't be added).
    results.watch(page, "imports-matched", [/status of 409/]);
    await signInOnSite(env, page, email);
    const me = (await page.evaluate(async () => (await (await fetch("/v1/me")).json()) as { uuid?: string; id?: string; display_name?: string })) ?? {};
    const [before] = [...(await accountsByUuid(env, [me.uuid ?? ""], pixel.app_id)).values()];
    results.check("a Carbon signed up on the account site (active, email verified, no membership of pixel-studio)", before?.status === "active" && before.emails[0]?.verified === true && before.membership === null, JSON.stringify(before).slice(0, 300));

    const seq = await lastSeq(env);
    const row = await importOne(ctx, pixel, { external_id: `px-${t}`, email: email.toUpperCase(), display_name: "Name Pixel Studio Has", username: `pixel_wants_${t}`, timezone: "Asia/Tokyo" });
    results.check("pixel-studio's import matches the Carbon by email (matched, their uuid and id)", row.outcome === "matched" && row.account_uuid === me.uuid && row.id === me.id, describeRow(row));
    const [after] = [...(await accountsByUuid(env, [me.uuid ?? ""], pixel.app_id)).values()];
    results.check("…the membership is imported (source import, external id), and the Carbon's own name, id and timezone are untouched", after?.membership?.status === "imported" && after.membership.source === "import" && after.membership.external_id === `px-${t}` && after.display_name === before?.display_name && after.handle === before?.handle && after.timezone === before?.timezone, JSON.stringify(after).slice(0, 400));
    const listed = await appCall<AppUser>(ctx, pixel, `/v1/apps/pixel-studio/users/${me.uuid}`);
    results.check("pixel-studio's user base lists them as imported with the email it supplied", listed.status === 200 && listed.body.status === "imported" && listed.body.email === email && listed.body.external_id === `px-${t}`, JSON.stringify(listed.body).slice(0, 300));
    const sent = await messagesAfter(env, seq);
    results.check("the Carbon was not emailed about it (imports never send email or SMS)", sent.length === 0, sent.map(item => `${item.channel} to ${item.to}`).join(", ") || "nothing captured");

    // The Carbon sees it on /apps, and removes its access.
    const mine = await page.evaluate(async () => (await (await fetch("/v1/me/apps?limit=100")).json()) as { items?: Array<{ app: { app_id: string }; status: string }> });
    results.check("GET /v1/me/apps lists pixel-studio as imported", (mine.items ?? []).some(item => item.app.app_id === "pixel-studio" && item.status === "imported"), JSON.stringify(mine.items?.map(item => `${item.app.app_id}:${item.status}`)));
    await page.goto(`${env.site}/apps`);
    const card = page.locator("#app-pixel-studio");
    await card.waitFor({ timeout: 20_000 });
    await sleep(500);
    const cardText = (await card.innerText()).replace(/\s+/g, " ");
    await shot(env, page, "imports-matched-01-apps");
    results.check("/apps shows Pixel Studio as \"Imported you\" and what that means", /Imported you/.test(cardText) && /imported your account, so it holds what it imported/.test(cardText), cardText.slice(0, 300));
    await card.getByRole("button", { name: "Remove access" }).click();
    await card.getByRole("button", { name: "Remove", exact: true }).click();
    const gone = await card.getByText(/Access removed/).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const [removed] = await rowsOf<{ status: string }>(env, `select status from memberships where app_id = 'pixel-studio' and account_uuid = ${lit(me.uuid ?? "")}`);
    results.check("the Carbon removes pixel-studio's access from /apps", gone && removed?.status === "access_removed", `${gone} ${removed?.status}`);
    const afterRemoval = await appCall<AppUser>(ctx, pixel, `/v1/apps/pixel-studio/users/${me.uuid}`);
    const removedView = afterRemoval.body;
    const defaultPhoto = `${env.iris}/pfp/carbon?id=${me.uuid}`;
    results.check("pixel-studio's user base then shows them as access_removed, with no email", removedView.status === "access_removed" && !removedView.email, JSON.stringify(removedView).slice(0, 300));
    results.check(
      "…and none of the account's own data: display name \"Access removed\", the default photo, no phone, dob or timezone; its own records (external id) and the current id stay",
      removedView.display_name === "Access removed" && removedView.pfp_url === defaultPhoto && !removedView.phone && !removedView.dob && !removedView.timezone && removedView.external_id === `px-${t}` && removedView.id === me.id,
      JSON.stringify(removedView).slice(0, 400),
    );
    // "It can no longer see anything about you" (/apps): a detail the Carbon changes afterwards must not reach the app.
    const renamed = `Mira Renamed ${t}`;
    const patched = await page.evaluate(async name => (await fetch("/v1/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: name }) })).status, renamed);
    const seenByApp = await appCall<AppUser>(ctx, pixel, `/v1/apps/pixel-studio/users/${me.uuid}`);
    const search = async (q: string) => ((await appCall<{ items: AppUser[] }>(ctx, pixel, `/v1/apps/pixel-studio/users?q=${encodeURIComponent(q)}`)).body.items ?? []).some(user => user.uuid === me.uuid);
    const listedByApp = await appCall<{ items: AppUser[] }>(ctx, pixel, `/v1/apps/pixel-studio/users?status=access_removed&q=${encodeURIComponent(renamed)}`);
    results.check("after removing its access, the Carbon renames themself: pixel-studio can't read the new name (nor find them by it)", patched === 200 && seenByApp.body.display_name !== renamed && !(listedByApp.body.items ?? []).some(user => user.uuid === me.uuid), `PATCH ${patched}; the app reads display_name "${seenByApp.body.display_name}"; search by the new name finds ${(listedByApp.body.items ?? []).length}`);
    // Another way in: the account lookup by uuid, which every app may call (docs: "the current public identity").
    const lookedUp = await appCall<{ id?: string; display_name?: string; pfp_url?: string }>(ctx, pixel, `/v1/accounts/${me.uuid}`);
    results.check(
      "…and no other call of the app hands the new name back: GET /v1/accounts/{uuid} as pixel-studio (/apps told the Carbon \"It can no longer see anything about you\")",
      lookedUp.status === 200 && lookedUp.body.display_name !== renamed,
      `GET /v1/accounts/${me.uuid} → ${lookedUp.status} ${JSON.stringify(lookedUp.body).slice(0, 300)}`,
    );
    const byOldName = await search(me.display_name ?? "none");
    const byExternal = await search(`px-${t}`);
    const byUuid = await search(me.uuid ?? "none");
    results.check("search finds them by the app's own records (external id, uuid), never by their name, old or new", !byOldName && byExternal && byUuid, `old name ${byOldName}, external id ${byExternal}, uuid ${byUuid}`);
    const again = await importOne(ctx, pixel, { external_id: `px-${t}`, email, display_name: "Name Pixel Studio Has" });
    const [still] = await rowsOf<{ status: string }>(env, `select status from memberships where app_id = 'pixel-studio' and account_uuid = ${lit(me.uuid ?? "")}`);
    results.check("re-importing them is skipped (access_removed) and the access stays removed", again.outcome === "skipped" && again.messages.some(m => m.code === "access_removed") && still?.status === "access_removed", `${describeRow(again)}; ${still?.status}`);
    const forced = await importOne(ctx, pixel, { external_id: `px-${t}-v2`, email, display_name: "Name Pixel Studio Has" }, { update_existing: true });
    const [stillAfterForce] = await rowsOf<{ status: string; external_id: string }>(env, `select status, external_id from memberships where app_id = 'pixel-studio' and account_uuid = ${lit(me.uuid ?? "")}`);
    results.check("…even with update_existing: skipped, the membership untouched (still access_removed, external id kept)", forced.outcome === "skipped" && forced.messages.some(m => m.code === "access_removed") && stillAfterForce?.status === "access_removed" && stillAfterForce.external_id === `px-${t}`, `${describeRow(forced)}; ${JSON.stringify(stillAfterForce)}`);

    // Signing in to the app again is what gives it access again.
    await page.goto(`${env.apps}/pixel-studio/`);
    await page.locator("#signin-hosted").click();
    const continueAs = page.getByRole("button", { name: /^Continue as/ });
    const offered = await continueAs.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    if (offered) {
      await continueAs.click();
      await afterConsent(env, page, "pixel-studio", "imports-matched-02-signin-again");
    }
    const received = offered ? await appAccount(page) : null;
    const back = await appCall<AppUser>(ctx, pixel, `/v1/apps/pixel-studio/users/${me.uuid}`);
    const [member] = await rowsOf<{ status: string; external_id: string }>(env, `select status, external_id from memberships where app_id = 'pixel-studio' and account_uuid = ${lit(me.uuid ?? "")}`);
    results.check("signing in to pixel-studio again (Continue as → share) makes the membership active, keeping the app's external id", offered && received?.uuid === me.uuid && member?.status === "active" && member.external_id === `px-${t}`, `${offered ? JSON.stringify(received).slice(0, 160) : "no Continue as"}; ${JSON.stringify(member)}`);
    results.check("…and the user base shows what the Carbon shares now: their current name and the email it requires", back.body.status === "active" && back.body.display_name === renamed && back.body.email === email && (await search(renamed)), JSON.stringify(back.body).slice(0, 300));
    const afterSignin = await importOne(ctx, pixel, { external_id: `px-${t}`, email, display_name: "Name Pixel Studio Has" });
    const [notDemoted] = await rowsOf<{ status: string }>(env, `select status from memberships where app_id = 'pixel-studio' and account_uuid = ${lit(me.uuid ?? "")}`);
    results.check("an import after that matches them and leaves the membership active", afterSignin.outcome === "matched" && afterSignin.account_uuid === me.uuid && notDemoted?.status === "active", `${describeRow(afterSignin)}; ${notDemoted?.status}`);

    // An address an import parked on a new, unclaimed account belongs to that account: another Carbon (here the same
    // person, signed in with their first email) can't add it to theirs. They are told to sign in with it instead.
    const other = `mira.other.${t}@example.test`;
    const parked = await importOne(ctx, pixel, { external_id: `px-other-${t}`, email: other, display_name: "Mira Elsewhere" });
    const seqBefore = await lastSeq(env);
    await page.goto(`${env.site}/apps`);
    const added = await page.evaluate(async address => {
      const answer = await fetch("/v1/me/emails", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ email: address }) });
      return { status: answer.status, body: (await answer.json().catch(() => null)) as { error?: { code?: string; message?: string; hint?: string } } | null };
    }, other);
    const codes = (await messagesAfter(env, seqBefore)).filter(item => item.to === other);
    const [still2] = [...(await accountsByUuid(env, [parked.account_uuid ?? ""], pixel.app_id)).values()];
    results.check(
      "an address an import parked on an unclaimed account can't be added to another Carbon's account: 409 email_in_use (\"Sign in with it to use that account\"), no code sent, the imported account untouched",
      parked.outcome === "created" && added.status === 409 && added.body?.error?.code === "email_in_use" && /Sign in with it to use that account/.test(added.body.error.hint ?? "") && codes.length === 0 && still2?.status === "unclaimed" && still2.emails[0]?.email === other && still2.emails[0]?.verified === false,
      `${describeRow(parked)}; POST /v1/me/emails → ${added.status} ${added.body?.error?.code}: ${added.body?.error?.message} | ${added.body?.error?.hint}; codes sent ${codes.length}; ${JSON.stringify(still2?.emails)}`,
    );
    await context.close();
  },
};

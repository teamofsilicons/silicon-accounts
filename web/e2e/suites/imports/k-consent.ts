/**
 * An import that matches an existing, active Carbon: the app gets a membership (imported) without the Carbon signing
 * in, so the Carbon must be able to see it and undo it. The Carbon finds the app on /apps as "Imported you", with what
 * that means; their own details are untouched; removing its access works like any app's, the app's user base then
 * shows nothing about them, and the next import doesn't bring them back.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { newContext, shot, signInOnSite, sleep, tag } from "../../lib";
import { accountsByUuid, allRows, appCall, describeRow, fakeApp, forgetImportBudgets, lastSeq, lit, messagesAfter, postJson, rowsOf, waitJob, type FakeApp, type RowResult } from "./_helpers";

type Ctx = Parameters<Journey["run"]>[0];

async function importOne(ctx: Ctx, app: FakeApp, row: Record<string, unknown>): Promise<RowResult> {
  const answer = await postJson(ctx, app, { rows: [row], options: {} }, { key: randomUUID() });
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
  status: string;
  email?: string | null;
  external_id: string | null;
}

export const journey: Journey = {
  name: "imports-matched-visible",
  title: "an import matching an active Carbon: the app's membership is imported (the Carbon's details untouched), the Carbon sees \"Imported you\" on /apps and removes its access; the app then sees nothing and the next import skips them",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const pixel = fakeApp("pixel-studio");
    await forgetImportBudgets(env, pixel.app_id);
    const t = tag();
    const email = `mira.${t}@example.test`;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "imports-matched");
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
    results.check("pixel-studio's user base then shows them as access_removed, with no email", afterRemoval.body.status === "access_removed" && !afterRemoval.body.email, JSON.stringify(afterRemoval.body).slice(0, 300));
    // "It can no longer see anything about you" (/apps): a detail the Carbon changes afterwards must not reach the app.
    const renamed = `Mira Renamed ${t}`;
    const patched = await page.evaluate(async name => (await fetch("/v1/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ display_name: name }) })).status, renamed);
    const seenByApp = await appCall<AppUser>(ctx, pixel, `/v1/apps/pixel-studio/users/${me.uuid}`);
    const listedByApp = await appCall<{ items: AppUser[] }>(ctx, pixel, `/v1/apps/pixel-studio/users?status=access_removed&q=${encodeURIComponent(renamed)}`);
    results.check("after removing its access, the Carbon renames themself: pixel-studio can't read the new name (nor find them by it)", patched === 200 && seenByApp.body.display_name !== renamed && !(listedByApp.body.items ?? []).some(user => user.uuid === me.uuid), `PATCH ${patched}; the app reads display_name "${seenByApp.body.display_name}"; search by the new name finds ${(listedByApp.body.items ?? []).length}`);
    const again = await importOne(ctx, pixel, { external_id: `px-${t}`, email, display_name: "Name Pixel Studio Has" });
    const [still] = await rowsOf<{ status: string }>(env, `select status from memberships where app_id = 'pixel-studio' and account_uuid = ${lit(me.uuid ?? "")}`);
    results.check("re-importing them is skipped (access_removed) and the access stays removed", again.outcome === "skipped" && again.messages.some(m => m.code === "access_removed") && still?.status === "access_removed", `${describeRow(again)}; ${still?.status}`);
    await context.close();
  },
};

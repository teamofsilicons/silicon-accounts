/**
 * Ids an import may not take. UNDERSTANDING.md: when a Carbon changes their id, the old one stays reserved for 10 days
 * so no one else can take it (the previous owner may reclaim it), and after that it becomes available again. An import
 * whose username asks for such an id gets another one (id_conflict saying why), a dry run says the same, the id the
 * Carbon holds now is simply taken, and once the 10 days are over (time travel) the next import gets the old id exactly,
 * after which the Carbon can no longer reclaim it.
 */
import type { Journey } from "../../context";
import { newContext, signInOnSite, tag } from "../../lib";
import { VALID_ID, describeRow, fakeApp, forgetImportBudgets, importRows, lit, psql, rowsOf } from "./_helpers";

export const journey: Journey = {
  name: "imports-reserved-ids",
  title: "an id a Carbon released less than 10 days ago is never given to an imported account (id_conflict: reserved for its previous owner; dry runs too); 10 days later (time travel) an import takes it exactly and the Carbon can no longer reclaim it",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const crm = fakeApp("legacy-crm");
    await forgetImportBudgets(env, crm.app_id);
    const t = tag();
    const oldId = `c:rex_old_${t}`;
    const newId = `c:rex_new_${t}`;
    const context = await newContext(browser);
    const page = await context.newPage();
    results.watch(page, "imports-reserved", [/status of 409/]);
    await signInOnSite(env, page, `rex.${t}@example.test`);
    const change = (id: string) =>
      page.evaluate(async next => {
        const answer = await fetch("/v1/me/id", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ id: next }) });
        return { status: answer.status, body: (await answer.json().catch(() => null)) as { error?: { code?: string } } | null };
      }, id);
    const me = await page.evaluate(async () => ((await (await fetch("/v1/me")).json()) as { uuid?: string }).uuid ?? "");
    const first = await change(oldId);
    const second = await change(newId);
    const [reservation] = await rowsOf<{ account_uuid: string; days: number }>(env, `select account_uuid, extract(epoch from reserved_until - now()) / 86400 as days from handle_reservations where handle = ${lit(oldId)}`);
    results.check("the Carbon takes c:rex_old_<tag>, then moves to c:rex_new_<tag>: the old id is reserved for them for 10 days", first.status === 200 && second.status === 200 && reservation?.account_uuid === me && reservation.days > 9.9 && reservation.days <= 10, `${first.status} ${second.status}; ${JSON.stringify(reservation)}`);

    const dry = await importRows(ctx, crm, [{ external_id: `rex-dry-${t}`, email: `rex.dry.${t}@legacy-crm.test`, display_name: "Rex Dry", username: `rex_old_${t}` }], { dry_run: true });
    const dryRow = dry.rows[0];
    const reservedWhy = (row: typeof dryRow) => row?.messages.find(m => m.code === "id_conflict" && m.level === "warning" && m.field === "username")?.message ?? "";
    results.check(
      "a dry run asking for the reserved id announces another one, saying why (\"Wanted c:rex_old_<tag>, assigned …: c:rex_old_<tag> was released recently and is reserved for its previous owner.\")",
      dryRow?.outcome === "created" && dryRow.id !== oldId && VALID_ID.test(dryRow.id ?? "") && reservedWhy(dryRow).startsWith(`Wanted ${oldId}, assigned ${dryRow.id}: ${oldId} was released recently and is reserved for its previous owner`),
      describeRow(dryRow),
    );

    const real = await importRows(ctx, crm, [
      { external_id: `rex-1-${t}`, email: `rex.one.${t}@legacy-crm.test`, display_name: "Rex One", username: `rex_old_${t}` },
      { external_id: `rex-2-${t}`, email: `rex.two.${t}@legacy-crm.test`, display_name: "Rex Two", username: `rex_new_${t}` },
    ]);
    const [one, two] = real.rows;
    results.check("the import gives the account that asked for the reserved id another one (id_conflict: reserved for its previous owner)", one?.outcome === "created" && one.id !== oldId && VALID_ID.test(one.id ?? "") && reservedWhy(one).includes("reserved for its previous owner"), describeRow(one));
    results.check("…and the one asking for the Carbon's current id another one too (id_conflict: already taken by another account)", two?.outcome === "created" && two.id !== newId && (two.messages.find(m => m.code === "id_conflict")?.message ?? "").includes(`${newId} is already taken by another account`), describeRow(two));
    const [still] = await rowsOf<{ account_uuid: string }>(env, `select account_uuid from handle_reservations where handle = ${lit(oldId)} and reserved_until > now()`);
    const holder = await psql(env, `select count(*) from accounts where handle = ${lit(oldId)}`);
    results.check("the reservation is untouched: still the Carbon's, and no account holds c:rex_old_<tag>", still?.account_uuid === me && holder === "0", `${JSON.stringify(still)}; ${holder} holders`);

    // Ten days later the reservation is over: the id is free for anyone, an import included.
    await psql(env, `update handle_reservations set reserved_until = now() - interval '1 second' where handle = ${lit(oldId)}`);
    const later = await importRows(ctx, crm, [{ external_id: `rex-3-${t}`, email: `rex.three.${t}@legacy-crm.test`, display_name: "Rex Later", username: `rex_old_${t}` }]);
    const laterRow = later.rows[0];
    results.check("10 days later (time travel), an import asking for c:rex_old_<tag> gets it exactly, with no id_conflict", laterRow?.outcome === "created" && laterRow.id === oldId && !laterRow.messages.some(m => m.code === "id_conflict"), describeRow(laterRow));
    const [owner] = await rowsOf<{ uuid: string; status: string }>(env, `select uuid, status from accounts where handle = ${lit(oldId)}`);
    results.check("…the imported (unclaimed) account holds it now", owner?.uuid === laterRow?.account_uuid && owner?.status === "unclaimed", JSON.stringify(owner));
    const reclaim = await change(oldId);
    results.check("…and the Carbon can no longer reclaim it: 409 id_taken", reclaim.status === 409 && reclaim.body?.error?.code === "id_taken", `${reclaim.status} ${JSON.stringify(reclaim.body).slice(0, 200)}`);
    await context.close();
  },
};

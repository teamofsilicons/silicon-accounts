/**
 * Imported members (02-api: id changes go "to every member app (status active or imported)"): an app imports its old
 * users (legacy-crm), one of them already has an account, so the import matches it with a membership in status
 * imported and no granted scopes. Importing sends nothing; later changes reach the app with only what any app may see
 * (profile: name, photo, id), never the email the app imported by. If the Carbon removes the app's access, a new
 * import does not bring the app's webhooks back.
 */
import { randomUUID } from "node:crypto";
import type { Ctx, Journey } from "../../context";
import { codeFor, lastSeq, sleep } from "../../lib";
import { appCall, checkEq, inboxEvents, must, newCarbon, short, storedEvents, uid, waitEvent } from "./_helpers";

const APP = "legacy-crm";
const BASE_KEYS = ["display_name", "id", "kind", "membership_id", "pfp_url", "updated_at", "uuid", "version"];

interface Job {
  id: string;
  status: string;
  counts?: Record<string, number>;
}

async function importRows(ctx: Ctx, rows: Array<Record<string, unknown>>): Promise<{ job: Job; outcomes: Array<{ outcome: string; account_uuid: string | null }> }> {
  const started = must("start the import", await appCall<{ job: Job }>(ctx.env, APP, "POST", `/v1/apps/${APP}/imports`, { json: { rows, options: {} }, idempotencyKey: randomUUID() }), [200, 201, 202]).body.job;
  let job = started;
  for (let i = 0; i < 120 && job.status !== "completed" && job.status !== "failed"; i++) {
    await sleep(250);
    const answer = must("the import job", await appCall<{ job?: Job } & Job>(ctx.env, APP, "GET", `/v1/apps/${APP}/imports/${started.id}`), 200).body;
    job = answer.job ?? answer;
  }
  const outcomes = must("the import rows", await appCall<{ items: Array<{ outcome: string; account_uuid: string | null }> }>(ctx.env, APP, "GET", `/v1/apps/${APP}/imports/${started.id}/rows?limit=50`), 200).body.items;
  return { job, outcomes };
}

export const journey: Journey = {
  name: "webhooks-imported-members",
  title: "an app that imported an existing Carbon (membership imported) hears of id and name changes with profile fields only, nothing on import, nothing about the email; after the Carbon removes its access a re-import does not bring the webhooks back",
  timeoutMs: 4 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await newCarbon(ctx, "imported");
    let since = Date.now();
    const first = await importRows(ctx, [{ email: carbon.email, external_id: `crm-${uid()}`, display_name: "From the CRM" }]);
    checkEq(results, "the import matched the existing account", { status: first.job.status, outcomes: first.outcomes.map(row => [row.outcome, row.account_uuid]) }, { status: "completed", outcomes: [["matched", carbon.uuid]] });
    const user = must("the app's user", await appCall<{ status?: string; membership_id?: string }>(env, APP, "GET", `/v1/apps/${APP}/users/${carbon.uuid}`), 200).body;
    results.check("the membership is imported (not active: the Carbon never signed in to the app)", user.status === "imported" && user.membership_id === `${APP}:${carbon.uuid}`, short(user, 300));
    checkEq(results, "importing sends the app no webhook", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).length, 0);

    // ---- an id change reaches the importing app ------------------------------------------------------------------------
    let after = (await inboxEvents(env, APP, { uuid: "none" })).last_seq;
    since = Date.now();
    const newId = `c:wh-imported2-${uid()}`;
    must("change the id", await carbon.visitor.call("POST", "/v1/me/id", { json: { id: newId } }), 200);
    checkEq(results, "id change: account.id_changed goes to the app with the imported membership", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`), [`account.id_changed→${APP}`]);
    const idEvent = await waitEvent(env, APP, { type: "account.id_changed", uuid: carbon.uuid, after });
    checkEq(results, "id change: the app received {uuid, membership_id, kind, old_id, new_id}", idEvent?.payload.data, { uuid: carbon.uuid, membership_id: `${APP}:${carbon.uuid}`, kind: "carbon", old_id: carbon.id, new_id: newId });

    // ---- profile fields only -------------------------------------------------------------------------------------------
    after = (await inboxEvents(env, APP, { uuid: "none" })).last_seq;
    const name = `WH Imported ${uid()}`;
    must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: name } }), 200);
    const updated = await waitEvent(env, APP, { type: "account.updated", uuid: carbon.uuid, after });
    const data = updated?.payload.data as { changed?: string[]; account?: Record<string, unknown> } | undefined;
    checkEq(results, "rename: the app hears changed [display_name] and sees only the profile fields (no email although it imported by email)", { changed: data?.changed, keys: Object.keys(data?.account ?? {}).sort(), name: data?.account?.display_name }, { changed: ["display_name"], keys: BASE_KEYS, name });
    const email2 = `wh.imported2+${uid()}@example.test`;
    const seq = await lastSeq(env);
    const challenge = must("add an email", await carbon.visitor.call<{ challenge_id: string }>("POST", "/v1/me/emails", { json: { email: email2 } }), [200, 201]).body;
    must("verify it", await carbon.visitor.call("POST", "/v1/me/emails/verify", { json: { challenge_id: challenge.challenge_id, code: await codeFor(env, email2, seq) } }), 200);
    since = Date.now();
    must("make it primary", await carbon.visitor.call("POST", `/v1/me/emails/${encodeURIComponent(email2)}/primary`), 200);
    checkEq(results, "a new primary email is not sent to an app that was never granted email", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => row.target_id), []);

    // ---- access removed: a re-import does not bring the webhooks back ----------------------------------------------------
    since = Date.now();
    must("remove the app's access", await carbon.visitor.call("DELETE", `/v1/me/apps/${APP}`), [200, 204]);
    checkEq(results, "removing an imported app's access tells it (membership.access_removed)", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`), [`membership.access_removed→${APP}`]);
    const second = await importRows(ctx, [{ email: carbon.email, external_id: `crm-${uid()}` }]);
    const status = must("the app's user", await appCall<{ status?: string }>(env, APP, "GET", `/v1/apps/${APP}/users/${carbon.uuid}`), [200, 404]).body.status ?? "gone";
    results.check("a re-import leaves the membership access_removed", second.job.status === "completed" && status === "access_removed", `${second.job.status}, ${status}, ${short(second.outcomes)}`);
    since = Date.now();
    must("rename", await carbon.visitor.call("PATCH", "/v1/me", { json: { display_name: `${name} again` } }), 200);
    checkEq(results, "after the re-import, changes still don't reach the app", (await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 })).map(row => row.target_id), []);
  },
};
